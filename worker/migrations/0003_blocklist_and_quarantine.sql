-- Migration 0003: Sender blocklist + message quarantine
--
-- blocked_senders: agent or human can block senders, rejected at edge
-- messages.status now supports 'quarantine' for held flagged emails

-- Sender blocklist
CREATE TABLE IF NOT EXISTS blocked_senders (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,           -- email address or @domain pattern
  reason TEXT DEFAULT '',         -- why blocked (for audit trail)
  blocked_by TEXT NOT NULL DEFAULT 'agent',  -- 'agent' | 'human'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mailbox_id, sender)
);

CREATE INDEX IF NOT EXISTS idx_blocked_senders_mailbox ON blocked_senders(mailbox_id);
