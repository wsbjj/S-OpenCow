// SPDX-License-Identifier: Apache-2.0

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

interface LegacyMessageRow {
  session_id: string
  messages: string
}

interface SessionIdRow {
  id: string
}

interface MessageItemRow {
  session_id: string
  ordinal: number
  content_json: string
}

interface LegacyMessage {
  id?: unknown
  role?: unknown
  timestamp?: unknown
  content?: unknown
  event?: unknown
}

interface PreparedMessageItem {
  sessionId: string
  ordinal: number
  messageId: string
  turnIndex: number
  role: string
  timestamp: number
  contentJson: string
  textContent: string
}

const SUMMARY_LIMIT = 80
const INSERT_CHUNK_SIZE = 200

function parseMessages(raw: string): LegacyMessage[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as LegacyMessage[]) : []
  } catch {
    return []
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function extractBlockText(block: unknown): string {
  if (!block || typeof block !== 'object') return ''
  const typed = block as Record<string, unknown>
  switch (typed.type) {
    case 'text':
      return typeof typed.text === 'string' ? typed.text : ''
    case 'slash_command': {
      const label = typeof typed.label === 'string' ? `/${typed.label}` : ''
      const expanded = typeof typed.expandedText === 'string' ? typed.expandedText : ''
      return [label, expanded].filter(Boolean).join(' ')
    }
    case 'tool_use': {
      const name = typeof typed.name === 'string' ? typed.name : ''
      const input = stringifyValue(typed.input)
      const progress = typeof typed.progress === 'string' ? typed.progress : ''
      return [name, input, progress].filter(Boolean).join(' ')
    }
    case 'tool_result':
      return stringifyValue(typed.content)
    case 'thinking':
      return typeof typed.thinking === 'string' ? typed.thinking : ''
    case 'document':
      return typeof typed.title === 'string' ? typed.title : ''
    default:
      return ''
  }
}

function extractMessageText(message: LegacyMessage): string {
  if (Array.isArray(message.content)) {
    return message.content.map(extractBlockText).filter(Boolean).join(' ').trim()
  }
  if (message.role === 'system') {
    return stringifyValue(message.event)
  }
  return ''
}

function hasImage(message: LegacyMessage): boolean {
  return Array.isArray(message.content) && message.content.some((block) => {
    return !!block && typeof block === 'object' && (block as Record<string, unknown>).type === 'image'
  })
}

function firstUserSummary(messages: LegacyMessage[]): string | null {
  const firstUser = messages.find((message) => message.role === 'user')
  if (!firstUser) return null
  const text = extractMessageText(firstUser)
  if (text.length > 0) {
    return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text
  }
  return hasImage(firstUser) ? '(image)' : null
}

function prepareMessageItems(sessionId: string, messages: LegacyMessage[]): PreparedMessageItem[] {
  let turnIndex = -1
  return messages.map((message, ordinal) => {
    if (message.role === 'user') turnIndex += 1
    const role = typeof message.role === 'string' ? message.role : 'system'
    const messageId = typeof message.id === 'string' && message.id.length > 0
      ? message.id
      : `${sessionId}-${ordinal}`
    const timestamp = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
      ? message.timestamp
      : 0
    return {
      sessionId,
      ordinal,
      messageId,
      turnIndex: Math.max(turnIndex, 0),
      role,
      timestamp,
      contentJson: JSON.stringify(message),
      textContent: extractMessageText(message),
    }
  })
}

async function insertMessageItems(
  db: Kysely<unknown>,
  rows: PreparedMessageItem[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE)
    if (chunk.length === 0) continue
    await sql`
      INSERT INTO managed_session_message_items (
        session_id, ordinal, message_id, turn_index, role, timestamp, content_json, text_content
      )
      VALUES ${sql.join(chunk.map((row) => sql`(
        ${row.sessionId},
        ${row.ordinal},
        ${row.messageId},
        ${row.turnIndex},
        ${row.role},
        ${row.timestamp},
        ${row.contentJson},
        ${row.textContent}
      )`))}
    `.execute(db)
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE managed_sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0`.execute(db)
  await sql`ALTER TABLE managed_sessions ADD COLUMN first_user_summary TEXT`.execute(db)

  await sql`
    CREATE TABLE managed_session_message_items (
      session_id   TEXT    NOT NULL REFERENCES managed_sessions(id) ON DELETE CASCADE,
      ordinal      INTEGER NOT NULL,
      message_id   TEXT    NOT NULL,
      turn_index   INTEGER NOT NULL,
      role         TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      content_json TEXT    NOT NULL,
      text_content TEXT    NOT NULL DEFAULT '',
      PRIMARY KEY (session_id, ordinal),
      UNIQUE (session_id, message_id)
    )
  `.execute(db)

  await sql`
    CREATE INDEX idx_session_message_items_session_ordinal
    ON managed_session_message_items (session_id, ordinal)
  `.execute(db)

  await sql`
    CREATE INDEX idx_session_message_items_session_turn
    ON managed_session_message_items (session_id, turn_index)
  `.execute(db)

  await sql`
    CREATE VIRTUAL TABLE managed_session_message_items_fts USING fts5(
      text_content,
      content='managed_session_message_items',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    )
  `.execute(db)

  await sql`
    CREATE TRIGGER managed_session_message_items_fts_ai
    AFTER INSERT ON managed_session_message_items BEGIN
      INSERT INTO managed_session_message_items_fts(rowid, text_content)
      VALUES (new.rowid, new.text_content);
    END
  `.execute(db)

  await sql`
    CREATE TRIGGER managed_session_message_items_fts_au
    AFTER UPDATE OF text_content ON managed_session_message_items BEGIN
      INSERT INTO managed_session_message_items_fts(
        managed_session_message_items_fts, rowid, text_content
      )
      VALUES ('delete', old.rowid, old.text_content);
      INSERT INTO managed_session_message_items_fts(rowid, text_content)
      VALUES (new.rowid, new.text_content);
    END
  `.execute(db)

  await sql`
    CREATE TRIGGER managed_session_message_items_fts_ad
    AFTER DELETE ON managed_session_message_items BEGIN
      INSERT INTO managed_session_message_items_fts(
        managed_session_message_items_fts, rowid, text_content
      )
      VALUES ('delete', old.rowid, old.text_content);
    END
  `.execute(db)

  const legacyRows = (await sql<LegacyMessageRow>`
    SELECT session_id, messages FROM managed_session_messages
  `.execute(db)).rows

  for (const legacy of legacyRows) {
    const messages = parseMessages(legacy.messages)
    const items = prepareMessageItems(legacy.session_id, messages)
    await insertMessageItems(db, items)
    await sql`
      UPDATE managed_sessions
      SET message_count = ${messages.length},
          first_user_summary = ${firstUserSummary(messages)}
      WHERE id = ${legacy.session_id}
    `.execute(db)
  }

  await sql`DROP TABLE managed_session_messages`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE managed_session_messages (
      session_id TEXT PRIMARY KEY NOT NULL REFERENCES managed_sessions(id) ON DELETE CASCADE,
      messages   TEXT NOT NULL DEFAULT '[]'
    )
  `.execute(db)

  const sessions = (await sql<SessionIdRow>`SELECT id FROM managed_sessions`.execute(db)).rows
  const itemRows = (await sql<MessageItemRow>`
    SELECT session_id, ordinal, content_json
    FROM managed_session_message_items
    ORDER BY session_id ASC, ordinal ASC
  `.execute(db)).rows

  const grouped = new Map<string, string[]>()
  for (const row of itemRows) {
    const messages = grouped.get(row.session_id) ?? []
    messages.push(row.content_json)
    grouped.set(row.session_id, messages)
  }

  for (const session of sessions) {
    const content = `[${(grouped.get(session.id) ?? []).join(',')}]`
    await sql`
      INSERT INTO managed_session_messages (session_id, messages)
      VALUES (${session.id}, ${content})
    `.execute(db)
  }

  await sql`DROP TRIGGER IF EXISTS managed_session_message_items_fts_ad`.execute(db)
  await sql`DROP TRIGGER IF EXISTS managed_session_message_items_fts_au`.execute(db)
  await sql`DROP TRIGGER IF EXISTS managed_session_message_items_fts_ai`.execute(db)
  await sql`DROP TABLE IF EXISTS managed_session_message_items_fts`.execute(db)
  await sql`DROP TABLE IF EXISTS managed_session_message_items`.execute(db)
  await sql`ALTER TABLE managed_sessions DROP COLUMN first_user_summary`.execute(db)
  await sql`ALTER TABLE managed_sessions DROP COLUMN message_count`.execute(db)
}
