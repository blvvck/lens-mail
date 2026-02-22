-- Lens Mail — D1 Schema
-- Metadata ONLY. Email bodies and attachments live in R2.
-- Every query scoped by mailbox_id via middleware.

-- Mailboxes: one per agent email address
CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,                    -- ulid
  address TEXT NOT NULL UNIQUE,           -- godel@lenscli.com
  display_name TEXT,                      -- optional friendly name
  domain TEXT NOT NULL DEFAULT 'lenscli.com',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settings TEXT DEFAULT '{}',             -- JSON: retention_days, poll_interval, etc.
  status TEXT NOT NULL DEFAULT 'active'   -- active | suspended | deleted
);

CREATE INDEX IF NOT EXISTS idx_mailboxes_address ON mailboxes(address);
CREATE INDEX IF NOT EXISTS idx_mailboxes_domain ON mailboxes(domain);

-- API Keys: multiple per mailbox (rotation support)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,                    -- ulid
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,                 -- SHA-256 of full key (lm_xxx)
  key_prefix TEXT NOT NULL,               -- first 8 chars for identification (lm_xxxxxxxx)
  label TEXT DEFAULT 'default',           -- human label for the key
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT                         -- NULL = active, timestamp = revoked
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_mailbox ON api_keys(mailbox_id);

-- Messages: metadata index for inbox queries
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,                    -- ulid
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  message_id TEXT,                        -- RFC 5322 Message-ID header
  in_reply_to TEXT,                       -- threading
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_address TEXT NOT NULL,
  subject TEXT DEFAULT '',
  snippet TEXT DEFAULT '',                -- first 200 chars of body text
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  r2_key TEXT NOT NULL,                   -- R2 path: mail/{mailbox_id}/{id}/
  read INTEGER NOT NULL DEFAULT 0,        -- 0 = unread, 1 = read
  has_code INTEGER NOT NULL DEFAULT 0,    -- detected OTP/verification code
  has_link INTEGER NOT NULL DEFAULT 0,    -- contains links
  has_attachment INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  spam_score REAL DEFAULT 0.0,            -- 0.0 = clean, 1.0 = spam
  spf_result TEXT DEFAULT 'unknown',      -- pass | fail | softfail | neutral | none | unknown
  dkim_result TEXT DEFAULT 'unknown',     -- pass | fail | none | unknown
  dmarc_result TEXT DEFAULT 'unknown',    -- pass | fail | none | unknown
  security_flags TEXT DEFAULT '[]',       -- JSON array of SecurityFlag objects from security hooks
  size_bytes INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',  -- active | deletion_pending | deleted
  direction TEXT NOT NULL DEFAULT 'inbound'  -- inbound | outbound
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_unread ON messages(mailbox_id, read) WHERE read = 0;
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(mailbox_id, from_address);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(mailbox_id, status);

-- Filters: persistent inbox filters/categories
CREATE TABLE IF NOT EXISTS filters (
  id TEXT PRIMARY KEY,                    -- ulid
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                     -- "receipts", "deploys", "auth"
  rules TEXT NOT NULL,                    -- JSON: {from: "*@stripe.com", subject: "deploy*"}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mailbox_id, name)
);

CREATE INDEX IF NOT EXISTS idx_filters_mailbox ON filters(mailbox_id);

-- Tags: user-defined labels on messages (junction table)
CREATE TABLE IF NOT EXISTS message_tags (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_message_tags_tag ON message_tags(tag);

-- Rooms: identity-based persistent messaging
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,                    -- ulid
  name TEXT NOT NULL UNIQUE,              -- "deploy-team"
  description TEXT DEFAULT '',            -- optional room description
  created_by TEXT NOT NULL,               -- mailbox address of creator
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settings TEXT DEFAULT '{}'              -- JSON: max_members, retention, etc.
);

CREATE INDEX IF NOT EXISTS idx_rooms_name ON rooms(name);

-- Room Members
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',    -- owner | admin | member
  status TEXT NOT NULL DEFAULT 'active',  -- invited | active | left
  last_read_seq INTEGER NOT NULL DEFAULT 0, -- last seq read by this member
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, mailbox_id)
);

-- Room Messages: seq-ordered within room
CREATE TABLE IF NOT EXISTS room_messages (
  id TEXT PRIMARY KEY,                    -- ulid
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,                   -- monotonically increasing per room
  sender_id TEXT NOT NULL,                -- mailbox_id
  sender_address TEXT NOT NULL,           -- godel@lenscli.com
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',  -- text | status | request | ack | data
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, seq ASC);

-- Outbound Queue tracking (for retry/dead-letter)
CREATE TABLE IF NOT EXISTS outbound_sends (
  id TEXT PRIMARY KEY,                    -- ulid (also the send_id returned to client)
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  idempotency_key TEXT UNIQUE,            -- client-generated UUID, expires 24h
  to_address TEXT NOT NULL,
  cc_address TEXT,                        -- comma-separated CC addresses
  bcc_address TEXT,                       -- comma-separated BCC addresses
  subject TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | sending | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  error_reason TEXT,
  in_reply_to TEXT,                       -- Message-ID of original (for threading)
  references_header TEXT,                 -- References header chain (for threading)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  r2_key TEXT                             -- R2 path for body/attachments
);

CREATE INDEX IF NOT EXISTS idx_outbound_mailbox ON outbound_sends(mailbox_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_idempotency ON outbound_sends(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_sends(status) WHERE status IN ('queued', 'sending');

-- Drafts (cloud-synced v2)
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,                    -- ulid
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  to_address TEXT,
  subject TEXT DEFAULT '',
  r2_key TEXT,                            -- R2 path for draft body
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_drafts_mailbox ON drafts(mailbox_id, updated_at DESC);

-- Rate limiting tracking
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,                   -- "send:{mailbox_id}:hourly" or "provision:{ip}:hourly"
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

-- Per-sender inbound rate tracking (flood detection)
CREATE TABLE IF NOT EXISTS sender_rate (
  mailbox_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  window TEXT NOT NULL,                   -- ISO hour: "2026-02-22T14"
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mailbox_id, sender, window)
);

CREATE INDEX IF NOT EXISTS idx_sender_rate_window ON sender_rate(window);

-- Sender blocklist: agent or human can block senders
-- Blocked senders are rejected at the edge (email worker)
CREATE TABLE IF NOT EXISTS blocked_senders (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,                   -- email address or @domain pattern
  reason TEXT DEFAULT '',                 -- why blocked (for audit)
  blocked_by TEXT NOT NULL DEFAULT 'agent', -- 'agent' | 'human'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mailbox_id, sender)
);

CREATE INDEX IF NOT EXISTS idx_blocked_senders_mailbox ON blocked_senders(mailbox_id);

-- BYOD domain verification
CREATE TABLE IF NOT EXISTS custom_domains (
  id TEXT PRIMARY KEY,                    -- ulid
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  domain TEXT NOT NULL UNIQUE,
  verification_token TEXT NOT NULL,       -- TXT record value for verification
  status TEXT NOT NULL DEFAULT 'pending', -- pending | verified | failed
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_custom_domains_domain ON custom_domains(domain);
