import type { Env, AuthContext, Room, RoomMessage } from '../types';
import { ok, notFound, validationError } from '../lib/response';
import { ulid } from '../lib/ulid';
import { scanForInjection } from '../lib/security-hooks';
import { isBlocked } from './blocklist';

const VALID_MESSAGE_TYPES = ['text', 'status', 'request', 'ack', 'data'];

/** Route all /api/v1/mail/rooms/* requests */
export async function handleRoomRoutes(
  path: string,
  method: string,
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  // POST /api/v1/mail/rooms — Create room
  if (path === '/api/v1/mail/rooms' && method === 'POST') {
    return createRoom(request, env, auth);
  }

  // GET /api/v1/mail/rooms — List rooms
  if (path === '/api/v1/mail/rooms' && method === 'GET') {
    return listRooms(env, auth);
  }

  // Room-specific routes: /api/v1/mail/rooms/:name/...
  const roomMatch = path.match(/^\/api\/v1\/mail\/rooms\/([^/]+)(\/.*)?$/);
  if (!roomMatch) return notFound();

  const roomName = decodeURIComponent(roomMatch[1]);
  const subpath = roomMatch[2] || '';

  // GET /rooms/:name/messages — Read messages
  if (subpath === '/messages' && method === 'GET') {
    return getRoomMessages(roomName, request, env, auth);
  }

  // POST /rooms/:name/messages — Send message
  if (subpath === '/messages' && method === 'POST') {
    return sendRoomMessage(roomName, request, env, auth);
  }

  // POST /rooms/:name/invite — Invite member
  if (subpath === '/invite' && method === 'POST') {
    return inviteToRoom(roomName, request, env, auth);
  }

  // POST /rooms/:name/join — Join room
  if (subpath === '/join' && method === 'POST') {
    return joinRoom(roomName, env, auth);
  }

  // POST /rooms/:name/leave — Leave room
  if (subpath === '/leave' && method === 'POST') {
    return leaveRoom(roomName, env, auth);
  }

  // GET /rooms/:name/members — List members
  if (subpath === '/members' && method === 'GET') {
    return getRoomMembers(roomName, env, auth);
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** POST /api/v1/mail/rooms — Create a room */
async function createRoom(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = await request.json<{ name: string; description?: string }>().catch(() => null);
  if (!body?.name) return validationError('Missing room name');

  const roomId = ulid();
  const description = body.description || '';

  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO rooms (id, name, description, created_by) VALUES (?, ?, ?, ?)'
      ).bind(roomId, body.name, description, auth.address),
      env.DB.prepare(
        "INSERT INTO room_members (room_id, mailbox_id, role, status) VALUES (?, ?, 'owner', 'active')"
      ).bind(roomId, auth.mailboxId),
    ]);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      return validationError('Room name already taken');
    }
    throw e;
  }

  const room = await env.DB.prepare(
    'SELECT id, name, description, created_by, created_at FROM rooms WHERE id = ?'
  ).bind(roomId).first();

  return ok(room, 201);
}

/** GET /api/v1/mail/rooms — List rooms for current agent */
async function listRooms(env: Env, auth: AuthContext): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.name, r.description, r.created_by, r.created_at, rm.role, rm.status,
            (SELECT COUNT(*) FROM room_messages msg
             WHERE msg.room_id = r.id AND msg.seq > rm.last_read_seq) AS unread
     FROM rooms r
     JOIN room_members rm ON rm.room_id = r.id
     WHERE rm.mailbox_id = ? AND rm.status IN ('active', 'invited')`
  ).bind(auth.mailboxId).all();

  return ok({ rooms: results || [] });
}

/** POST /api/v1/mail/rooms/:name/invite — Invite agent to room */
async function inviteToRoom(
  roomName: string, request: Request, env: Env, auth: AuthContext
): Promise<Response> {
  const room = await getRoom(roomName, env);
  if (!room) return notFound('Room not found');

  // Inviter must be an active member
  const membership = await getMembership(room.id, auth.mailboxId, env);
  if (!membership || membership.status !== 'active') {
    return validationError('Not a member of this room');
  }

  const body = await request.json<{ address: string }>().catch(() => null);
  if (!body?.address) return validationError('Missing address');

  const invitee = await env.DB.prepare(
    'SELECT id FROM mailboxes WHERE address = ? AND status = ?'
  ).bind(body.address, 'active').first<{ id: string }>();

  if (!invitee) return validationError('Address not found');

  // Check if they were previously a member (could have left)
  const existing = await getMembership(room.id, invitee.id, env);
  if (existing) {
    if (existing.status === 'active') {
      return validationError('Already a member');
    }
    // Re-invite (left or previously invited)
    await env.DB.prepare(
      "UPDATE room_members SET status = 'invited', joined_at = datetime('now') WHERE room_id = ? AND mailbox_id = ?"
    ).bind(room.id, invitee.id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO room_members (room_id, mailbox_id, role, status) VALUES (?, ?, 'member', 'invited')"
    ).bind(room.id, invitee.id).run();
  }

  return ok({ invited: body.address });
}

/** POST /api/v1/mail/rooms/:name/join — Accept invite / join room */
async function joinRoom(roomName: string, env: Env, auth: AuthContext): Promise<Response> {
  const room = await getRoom(roomName, env);
  if (!room) return notFound('Room not found');

  const membership = await getMembership(room.id, auth.mailboxId, env);

  if (!membership) {
    return validationError('No pending invite');
  }

  if (membership.status === 'active') {
    return ok({ status: 'already_member' });
  }

  if (membership.status !== 'invited') {
    return validationError('No pending invite');
  }

  await env.DB.prepare(
    "UPDATE room_members SET status = 'active', joined_at = datetime('now') WHERE room_id = ? AND mailbox_id = ?"
  ).bind(room.id, auth.mailboxId).run();

  return ok({ joined: roomName });
}

/** POST /api/v1/mail/rooms/:name/messages — Send message to room */
async function sendRoomMessage(
  roomName: string, request: Request, env: Env, auth: AuthContext
): Promise<Response> {
  const room = await getRoom(roomName, env);
  if (!room) return notFound('Room not found');

  const membership = await getMembership(room.id, auth.mailboxId, env);
  if (!membership || membership.status !== 'active') {
    return validationError('Not an active member of this room');
  }

  const body = await request.json<{ content: string; type?: string }>().catch(() => null);
  if (!body?.content) return validationError('Missing message content');
  if (body.content.length > 65536) return validationError('Message content exceeds 64KB limit');

  const messageType = body.type || 'text';
  if (!VALID_MESSAGE_TYPES.includes(messageType)) {
    return validationError(`Invalid message type. Must be one of: ${VALID_MESSAGE_TYPES.join(', ')}`);
  }

  // Security: check if sender is blocked by any room member's blocklist
  // (prevents a blocked sender from reaching agents via rooms)
  if (await isBlocked(env, auth.mailboxId, auth.address)) {
    return validationError('Sender is blocked');
  }

  // Security: scan for prompt injection in message content
  const injection = scanForInjection(body.content);
  if (injection && injection.severity === 'critical') {
    return validationError('Message blocked: potential prompt injection detected');
  }

  const msgId = ulid();

  // Get next seq (MAX + 1, default 1 for first message)
  const seqRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM room_messages WHERE room_id = ?'
  ).bind(room.id).first<{ next_seq: number }>();
  const seq = seqRow?.next_seq || 1;

  // For non-critical injection, tag the message so readers see a warning
  const injectionWarning = injection ? `⚠️ INJECTION PATTERNS DETECTED: ${injection.patterns.join(', ')}` : null;

  await env.DB.prepare(
    `INSERT INTO room_messages (id, room_id, seq, sender_id, sender_address, content, message_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(msgId, room.id, seq, auth.mailboxId, auth.address, body.content, messageType).run();

  // Update sender's last_read_seq to include their own message
  await env.DB.prepare(
    'UPDATE room_members SET last_read_seq = ? WHERE room_id = ? AND mailbox_id = ?'
  ).bind(seq, room.id, auth.mailboxId).run();

  const msg = await env.DB.prepare(
    'SELECT id, seq, sender_address, content, message_type, created_at FROM room_messages WHERE id = ?'
  ).bind(msgId).first();

  // Include injection warning if detected (non-critical — critical was already blocked)
  if (injectionWarning) {
    return ok({ security_warning: injectionWarning, ...msg as Record<string, unknown> }, 201);
  }

  return ok(msg, 201);
}

/** GET /api/v1/mail/rooms/:name/messages — Read room messages */
async function getRoomMessages(
  roomName: string, request: Request, env: Env, auth: AuthContext
): Promise<Response> {
  const room = await getRoom(roomName, env);
  if (!room) return notFound('Room not found');

  const membership = await getMembership(room.id, auth.mailboxId, env);
  if (!membership || membership.status === 'left') {
    return validationError('Not a member of this room');
  }

  const url = new URL(request.url);
  const afterSeq = parseInt(url.searchParams.get('after_seq') || '0');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);

  let query = 'SELECT rm.id, rm.seq, rm.sender_address, rm.content, rm.message_type, rm.created_at';
  query += ', m.display_name AS sender_name';
  query += ' FROM room_messages rm';
  query += ' JOIN mailboxes m ON m.id = rm.sender_id';
  query += ' WHERE rm.room_id = ?';
  const params: unknown[] = [room.id];

  if (afterSeq > 0) {
    query += ' AND rm.seq > ?';
    params.push(afterSeq);
  }

  query += ' ORDER BY rm.seq ASC LIMIT ?';
  params.push(limit);

  const { results } = await env.DB.prepare(query).bind(...params).all();
  const rawMessages = results || [];

  // Security: scan each message for prompt injection patterns on read
  // This ensures the consuming agent sees warnings even for messages
  // that were posted before security hooks were added
  const messages = rawMessages.map((m: Record<string, unknown>) => {
    const content = m.content as string;
    const injection = scanForInjection(content || '');
    if (injection) {
      return {
        ...m,
        security_warning: `⚠️ INJECTION PATTERNS: ${injection.patterns.join(', ')}`,
        security_severity: injection.severity,
      };
    }
    return m;
  });

  // Update last_read_seq to the highest seq we returned
  if (messages.length > 0) {
    const maxSeq = (messages[messages.length - 1] as Record<string, unknown>).seq as number;
    if (maxSeq > membership.last_read_seq) {
      await env.DB.prepare(
        'UPDATE room_members SET last_read_seq = ? WHERE room_id = ? AND mailbox_id = ?'
      ).bind(maxSeq, room.id, auth.mailboxId).run();
    }
  }

  return ok({ messages });
}

/** GET /api/v1/mail/rooms/:name/members — List room members */
async function getRoomMembers(roomName: string, env: Env, auth: AuthContext): Promise<Response> {
  const room = await getRoom(roomName, env);
  if (!room) return notFound('Room not found');

  const membership = await getMembership(room.id, auth.mailboxId, env);
  if (!membership || membership.status === 'left') {
    return validationError('Not a member of this room');
  }

  const { results } = await env.DB.prepare(
    `SELECT m.address, m.display_name AS name, rm.role, rm.status, rm.joined_at
     FROM room_members rm
     JOIN mailboxes m ON m.id = rm.mailbox_id
     WHERE rm.room_id = ? AND rm.status != 'left'`
  ).bind(room.id).all();

  return ok({ members: results || [] });
}

/** POST /api/v1/mail/rooms/:name/leave — Leave room */
async function leaveRoom(roomName: string, env: Env, auth: AuthContext): Promise<Response> {
  const room = await getRoom(roomName, env);
  if (!room) return notFound('Room not found');

  const membership = await getMembership(room.id, auth.mailboxId, env);
  if (!membership || membership.status !== 'active') {
    return validationError('Not an active member of this room');
  }

  if (membership.role === 'owner') {
    // Transfer ownership to next member, or delete room if no one left
    const nextMember = await env.DB.prepare(
      "SELECT mailbox_id FROM room_members WHERE room_id = ? AND mailbox_id != ? AND status = 'active' ORDER BY joined_at ASC LIMIT 1"
    ).bind(room.id, auth.mailboxId).first<{ mailbox_id: string }>();

    if (nextMember) {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE room_members SET role = 'owner' WHERE room_id = ? AND mailbox_id = ?"
        ).bind(room.id, nextMember.mailbox_id),
        env.DB.prepare(
          "UPDATE room_members SET status = 'left' WHERE room_id = ? AND mailbox_id = ?"
        ).bind(room.id, auth.mailboxId),
      ]);
    } else {
      // No active members left — delete the room
      await env.DB.batch([
        env.DB.prepare('DELETE FROM room_messages WHERE room_id = ?').bind(room.id),
        env.DB.prepare('DELETE FROM room_members WHERE room_id = ?').bind(room.id),
        env.DB.prepare('DELETE FROM rooms WHERE id = ?').bind(room.id),
      ]);
      return ok({ left: roomName, room_deleted: true });
    }
  } else {
    await env.DB.prepare(
      "UPDATE room_members SET status = 'left' WHERE room_id = ? AND mailbox_id = ?"
    ).bind(room.id, auth.mailboxId).run();
  }

  return ok({ left: roomName });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getRoom(name: string, env: Env) {
  return env.DB.prepare('SELECT * FROM rooms WHERE name = ?')
    .bind(name).first<Room>();
}

async function getMembership(roomId: string, mailboxId: string, env: Env) {
  return env.DB.prepare(
    'SELECT role, status, last_read_seq FROM room_members WHERE room_id = ? AND mailbox_id = ?'
  ).bind(roomId, mailboxId).first<{ role: string; status: string; last_read_seq: number }>();
}
