import PostalMime from 'postal-mime';
import type { Env, InboundMessage } from '../types';
import { applyFilters } from '../api/filters';
import {
  calculateSpamScore,
  checkSpfFromHeaders,
  checkDkimFromHeaders,
  checkDmarcFromHeaders,
} from '../lib/spam';
import { runSecurityHooks, type SecurityFlag } from '../lib/security-hooks';
import {
  MAX_TEMP_MESSAGES,
  MAX_TEMP_STORAGE_BYTES,
  TEMPORARY_MAILBOX_TYPE,
  calculateStoredBytes,
  isExpired,
  purgeR2Prefix,
} from '../lib/temporary';

/** OTP / verification code patterns */
const CODE_PATTERNS = [
  /\b(\d{4,8})\b/,                          // 4-8 digit codes
  /(?:code|otp|pin|token)[:\s]+(\w{4,8})/i, // labeled codes
  /verification[:\s]+(\w{4,8})/i,
];

/** URL extraction pattern */
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

/**
 * Stage 2: Queue Consumer — heavy processing.
 * MIME parse, attachment extraction, regex scanning, spam scoring, D1 indexing.
 */
export async function processInboundQueue(
  batch: MessageBatch<InboundMessage>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processMessage(msg.body, env);
      msg.ack();
    } catch (err) {
      console.error(`Failed to process ${msg.body.messageId}:`, err);
      msg.retry();
    }
  }
}

async function processMessage(msg: InboundMessage, env: Env): Promise<void> {
  const mailboxState = await env.DB.prepare(
    `SELECT status, mailbox_type, expires_at FROM mailboxes WHERE id = ?`
  ).bind(msg.mailboxId).first<{ status: string; mailbox_type: string; expires_at: string | null }>();
  if (!mailboxState || mailboxState.status !== 'active' || isExpired(mailboxState.expires_at)) {
    await purgeR2Prefix(env.MAIL_BUCKET, msg.r2Key);
    return;
  }

  // Fetch raw email from R2
  const rawObj = await env.MAIL_BUCKET.get(`${msg.r2Key}raw.eml`);
  if (!rawObj) throw new Error(`Raw email not found at ${msg.r2Key}raw.eml`);

  const rawBuffer = await rawObj.arrayBuffer();

  // Parse MIME
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBuffer);

  const bodyText = parsed.text || '';
  const bodyHtml = parsed.html || '';

  const stateAfterParse = await env.DB.prepare(
    `SELECT status, mailbox_type, expires_at FROM mailboxes WHERE id = ?`
  ).bind(msg.mailboxId).first<{ status: string; mailbox_type: string; expires_at: string | null }>();
  if (!stateAfterParse || stateAfterParse.status !== 'active' || isExpired(stateAfterParse.expires_at)) {
    await purgeR2Prefix(env.MAIL_BUCKET, msg.r2Key);
    return;
  }

  if (stateAfterParse.mailbox_type === TEMPORARY_MAILBOX_TYPE) {
    const usage = await env.DB.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(storage_bytes), 0) as bytes
       FROM messages WHERE mailbox_id = ? AND status IN ('active', 'quarantine')`
    ).bind(msg.mailboxId).first<{ count: number; bytes: number }>();
    if ((usage?.count || 0) >= MAX_TEMP_MESSAGES) {
      await purgeR2Prefix(env.MAIL_BUCKET, msg.r2Key);
      return;
    }
  }

  const storageBytes = calculateStoredBytes(
    rawBuffer,
    bodyText,
    bodyHtml,
    (parsed.attachments || []).map((attachment) => attachment.content),
  );

  // Store parsed body in R2
  await env.MAIL_BUCKET.put(`${msg.r2Key}body.txt`, bodyText);
  if (bodyHtml) {
    await env.MAIL_BUCKET.put(`${msg.r2Key}body.html`, bodyHtml);
  }

  // Extract attachments to R2
  let attachmentCount = 0;
  if (parsed.attachments?.length) {
    for (const attachment of parsed.attachments) {
      const filename = attachment.filename || `attachment_${attachmentCount}`;
      await env.MAIL_BUCKET.put(
        `${msg.r2Key}attachments/${filename}`,
        attachment.content,
        { httpMetadata: { contentType: attachment.mimeType } }
      );
      attachmentCount++;
    }
  }

  // Detect codes and links
  const hasCode = CODE_PATTERNS.some((p) => p.test(bodyText));
  const links = bodyText.match(URL_PATTERN) || bodyHtml.match(URL_PATTERN) || [];
  const hasLink = links.length > 0;

  // Snippet: first 200 chars of body text
  const snippet = bodyText.slice(0, 200).replace(/\s+/g, ' ').trim();

  // --- Spam scoring ---
  // Build a Headers object from the raw email headers for auth checks.
  // postal-mime exposes headers — we need Authentication-Results from them.
  const rawHeaders = new Headers();
  if (parsed.headers) {
    for (const header of parsed.headers) {
      rawHeaders.append(header.key, header.value);
    }
  }

  const fromDomain = (parsed.from?.address || '').split('@')[1]?.toLowerCase() || '';
  const spfResult = checkSpfFromHeaders(rawHeaders);
  const dkimResult = checkDkimFromHeaders(rawHeaders);
  const dmarcResult = checkDmarcFromHeaders(rawHeaders);

  const spamAnalysis = calculateSpamScore({
    fromDomain,
    subject: parsed.subject || '',
    bodyText,
    bodyHtml,
    linkCount: links.length,
    spfResult,
    dkimResult,
    dmarcResult,
  });

  // --- Security hooks (stop hooks for AI agents) ---
  // Resolve mailbox address + settings for impersonation/owner verification checks
  const mailbox = await env.DB.prepare(
    'SELECT address, settings FROM mailboxes WHERE id = ?'
  ).bind(msg.mailboxId).first<{ address: string; settings: string }>();

  // Extract owner_secret from mailbox settings (TOTP 2FA — secret never in email)
  let ownerSecret: string | null = null;
  try {
    const settings = JSON.parse(mailbox?.settings || '{}');
    ownerSecret = settings.owner_secret || null;
  } catch { /* invalid JSON in settings — skip */ }

  const attachmentFilenames = (parsed.attachments || []).map(
    (a, i) => a.filename || `attachment_${i}`
  );

  const securityFlags = runSecurityHooks({
    fromAddress: parsed.from?.address || '',
    fromDomain,
    subject: parsed.subject || '',
    bodyText,
    spfResult,
    dkimResult,
    dmarcResult,
    attachmentFilenames,
    mailboxAddress: mailbox?.address || '',
    ownerSecret,
  });

  // --- Per-sender rate tracking ---
  const senderAddress = (parsed.from?.address || '').toLowerCase();
  const currentHour = new Date().toISOString().slice(0, 13); // "2026-02-22T14"

  await env.DB.prepare(
    `INSERT INTO sender_rate (mailbox_id, sender, window, count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (mailbox_id, sender, window) DO UPDATE SET count = count + 1`
  ).bind(msg.mailboxId, senderAddress, currentHour).run();

  // Check rate — flag if sender exceeds 50 emails/hour
  const rateRow = await env.DB.prepare(
    'SELECT count FROM sender_rate WHERE mailbox_id = ? AND sender = ? AND window = ?'
  ).bind(msg.mailboxId, senderAddress, currentHour).first<{ count: number }>();

  if (rateRow && rateRow.count > 50) {
    securityFlags.push({
      flag: 'sender_flood',
      message: `🚨 FLOOD DETECTED: ${senderAddress} has sent ${rateRow.count} emails this hour. This may be an automated attack or spam campaign.`,
      severity: rateRow.count > 200 ? 'critical' : 'high',
      details: `count=${rateRow.count}, window=${currentHour}`,
    });
  }

  const flagsJson = securityFlags.length > 0 ? JSON.stringify(securityFlags) : null;

  const stateBeforeIndex = await env.DB.prepare(
    `SELECT status, expires_at FROM mailboxes WHERE id = ?`
  ).bind(msg.mailboxId).first<{ status: string; expires_at: string | null }>();
  if (!stateBeforeIndex || stateBeforeIndex.status !== 'active' || isExpired(stateBeforeIndex.expires_at)) {
    await purgeR2Prefix(env.MAIL_BUCKET, msg.r2Key);
    return;
  }

  // Quarantine: if any critical/high severity flags, hold for human review
  const hasSevereFlags = securityFlags.some(
    (f) => f.severity === 'critical' || f.severity === 'high'
  );
  // owner_verified overrides quarantine — trusted sender
  const ownerVerified = securityFlags.some((f) => f.flag === 'owner_verified');
  const messageStatus = (hasSevereFlags && !ownerVerified) ? 'quarantine' : 'active';

  // Index in D1 — store auth results, security flags alongside spam score
  const indexed = await env.DB.prepare(
    `INSERT INTO messages (
      id, mailbox_id, message_id, in_reply_to,
      from_address, from_name, to_address, subject,
      snippet, received_at, r2_key, has_code, has_link,
      has_attachment, attachment_count, spam_score,
      spf_result, dkim_result, dmarc_result,
      security_flags, size_bytes, storage_bytes, status, direction
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'inbound'
      FROM mailboxes mb
      WHERE mb.id = ?
      AND mb.status = 'active'
      AND (mb.expires_at IS NULL OR julianday(mb.expires_at) > julianday('now'))
      AND (
        mb.mailbox_type != ? OR (
          (SELECT COUNT(*) FROM messages WHERE mailbox_id = mb.id AND status IN ('active', 'quarantine')) < ?
          AND (SELECT COALESCE(SUM(storage_bytes), 0) FROM messages WHERE mailbox_id = mb.id AND status IN ('active', 'quarantine')) + ? <= ?
        )
      )`
  ).bind(
    msg.messageId,
    msg.mailboxId,
    parsed.messageId || null,
    parsed.inReplyTo || null,
    parsed.from?.address || '',
    parsed.from?.name || null,
    parsed.to?.[0]?.address || '',
    parsed.subject || '',
    snippet,
    msg.receivedAt,
    msg.r2Key,
    hasCode ? 1 : 0,
    hasLink ? 1 : 0,
    attachmentCount > 0 ? 1 : 0,
    attachmentCount,
    spamAnalysis.score,
    spfResult,
    dkimResult,
    dmarcResult,
    flagsJson,
    rawBuffer.byteLength,
    storageBytes,
    messageStatus,
    msg.mailboxId,
    TEMPORARY_MAILBOX_TYPE,
    MAX_TEMP_MESSAGES,
    storageBytes,
    MAX_TEMP_STORAGE_BYTES,
  ).run();

  if (indexed.meta.changes === 0) {
    await purgeR2Prefix(env.MAIL_BUCKET, msg.r2Key);
    return;
  }

  // Apply filters — auto-tag based on mailbox filter rules
  await applyFilters(env, msg.mailboxId, {
    id: msg.messageId,
    from_address: parsed.from?.address || '',
    subject: parsed.subject || '',
    has_attachment: attachmentCount > 0 ? 1 : 0,
  });
}
