import { describe, expect, it } from 'vitest';
import { checkTemporaryProvisionRateLimit } from './rate-limit';

function concurrentRateLimitEnv() {
  const rows = new Map<string, { count: number; expires_at: string }>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (!sql.startsWith('SELECT count')) return null;
              const row = rows.get(String(values[0]));
              return row ? { count: row.count, window_start: '', expires_at: row.expires_at } : null;
            },
            run: async () => {
              const key = String(values[0]);
              if (sql.startsWith('INSERT OR IGNORE')) {
                if (rows.has(key)) return { meta: { changes: 0 } };
                rows.set(key, { count: 1, expires_at: String(values[2]) });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith('UPDATE rate_limits SET count = 1')) {
                const resetKey = String(values[2]);
                const row = rows.get(resetKey);
                if (row && new Date(row.expires_at) <= new Date(String(values[3]))) {
                  rows.set(resetKey, { count: 1, expires_at: String(values[1]) });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.startsWith('UPDATE rate_limits SET count = count + 1')) {
                const row = rows.get(key);
                const max = Number(values[2]);
                if (row && new Date(row.expires_at) > new Date(String(values[1])) && row.count < max) {
                  row.count++;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  return { DB: db } as never;
}

describe('temporary provisioning rate limits', () => {
  it('does not allow concurrent requests to exceed two hourly reservations', async () => {
    const env = concurrentRateLimitEnv();
    const results = await Promise.all([
      checkTemporaryProvisionRateLimit(env, '203.0.113.10'),
      checkTemporaryProvisionRateLimit(env, '203.0.113.10'),
      checkTemporaryProvisionRateLimit(env, '203.0.113.10'),
    ]);
    expect(results.filter((retryAfter) => retryAfter === 0)).toHaveLength(2);
    expect(results.filter((retryAfter) => retryAfter > 0)).toHaveLength(1);
  });
});
