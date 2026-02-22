import type { Env } from '../types';

/**
 * Hourly cron — cleanup expired data, retry stuck operations.
 */
export async function handleCron(env: Env, ctx: ExecutionContext): Promise<void> {
  await Promise.all([
    cleanupExpiredMessages(env),
    cleanupExpiredRateLimits(env),
    cleanupSenderRateLimits(env),
    cleanupStaleIdempotencyKeys(env),
    retryStuckDeletions(env),
  ]);
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
