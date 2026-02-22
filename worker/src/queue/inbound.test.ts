import { describe, expect, it } from 'vitest';
import { processInboundQueue } from './inbound';

describe('temporary inbound queue lifecycle', () => {
  it('discards queued raw mail after mailbox expiry instead of retrying it', async () => {
    const deleted: string[] = [];
    let rawFetched = false;
    const db = {
      prepare() {
        return {
          bind() {
            return { first: async () => ({ status: 'expired', mailbox_type: 'temporary', expires_at: new Date(Date.now() - 1_000).toISOString() }) };
          },
        };
      },
    };
    const bucket = {
      get: async () => { rawFetched = true; return null; },
      list: async () => ({ objects: [{ key: 'mail/mbx/msg/raw.eml' }], truncated: false, cursor: undefined }),
      delete: async (key: string) => { deleted.push(key); },
    };
    let acked = false;
    let retried = false;
    await processInboundQueue({
      messages: [{
        body: { mailboxId: 'mbx', messageId: 'msg', r2Key: 'mail/mbx/msg/', receivedAt: new Date().toISOString() },
        ack: () => { acked = true; },
        retry: () => { retried = true; },
      }],
      queue: 'lens-mail-inbound',
    } as never, { DB: db, MAIL_BUCKET: bucket } as never);

    expect(rawFetched).toBe(false);
    expect(deleted).toEqual(['mail/mbx/msg/raw.eml']);
    expect(acked).toBe(true);
    expect(retried).toBe(false);
  });

  it('does not retain parsed R2 objects when the conditional mailbox write loses an expiry race', async () => {
    const deleted: string[] = [];
    const putKeys: string[] = [];
    let messageInsertAttempted = false;
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => {
                if (sql.includes('SELECT status')) return { status: 'active', mailbox_type: 'temporary', expires_at: new Date(Date.now() + 60_000).toISOString() };
                if (sql.includes('SELECT COUNT(*)')) return { count: 0, bytes: 0 };
                if (sql.includes('SELECT address, settings')) return { address: 'tmp-a1b2c3d4@lenscli.com', settings: '{}' };
                return null;
              },
              run: async () => {
                if (sql.includes('INSERT INTO messages')) {
                  messageInsertAttempted = true;
                  return { meta: { changes: 0 } };
                }
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    };
    const bucket = {
      get: async () => new Response('From: sender@example.com\nTo: tmp-a1b2c3d4@lenscli.com\nSubject: Code\n\n123456'),
      put: async (key: string) => { putKeys.push(key); },
      list: async () => ({ objects: putKeys.map((key) => ({ key })), truncated: false, cursor: undefined }),
      delete: async (key: string) => { deleted.push(key); },
    };
    let acked = false;
    await processInboundQueue({
      messages: [{
        body: { mailboxId: 'mbx', messageId: 'msg', r2Key: 'mail/mbx/msg/', receivedAt: new Date().toISOString() },
        ack: () => { acked = true; },
        retry: () => { throw new Error('unexpected retry'); },
      }],
      queue: 'lens-mail-inbound',
    } as never, { DB: db, MAIL_BUCKET: bucket } as never);

    expect(messageInsertAttempted).toBe(true);
    expect(acked).toBe(true);
    expect(putKeys.length).toBeGreaterThan(0);
    expect(deleted).toEqual(putKeys);
  });
});
