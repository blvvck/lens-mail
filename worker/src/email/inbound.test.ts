import { describe, expect, it } from 'vitest';
import { handleInboundEmail } from './inbound';

describe('temporary inbound mailbox expiry', () => {
  it('rejects mail addressed to an expired temporary mailbox at the edge', async () => {
    let rejection = '';
    let stored = false;
    const db = {
      prepare() {
        return {
          bind() {
            return { first: async () => null };
          },
        };
      },
    };
    const bucket = { put: async () => { stored = true; } };
    const message = {
      to: 'tmp-a1b2c3d4@lenscli.com',
      from: 'sender@example.com',
      rawSize: 10,
      headers: new Headers(),
      raw: new ReadableStream<Uint8Array>(),
      setReject: (reason: string) => { rejection = reason; },
    };

    await handleInboundEmail(message as never, { DB: db, MAIL_BUCKET: bucket } as never, {} as ExecutionContext);

    expect(rejection).toBe('Unknown recipient');
    expect(stored).toBe(false);
  });
});
