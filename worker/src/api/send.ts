import type { Env, AuthContext, OutboundMessage } from '../types';
import { ok, validationError, rateLimited } from '../lib/response';
import { ulid } from '../lib/ulid';
import { checkSendRateLimit } from '../lib/rate-limit';

/** POST /api/v1/mail/send — Queue outbound email */
export async function handleSend(
  request: Request,
  env: Env,
  auth: AuthContext,
  ctx: ExecutionContext
): Promise<Response> {
  const body = await request.json<{
    to: string;
    subject?: string;
    body?: string;
    html?: string;
    cc?: string;
    bcc?: string;
    attachments?: Array<{ filename: string; content: string; content_type?: string }>;
  }>().catch(() => null);

  if (!body?.to) return validationError('Missing required field: to');

  // Validate email addresses
  if (!isValidEmailList(body.to)) return validationError('Invalid "to" address');
  if (body.cc && !isValidEmailList(body.cc)) return validationError('Invalid "cc" address');
  if (body.bcc && !isValidEmailList(body.bcc)) return validationError('Invalid "bcc" address');

  // Body size limits (1MB each for text and HTML)
  const MAX_BODY_BYTES = 1024 * 1024;
  if (body.body && body.body.length > MAX_BODY_BYTES) return validationError('Message body exceeds 1MB limit');
  if (body.html && body.html.length > MAX_BODY_BYTES) return validationError('HTML body exceeds 1MB limit');

  // Idempotency check
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (idempotencyKey) {
    const existing = await env.DB.prepare(
      'SELECT id, status FROM outbound_sends WHERE idempotency_key = ?'
    ).bind(idempotencyKey).first<{ id: string; status: string }>();
    if (existing) {
      return ok({ sendId: existing.id, status: existing.status, deduplicated: true }, 200);
    }
  }

  // Rate limit check (hourly + daily)
  const rateLimitResult = await checkSendRateLimit(env, auth.mailboxId);
  if (rateLimitResult > 0) return rateLimited(rateLimitResult);

  const sendId = ulid();
  const r2Key = `mail/${auth.mailboxId}/outbound/${sendId}/`;

  // Store body in R2 — text and HTML separately
  if (body.body) {
    await env.MAIL_BUCKET.put(`${r2Key}body.txt`, body.body);
  }
  if (body.html) {
    await env.MAIL_BUCKET.put(`${r2Key}body.html`, body.html);
  }

  // Store attachments in R2
  if (body.attachments?.length) {
    for (const att of body.attachments) {
      if (!att.filename || !att.content) continue;

      // Validate size (25MB per attachment, base64 overhead ~33%)
      if (att.content.length > 25 * 1024 * 1024 * 1.34) {
        return validationError(`Attachment "${att.filename}" exceeds 25MB limit`);
      }

      const buffer = base64ToArrayBuffer(att.content);
      await env.MAIL_BUCKET.put(
        `${r2Key}attachments/${att.filename}`,
        buffer,
        {
          httpMetadata: {
            contentType: att.content_type || guessMimeType(att.filename),
          },
        }
      );
    }
  }

  // Record in D1
  await env.DB.prepare(
    `INSERT INTO outbound_sends (id, mailbox_id, idempotency_key, to_address, cc_address, bcc_address, subject, status, r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
  ).bind(
    sendId, auth.mailboxId, idempotencyKey,
    body.to, body.cc || null, body.bcc || null,
    body.subject || '', r2Key
  ).run();

  // Enqueue for sending
  const queueMsg: OutboundMessage = {
    sendId,
    mailboxId: auth.mailboxId,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject || '',
    r2Key,
    attempt: 0,
  };

  await env.OUTBOUND_QUEUE.send(queueMsg);

  return ok({ sendId, status: 'queued' }, 202);
}

/** POST /api/v1/mail/reply/:id — Reply to a message */
export async function handleReply(
  messageId: string,
  request: Request,
  env: Env,
  auth: AuthContext,
  ctx: ExecutionContext
): Promise<Response> {
  // Fetch original message
  const original = await env.DB.prepare(
    'SELECT from_address, subject, message_id, r2_key FROM messages WHERE id = ? AND mailbox_id = ?'
  ).bind(messageId, auth.mailboxId).first<{
    from_address: string;
    subject: string;
    message_id: string | null;
    r2_key: string;
  }>();

  if (!original) return validationError('Original message not found');

  const body = await request.json<{
    body?: string;
    html?: string;
    noQuote?: boolean;
    attachments?: Array<{ filename: string; content: string; content_type?: string }>;
  }>().catch(() => ({}));

  const replyBody = (body as { body?: string }).body || '';
  const replyHtml = (body as { html?: string }).html || '';
  const noQuote = (body as { noQuote?: boolean }).noQuote ?? false;

  // Body size limits
  const MAX_BODY_BYTES = 1024 * 1024;
  if (replyBody.length > MAX_BODY_BYTES) return validationError('Reply body exceeds 1MB limit');
  if (replyHtml.length > MAX_BODY_BYTES) return validationError('Reply HTML body exceeds 1MB limit');

  // Build reply subject (no double Re:)
  const subject = original.subject.startsWith('Re: ')
    ? original.subject
    : `Re: ${original.subject}`;

  const sendId = ulid();
  const r2Key = `mail/${auth.mailboxId}/outbound/${sendId}/`;

  // Optionally include quoted original
  let finalBody = replyBody;
  if (!noQuote) {
    const originalBody = await env.MAIL_BUCKET.get(`${original.r2_key}body.txt`);
    const originalText = originalBody ? await originalBody.text() : '';
    if (originalText) {
      const quoted = originalText.split('\n').map((line) => `> ${line}`).join('\n');
      finalBody = `${replyBody}\n\nOn ${new Date().toISOString()}, ${original.from_address} wrote:\n${quoted}`;
    }
  }

  await env.MAIL_BUCKET.put(`${r2Key}body.txt`, finalBody);
  if (replyHtml) {
    await env.MAIL_BUCKET.put(`${r2Key}body.html`, replyHtml);
  }

  // Store attachments
  const attachments = (body as { attachments?: Array<{ filename: string; content: string; content_type?: string }> }).attachments;
  if (attachments?.length) {
    for (const att of attachments) {
      if (!att.filename || !att.content) continue;
      const buffer = base64ToArrayBuffer(att.content);
      await env.MAIL_BUCKET.put(
        `${r2Key}attachments/${att.filename}`,
        buffer,
        { httpMetadata: { contentType: att.content_type || guessMimeType(att.filename) } }
      );
    }
  }

  // Store with threading headers
  await env.DB.prepare(
    `INSERT INTO outbound_sends (id, mailbox_id, to_address, subject, status, r2_key, in_reply_to, references_header)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`
  ).bind(
    sendId, auth.mailboxId, original.from_address, subject, r2Key,
    original.message_id || null,
    original.message_id || null, // References = In-Reply-To for single-depth thread
  ).run();

  const queueMsg: OutboundMessage = {
    sendId,
    mailboxId: auth.mailboxId,
    to: original.from_address,
    subject,
    r2Key,
    attempt: 0,
  };

  await env.OUTBOUND_QUEUE.send(queueMsg);
  return ok({ sendId, status: 'queued' }, 202);
}

/** POST /api/v1/mail/forward/:id — Forward a message */
export async function handleForward(
  messageId: string,
  request: Request,
  env: Env,
  auth: AuthContext,
  ctx: ExecutionContext
): Promise<Response> {
  const original = await env.DB.prepare(
    'SELECT r2_key, subject FROM messages WHERE id = ? AND mailbox_id = ?'
  ).bind(messageId, auth.mailboxId).first<{ r2_key: string; subject: string }>();

  if (!original) return validationError('Message not found');

  const body = await request.json<{ to: string; comment?: string; noAttachments?: boolean }>().catch(() => null);
  if (!body?.to) return validationError('Missing required field: to');
  if (!isValidEmailList(body.to)) return validationError('Invalid "to" address');

  // Prevent self-forwarding loops
  if (body.to === auth.address) {
    return validationError('Cannot forward to yourself');
  }

  // Forward rate limit: 20/hour per agent
  const forwardLimitResult = await checkForwardRateLimit(env, auth.mailboxId);
  if (forwardLimitResult > 0) return rateLimited(forwardLimitResult);

  const sendId = ulid();
  const r2Key = `mail/${auth.mailboxId}/outbound/${sendId}/`;

  // Copy original body + prepend comment
  const originalBodyObj = await env.MAIL_BUCKET.get(`${original.r2_key}body.txt`);
  const originalText = originalBodyObj ? await originalBodyObj.text() : '';
  const forwardText = body.comment
    ? `${body.comment}\n\n--- Forwarded ---\n${originalText}`
    : `--- Forwarded ---\n${originalText}`;

  await env.MAIL_BUCKET.put(`${r2Key}body.txt`, forwardText);

  // Copy HTML body if exists
  const originalHtmlObj = await env.MAIL_BUCKET.get(`${original.r2_key}body.html`);
  if (originalHtmlObj) {
    const originalHtml = await originalHtmlObj.text();
    const forwardHtml = body.comment
      ? `<p>${escapeHtml(body.comment)}</p><hr><p><em>Forwarded message:</em></p>${originalHtml}`
      : `<p><em>Forwarded message:</em></p><hr>${originalHtml}`;
    await env.MAIL_BUCKET.put(`${r2Key}body.html`, forwardHtml);
  }

  // Copy original attachments (unless opted out)
  if (!body.noAttachments) {
    const attachmentListing = await env.MAIL_BUCKET.list({
      prefix: `${original.r2_key}attachments/`,
    });
    for (const obj of attachmentListing.objects) {
      const file = await env.MAIL_BUCKET.get(obj.key);
      if (!file) continue;
      const filename = obj.key.split('/').pop() || 'attachment';
      await env.MAIL_BUCKET.put(
        `${r2Key}attachments/${filename}`,
        await file.arrayBuffer(),
        { httpMetadata: file.httpMetadata }
      );
    }
  }

  const subject = `Fwd: ${original.subject}`;

  await env.DB.prepare(
    `INSERT INTO outbound_sends (id, mailbox_id, to_address, subject, status, r2_key)
     VALUES (?, ?, ?, ?, 'queued', ?)`
  ).bind(sendId, auth.mailboxId, body.to, subject, r2Key).run();

  const queueMsg: OutboundMessage = {
    sendId,
    mailboxId: auth.mailboxId,
    to: body.to,
    subject,
    r2Key,
    attempt: 0,
  };

  await env.OUTBOUND_QUEUE.send(queueMsg);
  return ok({ sendId, status: 'queued' }, 202);
}

// --- Helpers ---

/** Basic email format validation */
function isValidEmailList(emails: string): boolean {
  return emails.split(',').every((email) => {
    const trimmed = email.trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  });
}

/** Base64 string to ArrayBuffer */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Guess MIME type from filename extension */
function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    pdf: 'application/pdf',
    csv: 'text/csv',
    json: 'application/json',
    txt: 'text/plain',
    html: 'text/html',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return mimeMap[ext || ''] || 'application/octet-stream';
}

/** Escape HTML special characters */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Check forward rate limit: 20/hour per agent */
async function checkForwardRateLimit(env: Env, mailboxId: string): Promise<number> {
  const key = `forward:${mailboxId}:hourly`;
  const now = new Date();
  const row = await env.DB.prepare(
    'SELECT count, expires_at FROM rate_limits WHERE key = ?'
  ).bind(key).first<{ count: number; expires_at: string }>();

  if (!row || new Date(row.expires_at) < now) {
    const expiresAt = new Date(now.getTime() + 3600 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO rate_limits (key, count, window_start, expires_at)
       VALUES (?, 1, ?, ?)`
    ).bind(key, now.toISOString(), expiresAt).run();
    return 0;
  }

  if (row.count >= 20) {
    return Math.ceil((new Date(row.expires_at).getTime() - now.getTime()) / 1000);
  }

  await env.DB.prepare(
    'UPDATE rate_limits SET count = count + 1 WHERE key = ?'
  ).bind(key).run();
  return 0;
}
