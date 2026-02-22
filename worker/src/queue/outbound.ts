import type { Env, OutboundMessage } from '../types';

/**
 * Outbound Queue Consumer — sends email via ZeptoMail.
 * 3 retries with exponential backoff (1s, 4s, 16s).
 * Dead letter state on final failure.
 *
 * Supports: plaintext, HTML, CC/BCC, attachments.
 */
export async function processOutboundQueue(
  batch: MessageBatch<OutboundMessage>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await sendViaZeptoMail(msg.body, env);
      msg.ack();
    } catch (err) {
      const attempt = msg.body.attempt;
      if (attempt >= 2) {
        // Final failure — dead letter
        await env.DB.prepare(
          `UPDATE outbound_sends SET status = 'failed', error_reason = ?, last_attempt_at = datetime('now'), attempts = ?
           WHERE id = ?`
        ).bind(String(err), attempt + 1, msg.body.sendId).run();
        msg.ack(); // Don't retry
      } else {
        // Retry with incremented attempt
        msg.retry({ delaySeconds: Math.pow(4, attempt) }); // 1s, 4s, 16s
      }
    }
  }
}

/** ZeptoMail recipient shape */
interface ZeptoRecipient {
  email_address: { address: string; name?: string };
}

/** ZeptoMail attachment shape */
interface ZeptoAttachment {
  content: string; // base64-encoded
  mime_type: string;
  name: string;
}

async function sendViaZeptoMail(msg: OutboundMessage, env: Env): Promise<void> {
  // Update status to sending
  await env.DB.prepare(
    `UPDATE outbound_sends SET status = 'sending', attempts = ?, last_attempt_at = datetime('now')
     WHERE id = ?`
  ).bind(msg.attempt + 1, msg.sendId).run();

  // Fetch body text from R2
  const bodyTextObj = await env.MAIL_BUCKET.get(`${msg.r2Key}body.txt`);
  const bodyText = bodyTextObj ? await bodyTextObj.text() : '';

  // Fetch HTML body from R2 (if exists)
  const bodyHtmlObj = await env.MAIL_BUCKET.get(`${msg.r2Key}body.html`);
  const bodyHtml = bodyHtmlObj ? await bodyHtmlObj.text() : '';

  // Get sender address
  const mailbox = await env.DB.prepare(
    'SELECT address, display_name FROM mailboxes WHERE id = ?'
  ).bind(msg.mailboxId).first<{ address: string; display_name: string | null }>();

  if (!mailbox) throw new Error(`Mailbox ${msg.mailboxId} not found`);

  // Build recipient lists
  const toRecipients: ZeptoRecipient[] = msg.to
    .split(',')
    .map((addr) => addr.trim())
    .filter(Boolean)
    .map((addr) => ({ email_address: { address: addr } }));

  const ccRecipients: ZeptoRecipient[] = msg.cc
    ? msg.cc.split(',').map((addr) => addr.trim()).filter(Boolean)
        .map((addr) => ({ email_address: { address: addr } }))
    : [];

  const bccRecipients: ZeptoRecipient[] = msg.bcc
    ? msg.bcc.split(',').map((addr) => addr.trim()).filter(Boolean)
        .map((addr) => ({ email_address: { address: addr } }))
    : [];

  // Fetch attachments from R2
  const attachments = await loadAttachments(msg.r2Key, env);

  // Build ZeptoMail payload
  const payload: Record<string, unknown> = {
    from: {
      address: mailbox.address,
      ...(mailbox.display_name ? { name: mailbox.display_name } : {}),
    },
    to: toRecipients,
    subject: msg.subject,
  };

  // Add CC/BCC if present
  if (ccRecipients.length > 0) {
    payload.cc = ccRecipients;
  }
  if (bccRecipients.length > 0) {
    payload.bcc = bccRecipients;
  }

  // Add body — prefer HTML if available, always include text for fallback
  if (bodyHtml) {
    payload.htmlbody = bodyHtml;
  }
  if (bodyText) {
    payload.textbody = bodyText;
  }

  // Add attachments if present
  if (attachments.length > 0) {
    payload.attachments = attachments;
  }

  // Add reply-to threading headers if this is a reply
  const sendRecord = await env.DB.prepare(
    'SELECT in_reply_to, references_header FROM outbound_sends WHERE id = ?'
  ).bind(msg.sendId).first<{ in_reply_to: string | null; references_header: string | null }>();

  if (sendRecord?.in_reply_to) {
    payload.reply_to = [{ email_address: { address: mailbox.address } }];
    // ZeptoMail supports custom headers for threading
    payload.custom_headers = [
      { name: 'In-Reply-To', value: sendRecord.in_reply_to },
      ...(sendRecord.references_header
        ? [{ name: 'References', value: sendRecord.references_header }]
        : []),
    ];
  }

  // Send via ZeptoMail API
  const response = await fetch('https://api.zeptomail.eu/v1.1/email', {
    method: 'POST',
    headers: {
      'Authorization': `Zoho-enczapikey ${env.ZEPTOMAIL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`ZeptoMail error ${response.status}: ${errorBody}`);
  }

  // Mark as sent
  await env.DB.prepare(
    `UPDATE outbound_sends SET status = 'sent', last_attempt_at = datetime('now'), attempts = ?
     WHERE id = ?`
  ).bind(msg.attempt + 1, msg.sendId).run();
}

/**
 * Load attachments from R2 for a given outbound message.
 * Attachments are stored at {r2Key}attachments/{filename}.
 * Returns ZeptoMail-compatible attachment objects (base64 encoded).
 */
async function loadAttachments(r2Key: string, env: Env): Promise<ZeptoAttachment[]> {
  const attachmentPrefix = `${r2Key}attachments/`;
  const listing = await env.MAIL_BUCKET.list({ prefix: attachmentPrefix });

  if (!listing.objects.length) return [];

  const attachments: ZeptoAttachment[] = [];
  for (const obj of listing.objects) {
    const file = await env.MAIL_BUCKET.get(obj.key);
    if (!file) continue;

    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const filename = obj.key.split('/').pop() || 'attachment';
    const mimeType = file.httpMetadata?.contentType || 'application/octet-stream';

    attachments.push({
      content: base64,
      mime_type: mimeType,
      name: filename,
    });
  }

  return attachments;
}

/** Convert ArrayBuffer to base64 string (Workers-compatible) */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
