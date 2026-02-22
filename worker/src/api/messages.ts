import type { Env, AuthContext, MessageMeta } from '../types';
import { ok, notFound, validationError } from '../lib/response';

/** GET /api/v1/mail/messages — List messages with filters */
export async function handleGetMessages(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const url = new URL(request.url);
  const unread = url.searchParams.get('unread');
  const from = url.searchParams.get('from');
  const since = url.searchParams.get('since');
  const filter = url.searchParams.get('filter');
  const tag = url.searchParams.get('tag');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  let query = 'SELECT m.* FROM messages m';
  let countQuery = 'SELECT COUNT(*) as total FROM messages m';
  const params: unknown[] = [];
  const countParams: unknown[] = [];

  if (tag) {
    query += ' JOIN message_tags mt ON mt.message_id = m.id AND mt.tag = ?';
    countQuery += ' JOIN message_tags mt ON mt.message_id = m.id AND mt.tag = ?';
    params.push(tag);
    countParams.push(tag);
  }

  query += ' WHERE m.mailbox_id = ? AND m.status = ?';
  countQuery += ' WHERE m.mailbox_id = ? AND m.status = ?';
  params.push(auth.mailboxId, 'active');
  countParams.push(auth.mailboxId, 'active');

  if (unread === 'true') {
    query += ' AND m.read = 0';
    countQuery += ' AND m.read = 0';
  }
  if (from) {
    query += ' AND m.from_address LIKE ?';
    countQuery += ' AND m.from_address LIKE ?';
    params.push(`%${from}%`);
    countParams.push(`%${from}%`);
  }
  if (since) {
    query += ' AND m.received_at >= ?';
    countQuery += ' AND m.received_at >= ?';
    params.push(since);
    countParams.push(since);
  }
  if (filter) {
    query += ' AND (m.subject LIKE ? OR m.from_address LIKE ? OR m.snippet LIKE ?)';
    countQuery += ' AND (m.subject LIKE ? OR m.from_address LIKE ? OR m.snippet LIKE ?)';
    const filterParam = `%${filter}%`;
    params.push(filterParam, filterParam, filterParam);
    countParams.push(filterParam, filterParam, filterParam);
  }

  query += ' ORDER BY m.received_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [{ results }, totalRow, unreadRow] = await Promise.all([
    env.DB.prepare(query).bind(...params).all<MessageMeta>(),
    env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>(),
    env.DB.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE mailbox_id = ? AND read = 0 AND status = ?'
    ).bind(auth.mailboxId, 'active').first<{ count: number }>(),
  ]);

  // Map messages to summary shape with truncated snippet
  const messages = (results || []).map((m) => {
    const checks = [m.spf_result, m.dkim_result, m.dmarc_result];
    const ap = checks.every((r) => r === 'pass');
    const af = checks.some((r) => r === 'fail');
    const flags = m.security_flags ? JSON.parse(m.security_flags) : [];
    return {
      id: m.id,
      from: m.from_address,
      from_name: m.from_name,
      subject: m.subject,
      received_at: m.received_at,
      read: !!m.read,
      has_attachments: !!m.has_attachment,
      snippet: (m.snippet || '').slice(0, 100),
      spam_score: m.spam_score,
      auth_status: ap ? 'pass' : af ? 'fail' : 'partial',
      flagged: flags.length > 0,
      flag_count: flags.length,
    };
  });

  return ok({
    count: totalRow?.total || 0,
    unread: unreadRow?.count || 0,
    messages,
  });
}

/** GET /api/v1/mail/messages/:id — Get single message */
export async function handleGetMessage(
  id: string,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const msg = await env.DB.prepare(
    'SELECT * FROM messages WHERE id = ? AND mailbox_id = ? AND status = ?'
  ).bind(id, auth.mailboxId, 'active').first<MessageMeta>();

  if (!msg) return notFound('Message not found');

  // Fetch body (text + html), headers, attachments, and tags in parallel
  const [bodyObj, htmlObj, headersObj, attachmentList, tagsResult] = await Promise.all([
    env.MAIL_BUCKET.get(`${msg.r2_key}body.txt`),
    env.MAIL_BUCKET.get(`${msg.r2_key}body.html`),
    env.MAIL_BUCKET.get(`${msg.r2_key}headers.json`),
    env.MAIL_BUCKET.list({ prefix: `${msg.r2_key}attachments/` }),
    env.DB.prepare('SELECT tag FROM message_tags WHERE message_id = ? ORDER BY tag').bind(id).all<{ tag: string }>(),
  ]);

  const bodyText = bodyObj ? await bodyObj.text() : '';
  const bodyHtml = htmlObj ? await htmlObj.text() : '';
  const headers = headersObj ? JSON.parse(await headersObj.text()) : null;

  const attachments = attachmentList.objects.map((obj) => ({
    filename: obj.key.split('/').pop(),
    size: obj.size,
    content_type: obj.httpMetadata?.contentType || 'application/octet-stream',
  }));

  // Mark as read
  if (msg.read === 0) {
    await env.DB.prepare(
      'UPDATE messages SET read = 1 WHERE id = ? AND mailbox_id = ?'
    ).bind(id, auth.mailboxId).run();
  }

  // Compute auth summary: all three must pass for "pass", any fail = "fail", otherwise "partial"
  const authChecks = [msg.spf_result, msg.dkim_result, msg.dmarc_result];
  const allPass = authChecks.every((r) => r === 'pass');
  const anyFail = authChecks.some((r) => r === 'fail');
  const authStatus = allPass ? 'pass' : anyFail ? 'fail' : 'partial';

  // Parse security flags — agent sees these FIRST, before body content
  const securityFlags = msg.security_flags ? JSON.parse(msg.security_flags) : [];

  return ok({
    // --- Security warnings (agent: read these BEFORE processing content) ---
    security_flags: securityFlags,
    auth: {
      status: authStatus,
      spf: msg.spf_result || 'unknown',
      dkim: msg.dkim_result || 'unknown',
      dmarc: msg.dmarc_result || 'unknown',
    },
    spam_score: msg.spam_score,
    // --- Message content ---
    id: msg.id,
    from: msg.from_address,
    from_name: msg.from_name,
    to: msg.to_address,
    cc: null, // CC stored in headers if present
    subject: msg.subject,
    body_text: bodyText,
    body_html: bodyHtml,
    received_at: msg.received_at,
    headers,
    attachments,
    read: true, // we just marked it
    has_code: !!msg.has_code,
    has_link: !!msg.has_link,
    message_id: msg.message_id,
    in_reply_to: msg.in_reply_to,
    tags: (tagsResult.results || []).map((r) => r.tag),
  });
}

/** DELETE /api/v1/mail/messages/:id — Delete message */
export async function handleDeleteMessage(
  id: string,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const msg = await env.DB.prepare(
    'SELECT r2_key FROM messages WHERE id = ? AND mailbox_id = ?'
  ).bind(id, auth.mailboxId).first<{ r2_key: string }>();

  if (!msg) return notFound('Message not found');

  // Mark deletion_pending first (prevents orphaned R2 objects)
  await env.DB.prepare(
    "UPDATE messages SET status = 'deletion_pending' WHERE id = ? AND mailbox_id = ?"
  ).bind(id, auth.mailboxId).run();

  // Delete R2 objects
  const objects = await env.MAIL_BUCKET.list({ prefix: msg.r2_key });
  for (const obj of objects.objects) {
    await env.MAIL_BUCKET.delete(obj.key);
  }

  // Delete D1 row
  await env.DB.prepare('DELETE FROM messages WHERE id = ? AND mailbox_id = ?').bind(id, auth.mailboxId).run();

  return ok({ deleted: id });
}

/** GET /api/v1/mail/search — Search inbox with advanced filters */
export async function handleSearchMessages(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get('q');
  const from = url.searchParams.get('from');
  const subject = url.searchParams.get('subject');
  const after = url.searchParams.get('after');
  const before = url.searchParams.get('before');
  const hasCode = url.searchParams.get('has_code');
  const hasLink = url.searchParams.get('has_link');
  const hasAttachment = url.searchParams.get('has_attachment');
  const tag = url.searchParams.get('tag');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  let query = 'SELECT m.* FROM messages m';
  let countQuery = 'SELECT COUNT(*) as total FROM messages m';
  const params: unknown[] = [];
  const countParams: unknown[] = [];

  if (tag) {
    query += ' JOIN message_tags mt ON mt.message_id = m.id AND mt.tag = ?';
    countQuery += ' JOIN message_tags mt ON mt.message_id = m.id AND mt.tag = ?';
    params.push(tag);
    countParams.push(tag);
  }

  query += ' WHERE m.mailbox_id = ? AND m.status = ?';
  countQuery += ' WHERE m.mailbox_id = ? AND m.status = ?';
  params.push(auth.mailboxId, 'active');
  countParams.push(auth.mailboxId, 'active');

  // Keyword search across subject, from, and snippet
  if (q) {
    const clause = ' AND (m.subject LIKE ? OR m.from_address LIKE ? OR m.from_name LIKE ? OR m.snippet LIKE ?)';
    query += clause;
    countQuery += clause;
    const qParam = `%${q}%`;
    params.push(qParam, qParam, qParam, qParam);
    countParams.push(qParam, qParam, qParam, qParam);
  }
  if (from) {
    const clause = ' AND (m.from_address LIKE ? OR m.from_name LIKE ?)';
    query += clause;
    countQuery += clause;
    const fromParam = `%${from}%`;
    params.push(fromParam, fromParam);
    countParams.push(fromParam, fromParam);
  }
  if (subject) {
    const clause = ' AND m.subject LIKE ?';
    query += clause;
    countQuery += clause;
    params.push(`%${subject}%`);
    countParams.push(`%${subject}%`);
  }
  if (after) {
    const clause = ' AND m.received_at >= ?';
    query += clause;
    countQuery += clause;
    params.push(after);
    countParams.push(after);
  }
  if (before) {
    const clause = ' AND m.received_at <= ?';
    query += clause;
    countQuery += clause;
    params.push(before);
    countParams.push(before);
  }
  if (hasCode === 'true') {
    const clause = ' AND m.has_code = 1';
    query += clause;
    countQuery += clause;
  }
  if (hasLink === 'true') {
    const clause = ' AND m.has_link = 1';
    query += clause;
    countQuery += clause;
  }
  if (hasAttachment === 'true') {
    const clause = ' AND m.has_attachment = 1';
    query += clause;
    countQuery += clause;
  }

  query += ' ORDER BY m.received_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [{ results }, totalRow, unreadRow] = await Promise.all([
    env.DB.prepare(query).bind(...params).all<MessageMeta>(),
    env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>(),
    env.DB.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE mailbox_id = ? AND read = 0 AND status = ?'
    ).bind(auth.mailboxId, 'active').first<{ count: number }>(),
  ]);

  const messages = (results || []).map((m) => {
    const checks = [m.spf_result, m.dkim_result, m.dmarc_result];
    const ap = checks.every((r) => r === 'pass');
    const af = checks.some((r) => r === 'fail');
    const flags = m.security_flags ? JSON.parse(m.security_flags) : [];
    return {
      id: m.id,
      from: m.from_address,
      from_name: m.from_name,
      subject: m.subject,
      received_at: m.received_at,
      read: !!m.read,
      has_attachments: !!m.has_attachment,
      snippet: (m.snippet || '').slice(0, 100),
      spam_score: m.spam_score,
      auth_status: ap ? 'pass' : af ? 'fail' : 'partial',
      flagged: flags.length > 0,
      flag_count: flags.length,
    };
  });

  return ok({
    count: totalRow?.total || 0,
    unread: unreadRow?.count || 0,
    messages,
  });
}

/** GET /api/v1/mail/messages/:id/thread — Get conversation thread */
export async function handleGetThread(
  id: string,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  // 1. Get the target message (verify ownership)
  const target = await env.DB.prepare(
    'SELECT * FROM messages WHERE id = ? AND mailbox_id = ? AND status = ?'
  ).bind(id, auth.mailboxId, 'active').first<MessageMeta>();

  if (!target) return notFound('Message not found');

  // Collect thread items keyed by id to deduplicate
  const threadMap = new Map<string, {
    id: string;
    from: string;
    from_name: string | null;
    to: string;
    subject: string;
    snippet: string;
    received_at: string;
    read: boolean;
    direction: string;
    is_current: boolean;
  }>();

  // Add target message
  threadMap.set(target.id, {
    id: target.id,
    from: target.from_address,
    from_name: target.from_name,
    to: target.to_address,
    subject: target.subject,
    snippet: (target.snippet || '').slice(0, 100),
    received_at: target.received_at,
    read: !!target.read,
    direction: target.direction,
    is_current: true,
  });

  // 2. Walk in_reply_to chain backwards to find ancestors (max depth 50)
  let currentMessageId = target.in_reply_to;
  let depth = 0;
  while (currentMessageId && depth < 50) {
    const ancestor = await env.DB.prepare(
      'SELECT * FROM messages WHERE message_id = ? AND mailbox_id = ? AND status = ?'
    ).bind(currentMessageId, auth.mailboxId, 'active').first<MessageMeta>();

    if (!ancestor) break;
    if (threadMap.has(ancestor.id)) break; // cycle protection

    threadMap.set(ancestor.id, {
      id: ancestor.id,
      from: ancestor.from_address,
      from_name: ancestor.from_name,
      to: ancestor.to_address,
      subject: ancestor.subject,
      snippet: (ancestor.snippet || '').slice(0, 100),
      received_at: ancestor.received_at,
      read: !!ancestor.read,
      direction: ancestor.direction,
      is_current: false,
    });

    currentMessageId = ancestor.in_reply_to;
    depth++;
  }

  // 3. Find descendants: messages that reply to the target's message_id
  if (target.message_id) {
    const { results: descendants } = await env.DB.prepare(
      'SELECT * FROM messages WHERE in_reply_to = ? AND mailbox_id = ? AND status = ?'
    ).bind(target.message_id, auth.mailboxId, 'active').all<MessageMeta>();

    for (const desc of descendants || []) {
      if (threadMap.has(desc.id)) continue;
      threadMap.set(desc.id, {
        id: desc.id,
        from: desc.from_address,
        from_name: desc.from_name,
        to: desc.to_address,
        subject: desc.subject,
        snippet: (desc.snippet || '').slice(0, 100),
        received_at: desc.received_at,
        read: !!desc.read,
        direction: desc.direction,
        is_current: false,
      });
    }
  }

  // 4. Check outbound_sends for our replies to this message
  if (target.message_id) {
    const { results: outbound } = await env.DB.prepare(
      'SELECT id, to_address, subject, created_at, in_reply_to FROM outbound_sends WHERE in_reply_to = ? AND mailbox_id = ?'
    ).bind(target.message_id, auth.mailboxId).all<{
      id: string;
      to_address: string;
      subject: string;
      created_at: string;
      in_reply_to: string | null;
    }>();

    for (const out of outbound || []) {
      if (threadMap.has(out.id)) continue;
      threadMap.set(out.id, {
        id: out.id,
        from: auth.address,
        from_name: null,
        to: out.to_address,
        subject: out.subject,
        snippet: '',
        received_at: out.created_at,
        read: true,
        direction: 'outbound',
        is_current: false,
      });
    }
  }

  // 5. Sort chronologically
  const thread = Array.from(threadMap.values()).sort(
    (a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime()
  );

  return ok({ thread, count: thread.length });
}

/** GET /api/v1/mail/messages/:id/attachments/:filename — Download attachment */
export async function handleDownloadAttachment(
  messageId: string,
  rawFilename: string,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  // Sanitize filename: strip path separators, reject traversal attempts
  const filename = rawFilename.split('/').pop()?.split('\\').pop() || '';
  if (!filename || filename.includes('..') || filename.includes('\0') || filename.length > 255) {
    return notFound('Invalid filename');
  }

  const msg = await env.DB.prepare(
    'SELECT r2_key FROM messages WHERE id = ? AND mailbox_id = ? AND status = ?'
  ).bind(messageId, auth.mailboxId, 'active').first<{ r2_key: string }>();

  if (!msg) return notFound('Message not found');

  const r2Object = await env.MAIL_BUCKET.get(`${msg.r2_key}attachments/${filename}`);
  if (!r2Object) return notFound('Attachment not found');

  const contentType = r2Object.httpMetadata?.contentType || 'application/octet-stream';

  return new Response(r2Object.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': String(r2Object.size),
    },
  });
}

/**
 * GET /api/v1/mail/wait — Poll for a matching email
 *
 * CF Workers have a 30s CPU time limit, so we can't long-poll.
 * Instead: check D1, if no match return { found: false, retry_after: 5 }.
 * The CLI will poll repeatedly until timeout.
 */
export async function handleWaitMessage(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const subject = url.searchParams.get('subject');
  const since = url.searchParams.get('since'); // ISO timestamp — only match emails after this

  // At least one filter is required, otherwise it's just /messages
  if (!from && !subject) {
    return validationError('At least one filter required: from, subject');
  }

  let query = 'SELECT * FROM messages WHERE mailbox_id = ? AND status = ?';
  const params: unknown[] = [auth.mailboxId, 'active'];

  if (from) {
    query += ' AND from_address LIKE ?';
    params.push(`%${from}%`);
  }
  if (subject) {
    query += ' AND subject LIKE ?';
    params.push(`%${subject}%`);
  }
  if (since) {
    query += ' AND received_at >= ?';
    params.push(since);
  }

  query += ' ORDER BY received_at DESC LIMIT 1';

  const msg = await env.DB.prepare(query).bind(...params).first<MessageMeta>();

  if (!msg) {
    return ok({ found: false, retry_after: 5 });
  }

  // Found a match — return full message (same as read endpoint)
  const [bodyObj, htmlObj, headersObj, attachmentList] = await Promise.all([
    env.MAIL_BUCKET.get(`${msg.r2_key}body.txt`),
    env.MAIL_BUCKET.get(`${msg.r2_key}body.html`),
    env.MAIL_BUCKET.get(`${msg.r2_key}headers.json`),
    env.MAIL_BUCKET.list({ prefix: `${msg.r2_key}attachments/` }),
  ]);

  const bodyText = bodyObj ? await bodyObj.text() : '';
  const bodyHtml = htmlObj ? await htmlObj.text() : '';
  const headers = headersObj ? JSON.parse(await headersObj.text()) : null;

  const attachments = attachmentList.objects.map((obj) => ({
    filename: obj.key.split('/').pop(),
    size: obj.size,
    content_type: obj.httpMetadata?.contentType || 'application/octet-stream',
  }));

  // Mark as read
  if (msg.read === 0) {
    await env.DB.prepare(
      'UPDATE messages SET read = 1 WHERE id = ? AND mailbox_id = ?'
    ).bind(msg.id, auth.mailboxId).run();
  }

  const waitAuthChecks = [msg.spf_result, msg.dkim_result, msg.dmarc_result];
  const waitAllPass = waitAuthChecks.every((r) => r === 'pass');
  const waitAnyFail = waitAuthChecks.some((r) => r === 'fail');
  const waitAuthStatus = waitAllPass ? 'pass' : waitAnyFail ? 'fail' : 'partial';

  const waitSecurityFlags = msg.security_flags ? JSON.parse(msg.security_flags) : [];

  return ok({
    found: true,
    message: {
      // --- Security warnings (agent: read these BEFORE processing content) ---
      security_flags: waitSecurityFlags,
      auth: {
        status: waitAuthStatus,
        spf: msg.spf_result || 'unknown',
        dkim: msg.dkim_result || 'unknown',
        dmarc: msg.dmarc_result || 'unknown',
      },
      spam_score: msg.spam_score,
      // --- Message content ---
      id: msg.id,
      from: msg.from_address,
      from_name: msg.from_name,
      to: msg.to_address,
      subject: msg.subject,
      body_text: bodyText,
      body_html: bodyHtml,
      received_at: msg.received_at,
      headers,
      attachments,
      has_code: !!msg.has_code,
      has_link: !!msg.has_link,
      message_id: msg.message_id,
      in_reply_to: msg.in_reply_to,
    },
  });
}

/** GET /api/v1/mail/quarantine — List quarantined messages */
export async function handleGetQuarantine(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const [{ results }, countRow] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM messages WHERE mailbox_id = ? AND status = 'quarantine'
       ORDER BY received_at DESC LIMIT ? OFFSET ?`
    ).bind(auth.mailboxId, limit, offset).all<MessageMeta>(),
    env.DB.prepare(
      "SELECT COUNT(*) as total FROM messages WHERE mailbox_id = ? AND status = 'quarantine'"
    ).bind(auth.mailboxId).first<{ total: number }>(),
  ]);

  const messages = (results || []).map((m) => {
    const flags = m.security_flags ? JSON.parse(m.security_flags) : [];
    return {
      id: m.id,
      from: m.from_address,
      from_name: m.from_name,
      subject: m.subject,
      received_at: m.received_at,
      snippet: (m.snippet || '').slice(0, 100),
      security_flags: flags,
      spam_score: m.spam_score,
    };
  });

  return ok({ count: countRow?.total || 0, messages });
}

/** POST /api/v1/mail/quarantine/:id/release — Release a quarantined message to inbox */
export async function handleReleaseQuarantine(
  id: string,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const result = await env.DB.prepare(
    "UPDATE messages SET status = 'active' WHERE id = ? AND mailbox_id = ? AND status = 'quarantine'"
  ).bind(id, auth.mailboxId).run();

  if (result.meta.changes === 0) {
    return notFound('Message not found in quarantine');
  }

  return ok({ released: id });
}
