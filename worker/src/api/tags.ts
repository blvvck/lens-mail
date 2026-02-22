import type { Env, AuthContext } from '../types';
import { ok, notFound, validationError } from '../lib/response';

/** POST /api/v1/mail/messages/:id/tags — Add tags to a message */
async function handleAddTags(
  messageId: string,
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  // Validate message belongs to this mailbox
  const msg = await env.DB.prepare(
    'SELECT id FROM messages WHERE id = ? AND mailbox_id = ? AND status = ?'
  ).bind(messageId, auth.mailboxId, 'active').first<{ id: string }>();

  if (!msg) return notFound('Message not found');

  const body = await request.json<{ tags?: string[] }>();
  if (!body.tags || !Array.isArray(body.tags) || body.tags.length === 0) {
    return validationError('tags must be a non-empty array of strings');
  }
  if (body.tags.length > 10) {
    return validationError('Maximum 10 tags per request');
  }

  // Validate each tag: non-empty, 1-50 chars
  for (const tag of body.tags) {
    if (typeof tag !== 'string' || tag.trim().length === 0 || tag.trim().length > 50) {
      return validationError('Each tag must be 1-50 characters');
    }
  }

  // Check total tag count on message (max 25)
  const existing = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM message_tags WHERE message_id = ?'
  ).bind(messageId).first<{ count: number }>();
  if ((existing?.count || 0) + body.tags.length > 25) {
    return validationError('Maximum 25 tags per message');
  }

  // Insert tags (ignore duplicates via INSERT OR IGNORE)
  const stmts = body.tags.map((tag) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO message_tags (message_id, tag) VALUES (?, ?)'
    ).bind(messageId, tag.trim().toLowerCase())
  );

  await env.DB.batch(stmts);

  // Return all tags on this message
  const { results } = await env.DB.prepare(
    'SELECT tag FROM message_tags WHERE message_id = ? ORDER BY tag'
  ).bind(messageId).all<{ tag: string }>();

  return ok({ tags: (results || []).map((r) => r.tag) });
}

/** DELETE /api/v1/mail/messages/:id/tags — Remove tags from a message */
async function handleRemoveTags(
  messageId: string,
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  // Validate message belongs to this mailbox
  const msg = await env.DB.prepare(
    'SELECT id FROM messages WHERE id = ? AND mailbox_id = ? AND status = ?'
  ).bind(messageId, auth.mailboxId, 'active').first<{ id: string }>();

  if (!msg) return notFound('Message not found');

  const body = await request.json<{ tags?: string[] }>();
  if (!body.tags || !Array.isArray(body.tags) || body.tags.length === 0) {
    return validationError('tags must be a non-empty array of strings');
  }

  // Delete specified tags
  const stmts = body.tags.map((tag) =>
    env.DB.prepare(
      'DELETE FROM message_tags WHERE message_id = ? AND tag = ?'
    ).bind(messageId, tag.trim().toLowerCase())
  );

  await env.DB.batch(stmts);

  // Return remaining tags
  const { results } = await env.DB.prepare(
    'SELECT tag FROM message_tags WHERE message_id = ? ORDER BY tag'
  ).bind(messageId).all<{ tag: string }>();

  return ok({ tags: (results || []).map((r) => r.tag) });
}

/** GET /api/v1/mail/tags — List all tags for this mailbox with counts */
export async function handleListTags(
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT mt.tag, COUNT(*) as count
     FROM message_tags mt
     JOIN messages m ON m.id = mt.message_id
     WHERE m.mailbox_id = ? AND m.status = ?
     GROUP BY mt.tag
     ORDER BY count DESC`
  ).bind(auth.mailboxId, 'active').all<{ tag: string; count: number }>();

  return ok({ tags: results || [] });
}

/** Route handler for /api/v1/mail/messages/:id/tags */
export async function handleTagRoutes(
  messageId: string,
  method: string,
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  if (method === 'POST') {
    return handleAddTags(messageId, request, env, auth);
  }
  if (method === 'DELETE') {
    return handleRemoveTags(messageId, request, env, auth);
  }
  return notFound('Unknown endpoint');
}
