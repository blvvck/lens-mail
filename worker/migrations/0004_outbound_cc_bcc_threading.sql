ALTER TABLE outbound_sends ADD COLUMN cc_address TEXT;
ALTER TABLE outbound_sends ADD COLUMN bcc_address TEXT;
ALTER TABLE outbound_sends ADD COLUMN in_reply_to TEXT;
ALTER TABLE outbound_sends ADD COLUMN references_header TEXT;
