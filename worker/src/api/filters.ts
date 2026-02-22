import type { Env, AuthContext } from '../types';
import { ok, notFound, validationError } from '../lib/response';
import { ulid } from '../lib/ulid';

/** Shape of filter rules stored as JSON */
interface FilterRules {
  from?: string;
  subject?: string;
  has_attachment?: boolean;
}

/** Filter row from D1 */
interface FilterRow {
  id: string;
  mailbox_id: string;
  name: string;
  rules: string; // JSON string of FilterRules
  created_at: string;
}

/** POST /api/v1/mail/filters — Create a filter */
async function handleCreateFilter(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const body = await request.json<{ name?: string; rules?: FilterRules }>();

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return validationError('name is required and must be a non-empty string');
  }
  if (!body.rules || typeof body.rules !== 'object') {
    return validationError('rules is required and must be an object');
  }

  // Validate at least one rule is provided
  const { from, subject, has_attachment } = body.rules;
  if (!from && !subject && has_attachment === undefined) {
    return validationError('At least one rule is required: from, subject, or has_attachment');
  }

  // Check filter count limit (max 50 per mailbox)
  const filterCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM filters WHERE mailbox_id = ?'
  ).bind(auth.mailboxId).first<{ count: number }>();
  if ((filterCount?.count || 0) >= 50) {
    return validationError('Maximum 50 filters per mailbox');
  }

  const id = ulid();
  const name = body.name.trim().toLowerCase();
  // Sanitize rules: only pick recognized fields, limit lengths
  const sanitizedRules: FilterRules = {};
  if (typeof from === 'string') sanitizedRules.from = from.slice(0, 200);
  if (typeof subject === 'string') sanitizedRules.subject = subject.slice(0, 200);
  if (has_attachment !== undefined) sanitizedRules.has_attachment = has_attachment;
  const rulesJson = JSON.stringify(sanitizedRules);

  try {
    await env.DB.prepare(
      'INSERT INTO filters (id, mailbox_id, name, rules) VALUES (?, ?, ?, ?)'
    ).bind(id, auth.mailboxId, name, rulesJson).run();
  } catch (e: unknown) {
    // UNIQUE constraint on (mailbox_id, name)
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      return validationError('A filter with this name already exists');
    }
    throw e;
  }

  return ok({
    id,
    name,
    rules: body.rules,
    created_at: new Date().toISOString(),
  }, 201);
}

/** GET /api/v1/mail/filters — List all filters */
async function handleListFilters(
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT id, name, rules, created_at FROM filters WHERE mailbox_id = ? ORDER BY created_at DESC'
  ).bind(auth.mailboxId).all<FilterRow>();

  const filters = (results || []).map((f) => ({
    id: f.id,
    name: f.name,
    rules: JSON.parse(f.rules) as FilterRules,
    created_at: f.created_at,
  }));

  return ok({ filters });
}

/** DELETE /api/v1/mail/filters/:name — Delete a filter by name */
async function handleDeleteFilter(
  name: string,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const result = await env.DB.prepare(
    'DELETE FROM filters WHERE mailbox_id = ? AND name = ?'
  ).bind(auth.mailboxId, name).run();

  if (!result.meta.changes || result.meta.changes === 0) {
    return notFound(`Filter "${name}" not found`);
  }

  return ok({ deleted: name });
}

/** Route handler for /api/v1/mail/filters */
export async function handleFilterRoutes(
  path: string,
  method: string,
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  // POST /api/v1/mail/filters — create
  if (path === '/api/v1/mail/filters' && method === 'POST') {
    return handleCreateFilter(request, env, auth);
  }

  // GET /api/v1/mail/filters — list
  if (path === '/api/v1/mail/filters' && method === 'GET') {
    return handleListFilters(env, auth);
  }

  // DELETE /api/v1/mail/filters/:name — delete by name
  if (path.startsWith('/api/v1/mail/filters/') && method === 'DELETE') {
    const name = decodeURIComponent(path.split('/').pop()!);
    return handleDeleteFilter(name, env, auth);
  }

  return notFound('Unknown endpoint');
}

/**
 * Glob match: converts a simple glob pattern (* as wildcard) to a regex.
 * e.g. "*@stripe.com" matches "receipts@stripe.com"
 * e.g. "Receipt*" matches "Receipt for your order"
 */
function globMatch(pattern: string, value: string): boolean {
  // Collapse repeated wildcards to prevent ReDoS
  const normalized = pattern.replace(/\*{2,}/g, '*');
  if (normalized.length > 200) return false; // sanity limit
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`, 'i');
  return regex.test(value);
}

/**
 * Apply all filters for a mailbox to a newly inserted message.
 * For each matching filter, the filter's name is added as a tag.
 */
export async function applyFilters(
  env: Env,
  mailboxId: string,
  message: {
    id: string;
    from_address: string;
    subject: string;
    has_attachment: number;
  }
): Promise<void> {
  const { results } = await env.DB.prepare(
    'SELECT name, rules FROM filters WHERE mailbox_id = ?'
  ).bind(mailboxId).all<{ name: string; rules: string }>();

  if (!results || results.length === 0) return;

  const tagsToInsert: string[] = [];

  for (const filter of results) {
    const rules: FilterRules = JSON.parse(filter.rules);
    let matches = true;

    // All rules must match (AND logic)
    if (rules.from) {
      if (!globMatch(rules.from, message.from_address)) {
        matches = false;
      }
    }
    if (rules.subject && matches) {
      if (!globMatch(rules.subject, message.subject)) {
        matches = false;
      }
    }
    if (rules.has_attachment !== undefined && matches) {
      const msgHasAttachment = message.has_attachment === 1;
      if (rules.has_attachment !== msgHasAttachment) {
        matches = false;
      }
    }

    if (matches) {
      tagsToInsert.push(filter.name);
    }
  }

  if (tagsToInsert.length === 0) return;

  // Batch insert matching filter names as tags
  const stmts = tagsToInsert.map((tag) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO message_tags (message_id, tag) VALUES (?, ?)'
    ).bind(message.id, tag)
  );

  await env.DB.batch(stmts);
}
