// SPDX-License-Identifier: Apache-2.0

import type { Kysely } from 'kysely'
import type { Database } from '../database/types'
import type { ManagedSessionInfo } from '../../src/shared/types'
import {
  managedSessionInfoToMessagesRow,
  managedSessionInfoToRow,
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
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * No-op for SQLite — kept for API compatibility.
   */
  async load(): Promise<void> {
    // intentionally empty
  }

  async save(session: ManagedSessionInfo): Promise<void> {
    const row = managedSessionInfoToRow(session)
    const messagesRow = managedSessionInfoToMessagesRow(session)

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
        .insertInto('managed_session_messages')
        .values(messagesRow)
        .onConflict((oc) =>
          oc.column('session_id').doUpdateSet({
            messages: messagesRow.messages,
          })
        )
        .execute()
    })
  }

  async remove(sessionId: string): Promise<void> {
    await this.db.deleteFrom('managed_sessions').where('id', '=', sessionId).execute()
  }

  private async getMessagesJson(sessionId: string): Promise<string> {
    const row = await this.db
      .selectFrom('managed_session_messages')
      .select('messages')
      .where('session_id', '=', sessionId)
      .executeTakeFirst()

    return row?.messages ?? '[]'
  }

  async get(sessionId: string): Promise<ManagedSessionInfo | null> {
    const row = await this.db
      .selectFrom('managed_sessions')
      .select(MANAGED_SESSION_COLUMNS)
      .where('id', '=', sessionId)
      .executeTakeFirst()

    if (!row) return null

    return managedSessionRowToInfo(row, await this.getMessagesJson(row.id))
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
    if (idMatch) return managedSessionRowToInfo(idMatch, await this.getMessagesJson(idMatch.id))

    const engineRefMatch = await this.db
      .selectFrom('managed_sessions')
      .select(MANAGED_SESSION_COLUMNS)
      .where('sdk_session_id', 'in', refs)
      .orderBy('last_activity', 'desc')
      .executeTakeFirst()
    if (engineRefMatch) {
      return managedSessionRowToInfo(engineRefMatch, await this.getMessagesJson(engineRefMatch.id))
    }

    return null
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

    return result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0)
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
