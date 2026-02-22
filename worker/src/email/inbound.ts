import type { Env, InboundMessage } from '../types';
import { ulid } from '../lib/ulid';
import { isKnownSpamDomain, checkSpfFromHeaders } from '../lib/spam';
import { isBlocked } from '../api/blocklist';

/** Max emails per sender per mailbox per hour before rate limiting kicks in */
const MAX_SENDER_PER_HOUR = 50;

/**
 * Stage 1: Email Worker — minimal work to stay under CPU limits.
 * Stores raw email in R2, enqueues to processing queue.
 *
 * Defense layers at edge:
 * 1. Size limit (25MB)
 * 2. Known spam domain rejection
 * 3. SPF failure rejection
 * 4. Per-sender rate limiting (flood protection)
 * 5. Sender blocklist (agent/human-managed)
 *
 * Heavier analysis (spam score, DKIM/DMARC) happens in the queue consumer.
 */
export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const to = message.to;
  const from = message.from;
  const rawSize = message.rawSize;

  // --- Edge-level spam rejection ---

  // 1. Size limit: reject emails over 25MB
  if (rawSize > 25 * 1024 * 1024) {
    message.setReject('Message too large');
    return;
  }

  // 2. Known spam domain: reject immediately
  const fromDomain = from.split('@')[1]?.toLowerCase();
  if (fromDomain && isKnownSpamDomain(fromDomain)) {
    message.setReject('Rejected');
    return;
  }

  // 3. SPF check: read Authentication-Results header from Cloudflare
  //    Cloudflare Email Routing adds this header before passing to Worker.
  const spfResult = checkSpfFromHeaders(message.headers);
  if (spfResult === 'fail' || spfResult === 'softfail') {
    message.setReject('SPF check failed');
    return;
  }

  // --- Mailbox resolution ---

  const mailbox = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE address = ? AND status = 'active'"
  ).bind(to).first<{ id: string }>();

  if (!mailbox) {
    message.setReject('Unknown recipient');
    return;
  }

  // 4. Per-sender rate limiting: max N emails per sender per hour
  const senderLower = from.toLowerCase();
  const currentHour = new Date().toISOString().slice(0, 13); // "2026-02-22T14"

  const rateRow = await env.DB.prepare(
    `SELECT count FROM sender_rate
     WHERE mailbox_id = ? AND sender = ? AND window = ?`
  ).bind(mailbox.id, senderLower, currentHour).first<{ count: number }>();

  if (rateRow && rateRow.count >= MAX_SENDER_PER_HOUR) {
    message.setReject('Rate limit exceeded');
    return;
  }

  // 5. Sender blocklist: agent or human blocked this sender
  if (await isBlocked(env, mailbox.id, from)) {
    message.setReject('Sender blocked');
    return;
  }

  const messageId = ulid();
  const r2Key = `mail/${mailbox.id}/${messageId}/`;

  // Store raw email in R2
  const rawEmail = await new Response(message.raw).arrayBuffer();
  await env.MAIL_BUCKET.put(`${r2Key}raw.eml`, rawEmail);

  // Enqueue for heavy processing (MIME parse, attachment extract, D1 index)
  const queueMsg: InboundMessage = {
    mailboxId: mailbox.id,
    messageId,
    r2Key,
    receivedAt: new Date().toISOString(),
  };

  await env.INBOUND_QUEUE.send(queueMsg);
}
