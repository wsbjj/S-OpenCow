// SPDX-License-Identifier: Apache-2.0

import type { Kysely } from 'kysely'

/**
 * Migration 053 — Persist session-level desired model selection.
 *
 * These fields are user intent for the next turn. They are intentionally
 * separate from `model`, which is the model observed from the running engine.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('managed_sessions')
    .addColumn('desired_engine_kind', 'text')
    .execute()

  await db.schema
    .alterTable('managed_sessions')
    .addColumn('desired_model', 'text')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('managed_sessions')
    .dropColumn('desired_model')
    .execute()

  await db.schema
    .alterTable('managed_sessions')
    .dropColumn('desired_engine_kind')
    .execute()
}
