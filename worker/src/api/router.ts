import type { Env, AuthContext } from '../types';
import { authenticate, authError } from '../lib/auth';
import { ok, notFound, validationError, forbidden } from '../lib/response';
import { handleProvision, handleTemporaryProvision, handleRotateKey, handleRevokeKey, handleOwnerToken, handleGetVerifyCode, handleDeleteOwnerToken } from './provision';
import { handleGetMessages, handleGetMessage, handleDeleteMessage, handleSearchMessages, handleWaitMessage, handleDownloadAttachment, handleGetThread, handleGetQuarantine, handleReleaseQuarantine } from './messages';
import { handleSend, handleReply, handleForward } from './send';
import { handleGetStats } from './stats';
import { handleRoomRoutes } from './rooms';
import { handleDraftRoutes } from './drafts';
import { handleTagRoutes, handleListTags } from './tags';
import { handleFilterRoutes } from './filters';
import { handleBlockSender, handleUnblockSender, handleListBlocked } from './blocklist';
import { temporaryRouteAllowed } from '../lib/temporary';

/** Route all API requests */
export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Health check — no auth needed
  if (path === '/health' && method === 'GET') {
    return ok({ status: 'ok', timestamp: new Date().toISOString() });
  }

  // Provisioning — no auth needed (rate-limited by IP)
  if (path === '/api/v1/mail/provision' && method === 'POST') {
    return handleProvision(request, env);
  }
  if (path === '/api/v1/mail/temp' && method === 'POST') {
    return handleTemporaryProvision(request, env);
  }

  // Everything else requires auth
  const auth = await authenticate(request, env);
  if (!auth) return authError();

  if (auth.mailboxType === 'temporary' && !temporaryRouteAllowed(path, method)) {
    return forbidden('This operation is not available for temporary mailboxes');
  }

  // --- Authenticated routes ---

  // Key management
  if (path === '/api/v1/mail/keys/rotate' && method === 'POST') {
    return handleRotateKey(request, env, auth);
  }
  if (path.startsWith('/api/v1/mail/keys/') && method === 'DELETE') {
    const prefix = path.split('/').pop()!;
    return handleRevokeKey(prefix, env, auth);
  }

  // Owner verification (TOTP-style 2FA for email)
  if (path === '/api/v1/mail/owner-token' && method === 'POST') {
    return handleOwnerToken(request, env, auth);
  }
  if (path === '/api/v1/mail/owner-token/code' && method === 'GET') {
    return handleGetVerifyCode(env, auth);
  }
  if (path === '/api/v1/mail/owner-token' && method === 'DELETE') {
    return handleDeleteOwnerToken(env, auth);
  }

  // Sender blocklist
  if (path === '/api/v1/mail/block' && method === 'POST') {
    return handleBlockSender(request, env, auth);
  }
  if (path === '/api/v1/mail/block' && method === 'DELETE') {
    return handleUnblockSender(request, env, auth);
  }
  if (path === '/api/v1/mail/blocked' && method === 'GET') {
    return handleListBlocked(env, auth);
  }

  // Quarantine
  if (path === '/api/v1/mail/quarantine' && method === 'GET') {
    return handleGetQuarantine(request, env, auth);
  }
  if (path.match(/^\/api\/v1\/mail\/quarantine\/[A-Z0-9]+\/release$/) && method === 'POST') {
    const id = path.split('/')[5];
    return handleReleaseQuarantine(id, env, auth);
  }

  // Search
  if (path === '/api/v1/mail/search' && method === 'GET') {
    return handleSearchMessages(request, env, auth);
  }

  // Wait/poll for matching email
  if (path === '/api/v1/mail/wait' && method === 'GET') {
    return handleWaitMessage(request, env, auth);
  }

  // Tags - message-level (must be before messages/:id)
  if (path.match(/^\/api\/v1\/mail\/messages\/[A-Z0-9]+\/tags$/) && (method === 'POST' || method === 'DELETE')) {
    const id = path.split('/')[5];
    return handleTagRoutes(id, method, request, env, auth);
  }
  // Tags - list all
  if (path === '/api/v1/mail/tags' && method === 'GET') {
    return handleListTags(env, auth);
  }

  // Filters
  if (path.startsWith('/api/v1/mail/filters')) {
    return handleFilterRoutes(path, method, request, env, auth);
  }

  // Messages
  if (path === '/api/v1/mail/messages' && method === 'GET') {
    return handleGetMessages(request, env, auth);
  }

  // Attachment download (must be before messages/:id)
  if (path.match(/^\/api\/v1\/mail\/messages\/[A-Z0-9]+\/attachments\/.+$/) && method === 'GET') {
    const parts = path.split('/');
    const messageId = parts[5]; // /api/v1/mail/messages/{id}/attachments/{filename}
    const filename = decodeURIComponent(parts[7]);
    return handleDownloadAttachment(messageId, filename, env, auth);
  }

  // Thread view (must be before messages/:id)
  if (path.match(/^\/api\/v1\/mail\/messages\/[A-Z0-9]+\/thread$/) && method === 'GET') {
    const id = path.split('/')[5];
    return handleGetThread(id, env, auth);
  }

  if (path.match(/^\/api\/v1\/mail\/messages\/[A-Z0-9]+$/) && method === 'GET') {
    const id = path.split('/').pop()!;
    return handleGetMessage(id, env, auth);
  }
  if (path.match(/^\/api\/v1\/mail\/messages\/[A-Z0-9]+$/) && method === 'DELETE') {
    const id = path.split('/').pop()!;
    return handleDeleteMessage(id, env, auth);
  }

  // Send / Reply / Forward
  if (path === '/api/v1/mail/send' && method === 'POST') {
    return handleSend(request, env, auth, ctx);
  }
  if (path.match(/^\/api\/v1\/mail\/reply\/[A-Z0-9]+$/) && method === 'POST') {
    const id = path.split('/').pop()!;
    return handleReply(id, request, env, auth, ctx);
  }
  if (path.match(/^\/api\/v1\/mail\/forward\/[A-Z0-9]+$/) && method === 'POST') {
    const id = path.split('/').pop()!;
    return handleForward(id, request, env, auth, ctx);
  }

  // Stats
  if (path === '/api/v1/mail/stats' && method === 'GET') {
    return handleGetStats(env, auth);
  }

  // Drafts
  if (path.startsWith('/api/v1/mail/drafts')) {
    return handleDraftRoutes(path, method, request, env, auth);
  }

  // Rooms
  if (path.startsWith('/api/v1/mail/rooms')) {
    return handleRoomRoutes(path, method, request, env, auth);
  }

  return notFound('Unknown endpoint');
}
