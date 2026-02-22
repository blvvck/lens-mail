import { describe, expect, it } from 'vitest';
import { handleProvision, handleTemporaryProvision } from './provision';
import type { Env } from '../types';

function fakeEnv(
  runOverride?: (sql: string) => { meta: { changes: number } },
  batchOverride?: () => { meta: { changes: number } }[],
) {
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind() {
          return {
            first: async () => sql.includes('COUNT(*)') ? { count: 0 } : null,
            run: async () => runOverride?.(sql) || ({ meta: { changes: 1 } }),
          };
        },
      };
    },
    batch: async () => batchOverride?.() || [{ meta: { changes: 1 } }, { meta: { changes: 1 } }],
  };
  return {
    DB: db,
    DOMAIN: 'lenscli.com',
    ADMIN_KEY: '',
    statements,
  } as unknown as Env & { statements: string[] };
}

describe('temporary mailbox provisioning', () => {
  it('returns a random receive-only address and expiry', async () => {
    const env = fakeEnv();
    const response = await handleTemporaryProvision(
      new Request('https://api.lenscli.com/api/v1/mail/temp', {
        method: 'POST',
        body: JSON.stringify({ name: 'My Agent', ttl: 900 }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
      }),
      env,
    );
    const body = await response.json() as { data: { address: string; apiKey: string; mailboxType: string; expiresAt: string } };
    expect(response.status).toBe(201);
    expect(body.data.address).toMatch(/^my-agent-[a-f0-9]{20}@lenscli\.com$/);
    expect(body.data.apiKey).toMatch(/^lm_[0-9a-f]{48}$/);
    expect(body.data.mailboxType).toBe('temporary');
    expect(new Date(body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(env.statements.some((sql) => sql.includes('mailbox_type'))).toBe(true);
  });

  it('rejects malformed API TTLs before touching provisioning state', async () => {
    const env = fakeEnv();
    const response = await handleTemporaryProvision(
      new Request('https://api.lenscli.com/api/v1/mail/temp', {
        method: 'POST',
        body: JSON.stringify({ ttl: 299 }),
        headers: { 'Content-Type': 'application/json' },
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(env.statements).toHaveLength(0);
  });

  it('rejects reserved brand aliases for temporary provisioning before rate limiting', async () => {
    const env = fakeEnv();
    const response = await handleTemporaryProvision(
      new Request('https://api.lenscli.com/api/v1/mail/temp', {
        method: 'POST',
        body: JSON.stringify({ name: 'sales' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(env.statements).toHaveLength(0);
  });

  it('rejects reserved brand aliases for persistent provisioning too', async () => {
    const env = fakeEnv();
    const response = await handleProvision(
      new Request('https://api.lenscli.com/api/v1/mail/provision', {
        method: 'POST',
        body: JSON.stringify({ name: 'contact' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(env.statements).toHaveLength(0);
  });

  it('persists a validated display name for persistent provisioning', async () => {
    const env = fakeEnv();
    const response = await handleProvision(
      new Request('https://api.lenscli.com/api/v1/mail/provision', {
        method: 'POST',
        body: JSON.stringify({ name: 'checkout-agent', displayName: 'Checkout Agent' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      env,
    );
    expect(response.status).toBe(201);
    const body = await response.json() as { data: { displayName: string } };
    expect(body.data.displayName).toBe('Checkout Agent');
    expect(env.statements.some((sql) => sql.includes('display_name'))).toBe(true);
  });

  it('rejects header injection in a display name', async () => {
    const env = fakeEnv();
    const response = await handleProvision(
      new Request('https://api.lenscli.com/api/v1/mail/provision', {
        method: 'POST',
        body: JSON.stringify({ name: 'checkout-agent', displayName: 'Checkout\r\nBcc: attacker@example.com' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(env.statements).toHaveLength(0);
  });

  it('does not allow temporary mailboxes to carry a display name', async () => {
    const env = fakeEnv();
    const response = await handleTemporaryProvision(
      new Request('https://api.lenscli.com/api/v1/mail/temp', {
        method: 'POST',
        body: JSON.stringify({ displayName: 'Checkout Agent' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(env.statements).toHaveLength(0);
  });

  it('retries an address collision without returning the existing address', async () => {
    let batchAttempts = 0;
    const env = fakeEnv(undefined, () => {
      batchAttempts++;
      if (batchAttempts === 1) throw new Error('UNIQUE constraint failed: mailboxes.address');
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    });
    const response = await handleTemporaryProvision(
      new Request('https://api.lenscli.com/api/v1/mail/temp', {
        method: 'POST',
        body: JSON.stringify({ name: 'agent' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      env,
    );
    expect(response.status).toBe(201);
    expect(batchAttempts).toBe(2);
  });

  it('reserves the final active temporary mailbox slot atomically', async () => {
    let active = 999;
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => sql.includes('FROM mailboxes') ? { count: active } : null,
              run: async () => {
                if (sql.includes('INSERT INTO mailboxes')) {
                  if (active >= 1000) return { meta: { changes: 0 } };
                  active++;
                }
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
      batch: async () => {
        if (active >= 1000) return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }];
        active++;
        return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
      },
    };
    const env = { DB: db, DOMAIN: 'lenscli.com', ADMIN_KEY: '' } as never;
    const responses = await Promise.all([
      handleTemporaryProvision(new Request('https://api.lenscli.com/api/v1/mail/temp', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }), env),
      handleTemporaryProvision(new Request('https://api.lenscli.com/api/v1/mail/temp', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }), env),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
  });
});
