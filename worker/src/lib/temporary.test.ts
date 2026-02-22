import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TEMP_TTL_SECONDS,
  MIN_TEMP_TTL_SECONDS,
  TEMPORARY_MAILBOX_TYPE,
  MAX_TEMP_NAME_LENGTH,
  calculateStoredBytes,
  generateTemporaryLocalPart,
  isReservedMailboxName,
  parseTemporaryTtl,
  sanitizeTemporaryName,
  temporaryRouteAllowed,
  temporaryOperationAllowed,
} from './temporary';

describe('temporary mailbox policy', () => {
  it('defaults the API TTL to one hour and enforces the documented bounds', () => {
    expect(parseTemporaryTtl(undefined)).toBe(3600);
    expect(parseTemporaryTtl('300')).toBe(MIN_TEMP_TTL_SECONDS);
    expect(parseTemporaryTtl(String(MAX_TEMP_TTL_SECONDS))).toBe(MAX_TEMP_TTL_SECONDS);
    expect(() => parseTemporaryTtl('299')).toThrow();
    expect(() => parseTemporaryTtl(String(MAX_TEMP_TTL_SECONDS + 1))).toThrow();
    expect(() => parseTemporaryTtl('1h')).toThrow();
  });

  it('creates a recognizable random local part from an optional name', () => {
    const generated = generateTemporaryLocalPart('My Agent');
    expect(generated).toMatch(/^my-agent-[a-f0-9]{20}$/);
    expect(generateTemporaryLocalPart()).toMatch(/^tmp-[a-f0-9]{20}$/);
  });

  it('accounts for raw, parsed, and attachment bytes', () => {
    expect(calculateStoredBytes(new Uint8Array(10), 'hello', '<p>hello</p>', [new Uint8Array(20)])).toBe(47);
  });

  it('uses ten random bytes without truncating the suffix', () => {
    const lengths: number[] = [];
    const original = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
      lengths.push(bytes.byteLength);
      return original(bytes);
    });
    generateTemporaryLocalPart('agent');
    expect(lengths).toEqual([10]);
    vi.restoreAllMocks();
  });

  it('keeps the generated address within the 64-character SMTP local-part limit', () => {
    const localPart = generateTemporaryLocalPart('a'.repeat(100));
    expect(MAX_TEMP_NAME_LENGTH).toBe(43);
    expect(localPart).toHaveLength(64);
    expect(localPart.length).toBeLessThanOrEqual(64);
    expect(sanitizeTemporaryName('a'.repeat(100))).toHaveLength(MAX_TEMP_NAME_LENGTH);
  });

  it('allows only receive-side operations for temporary mailboxes', () => {
    expect(temporaryOperationAllowed(TEMPORARY_MAILBOX_TYPE, 'messages.read')).toBe(true);
    expect(temporaryOperationAllowed(TEMPORARY_MAILBOX_TYPE, 'messages.delete')).toBe(true);
    expect(temporaryOperationAllowed(TEMPORARY_MAILBOX_TYPE, 'messages.send')).toBe(false);
    expect(temporaryOperationAllowed(TEMPORARY_MAILBOX_TYPE, 'drafts.create')).toBe(false);
    expect(temporaryOperationAllowed('persistent', 'messages.send')).toBe(true);
  });

  it('rejects mutation routes while preserving receive routes', () => {
    expect(temporaryRouteAllowed('/api/v1/mail/messages', 'GET')).toBe(true);
    expect(temporaryRouteAllowed('/api/v1/mail/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV', 'DELETE')).toBe(true);
    expect(temporaryRouteAllowed('/api/v1/mail/send', 'POST')).toBe(false);
    expect(temporaryRouteAllowed('/api/v1/mail/drafts', 'POST')).toBe(false);
    expect(temporaryRouteAllowed('/api/v1/mail/rooms', 'GET')).toBe(false);
    expect(temporaryRouteAllowed('/api/v1/mail/keys/abc', 'DELETE')).toBe(false);
  });

  it('reserves brand and role aliases for every provisioning path', () => {
    for (const name of ['admin', 'postmaster', 'support', 'sales', 'contact', 'hello', 'customer', 'marketing', 'noc', 'billing', 'payments', 'privacy', 'customerservice', 'feedback', 'everyone', 'lens', 'lens-cli', 'lenscli', 'no.reply', 'mailer-daemon']) {
      expect(isReservedMailboxName(name)).toBe(true);
    }
    expect(isReservedMailboxName('my-agent')).toBe(false);
  });
});
