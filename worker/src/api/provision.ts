import type { Env, AuthContext } from '../types';
import { ok, validationError, rateLimited } from '../lib/response';
import { generateApiKey, hashKey, keyPrefix } from '../lib/auth';
import { checkProvisionRateLimit, checkTemporaryProvisionRateLimit } from '../lib/rate-limit';
import { ulid } from '../lib/ulid';
import { generateVerifyCode } from '../lib/security-hooks';
import { validateDisplayName } from '../lib/display-name';
import {
  MAX_ACTIVE_TEMP_MAILBOXES,
  TEMPORARY_MAILBOX_TYPE,
  generateTemporaryLocalPart,
  parseTemporaryTtl,
  sanitizeTemporaryName,
  isReservedMailboxName,
} from '../lib/temporary';

// Word lists for generating memorable secrets
const ADJECTIVES = [
  'crystal', 'velvet', 'iron', 'golden', 'silver', 'cobalt', 'amber', 'jade',
  'coral', 'onyx', 'scarlet', 'arctic', 'lunar', 'solar', 'ember', 'frost',
];
const NOUNS = [
  'falcon', 'phoenix', 'cipher', 'beacon', 'anchor', 'prism', 'atlas', 'nexus',
  'vortex', 'summit', 'forge', 'herald', 'sentinel', 'harbor', 'raven', 'lotus',
];

/**
 * POST /api/v1/mail/provision — Create new mailbox + API key
 *
 * Security:
 * - Rate limited by IP: 3/hour, 10/day
 * - Admin key bypasses rate limits
 * - Enumeration prevention: "taken" and "invalid" return same error shape
 */
export async function handleProvision(
  request: Request,
  env: Env
): Promise<Response> {
  const body = await request.json<{ name?: string; displayName?: unknown }>().catch(() => ({}));
  let displayName: string | null;
  try {
    displayName = validateDisplayName((body as { displayName?: unknown }).displayName);
  } catch (error) {
    return validationError(error instanceof Error ? error.message : 'Invalid display name');
  }
  const name = (body as { name?: string }).name?.toLowerCase().replace(/[^a-z0-9._-]/g, '');

  if (!name || name.length < 1 || name.length > 64) {
    // Same error shape as "address taken" — prevents enumeration
    return validationError('Could not provision mailbox');
  }

  // Reserved names that can't be provisioned
  if (isReservedMailboxName(name)) {
    // Same error shape — prevents enumeration of reserved names
    return validationError('Could not provision mailbox');
  }

  const address = `${name}@${env.DOMAIN}`;

  // Check if address already taken (same error shape to prevent enumeration)
  const existing = await env.DB.prepare(
    'SELECT id FROM mailboxes WHERE address = ?'
  ).bind(address).first();

  if (existing) {
    return validationError('Could not provision mailbox');
  }

  // Rate limit by IP — unless admin key is provided
  const authHeader = request.headers.get('Authorization');
  const isAdmin = authHeader?.startsWith('Bearer lma_') && env.ADMIN_KEY &&
    (await hashKey(authHeader.slice(7))) === (await hashKey(env.ADMIN_KEY));

  if (!isAdmin) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limited = await checkProvisionRateLimit(env, ip);
    if (limited) return rateLimited(limited);
  }

  // Create mailbox + key
  const mailboxId = ulid();
  const apiKey = generateApiKey();
  const hash = await hashKey(apiKey);
  const prefix = keyPrefix(apiKey);
  const keyId = ulid();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mailboxes (id, address, display_name, domain) VALUES (?, ?, ?, ?)`
    ).bind(mailboxId, address, displayName, env.DOMAIN),
    env.DB.prepare(
      `INSERT INTO api_keys (id, mailbox_id, key_hash, key_prefix) VALUES (?, ?, ?, ?)`
    ).bind(keyId, mailboxId, hash, prefix),
  ]);

  return ok({ address, apiKey, mailboxId, ...(displayName ? { displayName } : {}) }, 201);
}

/**
 * POST /api/v1/mail/temp — Create a short-lived receive-only mailbox.
 *
 * The API accepts TTL as integer seconds so callers do not need to depend on
 * the CLI duration syntax. Addresses are random and tombstoned on expiry.
 */
export async function handleTemporaryProvision(
  request: Request,
  env: Env
): Promise<Response> {
  const body = await request.json<{ name?: unknown; ttl?: unknown; displayName?: unknown }>().catch(() => ({}));
  if (Object.prototype.hasOwnProperty.call(body, 'displayName')) {
    return validationError('Display names are not supported for temporary mailboxes');
  }
  let ttl: number;
  let name: string | null;
  try {
    ttl = parseTemporaryTtl((body as { ttl?: unknown }).ttl);
    name = sanitizeTemporaryName((body as { name?: unknown }).name);
  } catch (error) {
    return validationError(error instanceof Error ? error.message : 'Invalid temporary mailbox request');
  }
  if (name && isReservedMailboxName(name)) {
    return validationError('Could not provision mailbox');
  }

  const authHeader = request.headers.get('Authorization');
  const isAdmin = authHeader?.startsWith('Bearer lma_') && env.ADMIN_KEY &&
    (await hashKey(authHeader.slice(7))) === (await hashKey(env.ADMIN_KEY));

  if (!isAdmin) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limited = await checkTemporaryProvisionRateLimit(env, ip);
    if (limited) return rateLimited(limited);
  }

  const active = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM mailboxes
     WHERE mailbox_type = ? AND status = 'active'
     AND expires_at IS NOT NULL AND julianday(expires_at) > julianday('now')`
  ).bind(TEMPORARY_MAILBOX_TYPE).first<{ count: number }>();
  if ((active?.count || 0) >= MAX_ACTIVE_TEMP_MAILBOXES) {
    return rateLimited(3600);
  }

  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const mailboxId = ulid();
    const apiKey = generateApiKey();
    const hash = await hashKey(apiKey);
    const prefix = keyPrefix(apiKey);
    const keyId = ulid();
    const address = `${generateTemporaryLocalPart(name)}@${env.DOMAIN}`;

    try {
      const results = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO mailboxes (id, address, domain, mailbox_type, expires_at)
           SELECT ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM mailboxes
                  WHERE mailbox_type = ? AND status = 'active'
                  AND expires_at IS NOT NULL AND julianday(expires_at) > julianday('now')) < ?`
        ).bind(
          mailboxId, address, env.DOMAIN, TEMPORARY_MAILBOX_TYPE, expiresAt,
          TEMPORARY_MAILBOX_TYPE, MAX_ACTIVE_TEMP_MAILBOXES,
        ),
        env.DB.prepare(
          `INSERT INTO api_keys (id, mailbox_id, key_hash, key_prefix)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM mailboxes WHERE id = ?)`
        ).bind(keyId, mailboxId, hash, prefix, mailboxId),
      ]);
      if (results[0].meta.changes === 0) return rateLimited(3600);
      if (results[1].meta.changes === 0) throw new Error('Temporary mailbox key reservation failed');
      return ok({
        address,
        apiKey,
        mailboxId,
        mailboxType: TEMPORARY_MAILBOX_TYPE,
        expiresAt,
      }, 201);
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }

  return validationError('Could not provision temporary mailbox');
}

/** POST /api/v1/mail/keys/rotate — Generate new key, optionally revoke old */
export async function handleRotateKey(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const body = await request.json<{ revokeOld?: boolean }>().catch(() => ({}));
  const revokeOld = (body as { revokeOld?: boolean }).revokeOld ?? false;

  const apiKey = generateApiKey();
  const hash = await hashKey(apiKey);
  const prefix = keyPrefix(apiKey);
  const keyId = ulid();

  const stmts = [
    env.DB.prepare(
      `INSERT INTO api_keys (id, mailbox_id, key_hash, key_prefix) VALUES (?, ?, ?, ?)`
    ).bind(keyId, auth.mailboxId, hash, prefix),
  ];

  if (revokeOld) {
    stmts.push(
      env.DB.prepare(
        `UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`
      ).bind(auth.keyId)
    );
  }

  await env.DB.batch(stmts);
  return ok({ apiKey, prefix });
}

/** DELETE /api/v1/mail/keys/:prefix — Revoke a specific key */
export async function handleRevokeKey(
  prefix: string,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const result = await env.DB.prepare(
    `UPDATE api_keys SET revoked_at = datetime('now')
     WHERE key_prefix = ? AND mailbox_id = ? AND revoked_at IS NULL`
  ).bind(prefix, auth.mailboxId).run();

  if (result.meta.changes === 0) {
    return validationError('Key not found or already revoked');
  }

  return ok({ revoked: prefix });
}

/**
 * POST /api/v1/mail/owner-token — Set up owner verification (TOTP-style 2FA).
 *
 * Generates a shared secret that is shown ONCE to the human. The secret is
 * stored in mailbox settings. It is NEVER sent over email.
 *
 * Flow:
 * 1. Human runs `lens mail.verify` → generates secret, shows it once
 * 2. Human saves the secret (password manager, etc.)
 * 3. To verify: `lens mail.verify code` → shows a 6-digit code valid for 5 min
 * 4. Human includes "verify:XXXXXX" in their email
 * 5. Agent sees `owner_verified` flag on the message
 *
 * Secret format: adjective-noun-adjective-noun-NN (high entropy, memorable)
 */
export async function handleOwnerToken(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const body = await request.json<{ custom?: string }>().catch(() => ({}));
  const custom = (body as { custom?: string }).custom;

  let secret: string;

  if (custom) {
    if (custom.length < 8 || custom.length > 100) {
      return validationError('Custom secret must be 8-100 characters');
    }
    secret = custom;
  } else {
    // Auto-generate: adjective-noun-adjective-noun-NN (high entropy)
    const a1 = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const n1 = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const a2 = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const n2 = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const num = String(Math.floor(Math.random() * 100)).padStart(2, '0');
    secret = `${a1}-${n1}-${a2}-${n2}-${num}`;
  }

  // Read current settings, store owner_secret
  const row = await env.DB.prepare(
    'SELECT settings FROM mailboxes WHERE id = ?'
  ).bind(auth.mailboxId).first<{ settings: string }>();

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(row?.settings || '{}');
  } catch { /* invalid JSON — start fresh */ }

  settings.owner_secret = secret;
  // Remove old plaintext token if present
  delete settings.owner_token;

  await env.DB.prepare(
    'UPDATE mailboxes SET settings = ? WHERE id = ?'
  ).bind(JSON.stringify(settings), auth.mailboxId).run();

  // Generate the first code so human can verify setup works
  const { code, expiresIn } = generateVerifyCode(secret);

  return ok({
    secret,
    first_code: code,
    expires_in: expiresIn,
    message: 'SAVE THIS SECRET — it will not be shown again. Use `lens mail.verify code` to generate 6-digit codes. Include "verify:XXXXXX" in your email to authenticate.',
  });
}

/**
 * GET /api/v1/mail/owner-token/code — Generate current TOTP code.
 *
 * Returns the 6-digit code valid for the current 5-minute window.
 * Human calls this before sending an email that needs verification.
 */
export async function handleGetVerifyCode(
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT settings FROM mailboxes WHERE id = ?'
  ).bind(auth.mailboxId).first<{ settings: string }>();

  let secret: string | null = null;
  try {
    const settings = JSON.parse(row?.settings || '{}');
    secret = settings.owner_secret || null;
  } catch { /* invalid JSON */ }

  if (!secret) {
    return validationError('No owner verification secret configured. Run `lens mail.verify` first.');
  }

  const { code, expiresIn } = generateVerifyCode(secret);

  return ok({
    code,
    expires_in: expiresIn,
    instruction: `Include "verify:${code}" in your email subject or body.`,
  });
}

/**
 * DELETE /api/v1/mail/owner-token — Remove owner verification secret.
 */
export async function handleDeleteOwnerToken(
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT settings FROM mailboxes WHERE id = ?'
  ).bind(auth.mailboxId).first<{ settings: string }>();

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(row?.settings || '{}');
  } catch { /* invalid JSON — start fresh */ }

  delete settings.owner_secret;
  delete settings.owner_token; // clean up legacy

  await env.DB.prepare(
    'UPDATE mailboxes SET settings = ? WHERE id = ?'
  ).bind(JSON.stringify(settings), auth.mailboxId).run();

  return ok({ deleted: true });
}
