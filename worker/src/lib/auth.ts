import type { Env, AuthContext } from '../types';

/** Hash an API key using SHA-256 */
export async function hashKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Generate a new API key with lm_ prefix */
export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `lm_${key}`;
}

/** Extract prefix from key (first 8 chars after lm_) */
export function keyPrefix(key: string): string {
  return key.slice(0, 11); // "lm_" + 8 hex chars
}

/** Authenticate a request. Returns AuthContext or null. */
export async function authenticate(
  request: Request,
  env: Env
): Promise<AuthContext | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);

  // Check admin key (constant-time comparison via hash)
  if (token.startsWith('lma_') && env.ADMIN_KEY) {
    const tokenHash = await hashKey(token);
    const adminHash = await hashKey(env.ADMIN_KEY);
    if (tokenHash === adminHash) {
      return { mailboxId: '__admin__', address: 'admin', keyId: '__admin__' };
    }
    return null;
  }

  // Check regular API key
  if (!token.startsWith('lm_')) return null;

  const hash = await hashKey(token);
  const row = await env.DB.prepare(
    `SELECT ak.id as key_id, ak.mailbox_id, m.address
     FROM api_keys ak
     JOIN mailboxes m ON m.id = ak.mailbox_id
     WHERE ak.key_hash = ? AND ak.revoked_at IS NULL AND m.status = 'active'`
  )
    .bind(hash)
    .first<{ key_id: string; mailbox_id: string; address: string }>();

  if (!row) return null;

  // Update last_used_at (fire and forget)
  env.DB.prepare('UPDATE api_keys SET last_used_at = datetime(?) WHERE id = ?')
    .bind(new Date().toISOString(), row.key_id)
    .run();

  return {
    mailboxId: row.mailbox_id,
    address: row.address,
    keyId: row.key_id,
  };
}

/** JSON error response */
export function authError(): Response {
  return Response.json(
    { ok: false, error: 'Unauthorized', code: 2 },
    { status: 401 }
  );
}
