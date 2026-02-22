-- Migration: Rooms v2 — add description, member status, seq ordering
-- Run against D1 before deploying the updated rooms.ts

-- Add description column to rooms
ALTER TABLE rooms ADD COLUMN description TEXT DEFAULT '';

-- Add status and last_read_seq to room_members
ALTER TABLE room_members ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE room_members ADD COLUMN last_read_seq INTEGER NOT NULL DEFAULT 0;

-- Add seq column to room_messages
ALTER TABLE room_messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

-- Update index to use seq instead of created_at
DROP INDEX IF EXISTS idx_room_messages_room;
CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, seq ASC);
