// SPDX-License-Identifier: Apache-2.0

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

async function recreateManagedSessionIndexes(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX idx_sessions_state ON managed_sessions (state)
  `.execute(db)

  await sql`
    CREATE INDEX idx_sessions_origin_source ON managed_sessions (origin_source)
  `.execute(db)

  await sql`
    CREATE INDEX idx_managed_sessions_engine_kind ON managed_sessions (engine_kind)
  `.execute(db)

  await sql`
    CREATE INDEX idx_managed_sessions_sdk_session_id
    ON managed_sessions (sdk_session_id)
    WHERE sdk_session_id IS NOT NULL
  `.execute(db)
}

/**
 * Migration 054 — Split large managed session message payloads out of
 * `managed_sessions`.
 *
 * The session list only needs metadata such as state, created_at and
 * last_activity. Keeping the large messages JSON in the same row forces list
 * reads to pull historical message bodies too. This migration moves the JSON
 * body into a one-to-one table so details can load it on demand.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db)

  try {
    await sql`
      CREATE TABLE managed_session_messages_tmp (
        session_id TEXT PRIMARY KEY NOT NULL,
        messages   TEXT NOT NULL DEFAULT '[]'
      )
    `.execute(db)

    await sql`
      INSERT INTO managed_session_messages_tmp (session_id, messages)
      SELECT id, messages
      FROM managed_sessions
    `.execute(db)

    await sql`
      CREATE TABLE managed_sessions_new (
        id                  TEXT    PRIMARY KEY NOT NULL,
        sdk_session_id      TEXT,
        engine_kind         TEXT    NOT NULL DEFAULT 'claude',
        engine_state_json   TEXT,
        state               TEXT    NOT NULL,
        stop_reason         TEXT,
        origin_source       TEXT    NOT NULL DEFAULT 'agent',
        origin_id           TEXT,
        origin_extra        TEXT,
        project_path        TEXT,
        project_id          TEXT,
        desired_engine_kind TEXT,
        desired_model       TEXT,
        model               TEXT,
        created_at          INTEGER NOT NULL,
        last_activity       INTEGER NOT NULL,
        active_duration_ms  REAL    NOT NULL DEFAULT 0,
        active_started_at   REAL,
        total_cost_usd      REAL    NOT NULL DEFAULT 0,
        input_tokens        INTEGER NOT NULL DEFAULT 0,
        output_tokens       INTEGER NOT NULL DEFAULT 0,
        last_input_tokens   INTEGER NOT NULL DEFAULT 0,
        activity            TEXT,
        error               TEXT,
        execution_context   TEXT
      )
    `.execute(db)

    await sql`
      INSERT INTO managed_sessions_new (
        id, sdk_session_id, engine_kind, engine_state_json,
        state, stop_reason, origin_source, origin_id, origin_extra,
        project_path, project_id, desired_engine_kind, desired_model, model,
        created_at, last_activity, active_duration_ms, active_started_at,
        total_cost_usd, input_tokens, output_tokens, last_input_tokens,
        activity, error, execution_context
      )
      SELECT
        id, sdk_session_id, engine_kind, engine_state_json,
        state, stop_reason, origin_source, origin_id, origin_extra,
        project_path, project_id, desired_engine_kind, desired_model, model,
        created_at, last_activity, active_duration_ms, active_started_at,
        total_cost_usd, input_tokens, output_tokens, last_input_tokens,
        activity, error, execution_context
      FROM managed_sessions
    `.execute(db)

    await sql`DROP TABLE managed_sessions`.execute(db)
    await sql`ALTER TABLE managed_sessions_new RENAME TO managed_sessions`.execute(db)

    await recreateManagedSessionIndexes(db)

    await sql`
      CREATE TABLE managed_session_messages (
        session_id TEXT PRIMARY KEY NOT NULL REFERENCES managed_sessions(id) ON DELETE CASCADE,
        messages   TEXT NOT NULL DEFAULT '[]'
      )
    `.execute(db)

    await sql`
      INSERT INTO managed_session_messages (session_id, messages)
      SELECT session_id, messages
      FROM managed_session_messages_tmp
      WHERE session_id IN (SELECT id FROM managed_sessions)
    `.execute(db)

    await sql`DROP TABLE managed_session_messages_tmp`.execute(db)
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db)

  try {
    await sql`
      CREATE TABLE managed_sessions_new (
        id                  TEXT    PRIMARY KEY NOT NULL,
        sdk_session_id      TEXT,
        engine_kind         TEXT    NOT NULL DEFAULT 'claude',
        engine_state_json   TEXT,
        state               TEXT    NOT NULL,
        stop_reason         TEXT,
        origin_source       TEXT    NOT NULL DEFAULT 'agent',
        origin_id           TEXT,
        origin_extra        TEXT,
        project_path        TEXT,
        project_id          TEXT,
        desired_engine_kind TEXT,
        desired_model       TEXT,
        model               TEXT,
        messages            TEXT    NOT NULL DEFAULT '[]',
        created_at          INTEGER NOT NULL,
        last_activity       INTEGER NOT NULL,
        active_duration_ms  REAL    NOT NULL DEFAULT 0,
        active_started_at   REAL,
        total_cost_usd      REAL    NOT NULL DEFAULT 0,
        input_tokens        INTEGER NOT NULL DEFAULT 0,
        output_tokens       INTEGER NOT NULL DEFAULT 0,
        last_input_tokens   INTEGER NOT NULL DEFAULT 0,
        activity            TEXT,
        error               TEXT,
        execution_context   TEXT
      )
    `.execute(db)

    await sql`
      INSERT INTO managed_sessions_new (
        id, sdk_session_id, engine_kind, engine_state_json,
        state, stop_reason, origin_source, origin_id, origin_extra,
        project_path, project_id, desired_engine_kind, desired_model, model,
        messages, created_at, last_activity, active_duration_ms, active_started_at,
        total_cost_usd, input_tokens, output_tokens, last_input_tokens,
        activity, error, execution_context
      )
      SELECT
        ms.id, ms.sdk_session_id, ms.engine_kind, ms.engine_state_json,
        ms.state, ms.stop_reason, ms.origin_source, ms.origin_id, ms.origin_extra,
        ms.project_path, ms.project_id, ms.desired_engine_kind, ms.desired_model, ms.model,
        COALESCE(msm.messages, '[]'), ms.created_at, ms.last_activity,
        ms.active_duration_ms, ms.active_started_at,
        ms.total_cost_usd, ms.input_tokens, ms.output_tokens, ms.last_input_tokens,
        ms.activity, ms.error, ms.execution_context
      FROM managed_sessions ms
      LEFT JOIN managed_session_messages msm ON msm.session_id = ms.id
    `.execute(db)

    await sql`DROP TABLE managed_session_messages`.execute(db)
    await sql`DROP TABLE managed_sessions`.execute(db)
    await sql`ALTER TABLE managed_sessions_new RENAME TO managed_sessions`.execute(db)

    await recreateManagedSessionIndexes(db)
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db)
  }
}
