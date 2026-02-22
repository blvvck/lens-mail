import type { Env, AuthContext, OutboundMessage } from '../types';
import { ok, notFound, validationError } from '../lib/response';
import { ulid } from '../lib/ulid';

/** Route all /api/v1/mail/drafts/* requests */
export async function handleDraftRoutes(
  path: string,
  method: string,
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  // POST /api/v1/mail/drafts — Create draft
  if (path === '/api/v1/mail/drafts' && method === 'POST') {
    return createDraft(request, env, auth);
  }

  // GET /api/v1/mail/drafts — List drafts
  if (path === '/api/v1/mail/drafts' && method === 'GET') {
    return listDrafts(request, env, auth);
  }

  // Draft-specific routes: /api/v1/mail/drafts/:id/...
  const draftMatch = path.match(/^\/api\/v1\/mail\/drafts\/([A-Z0-9]+)(\/.*)?$/);
  if (!draftMatch) return notFound();

  const draftId = draftMatch[1];
  const subpath = draftMatch[2] || '';

  // POST /api/v1/mail/drafts/:id/send — Send draft
  if (subpath === '/send' && method === 'POST') {
    return sendDraft(draftId, env, auth);
  }

  // GET /api/v1/mail/drafts/:id — Get draft
  if (subpath === '' && method === 'GET') {
    return getDraft(draftId, env, auth);
  }

  // PUT /api/v1/mail/drafts/:id — Update draft
  if (subpath === '' && method === 'PUT') {
    return updateDraft(draftId, request, env, auth);
  }

  // DELETE /api/v1/mail/drafts/:id — Delete draft
  if (subpath === '' && method === 'DELETE') {
    return deleteDraft(draftId, env, auth);
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// D1 row shape
// ---------------------------------------------------------------------------

interface DraftRow {
  id: string;
  mailbox_id: string;
  to_address: string | null;
  subject: string;
  r2_key: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** POST /api/v1/mail/drafts — Save a new draft */
async function createDraft(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const body = await request.json<{
    to?: string;
    subject?: string;
    body?: string;
    html?: string;
  }>().catch(() => null);

  if (!body) return validationError('Invalid JSON body');

  // Draft count limit (max 100 per mailbox)
  const draftCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM drafts WHERE mailbox_id = ?'
  ).bind(auth.mailboxId).first<{ count: number }>();
  if ((draftCount?.count || 0) >= 100) {
    return validationError('Maximum 100 drafts per mailbox');
  }

  // Body size limits (1MB)
  const MAX_DRAFT_BODY = 1024 * 1024;
  if (body.body && body.body.length > MAX_DRAFT_BODY) return validationError('Draft body exceeds 1MB limit');
  if (body.html && body.html.length > MAX_DRAFT_BODY) return validationError('Draft HTML body exceeds 1MB limit');

  const id = ulid();
  const r2Key = `mail/${auth.mailboxId}/drafts/${id}/`;

  // Store body content in R2
  if (body.body) {
    await env.MAIL_BUCKET.put(`${r2Key}body.txt`, body.body);
  }
  if (body.html) {
    await env.MAIL_BUCKET.put(`${r2Key}body.html`, body.html);
  }

  await env.DB.prepare(
    `INSERT INTO drafts (id, mailbox_id, to_address, subject, r2_key)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    id,
    auth.mailboxId,
    body.to || null,
    body.subject || '',
    r2Key
  ).run();

  return ok({
    id,
    to: body.to || null,
    subject: body.subject || '',
    created_at: new Date().toISOString(),
  }, 201);
}

/** GET /api/v1/mail/drafts — List drafts */
async function listDrafts(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const [{ results }, totalRow] = await Promise.all([
    env.DB.prepare(
      'SELECT id, to_address, subject, updated_at FROM drafts WHERE mailbox_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?'
    ).bind(auth.mailboxId, limit, offset).all<Pick<DraftRow, 'id' | 'to_address' | 'subject' | 'updated_at'>>(),
    env.DB.prepare(
      'SELECT COUNT(*) as total FROM drafts WHERE mailbox_id = ?'
    ).bind(auth.mailboxId).first<{ total: number }>(),
  ]);

  return ok({
    count: totalRow?.total || 0,
    drafts: (results || []).map((d) => ({
      id: d.id,
      to: d.to_address,
      subject: d.subject,
      updated_at: d.updated_at,
    })),
  });
}

/** GET /api/v1/mail/drafts/:id — Get full draft with body */
async function getDraft(
  id: string,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const draft = await env.DB.prepare(
    'SELECT * FROM drafts WHERE id = ? AND mailbox_id = ?'
  ).bind(id, auth.mailboxId).first<DraftRow>();

  if (!draft) return notFound('Draft not found');

  let bodyText = '';
  let bodyHtml = '';

  if (draft.r2_key) {
    const [textObj, htmlObj] = await Promise.all([
      env.MAIL_BUCKET.get(`${draft.r2_key}body.txt`),
      env.MAIL_BUCKET.get(`${draft.r2_key}body.html`),
    ]);
    bodyText = textObj ? await textObj.text() : '';
    bodyHtml = htmlObj ? await htmlObj.text() : '';
  }

  return ok({
    id: draft.id,
    to: draft.to_address,
    subject: draft.subject,
    body: bodyText,
    html: bodyHtml,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
  });
}

/** PUT /api/v1/mail/drafts/:id — Update draft */
async function updateDraft(
  id: string,
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const draft = await env.DB.prepare(
    'SELECT * FROM drafts WHERE id = ? AND mailbox_id = ?'
  ).bind(id, auth.mailboxId).first<DraftRow>();

  if (!draft) return notFound('Draft not found');

  const body = await request.json<{
    to?: string;
    subject?: string;
    body?: string;
    html?: string;
  }>().catch(() => null);

  if (!body) return validationError('Invalid JSON body');

  // Body size limits (1MB)
  const MAX_DRAFT_BODY = 1024 * 1024;
  if (body.body && body.body.length > MAX_DRAFT_BODY) return validationError('Draft body exceeds 1MB limit');
  if (body.html && body.html.length > MAX_DRAFT_BODY) return validationError('Draft HTML body exceeds 1MB limit');

  const r2Key = draft.r2_key || `mail/${auth.mailboxId}/drafts/${id}/`;

  // Update R2 body content
  if (body.body !== undefined) {
    if (body.body) {
      await env.MAIL_BUCKET.put(`${r2Key}body.txt`, body.body);
    } else {
      await env.MAIL_BUCKET.delete(`${r2Key}body.txt`);
    }
  }
  if (body.html !== undefined) {
    if (body.html) {
      await env.MAIL_BUCKET.put(`${r2Key}body.html`, body.html);
    } else {
      await env.MAIL_BUCKET.delete(`${r2Key}body.html`);
    }
  }

  // Update D1 row
  await env.DB.prepare(
    `UPDATE drafts
     SET to_address = ?, subject = ?, r2_key = ?, updated_at = datetime('now')
     WHERE id = ? AND mailbox_id = ?`
  ).bind(
    body.to !== undefined ? (body.to || null) : draft.to_address,
    body.subject !== undefined ? (body.subject || '') : draft.subject,
    r2Key,
    id,
    auth.mailboxId
  ).run();

  return ok({ id, updated: true });
}

/** DELETE /api/v1/mail/drafts/:id — Delete draft + R2 cleanup */
async function deleteDraft(
  id: string,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const draft = await env.DB.prepare(
    'SELECT r2_key FROM drafts WHERE id = ? AND mailbox_id = ?'
  ).bind(id, auth.mailboxId).first<{ r2_key: string | null }>();

  if (!draft) return notFound('Draft not found');

  // Clean up R2 objects
  if (draft.r2_key) {
    const objects = await env.MAIL_BUCKET.list({ prefix: draft.r2_key });
    for (const obj of objects.objects) {
      await env.MAIL_BUCKET.delete(obj.key);
    }
  }

  // Delete D1 row (scoped by mailbox_id for defense-in-depth)
  await env.DB.prepare('DELETE FROM drafts WHERE id = ? AND mailbox_id = ?').bind(id, auth.mailboxId).run();

  return ok({ deleted: id });
}

/** POST /api/v1/mail/drafts/:id/send — Convert draft to outbound send */
async function sendDraft(
  id: string,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  // 1. Atomically claim the draft to prevent double-send (TOCTOU)
  const claimed = await env.DB.prepare(
    'DELETE FROM drafts WHERE id = ? AND mailbox_id = ? RETURNING *'
  ).bind(id, auth.mailboxId).first<DraftRow>();

  if (!claimed) return notFound('Draft not found or already sent');

  // 2. Validate it has to_address
  if (!claimed.to_address) {
    // Re-insert the draft since we deleted it
    await env.DB.prepare(
      'INSERT INTO drafts (id, mailbox_id, to_address, subject, r2_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(claimed.id, claimed.mailbox_id, claimed.to_address, claimed.subject, claimed.r2_key, claimed.created_at, claimed.updated_at).run();
    return validationError('Draft must have a "to" address before sending');
  }

  const draft = claimed;

  const sendId = ulid();
  const outboundR2Key = `mail/${auth.mailboxId}/outbound/${sendId}/`;

  // 3. Copy R2 body from drafts path to outbound path
  if (draft.r2_key) {
    const [textObj, htmlObj] = await Promise.all([
      env.MAIL_BUCKET.get(`${draft.r2_key}body.txt`),
      env.MAIL_BUCKET.get(`${draft.r2_key}body.html`),
    ]);

    if (textObj) {
      await env.MAIL_BUCKET.put(`${outboundR2Key}body.txt`, await textObj.text());
    }
    if (htmlObj) {
      await env.MAIL_BUCKET.put(`${outboundR2Key}body.html`, await htmlObj.text());
    }
  }

  // 4. Insert into outbound_sends
  await env.DB.prepare(
    `INSERT INTO outbound_sends (id, mailbox_id, to_address, subject, status, r2_key)
     VALUES (?, ?, ?, ?, 'queued', ?)`
  ).bind(sendId, auth.mailboxId, draft.to_address, draft.subject || '', outboundR2Key).run();

  // 5. Enqueue to OUTBOUND_QUEUE
  const queueMsg: OutboundMessage = {
    sendId,
    mailboxId: auth.mailboxId,
    to: draft.to_address as string, // validated non-null above
    subject: draft.subject || '',
    r2Key: outboundR2Key,
    attempt: 0,
  };

  await env.OUTBOUND_QUEUE.send(queueMsg);

  // 6. Clean up draft R2 objects (D1 row already deleted in step 1)
  if (draft.r2_key) {
    const objects = await env.MAIL_BUCKET.list({ prefix: draft.r2_key });
    for (const obj of objects.objects) {
      await env.MAIL_BUCKET.delete(obj.key);
    }
  }

  return ok({ sendId, status: 'queued' }, 202);
}
