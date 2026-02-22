import { afterEach, describe, expect, it, vi } from 'vitest';
import { processOutboundQueue } from './outbound';
import type { Env, OutboundMessage } from '../types';

function makeEnv(displayName: string | null, fetchMock: ReturnType<typeof vi.fn>): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => {
              if (sql.includes('SELECT address, display_name')) {
                return { address: 'checkout-agent@lenscli.com', display_name: displayName };
              }
              return null;
            },
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      };
    },
  };
  const bucket = {
    get: async (key: string) => key.endsWith('body.txt') ? new Response('hello') : null,
    list: async () => ({ objects: [] }),
  };
  vi.stubGlobal('fetch', fetchMock);
  return {
    DB: db,
    MAIL_BUCKET: bucket,
    ZEPTOMAIL_TOKEN: 'test-token',
  } as unknown as Env;
}

async function sendOne(env: Env) {
  const ack = vi.fn();
  const retry = vi.fn();
  const body: OutboundMessage = {
    sendId: 'send-1',
    mailboxId: 'mailbox-1',
    to: 'recipient@example.com',
    subject: 'Test',
    r2Key: 'mail/mailbox-1/outbound/send-1/',
    attempt: 0,
  };
  await processOutboundQueue({ messages: [{ body, ack, retry }] } as never, env);
  expect(ack).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
}

describe('outbound provider sender payload', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the display name separately while preserving the mailbox address', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await sendOne(makeEnv('Checkout Agent', fetchMock));

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.from).toEqual({ address: 'checkout-agent@lenscli.com', name: 'Checkout Agent' });
  });

  it('sends only the mailbox address when no display name is stored', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await sendOne(makeEnv(null, fetchMock));

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.from).toEqual({ address: 'checkout-agent@lenscli.com' });
  });
});
