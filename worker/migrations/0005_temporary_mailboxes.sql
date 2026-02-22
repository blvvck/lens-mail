ALTER TABLE mailboxes ADD COLUMN mailbox_type TEXT NOT NULL DEFAULT 'persistent';
ALTER TABLE mailboxes ADD COLUMN expires_at TEXT;
ALTER TABLE messages ADD COLUMN storage_bytes INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_mailboxes_expiry ON mailboxes(expires_at) WHERE expires_at IS NOT NULL;
