import { describe, expect, it } from 'vitest';
import { formatFromHeader, validateDisplayName } from './display-name';

describe('mailbox display names', () => {
  it('formats the provider From header without changing the mailbox address', () => {
    expect(formatFromHeader('checkout-agent@lenscli.com', 'Checkout Agent'))
      .toBe('Checkout Agent <checkout-agent@lenscli.com>');
    expect(formatFromHeader('checkout-agent@lenscli.com', null))
      .toBe('checkout-agent@lenscli.com');
  });

  it('rejects header control characters and overlong display names', () => {
    expect(() => validateDisplayName('Checkout\r\nBcc: attacker@example.com')).toThrow();
    expect(() => validateDisplayName('a'.repeat(101))).toThrow();
    expect(validateDisplayName('  Checkout Agent  ')).toBe('Checkout Agent');
  });
});
