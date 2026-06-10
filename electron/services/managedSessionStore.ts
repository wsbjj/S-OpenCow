// SPDX-License-Identifier: Apache-2.0

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../database/types'
import type {
  ManagedSessionInfo,
  ManagedSessionMessage,
  SessionMessagePage,
  SessionMessagePageParams,
  SessionMessageSearchMatch,
  SessionSnapshot,
} from '../../src/shared/types'
import {
  managedSessionInfoToMessageItemRows,
  managedSessionInfoToRow,
  messageItemRowToMessage,
  managedSessionRowToInfo,
} from './mappers/managedSessionRowMapper'

const MANAGED_SESSION_COLUMNS = [
  'id',
  'sdk_session_id',
  'engine_kind',
  'engine_state_json',
  'state',
  'stop_reason',
  'origin_source',
  'origin_id',
  'origin_extra',
  'project_path',
  'project_id',
  'desired_engine_kind',
  'desired_model',
  'model',
  'message_count',
  'first_user_summary',
  'created_at',
  'last_activity',
  'active_duration_ms',
  'active_started_at',
  'total_cost_usd',
  'input_tokens',
  'output_tokens',
  'last_input_tokens',
  'activity',
  'error',
  'execution_context',
] as const

const FULL_SESSION_CACHE_LIMIT = 3
const DEFAULT_MESSAGE_PAGE_LIMIT = 100
const MAX_MESSAGE_PAGE_LIMIT = 500
const MESSAGE_INSERT_CHUNK_SIZE = 200

function clampPageLimit(limit: number | undefined, fallback = DEFAULT_MESSAGE_PAGE_LIMIT): number {
  if (!Number.isFinite(limit ?? NaN)) return fallback
  return Math.max(1, Math.min(MAX_MESSAGE_PAGE_LIMIT, Math.trunc(limit!)))
}

function sanitizeFTS5Token(token: string): string {
  return token.replace(/[*+\-:.()]/g, '').trim()
}

function buildFTS5Query(query: string): string | null {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map(sanitizeFTS5Token)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`)

  return tokens.length > 0 ? tokens.join(' AND ') : null
}

/**
 * Persists ManagedSessionInfo snapshots to SQLite so that
 * Issue ↔ Session links survive app restarts.
 *
 * Only stopped / error sessions are stored — active sessions
 * are ephemeral and tracked by SessionOrchestrator in memory.
 *
 * With SQLite + WAL mode, concurrent writes are handled at the
 * database level, so the old write-chain pattern is no longer needed.
 */
export class ManagedSessionStore {
  private readonly fullSessionCache = new Map<string, ManagedSessionInfo>()

  constructor(private readonly db: Kysely<Database>) {}

  /**
   * No-op for SQLite — kept for API compatibility.
   */
  async load(): Promise<void> {
    // intentionally empty
  }

  async save(session: ManagedSessionInfo): Promise<void> {
    const row = managedSessionInfoToRow(session)
    const messageRows = managedSessionInfoToMessageItemRows(session)

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('managed_sessions')
        .values(row)
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            sdk_session_id: row.sdk_session_id,
            engine_kind: row.engine_kind,
            engine_state_json: row.engine_state_json,
            state: row.state,
            stop_reason: row.stop_reason,
            origin_source: row.origin_source,
            origin_id: row.origin_id,
            origin_extra: row.origin_extra,
            project_path: row.project_path,
            project_id: row.project_id,
            desired_engine_kind: row.desired_engine_kind,
            desired_model: row.desired_model,
            model: row.model,
            message_count: row.message_count,
            first_user_summary: row.first_user_summary,
            created_at: row.created_at,
            last_activity: row.last_activity,
            active_duration_ms: row.active_duration_ms,
            active_started_at: row.active_started_at,
            total_cost_usd: row.total_cost_usd,
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            last_input_tokens: row.last_input_tokens,
            activity: row.activity,
            error: row.error,
            execution_context: row.execution_context,
          })
        )
        .execute()

      await trx
        .deleteFrom('managed_session_message_items')
        .where('session_id', '=', session.id)
        .execute()

      for (let i = 0; i < messageRows.length; i += MESSAGE_INSERT_CHUNK_SIZE) {
        await trx
          .insertInto('managed_session_message_items')
          .values(messageRows.slice(i, i + MESSAGE_INSERT_CHUNK_SIZE))
          .execute()
      }
    })

    this.setCachedFullSession(session)
  }

  async remove(sessionId: string): Promise<void> {
    await this.db.deleteFrom('managed_sessions').where('id', '=', sessionId).execute()
    this.fullSessionCache.delete(sessionId)
  }

  private getCachedFullSession(sessionId: string): ManagedSessionInfo | null {
    const cached = this.fullSessionCache.get(sessionId)
    if (!cached) return null
    this.fullSessionCache.delete(sessionId)
    this.fullSessionCache.set(sessionId, cached)
    return cached
  }

  private setCachedFullSession(session: ManagedSessionInfo): void {
    this.fullSessionCache.delete(session.id)
    this.fullSessionCache.set(session.id, session)
    while (this.fullSessionCache.size > FULL_SESSION_CACHE_LIMIT) {
      const oldest = this.fullSessionCache.keys().next().value
      if (!oldest) break
      this.fullSessionCache.delete(oldest)
    }
  }

  private async getMessages(sessionId: string): Promise<ManagedSessionMessage[]> {
    const rows = await this.db
      .selectFrom('managed_session_message_items')
      .select('content_json')
      .where('session_id', '=', sessionId)
      .orderBy('ordinal', 'asc')
      .execute()

    return rows
      .map((row) => messageItemRowToMessage(row))
      .filter((message): message is ManagedSessionMessage => message !== null)
  }

  private rowToSnapshot(row: Parameters<typeof managedSessionRowToInfo>[0]): SessionSnapshot {
    const { messages: _messages, ...snapshot } = managedSessionRowToInfo(row, '[]')
    return snapshot
  }

  async getSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const row = await this.db
      .selectFrom('managed_sessions')
      .select(MANAGED_SESSION_COLUMNS)
      .where('id', '=', sessionId)
      .executeTakeFirst()

    return row ? this.rowToSnapshot(row) : null
  }

  async get(sessionId: string): Promise<ManagedSessionInfo | null> {
    const cached = this.getCachedFullSession(sessionId)
    if (cached) return cached

    const row = await this.db
      .selectFrom('managed_sessions')
      .select(MANAGED_SESSION_COLUMNS)
      .where('id', '=', sessionId)
      .executeTakeFirst()

    if (!row) return null

    const messages = await this.getMessages(row.id)
    const session = managedSessionRowToInfo(row, JSON.stringify(messages))
    this.setCachedFullSession(session)
    return session
  }

  /**
   * Resolve a managed session by any known session reference.
   * Supports OpenCow session ID and engine session ref (sdk_session_id).
   *
   * Selection policy:
   * 1. Prefer exact OpenCow ID matches.
   * 2. Fall back to engine ref matches.
   * 3. For multi-match cases, return the most recently active row.
   */
  async findBySessionRefs(sessionRefs: string[]): Promise<ManagedSessionInfo | null> {
    const refs = [...new Set(sessionRefs.filter((v) => typeof v === 'string' && v.length > 0))]
    if (refs.length === 0) return null

    const idMatch = await this.db
      .selectFrom('managed_sessions')
      .select(MANAGED_SESSION_COLUMNS)
      .where('id', 'in', refs)
      .orderBy('last_activity', 'desc')
      .executeTakeFirst()
    if (idMatch) {
      const messages = await this.getMessages(idMatch.id)
      return managedSessionRowToInfo(idMatch, JSON.stringify(messages))
    }

    const engineRefMatch = await this.db
      .selectFrom('managed_sessions')
      .select(MANAGED_SESSION_COLUMNS)
      .where('sdk_session_id', 'in', refs)
      .orderBy('last_activity', 'desc')
      .executeTakeFirst()
    if (engineRefMatch) {
      const messages = await this.getMessages(engineRefMatch.id)
      return managedSessionRowToInfo(engineRefMatch, JSON.stringify(messages))
    }

    return null
  }

  async getMessagePage(
    sessionId: string,
    params: SessionMessagePageParams = {},
  ): Promise<SessionMessagePage> {
    const limit = clampPageLimit(params.limit)
    const session = await this.getSnapshot(sessionId)
    const totalCount = session?.messageCount ?? 0

    let rows: Array<{ ordinal: number; content_json: string }>

    if (typeof params.aroundOrdinal === 'number' && Number.isFinite(params.aroundOrdinal)) {
      const center = Math.trunc(params.aroundOrdinal)
      const beforeCount = Math.floor((limit - 1) / 2)
      const afterCount = limit - 1 - beforeCount
      const start = Math.max(0, center - beforeCount)
      const end = center + afterCount
      rows = await this.db
        .selectFrom('managed_session_message_items')
        .select(['ordinal', 'content_json'])
        .where('session_id', '=', sessionId)
        .where('ordinal', '>=', start)
        .where('ordinal', '<=', end)
        .orderBy('ordinal', 'asc')
        .execute()
    } else if (typeof params.beforeOrdinal === 'number' && Number.isFinite(params.beforeOrdinal)) {
      rows = await this.db
        .selectFrom('managed_session_message_items')
        .select(['ordinal', 'content_json'])
        .where('session_id', '=', sessionId)
        .where('ordinal', '<', Math.trunc(params.beforeOrdinal))
        .orderBy('ordinal', 'desc')
        .limit(limit)
        .execute()
      rows.reverse()
    } else {
      rows = await this.db
        .selectFrom('managed_session_message_items')
        .select(['ordinal', 'content_json'])
        .where('session_id', '=', sessionId)
        .orderBy('ordinal', 'desc')
        .limit(limit)
        .execute()
      rows.reverse()
    }

    const messages = rows
      .map((row) => messageItemRowToMessage(row))
      .filter((message): message is ManagedSessionMessage => message !== null)
    const oldestOrdinal = rows.length > 0 ? rows[0].ordinal : null
    const newestOrdinal = rows.length > 0 ? rows[rows.length - 1].ordinal : null

    return {
      sessionId,
      messages,
      oldestOrdinal,
      newestOrdinal,
      totalCount,
      hasMoreBefore: oldestOrdinal != null && oldestOrdinal > 0,
    }
  }

  async searchSessionMessages(
    sessionId: string,
    query: string,
    limit = 50,
  ): Promise<SessionMessageSearchMatch[]> {
    const ftsQuery = buildFTS5Query(query)
    if (!ftsQuery) return []
    const safeLimit = clampPageLimit(limit, 50)

    const result = await sql<{
      session_id: string
      message_id: string
      ordinal: number
      turn_index: number
      role: ManagedSessionMessage['role']
      snippet: string
    }>`
      SELECT
        item.session_id,
        item.message_id,
        item.ordinal,
        item.turn_index,
        item.role,
        snippet(managed_session_message_items_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet
      FROM managed_session_message_items_fts
      JOIN managed_session_message_items item
        ON item.rowid = managed_session_message_items_fts.rowid
      WHERE managed_session_message_items_fts MATCH ${ftsQuery}
        AND item.session_id = ${sessionId}
      ORDER BY item.ordinal ASC
      LIMIT ${safeLimit}
    `.execute(this.db)

    return result.rows.map((row) => ({
      sessionId: row.session_id,
      messageId: row.message_id,
      ordinal: row.ordinal,
      turnIndex: row.turn_index,
      role: row.role,
      snippet: row.snippet,
    }))
  }

  /**
   * Update project_path for all sessions belonging to a renamed project.
   *
   * Uses project_id (stable UUID) as the query predicate — more precise than
   * path prefix matching and immune to collisions with similarly-named projects.
   *
   * @returns Number of session records updated.
   */
  async migrateProjectPath(params: {
    projectId: string
    newPath: string
  }): Promise<number> {
    const result = await this.db
      .updateTable('managed_sessions')
      .set({ project_path: params.newPath })
      .where('project_id', '=', params.projectId)
      .execute()

    const count = result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0)
    if (count > 0) this.fullSessionCache.clear()
    return count
  }

  /**
   * Default cap for list() — avoids loading thousands of historical sessions
   * on startup.  200 covers several months of typical usage while keeping
   * bootstrap and per-flush overhead bounded.
   */
  static readonly DEFAULT_LIST_LIMIT = 200

  /**
   * List recent managed sessions, ordered by last_activity descending.
   *
   * @param limit  Maximum rows to return.  Defaults to DEFAULT_LIST_LIMIT.
   *               Pass `Infinity` to load all rows (use sparingly).
   */
  async list(limit: number = ManagedSessionStore.DEFAULT_LIST_LIMIT): Promise<ManagedSessionInfo[]> {
    let query = this.db
      .selectFrom('managed_sessions')
      .select(MANAGED_SESSION_COLUMNS)
      .orderBy('last_activity', 'desc')

    if (Number.isFinite(limit)) {
      query = query.limit(limit)
    }

    const rows = await query.execute()

    return rows.map((row) => managedSessionRowToInfo(row, '[]'))
  }
}
