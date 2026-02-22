import { describe, expect, it } from 'vitest';
import { authenticate, hashKey } from './auth';

function envFor(expiresAt: string | null) {
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => sql.includes('SELECT ak.id')
              ? { key_id: 'key-1', mailbox_id: 'mailbox-1', address: 'tmp-a1b2c3d4@lenscli.com', mailbox_type: 'temporary', expires_at: expiresAt }
              : null,
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      };
    },
  };
  return { DB: db, ADMIN_KEY: '' } as never;
}

describe('mailbox authentication expiry', () => {
  it('rejects a temporary key after expiry', async () => {
    const response = await authenticate(
      new Request('https://api.lenscli.com/api/v1/mail/messages', { headers: { Authorization: 'Bearer lm_test' } }),
      envFor(new Date(Date.now() - 1_000).toISOString()),
    );
    expect(response).toBeNull();
  });

  it('carries temporary metadata for an active key', async () => {
    const response = await authenticate(
      new Request('https://api.lenscli.com/api/v1/mail/messages', { headers: { Authorization: 'Bearer lm_test' } }),
      envFor(new Date(Date.now() + 60_000).toISOString()),
    );
    expect(response).toMatchObject({ mailboxType: 'temporary', expiresAt: expect.any(String) });
  });
});
