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
  const row = await env.DB.prepare(
    'SELECT count, window_start, expires_at FROM rate_limits WHERE key = ?'
  ).bind(key).first<{ count: number; window_start: string; expires_at: string }>();

  if (!row || new Date(row.expires_at) < now) {
    // New window
    const expiresAt = new Date(now.getTime() + windowSeconds * 1000).toISOString();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO rate_limits (key, count, window_start, expires_at)
       VALUES (?, 1, ?, ?)`
    ).bind(key, now.toISOString(), expiresAt).run();
    return 0;
  }

  if (row.count >= maxCount) {
    return Math.ceil((new Date(row.expires_at).getTime() - now.getTime()) / 1000);
  }

  await env.DB.prepare(
    'UPDATE rate_limits SET count = count + 1 WHERE key = ?'
  ).bind(key).run();
  return 0;
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
