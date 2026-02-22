-- Migration 0002: Email security — auth results, security flags, sender rate limiting
--
-- Stores SPF/DKIM/DMARC results per message so agents can assess sender trust.
-- Stores security_flags JSON for prompt injection, impersonation, risky attachments.
-- Adds sender_rate table for inbound flooding protection.

-- Add individual auth result columns to messages
ALTER TABLE messages ADD COLUMN spf_result TEXT DEFAULT 'unknown';
ALTER TABLE messages ADD COLUMN dkim_result TEXT DEFAULT 'unknown';
ALTER TABLE messages ADD COLUMN dmarc_result TEXT DEFAULT 'unknown';

-- Security flags: JSON array of {flag, message, severity, details}
-- Populated by security hooks engine on inbound processing
ALTER TABLE messages ADD COLUMN security_flags TEXT;

-- Per-sender inbound rate tracking
-- Tracks email counts per sender per mailbox per hour window.
CREATE TABLE IF NOT EXISTS sender_rate (
  mailbox_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  window TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mailbox_id, sender, window)
);

CREATE INDEX IF NOT EXISTS idx_sender_rate_window ON sender_rate(window);
