import type { Env, AuthContext } from '../types';
import { ok, validationError, notFound } from '../lib/response';

/**
 * POST /api/v1/mail/block — Block a sender.
 *
 * Accepts an email address or @domain pattern.
 * Blocked senders are rejected at the edge (email worker) on next inbound.
 *
 * Body: { sender: "spammer@evil.com", reason?: "prompt injection attempts" }
 * Or:   { sender: "@evil.com", reason?: "entire domain is spam" }
 */
export async function handleBlockSender(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const body = await request.json<{ sender?: string; reason?: string }>().catch(() => ({}));
  const sender = (body as { sender?: string }).sender?.toLowerCase().trim();
  const reason = (body as { reason?: string }).reason || '';

  if (!sender) {
    return validationError('sender is required (email address or @domain)');
  }

  // Validate format: either email or @domain
  const isEmail = sender.includes('@') && !sender.startsWith('@');
  const isDomain = sender.startsWith('@') && sender.length > 1;

  if (!isEmail && !isDomain) {
    return validationError('sender must be an email address (user@domain.com) or domain pattern (@domain.com)');
  }

  // Max 500 blocked senders per mailbox
  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM blocked_senders WHERE mailbox_id = ?'
  ).bind(auth.mailboxId).first<{ count: number }>();

  if (countRow && countRow.count >= 500) {
    return validationError('Maximum 500 blocked senders per mailbox');
  }

  // Upsert — update reason if already blocked
  await env.DB.prepare(
    `INSERT INTO blocked_senders (mailbox_id, sender, reason, blocked_by)
     VALUES (?, ?, ?, 'agent')
     ON CONFLICT (mailbox_id, sender) DO UPDATE SET reason = ?, blocked_by = 'agent'`
  ).bind(auth.mailboxId, sender, reason, reason).run();

  return ok({ blocked: sender, reason });
}

/**
 * DELETE /api/v1/mail/block — Unblock a sender.
 *
 * Body: { sender: "spammer@evil.com" }
 */
export async function handleUnblockSender(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const body = await request.json<{ sender?: string }>().catch(() => ({}));
  const sender = (body as { sender?: string }).sender?.toLowerCase().trim();

  if (!sender) {
    return validationError('sender is required');
  }

  const result = await env.DB.prepare(
    'DELETE FROM blocked_senders WHERE mailbox_id = ? AND sender = ?'
  ).bind(auth.mailboxId, sender).run();

  if (result.meta.changes === 0) {
    return notFound('Sender not in blocklist');
  }

  return ok({ unblocked: sender });
}

/**
 * GET /api/v1/mail/blocked — List all blocked senders.
 */
export async function handleListBlocked(
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT sender, reason, blocked_by, created_at FROM blocked_senders WHERE mailbox_id = ? ORDER BY created_at DESC'
  ).bind(auth.mailboxId).all<{
    sender: string;
    reason: string;
    blocked_by: string;
    created_at: string;
  }>();

  return ok({ blocked: results || [], count: (results || []).length });
}

/**
 * Check if a sender is blocked for a given mailbox.
 * Checks both exact email match and @domain pattern.
 *
 * Used by the edge handler (email worker) to reject at inbound.
 */
export async function isBlocked(
  env: Env,
  mailboxId: string,
  senderAddress: string
): Promise<boolean> {
  const sender = senderAddress.toLowerCase();
  const domain = '@' + (sender.split('@')[1] || '');

  // Check exact email or domain pattern
  const row = await env.DB.prepare(
    'SELECT 1 FROM blocked_senders WHERE mailbox_id = ? AND (sender = ? OR sender = ?) LIMIT 1'
  ).bind(mailboxId, sender, domain).first();

  return !!row;
}
