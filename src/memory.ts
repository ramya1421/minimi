/**
 * memory.ts — conversation storage and ledger
 *
 * Uses better-sqlite3 (synchronous) so there is no async complexity here.
 * Two tables:
 *   messages  — every message with timestamp, role, content, threadId, userId
 *   ledger    — one row per assistant turn summarising the key claims made
 *
 * The ledger is what gets injected as "past conversations" context into
 * the system prompt, keeping it compact.  Full message history is retrieved
 * only when a specific date range is queried.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { DateRange, formatAbsolute } from "./dates";

const DB_PATH = path.join(process.cwd(), "data", "memory.db");

// Ensure the data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ── schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    userId    TEXT    NOT NULL,
    threadId  TEXT    NOT NULL,
    role      TEXT    NOT NULL,  -- 'user' | 'assistant'
    content   TEXT    NOT NULL,
    createdAt TEXT    NOT NULL   -- ISO 8601
  );

  CREATE INDEX IF NOT EXISTS idx_messages_user_time
    ON messages (userId, createdAt);

  CREATE TABLE IF NOT EXISTS ledger (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    userId    TEXT    NOT NULL,
    threadId  TEXT    NOT NULL,
    createdAt TEXT    NOT NULL,  -- ISO 8601, timestamp of the assistant turn
    topic     TEXT    NOT NULL,  -- one-line summary of what was asked
    claims    TEXT    NOT NULL   -- JSON array of key factual claims
  );

  CREATE INDEX IF NOT EXISTS idx_ledger_user_time
    ON ledger (userId, createdAt);
`);

// ── types ────────────────────────────────────────────────────────────────────

export interface Message {
  id?: number;
  userId: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string; // ISO 8601
}

export interface LedgerEntry {
  id?: number;
  userId: string;
  threadId: string;
  createdAt: string;
  topic: string;
  claims: string[]; // key factual claims from the assistant answer
}

// ── prepared statements ───────────────────────────────────────────────────────

const insertMessage = db.prepare(`
  INSERT INTO messages (userId, threadId, role, content, createdAt)
  VALUES (@userId, @threadId, @role, @content, @createdAt)
`);

const insertLedger = db.prepare(`
  INSERT INTO ledger (userId, threadId, createdAt, topic, claims)
  VALUES (@userId, @threadId, @createdAt, @topic, @claims)
`);

const getMessagesByDateRange = db.prepare(`
  SELECT * FROM messages
  WHERE userId = @userId
    AND createdAt >= @start
    AND createdAt <= @end
  ORDER BY createdAt ASC
`);

const getLedgerByDateRange = db.prepare(`
  SELECT * FROM ledger
  WHERE userId = @userId
    AND createdAt >= @start
    AND createdAt <= @end
  ORDER BY createdAt ASC
`);

const getRecentLedger = db.prepare(`
  SELECT * FROM ledger
  WHERE userId = @userId
  ORDER BY createdAt DESC
  LIMIT @limit
`);

const getThreadMessages = db.prepare(`
  SELECT * FROM messages
  WHERE threadId = @threadId
  ORDER BY createdAt ASC
`);

// ── public API ────────────────────────────────────────────────────────────────

export function saveMessage(msg: Omit<Message, "id">): void {
  insertMessage.run(msg);
}

export function saveLedgerEntry(entry: Omit<LedgerEntry, "id">): void {
  insertLedger.run({
    ...entry,
    claims: JSON.stringify(entry.claims),
  });
}

/**
 * Get messages from a specific date range for a user.
 * Returns an empty array (not null) when nothing is found.
 */
export function getMessagesInRange(
  userId: string,
  range: DateRange
): Message[] {
  return getMessagesByDateRange.all({
    userId,
    start: range.start.toISOString(),
    end: range.end.toISOString(),
  }) as Message[];
}

/**
 * Get ledger entries from a specific date range.
 */
export function getLedgerInRange(
  userId: string,
  range: DateRange
): LedgerEntry[] {
  const rows = getLedgerByDateRange.all({
    userId,
    start: range.start.toISOString(),
    end: range.end.toISOString(),
  }) as Array<LedgerEntry & { claims: string }>;

  return rows.map((r) => ({ ...r, claims: JSON.parse(r.claims) }));
}

/**
 * Get the N most recent ledger entries for a user (for the "past conversations"
 * block injected into every request).
 */
export function getRecentLedgerEntries(
  userId: string,
  limit = 20
): LedgerEntry[] {
  const rows = getRecentLedger.all({ userId, limit }) as Array<
    LedgerEntry & { claims: string }
  >;
  return rows.map((r) => ({ ...r, claims: JSON.parse(r.claims) }));
}

/**
 * Get all messages for a thread (for passing as conversation history to the
 * model).
 */
export function getThreadHistory(threadId: string): Message[] {
  return getThreadMessages.all({ threadId }) as Message[];
}

/**
 * Build the "Relevant prior conversation" block to inject into the prompt
 * when the user references a past date.
 *
 * Returns null if no messages were found for the date range.
 */
export function buildPriorContextBlock(
  userId: string,
  range: DateRange
): string | null {
  const messages = getMessagesInRange(userId, range);
  if (messages.length === 0) return null;

  const lines: string[] = [
    `## Relevant prior conversation (${formatAbsolute(range.start)} – ${formatAbsolute(range.end)})`,
    "",
  ];

  for (const msg of messages) {
    const when = formatAbsolute(new Date(msg.createdAt));
    const speaker = msg.role === "user" ? "User" : "Assistant";
    lines.push(`**${speaker}** [${when}]`);
    lines.push(msg.content);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Build the compact ledger block injected into every request so the model
 * knows what has been discussed before.
 */
export function buildLedgerBlock(userId: string): string {
  const entries = getRecentLedgerEntries(userId, 20);
  if (entries.length === 0) return "";

  const lines: string[] = ["## Past conversation summaries", ""];

  for (const entry of entries) {
    const when = formatAbsolute(new Date(entry.createdAt));
    lines.push(`**[${when}]** ${entry.topic}`);
    for (const claim of entry.claims) {
      lines.push(`  - ${claim}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Export the db instance so eval scripts can seed it directly
export { db };
