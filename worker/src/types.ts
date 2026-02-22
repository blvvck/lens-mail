/** Cloudflare Worker bindings */
export interface Env {
  // Storage
  DB: D1Database;
  MAIL_BUCKET: R2Bucket;

  // Queues
  INBOUND_QUEUE: Queue<InboundMessage>;
  OUTBOUND_QUEUE: Queue<OutboundMessage>;

  // Config vars
  DOMAIN: string;
  SEND_DOMAIN: string;
  MAX_SEND_PER_HOUR: string;
  MAX_SEND_PER_DAY: string;
  DEFAULT_RETENTION_DAYS: string;

  // Secrets
  ZEPTOMAIL_TOKEN: string;
  ADMIN_KEY: string;
}

/** Queue message for inbound email processing */
export interface InboundMessage {
  mailboxId: string;
  messageId: string; // our ULID
  r2Key: string; // path in R2 where raw email is stored
  receivedAt: string;
}

/** Queue message for outbound email sending */
export interface OutboundMessage {
  sendId: string; // ULID, matches outbound_sends.id
  mailboxId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  r2Key: string; // path in R2 where body/attachments are stored
  attempt: number;
}

/** Authenticated request context (attached by auth middleware) */
export interface AuthContext {
  mailboxId: string;
  address: string;
  keyId: string;
}

/** API response envelope */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: number;
}

/** Message metadata from D1 */
export interface MessageMeta {
  id: string;
  mailbox_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  from_address: string;
  from_name: string | null;
  to_address: string;
  subject: string;
  snippet: string;
  received_at: string;
  r2_key: string;
  read: number;
  has_code: number;
  has_link: number;
  has_attachment: number;
  attachment_count: number;
  spam_score: number;
  spf_result: string;
  dkim_result: string;
  dmarc_result: string;
  security_flags: string; // JSON array of SecurityFlag objects
  size_bytes: number;
  status: string;
  direction: string;
}

/** Room metadata */
export interface Room {
  id: string;
  name: string;
  description: string;
  created_by: string;
  created_at: string;
  settings: string;
}

/** Room member */
export interface RoomMember {
  room_id: string;
  mailbox_id: string;
  role: string;
  status: string;
  last_read_seq: number;
  joined_at: string;
}

/** Room message */
export interface RoomMessage {
  id: string;
  room_id: string;
  seq: number;
  sender_id: string;
  sender_address: string;
  content: string;
  message_type: string;
  created_at: string;
}
