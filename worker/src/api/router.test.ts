import { describe, expect, it } from 'vitest';
import { handleApi } from './router';

function tempAuthEnv() {
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => sql.includes('SELECT ak.id')
              ? { key_id: 'key-1', mailbox_id: 'mailbox-1', address: 'tmp-a1b2c3d4@lenscli.com', mailbox_type: 'temporary', expires_at: new Date(Date.now() + 60_000).toISOString() }
              : null,
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      };
    },
  };
  return { DB: db, ADMIN_KEY: '', DOMAIN: 'lenscli.com' } as never;
}

describe('temporary mailbox API policy', () => {
  it('rejects direct send attempts before reaching the send handler', async () => {
    const response = await handleApi(
      new Request('https://api.lenscli.com/api/v1/mail/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer lm_test' },
        body: '{}',
      }),
      tempAuthEnv(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, code: 6 });
  });

  it.each([
    ['POST', '/api/v1/mail/keys/rotate'],
    ['DELETE', '/api/v1/mail/keys/abc'],
    ['POST', '/api/v1/mail/owner-token'],
    ['DELETE', '/api/v1/mail/owner-token'],
    ['GET', '/api/v1/mail/owner-token/code'],
    ['POST', '/api/v1/mail/block'],
    ['DELETE', '/api/v1/mail/block'],
    ['POST', '/api/v1/mail/filters'],
    ['DELETE', '/api/v1/mail/filters/name'],
    ['GET', '/api/v1/mail/filters'],
    ['POST', '/api/v1/mail/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV/tags'],
    ['DELETE', '/api/v1/mail/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV/tags'],
    ['POST', '/api/v1/mail/drafts'],
    ['PUT', '/api/v1/mail/drafts/abc'],
    ['DELETE', '/api/v1/mail/drafts/abc'],
    ['GET', '/api/v1/mail/drafts'],
    ['POST', '/api/v1/mail/rooms'],
    ['GET', '/api/v1/mail/rooms'],
    ['GET', '/api/v1/mail/tags'],
    ['POST', '/api/v1/mail/quarantine/01ARZ3NDEKTSV4RRFFQ69G5FAV/release'],
    ['POST', '/api/v1/mail/reply/01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['POST', '/api/v1/mail/forward/01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['GET', '/api/v1/mail/send'],
    ['POST', '/api/v1/mail/messages'],
  ])('denies temporary mutation or alternate route %s %s', async (method, path) => {
    const response = await handleApi(
      new Request(`https://api.lenscli.com${path}`, { method, headers: { Authorization: 'Bearer lm_test' }, body: method === 'GET' ? undefined : '{}' }),
      tempAuthEnv(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
  });
});
