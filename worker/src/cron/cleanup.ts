import type { Env } from '../types';
import { purgeR2Prefix, TEMPORARY_MAILBOX_TYPE } from '../lib/temporary';

/**
 * Hourly cron — cleanup expired data, retry stuck operations.
 */
export async function handleCron(env: Env, ctx: ExecutionContext): Promise<void> {
  await cleanupExpiredTemporaryMailboxes(env);
  await Promise.all([
    cleanupExpiredMessages(env),
    cleanupExpiredRateLimits(env),
    cleanupSenderRateLimits(env),
    cleanupStaleIdempotencyKeys(env),
    retryStuckDeletions(env),
  ]);
}

/** Expire temporary mailboxes while retaining their address tombstones. */
export async function cleanupExpiredTemporaryMailboxes(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM mailboxes
     WHERE mailbox_type = ? AND status IN ('active', 'expired')
     AND expires_at IS NOT NULL AND julianday(expires_at) <= julianday('now')
     LIMIT 50`
  ).bind(TEMPORARY_MAILBOX_TYPE).all<{ id: string }>();

  for (const mailbox of results || []) {
    try {
      // Remove objects first. If this fails, the mailbox stays eligible for
      // the next cron pass instead of becoming an undeletable tombstone.
      await purgeR2Prefix(env.MAIL_BUCKET, `mail/${mailbox.id}/`);

      const messageIds = await env.DB.prepare(
        'SELECT id FROM messages WHERE mailbox_id = ?'
      ).bind(mailbox.id).all<{ id: string }>();
      if (messageIds.results?.length) {
        await env.DB.prepare(
          `DELETE FROM message_tags WHERE message_id IN (${messageIds.results.map(() => '?').join(',')})`
        ).bind(...messageIds.results.map((message) => message.id)).run();
      }

      await env.DB.batch([
        env.DB.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(mailbox.id),
        env.DB.prepare('DELETE FROM outbound_sends WHERE mailbox_id = ?').bind(mailbox.id),
        env.DB.prepare('DELETE FROM drafts WHERE mailbox_id = ?').bind(mailbox.id),
        env.DB.prepare('DELETE FROM sender_rate WHERE mailbox_id = ?').bind(mailbox.id),
        env.DB.prepare('DELETE FROM blocked_senders WHERE mailbox_id = ?').bind(mailbox.id),
        env.DB.prepare('DELETE FROM filters WHERE mailbox_id = ?').bind(mailbox.id),
        env.DB.prepare('DELETE FROM room_members WHERE mailbox_id = ?').bind(mailbox.id),
        env.DB.prepare('DELETE FROM api_keys WHERE mailbox_id = ?').bind(mailbox.id),
      ]);

      await env.DB.prepare(
        `UPDATE mailboxes SET status = 'expired'
         WHERE id = ? AND mailbox_type = ? AND status IN ('active', 'expired')
         AND expires_at IS NOT NULL AND julianday(expires_at) <= julianday('now')`
      ).bind(mailbox.id, TEMPORARY_MAILBOX_TYPE).run();
    } catch (error) {
      console.error(`Failed to clean temporary mailbox ${mailbox.id}:`, error);
    }
  }
}

/** Delete messages past retention period */
async function cleanupExpiredMessages(env: Env): Promise<void> {
  const defaultRetention = parseInt(env.DEFAULT_RETENTION_DAYS);

  // Find expired messages
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.r2_key, mb.settings
     FROM messages m
     JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE m.status = 'active'
     AND m.received_at < datetime('now', '-' || ? || ' days')
     LIMIT 100`
  ).bind(defaultRetention).all<{ id: string; r2_key: string; settings: string }>();

  if (!results?.length) return;

  for (const msg of results) {
    // Mark deletion_pending
    await env.DB.prepare(
      "UPDATE messages SET status = 'deletion_pending' WHERE id = ?"
    ).bind(msg.id).run();

    // Delete R2 objects
    const objects = await env.MAIL_BUCKET.list({ prefix: msg.r2_key });
    for (const obj of objects.objects) {
      await env.MAIL_BUCKET.delete(obj.key);
    }

    // Delete D1 row
    await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(msg.id).run();
  }
}

/** Purge expired rate limit entries */
async function cleanupExpiredRateLimits(env: Env): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM rate_limits WHERE expires_at < datetime('now')"
  ).run();
}

/** Purge sender rate tracking windows older than 2 hours */
async function cleanupSenderRateLimits(env: Env): Promise<void> {
  // sender_rate.window stores ISO hour strings like "2026-02-22T14"
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().slice(0, 13);
  await env.DB.prepare(
    'DELETE FROM sender_rate WHERE window < ?'
  ).bind(twoHoursAgo).run();
}

/** Remove idempotency keys older than 24h */
async function cleanupStaleIdempotencyKeys(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE outbound_sends SET idempotency_key = NULL
     WHERE idempotency_key IS NOT NULL
     AND created_at < datetime('now', '-1 day')`
  ).run();
}

/** Retry messages stuck in deletion_pending */
async function retryStuckDeletions(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, r2_key FROM messages WHERE status = 'deletion_pending' LIMIT 50"
  ).all<{ id: string; r2_key: string }>();

  if (!results?.length) return;

  for (const msg of results) {
    const objects = await env.MAIL_BUCKET.list({ prefix: msg.r2_key });
    for (const obj of objects.objects) {
      await env.MAIL_BUCKET.delete(obj.key);
    }
    await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(msg.id).run();
  }
}
