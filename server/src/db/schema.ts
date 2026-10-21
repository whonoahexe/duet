import { sqliteTable, text, integer, index, primaryKey, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /**
   * The profile photo attachment (QT-5zd-photo-store). Shared: either person may change either
   * photo. No FK on purpose: users and attachments would reference each other and SQLite would need
   * a table rebuild; the server only ever writes ids it has validated (T-5zd-02).
   */
  photoId: text("photo_id"),
})

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), // sha256(token) hex
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  userAgent: text("user_agent"),
})

/**
 * One row per message in the single conversation (D-07: a message owns 1..10 attachments).
 * `seq` is the total order and the history paging key; `id` is the client UUID used for dedup
 * (CHAT-04); `updated_seq` is the global change cursor bumped on every write (CHAT-05).
 */
export const messages = sqliteTable(
  "messages",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    senderId: text("sender_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind", { enum: ["text", "media", "voice"] }).notNull(),
    /** Message text or album caption, stored exactly as sent (no trim, no normalization). */
    body: text("body"),
    replyToSeq: integer("reply_to_seq").references((): AnySQLiteColumn => messages.seq),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedSeq: integer("updated_seq").notNull(),
  },
  (t) => [index("messages_updated_seq_idx").on(t.updatedSeq)],
)

/** Uploaded media. message_seq is null until the album message is created; position orders the album. */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(), // 128-bit random base64url (unguessable)
    uploaderId: text("uploader_id")
      .notNull()
      .references(() => users.id),
    messageSeq: integer("message_seq").references(() => messages.seq),
    position: integer("position").notNull().default(0), // 0..9 within the album
    kind: text("kind", { enum: ["image", "video", "audio"] }).notNull(),
    status: text("status", { enum: ["uploading", "processing", "ready", "failed"] }).notNull(),
    declaredSize: integer("declared_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    /** JSON number[] (0..100 per bar), voice notes only. */
    waveform: text("waveform"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("attachments_message_seq_idx").on(t.messageSeq)],
)

/** One reaction per person per message (D-04). The emoji is validated on write only. */
export const reactions = sqliteTable(
  "reactions",
  {
    messageSeq: integer("message_seq")
      .notNull()
      .references(() => messages.seq, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    emoji: text("emoji").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageSeq, t.userId] })],
)

/** Per-person read cursor (CHAT-07): the highest seq this person has seen. */
export const readState = sqliteTable("read_state", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  lastReadSeq: integer("last_read_seq").notNull().default(0),
  readAt: integer("read_at", { mode: "timestamp_ms" }),
})

/** Web Push subscriptions, bound to the session that saved them (logout removes them, Pitfall 9). */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastOkAt: integer("last_ok_at", { mode: "timestamp_ms" }),
})
