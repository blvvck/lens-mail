import type { AuthContext } from '../types';

export const TEMPORARY_MAILBOX_TYPE = 'temporary';
export const PERSISTENT_MAILBOX_TYPE = 'persistent';
export const MIN_TEMP_TTL_SECONDS = 5 * 60;
export const MAX_TEMP_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_TEMP_TTL_SECONDS = 60 * 60;
export const MAX_TEMP_NAME_LENGTH = 64 - 1 - 20;
export const MAX_ACTIVE_TEMP_MAILBOXES = 1_000;
export const MAX_TEMP_MESSAGES = 100;
export const MAX_TEMP_STORAGE_BYTES = 100 * 1024 * 1024;
export const RESERVED_MAILBOX_NAMES = new Set([
  'admin', 'postmaster', 'abuse', 'noreply', 'no-reply',
  'support', 'help', 'info', 'mailer-daemon', 'root',
  'hostmaster', 'webmaster', 'security', 'dmarc',
  'marketing', 'sales', 'noc', 'usenet', 'news', 'www', 'uucp', 'ftp', 'list-request',
  'billing', 'accounts', 'invoices', 'orders', 'payments', 'finance', 'careers', 'jobs',
  'hr', 'media', 'press', 'legal', 'privacy', 'compliance', 'contact', 'hello', 'customer',
  'customerservice', 'customercare', 'helpdesk', 'service', 'team', 'partners', 'feedback',
  'notifications', 'alerts', 'spam', 'subscribe', 'unsubscribe', 'remove', 'sysadmin',
  'tech', 'all', 'everyone',
  'lens', 'lenscli', 'lensmail',
].map((name) => name.replace(/[^a-z0-9]/g, '')));

export function isReservedMailboxName(name: string): boolean {
  return RESERVED_MAILBOX_NAMES.has(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

export function parseTemporaryTtl(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_TEMP_TTL_SECONDS;
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(seconds) || seconds < MIN_TEMP_TTL_SECONDS || seconds > MAX_TEMP_TTL_SECONDS) {
    throw new Error(`TTL must be an integer number of seconds between ${MIN_TEMP_TTL_SECONDS} and ${MAX_TEMP_TTL_SECONDS}`);
  }
  return seconds;
}

export function sanitizeTemporaryName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Name must be a string');
  const name = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TEMP_NAME_LENGTH);
  if (!name) throw new Error('Name must contain letters or numbers');
  return name;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generateTemporaryLocalPart(name?: string | null): string {
  return `${sanitizeTemporaryName(name) || 'tmp'}-${randomSuffix()}`;
}

export function isTemporaryMailbox(auth: Pick<AuthContext, 'mailboxType'>): boolean {
  return auth.mailboxType === TEMPORARY_MAILBOX_TYPE;
}

export function temporaryOperationAllowed(mailboxType: string | undefined, operation: string): boolean {
  if (mailboxType !== TEMPORARY_MAILBOX_TYPE) return true;
  return new Set([
    'messages.list',
    'messages.read',
    'messages.search',
    'messages.wait',
    'messages.delete',
    'messages.attachment',
    'messages.thread',
    'quarantine.read',
    'stats.read',
  ]).has(operation);
}

export function temporaryRouteAllowed(path: string, method: string): boolean {
  if (path.startsWith('/api/v1/mail/keys/')) return false;
  if (path.startsWith('/api/v1/mail/owner-token')) return false;
  if (path.startsWith('/api/v1/mail/block')) return false;
  if (path.startsWith('/api/v1/mail/filters')) return false;
  if (path.startsWith('/api/v1/mail/tags')) return false;
  if (path.startsWith('/api/v1/mail/rooms')) return false;
  if (path.startsWith('/api/v1/mail/drafts')) return false;
  if (path === '/api/v1/mail/send' || path.startsWith('/api/v1/mail/reply/') || path.startsWith('/api/v1/mail/forward/')) return false;
  if (path.match(/^\/api\/v1\/mail\/quarantine\/.+\/release$/)) return false;
  if (path === '/api/v1/mail/messages' && method === 'GET') return true;
  if (path === '/api/v1/mail/search' && method === 'GET') return true;
  if (path === '/api/v1/mail/wait' && method === 'GET') return true;
  if (path === '/api/v1/mail/quarantine' && method === 'GET') return true;
  if (path === '/api/v1/mail/stats' && method === 'GET') return true;
  if (path.match(/^\/api\/v1\/mail\/messages\/[A-Z0-9]+$/)) return method === 'GET' || method === 'DELETE';
  if (path.match(/^\/api\/v1\/mail\/messages\/[A-Z0-9]+\/attachments\/.+$/)) return method === 'GET';
  if (path.match(/^\/api\/v1\/mail\/messages\/[A-Z0-9]+\/thread$/)) return method === 'GET';
  return false;
}

export function isExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() <= now;
}

function byteLength(value: unknown): number {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
}

export function calculateStoredBytes(
  raw: unknown,
  bodyText: unknown,
  bodyHtml: unknown,
  attachments: unknown[] = [],
): number {
  return byteLength(raw) + byteLength(bodyText) + byteLength(bodyHtml) + attachments.reduce<number>((total, attachment) => total + byteLength(attachment), 0);
}

export async function purgeR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor ? { prefix, cursor } : { prefix });
    for (const object of page.objects) await bucket.delete(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
