import type { Env, AuthContext } from '../types';
import { ok } from '../lib/response';

/** GET /api/v1/mail/stats — Account statistics */
export async function handleGetStats(
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const [messages, unread, sent] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) as count FROM messages WHERE mailbox_id = ? AND status = 'active'"
    ).bind(auth.mailboxId).first<{ count: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) as count FROM messages WHERE mailbox_id = ? AND read = 0 AND status = 'active'"
    ).bind(auth.mailboxId).first<{ count: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) as count FROM outbound_sends WHERE mailbox_id = ? AND status = 'sent'"
    ).bind(auth.mailboxId).first<{ count: number }>(),
  ]);

  const mailbox = await env.DB.prepare(
    'SELECT created_at, settings FROM mailboxes WHERE id = ?'
  ).bind(auth.mailboxId).first<{ created_at: string; settings: string }>();

  return ok({
    total_messages: messages?.count || 0,
    unread: unread?.count || 0,
    total_sent: sent?.count || 0,
    created_at: mailbox?.created_at,
    address: auth.address,
  });
}
