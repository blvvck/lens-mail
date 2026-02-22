/**
 * Spam filtering utilities for inbound email.
 *
 * Two layers:
 * 1. Edge rejection (Email Worker) — fast, low-cost checks
 * 2. Spam scoring (Queue Consumer) — deeper analysis, stored on message metadata
 */

// --- Known spam domains ---
// Disposable email providers and known spam sources.
// This is a curated list — not exhaustive, but covers the high-volume offenders.
const KNOWN_SPAM_DOMAINS = new Set([
  // Disposable email services (used for spam/abuse)
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'grr.la',
  'tempmail.com',
  'temp-mail.org',
  'throwaway.email',
  'yopmail.com',
  'sharklasers.com',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.de',
  'dispostable.com',
  'maildrop.cc',
  'fakeinbox.com',
  'trashmail.com',
  'trashmail.me',
  'mailnesia.com',
  'tempmailaddress.com',
  'getairmail.com',
  'mohmal.com',
  'getnada.com',
  'emailondeck.com',
  'tempail.com',
  'mintemail.com',
]);

/** Check if a domain is a known spam/disposable email provider */
export function isKnownSpamDomain(domain: string): boolean {
  return KNOWN_SPAM_DOMAINS.has(domain.toLowerCase());
}

/**
 * Extract SPF result from Cloudflare's Authentication-Results header.
 *
 * Cloudflare Email Routing adds an Authentication-Results header with SPF,
 * DKIM, and DMARC results before passing the email to the Worker.
 *
 * Returns: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'unknown'
 */
export type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'unknown';

export function checkSpfFromHeaders(headers: Headers): SpfResult {
  const authResults = headers.get('Authentication-Results') || '';

  // Parse SPF result from header like:
  // "mx.cloudflare.net; spf=pass (sender SPF authorized) smtp.mailfrom=example.com"
  const spfMatch = authResults.match(/\bspf=(pass|fail|softfail|neutral|none)\b/i);
  if (spfMatch) {
    return spfMatch[1].toLowerCase() as SpfResult;
  }

  return 'unknown';
}

/**
 * Extract DKIM result from Authentication-Results header.
 */
export type DkimResult = 'pass' | 'fail' | 'none' | 'unknown';

export function checkDkimFromHeaders(headers: Headers): DkimResult {
  const authResults = headers.get('Authentication-Results') || '';
  const dkimMatch = authResults.match(/\bdkim=(pass|fail|none)\b/i);
  if (dkimMatch) {
    return dkimMatch[1].toLowerCase() as DkimResult;
  }
  return 'unknown';
}

/**
 * Extract DMARC result from Authentication-Results header.
 */
export type DmarcResult = 'pass' | 'fail' | 'none' | 'unknown';

export function checkDmarcFromHeaders(headers: Headers): DmarcResult {
  const authResults = headers.get('Authentication-Results') || '';
  const dmarcMatch = authResults.match(/\bdmarc=(pass|fail|none)\b/i);
  if (dmarcMatch) {
    return dmarcMatch[1].toLowerCase() as DmarcResult;
  }
  return 'unknown';
}

// --- Spam score calculation (for Queue Consumer) ---

/** Spam indicators with their weight (0.0 to 1.0 contribution) */
interface SpamSignal {
  name: string;
  weight: number;
  matched: boolean;
}

/** Common spam subject patterns */
const SPAM_SUBJECT_PATTERNS = [
  /\bcongratulations?\b/i,
  /\byou\s+(?:have\s+)?won\b/i,
  /\b(?:free|act\s+now|limited\s+time)\b/i,
  /\b(?:click\s+here|buy\s+now|order\s+now)\b/i,
  /\b(?:nigerian?\s+prince|inheritance|million\s+dollars?)\b/i,
  /\b(?:viagra|cialis|pharmacy|prescription)\b/i,
  /\b(?:casino|lottery|prize)\b/i,
  /\b(?:lose\s+weight|diet\s+pill|weight\s+loss)\b/i,
];

/** Common spam body patterns */
const SPAM_BODY_PATTERNS = [
  /dear\s+(?:sir|madam|friend|customer|beneficiary)/i,
  /(?:wire\s+transfer|western\s+union|money\s+gram)/i,
  /(?:bank\s+account|routing\s+number|swift\s+code)/i,
  /(?:unsubscribe|opt[\s-]?out|remove\s+from\s+list)/i,
  /(?:100%\s+free|risk[\s-]?free|no\s+obligation)/i,
  /(?:one[\s-]?time\s+offer|exclusive\s+deal)/i,
];

export interface SpamAnalysis {
  score: number; // 0.0 (clean) to 1.0 (spam)
  signals: string[]; // list of matched spam signals
}

/**
 * Calculate a spam score for a parsed email message.
 * Runs in the Queue Consumer where CPU time is less constrained.
 *
 * Score breakdown:
 * - SPF/DKIM/DMARC failures: 0.15 each
 * - Known spam domain: 0.30
 * - Spam subject patterns: 0.10 each (max 0.30)
 * - Spam body patterns: 0.05 each (max 0.20)
 * - Excessive links: 0.10
 * - No text body (HTML-only): 0.05
 *
 * Capped at 1.0.
 */
export function calculateSpamScore(params: {
  fromDomain: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  linkCount: number;
  spfResult: SpfResult;
  dkimResult: DkimResult;
  dmarcResult: DmarcResult;
}): SpamAnalysis {
  const signals: SpamSignal[] = [];

  // Authentication signals
  signals.push({
    name: 'spf_fail',
    weight: 0.15,
    matched: params.spfResult === 'fail' || params.spfResult === 'softfail',
  });
  signals.push({
    name: 'dkim_fail',
    weight: 0.15,
    matched: params.dkimResult === 'fail',
  });
  signals.push({
    name: 'dmarc_fail',
    weight: 0.15,
    matched: params.dmarcResult === 'fail',
  });

  // Known spam domain
  signals.push({
    name: 'spam_domain',
    weight: 0.30,
    matched: isKnownSpamDomain(params.fromDomain),
  });

  // Subject patterns (cap at 3 matches = 0.30)
  let subjectMatches = 0;
  for (const pattern of SPAM_SUBJECT_PATTERNS) {
    if (pattern.test(params.subject) && subjectMatches < 3) {
      signals.push({
        name: `spam_subject:${pattern.source.slice(0, 20)}`,
        weight: 0.10,
        matched: true,
      });
      subjectMatches++;
    }
  }

  // Body patterns (cap at 4 matches = 0.20)
  let bodyMatches = 0;
  for (const pattern of SPAM_BODY_PATTERNS) {
    if (pattern.test(params.bodyText) && bodyMatches < 4) {
      signals.push({
        name: `spam_body:${pattern.source.slice(0, 20)}`,
        weight: 0.05,
        matched: true,
      });
      bodyMatches++;
    }
  }

  // Excessive links (more than 20 in body)
  signals.push({
    name: 'excessive_links',
    weight: 0.10,
    matched: params.linkCount > 20,
  });

  // HTML-only (no text part) — common in spam
  signals.push({
    name: 'html_only',
    weight: 0.05,
    matched: !params.bodyText && !!params.bodyHtml,
  });

  const matchedSignals = signals.filter((s) => s.matched);
  const rawScore = matchedSignals.reduce((sum, s) => sum + s.weight, 0);
  const score = Math.min(1.0, Math.round(rawScore * 100) / 100);

  return {
    score,
    signals: matchedSignals.map((s) => s.name),
  };
}
