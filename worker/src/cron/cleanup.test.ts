import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupExpiredTemporaryMailboxes } from './cleanup';

describe('temporary mailbox cleanup', () => {
  afterEach(() => vi.restoreAllMocks());
  it('revokes data and storage while preserving the expired mailbox tombstone', async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind() {
            return {
              all: async () => sql.includes('SELECT id FROM mailboxes')
                ? { results: [{ id: 'mbx' }] }
                : { results: [] },
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      },
      batch: async (queries: Array<{ sql?: string }>) => {
        for (const query of queries) if (query.sql) statements.push(query.sql);
      },
    };
    const listed: string[] = [];
    const deleted: string[] = [];
    const bucket = {
      list: async (options: { prefix: string; cursor?: string }) => {
        listed.push(options.cursor || 'first');
        if (!options.cursor) return { objects: [{ key: 'mail/mbx/message/raw.eml' }], truncated: true, cursor: 'next' };
        return { objects: [{ key: 'mail/mbx/draft/body.txt' }], truncated: false, cursor: undefined };
      },
      delete: async (key: string) => { deleted.push(key); },
    };

    await cleanupExpiredTemporaryMailboxes({ DB: db, MAIL_BUCKET: bucket } as never);

    expect(statements.some((sql) => sql.includes("SET status = 'expired'"))).toBe(true);
    expect(statements.some((sql) => sql.includes('DELETE FROM api_keys'))).toBe(true);
    expect(statements.some((sql) => sql.includes('DELETE FROM mailboxes'))).toBe(false);
    expect(listed).toEqual(['first', 'next']);
    expect(deleted).toEqual(['mail/mbx/message/raw.eml', 'mail/mbx/draft/body.txt']);
  });

  it('leaves a failed purge eligible for retry and completes it later', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail = true;
    let statusUpdates = 0;
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              all: async () => sql.includes('SELECT id FROM mailboxes') ? { results: [{ id: 'mbx' }] } : { results: [] },
              run: async () => {
                if (sql.includes("SET status = 'expired'")) statusUpdates++;
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
      batch: async () => undefined,
    };
    const bucket = {
      list: async () => {
        if (fail) { fail = false; throw new Error('R2 unavailable'); }
        return { objects: [], truncated: false, cursor: undefined };
      },
      delete: async () => undefined,
    };

    await cleanupExpiredTemporaryMailboxes({ DB: db, MAIL_BUCKET: bucket } as never);
    expect(statusUpdates).toBe(0);
    await cleanupExpiredTemporaryMailboxes({ DB: db, MAIL_BUCKET: bucket } as never);
    expect(statusUpdates).toBe(1);
  });
});
