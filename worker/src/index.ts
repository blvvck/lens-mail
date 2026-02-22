import type { Env, InboundMessage, OutboundMessage } from './types';
import { handleApi } from './api/router';
import { handleInboundEmail } from './email/inbound';
import { processInboundQueue } from './queue/inbound';
import { processOutboundQueue } from './queue/outbound';
import { handleCron } from './cron/cleanup';

export default {
  /** HTTP API — all REST endpoints */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const response = await handleApi(request, env, ctx);

    // Add CORS headers to all responses
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },

  /** Inbound email handler — Cloudflare Email Routing */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleInboundEmail(message, env, ctx);
  },

  /** Queue consumer — processes inbound parsing and outbound sending */
  async queue(batch: MessageBatch<InboundMessage | OutboundMessage>, env: Env): Promise<void> {
    if (batch.queue === 'lens-mail-inbound') {
      await processInboundQueue(batch as MessageBatch<InboundMessage>, env);
    } else if (batch.queue === 'lens-mail-outbound') {
      await processOutboundQueue(batch as MessageBatch<OutboundMessage>, env);
    }
  },

  /** Cron trigger — hourly cleanup, monitoring */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleCron(env, ctx);
  },
};
