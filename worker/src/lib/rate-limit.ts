import type { Env } from '../types';

/**
 * Rate limiting for outbound email sends.
 *
 * Two windows enforced simultaneously:
 * - Hourly: MAX_SEND_PER_HOUR (default 50)
 * - Daily: MAX_SEND_PER_DAY (default 500)
 *
 * Returns 0 if allowed, or seconds until reset if rate limited.
 */
export async function checkSendRateLimit(env: Env, mailboxId: string): Promise<number> {
  const maxPerHour = parseInt(env.MAX_SEND_PER_HOUR) || 50;
  const maxPerDay = parseInt(env.MAX_SEND_PER_DAY) || 500;

  // Check hourly limit
  const hourlyResult = await checkWindow(
    env, `send:${mailboxId}:hourly`, maxPerHour, 3600
  );
  if (hourlyResult > 0) return hourlyResult;

  // Check daily limit
  const dailyResult = await checkWindow(
    env, `send:${mailboxId}:daily`, maxPerDay, 86400
  );
  if (dailyResult > 0) return dailyResult;

  return 0;
}

/**
 * Check and increment a rate limit window.
 * Returns 0 if allowed, or seconds until window reset.
 */
async function checkWindow(
  env: Env,
  key: string,
  maxCount: number,
  windowSeconds: number
): Promise<number> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + windowSeconds * 1000).toISOString();

  // Reserve the first slot atomically. INSERT OR IGNORE prevents concurrent
  // callers from replacing a live window and resetting its counter.
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO rate_limits (key, count, window_start, expires_at)
     VALUES (?, 1, ?, ?)`
  ).bind(key, nowIso, expiresAt).run();
  if (inserted.meta.changes > 0) return 0;

  // A single caller may roll an expired window forward; the predicate makes
  // that transition atomic when several callers arrive at the boundary.
  const reset = await env.DB.prepare(
    `UPDATE rate_limits SET count = 1, window_start = ?, expires_at = ?
     WHERE key = ? AND expires_at <= ?`
  ).bind(nowIso, expiresAt, key, nowIso).run();
  if (reset.meta.changes > 0) return 0;

  // The count predicate is the concurrency gate: SQLite serializes the
  // updates, so only maxCount callers can change a row in this window.
  const incremented = await env.DB.prepare(
    `UPDATE rate_limits SET count = count + 1
     WHERE key = ? AND expires_at > ? AND count < ?`
  ).bind(key, nowIso, maxCount).run();
  if (incremented.meta.changes > 0) return 0;

  const row = await env.DB.prepare(
    'SELECT expires_at FROM rate_limits WHERE key = ?'
  ).bind(key).first<{ expires_at: string }>();
  return Math.max(1, Math.ceil((new Date(row?.expires_at || expiresAt).getTime() - now.getTime()) / 1000));
}

/**
 * Check provisioning rate limit (hourly + daily).
 * - 3/hour per IP
 * - 10/day per IP
 *
 * Returns 0 if allowed, or seconds until reset.
 */
export async function checkProvisionRateLimit(env: Env, ip: string): Promise<number> {
  const hourlyResult = await checkWindow(env, `provision:${ip}:hourly`, 3, 3600);
  if (hourlyResult > 0) return hourlyResult;

  const dailyResult = await checkWindow(env, `provision:${ip}:daily`, 10, 86400);
  if (dailyResult > 0) return dailyResult;

  return 0;
}

/** Check temporary mailbox creation rate limit: 2/hour and 5/day per IP. */
export async function checkTemporaryProvisionRateLimit(env: Env, ip: string): Promise<number> {
  const hourlyResult = await checkWindow(env, `temp-provision:${ip}:hourly`, 2, 3600);
  if (hourlyResult > 0) return hourlyResult;

  const dailyResult = await checkWindow(env, `temp-provision:${ip}:daily`, 5, 86400);
  if (dailyResult > 0) return dailyResult;

  return 0;
}
