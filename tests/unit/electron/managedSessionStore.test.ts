// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { createTestDb } from '../../helpers/testDb'
import { ManagedSessionStore } from '../../../electron/services/managedSessionStore'
import { getOriginIssueId, type ManagedSessionInfo } from '../../../src/shared/types'
import type { Database } from '../../../electron/database/types'

function makeSession(overrides: Partial<ManagedSessionInfo> = {}): ManagedSessionInfo {
  return {
    id: `ccb-${Math.random().toString(36).slice(2, 8)}`,
    engineKind: 'claude',
    engineSessionRef: null,
    engineState: null,
    state: 'stopped',
    origin: { source: 'agent' },
    projectPath: null,
    projectId: null,
    model: 'claude-sonnet-4-6',
    messages: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
    activeDurationMs: 0,
    activeStartedAt: null,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastInputTokens: 0,
    activity: null,
    error: null,
    stopReason: null,
    executionContext: null,
    ...overrides
  }
}

describe('ManagedSessionStore', () => {
  let db: Kysely<Database>
  let close: () => Promise<void>
  let store: ManagedSessionStore

  async function listTableColumns(
    tableName: 'managed_sessions' | 'managed_session_messages',
  ): Promise<string[]> {
    const result = tableName === 'managed_sessions'
      ? await sql<{ name: string }>`PRAGMA table_info(managed_sessions)`.execute(db)
      : await sql<{ name: string }>`PRAGMA table_info(managed_session_messages)`.execute(db)
    return result.rows.map((column) => column.name)
  }

  beforeEach(async () => {
    ({ db, close } = await createTestDb())
    store = new ManagedSessionStore(db)
  })

  afterEach(async () => {
    if (close) {
      await close()
    }
  })

  describe('schema', () => {
    it('migrates messages out of the managed_sessions table', async () => {
      await expect(listTableColumns('managed_sessions')).resolves.not.toContain('messages')
      await expect(listTableColumns('managed_session_messages')).resolves.toEqual([
        'session_id',
        'messages',
      ])
    })
  })

  describe('load', () => {
    it('creates empty store when database is fresh', async () => {
      await store.load()
      expect(await store.list()).toEqual([])
    })
  })

  describe('save', () => {
    it('saves a session and persists to database', async () => {
      const session = makeSession({ id: 'ccb-save-1', origin: { source: 'issue', issueId: 'issue-1' } })
      await store.save(session)

      expect(await store.list()).toHaveLength(1)
      const loaded = await store.get('ccb-save-1')
      expect(loaded).not.toBeNull()
      expect(getOriginIssueId(loaded!.origin)).toBe('issue-1')
    })

    it('overwrites an existing session with the same id (upsert)', async () => {
      const session1 = makeSession({ id: 'ccb-upd-1', state: 'streaming' as const })
      await store.save(session1)

      const session2 = makeSession({ id: 'ccb-upd-1', state: 'stopped' as const })
      await store.save(session2)

      expect(await store.list()).toHaveLength(1)
      expect((await store.get('ccb-upd-1'))?.state).toBe('stopped')
    })

    it('updates project and active-duration fields on upsert', async () => {
      await store.save(makeSession({
        id: 'ccb-upd-2',
        projectId: 'project-1',
        activeDurationMs: 10,
      }))

      await store.save(makeSession({
        id: 'ccb-upd-2',
        projectId: 'project-2',
        activeDurationMs: 250,
        activeStartedAt: 12345,
      }))

      const loaded = await store.get('ccb-upd-2')
      expect(loaded?.projectId).toBe('project-2')
      expect(loaded?.activeDurationMs).toBe(250)
      expect(loaded?.activeStartedAt).toBe(12345)
    })

    it('persists engine metadata fields', async () => {
      await store.save(makeSession({
        id: 'ccb-engine-1',
        engineKind: 'codex',
        engineSessionRef: 'thread_123',
        engineState: { checkpoint: 'abc' },
      }))

      const loaded = await store.get('ccb-engine-1')
      expect(loaded?.engineKind).toBe('codex')
      expect(loaded?.engineSessionRef).toBe('thread_123')
      expect(loaded?.engineState).toEqual({ checkpoint: 'abc' })
    })

    it('persists desired session engine and model separately from observed runtime model', async () => {
      await store.save(makeSession({
        id: 'ccb-desired-model-1',
        engineKind: 'claude',
        desiredEngineKind: 'codex',
        desiredModel: 'gpt-5.3-codex',
        model: 'claude-sonnet-4-6',
      }))

      const loaded = await store.get('ccb-desired-model-1')
      expect(loaded?.desiredEngineKind).toBe('codex')
      expect(loaded?.desiredModel).toBe('gpt-5.3-codex')
      expect(loaded?.model).toBe('claude-sonnet-4-6')
    })

    it('updates split message storage when an existing session is upserted', async () => {
      await store.save(makeSession({
        id: 'ccb-msg-upsert-1',
        messages: [
          {
            id: 'msg-old',
            role: 'user',
            content: [{ type: 'text', text: 'old message' }],
            timestamp: 1,
          },
        ],
      }))

      await store.save(makeSession({
        id: 'ccb-msg-upsert-1',
        messages: [
          {
            id: 'msg-new',
            role: 'assistant',
            content: [{ type: 'text', text: 'new message' }],
            timestamp: 2,
          },
        ],
      }))

      const row = await db
        .selectFrom('managed_session_messages')
        .select(['session_id', 'messages'])
        .where('session_id', '=', 'ccb-msg-upsert-1')
        .executeTakeFirstOrThrow()

      expect(row.session_id).toBe('ccb-msg-upsert-1')
      expect(JSON.parse(row.messages)).toEqual([
        {
          id: 'msg-new',
          role: 'assistant',
          content: [{ type: 'text', text: 'new message' }],
          timestamp: 2,
        },
      ])
    })

    it('round-trips review origin payload fields', async () => {
      await store.save(makeSession({
        id: 'ccb-review-1',
        origin: {
          source: 'review',
          issueId: 'issue-1',
          sessionId: 'session-base-1',
          turnAnchorMessageId: 'msg-9',
        },
      }))

      const loaded = await store.get('ccb-review-1')
      expect(loaded?.origin.source).toBe('review')
      if (loaded?.origin.source === 'review') {
        expect(loaded.origin.issueId).toBe('issue-1')
        expect(loaded.origin.sessionId).toBe('session-base-1')
        expect(loaded.origin.turnAnchorMessageId).toBe('msg-9')
      }
    })
  })

  describe('list', () => {
    it('omits message bodies from list results', async () => {
      await store.save(makeSession({
        id: 'ccb-list-metadata-only-1',
        messages: [
          {
            id: 'msg-heavy',
            role: 'user',
            content: [{ type: 'text', text: 'large body' }],
            timestamp: 1,
          },
        ],
      }))

      const [listed] = await store.list()

      expect(listed.id).toBe('ccb-list-metadata-only-1')
      expect(listed.messages).toEqual([])
    })
  })

  describe('remove', () => {
    it('removes a session from the store', async () => {
      await store.save(makeSession({ id: 'ccb-del-1' }))
      await store.remove('ccb-del-1')

      expect(await store.list()).toHaveLength(0)
      expect(await store.get('ccb-del-1')).toBeNull()
    })

    it('cascades message storage removal when a session is deleted', async () => {
      await store.save(makeSession({
        id: 'ccb-del-messages-1',
        messages: [
          {
            id: 'msg-delete',
            role: 'user',
            content: [{ type: 'text', text: 'delete me' }],
            timestamp: 1,
          },
        ],
      }))

      await store.remove('ccb-del-messages-1')

      const row = await db
        .selectFrom('managed_session_messages')
        .select('session_id')
        .where('session_id', '=', 'ccb-del-messages-1')
        .executeTakeFirst()

      expect(row).toBeUndefined()
    })

    it('is a no-op for non-existent session', async () => {
      await store.remove('nonexistent')
      expect(await store.list()).toHaveLength(0)
    })
  })

  describe('get', () => {
    it('returns session by id', async () => {
      const session = makeSession({ id: 'ccb-get-1', origin: { source: 'issue', issueId: 'issue-42' } })
      await store.save(session)

      const result = await store.get('ccb-get-1')
      expect(result).not.toBeNull()
      expect(getOriginIssueId(result!.origin)).toBe('issue-42')
    })

    it('loads message bodies from split storage for session details', async () => {
      await store.save(makeSession({
        id: 'ccb-get-messages-1',
        messages: [
          {
            id: 'msg-detail',
            role: 'assistant',
            content: [{ type: 'text', text: 'detail body' }],
            timestamp: 1,
          },
        ],
      }))

      const loaded = await store.get('ccb-get-messages-1')

      expect(loaded?.messages).toEqual([
        {
          id: 'msg-detail',
          role: 'assistant',
          content: [{ type: 'text', text: 'detail body' }],
          timestamp: 1,
        },
      ])
    })

    it('returns null for non-existent id', async () => {
      expect(await store.get('nonexistent')).toBeNull()
    })
  })

  describe('migrateProjectPath', () => {
    it('updates project_path for all sessions matching the project_id', async () => {
      await store.save(makeSession({
        id: 'ccb-mig-1',
        projectId: 'proj-A',
        projectPath: '/Users/me/old-name',
      }))
      await store.save(makeSession({
        id: 'ccb-mig-2',
        projectId: 'proj-A',
        projectPath: '/Users/me/old-name',
      }))
      await store.save(makeSession({
        id: 'ccb-mig-3',
        projectId: 'proj-B',
        projectPath: '/Users/me/other-project',
      }))

      const count = await store.migrateProjectPath({
        projectId: 'proj-A',
        newPath: '/Users/me/new-name',
      })
      expect(count).toBe(2)

      const s1 = await store.get('ccb-mig-1')
      const s2 = await store.get('ccb-mig-2')
      const s3 = await store.get('ccb-mig-3')
      expect(s1!.projectPath).toBe('/Users/me/new-name')
      expect(s2!.projectPath).toBe('/Users/me/new-name')
      expect(s3!.projectPath).toBe('/Users/me/other-project') // untouched
    })

    it('returns 0 when no sessions match the project_id', async () => {
      await store.save(makeSession({
        id: 'ccb-mig-no',
        projectId: 'proj-X',
        projectPath: '/Users/me/something',
      }))
      const count = await store.migrateProjectPath({
        projectId: 'proj-nonexistent',
        newPath: '/Users/me/new',
      })
      expect(count).toBe(0)
    })
  })

  describe('persistence survives reload', () => {
    it('data is visible from a second store instance', async () => {
      await store.save(makeSession({ id: 'ccb-persist-1', origin: { source: 'issue', issueId: 'issue-A' } }))
      await store.save(makeSession({ id: 'ccb-persist-2', origin: { source: 'issue', issueId: 'issue-B' } }))

      // Create a new store instance using the same db
      const store2 = new ManagedSessionStore(db)

      expect(await store2.list()).toHaveLength(2)
      const p1 = await store2.get('ccb-persist-1')
      const p2 = await store2.get('ccb-persist-2')
      expect(getOriginIssueId(p1!.origin)).toBe('issue-A')
      expect(getOriginIssueId(p2!.origin)).toBe('issue-B')
    })

    it('preserves messages across instances', async () => {
      const session = makeSession({
        id: 'ccb-msg-1',
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: [{ type: 'text', text: 'Fix the bug' }],
            timestamp: Date.now()
          },
          {
            id: 'msg-2',
            role: 'assistant',
            content: [{ type: 'text', text: 'I will fix the bug.' }],
            timestamp: Date.now()
          }
        ]
      })
      await store.save(session)

      const store2 = new ManagedSessionStore(db)
      const loaded = await store2.get('ccb-msg-1')
      expect(loaded?.messages).toHaveLength(2)
      expect(loaded?.messages[0].role).toBe('user')
      expect(loaded?.messages[1].role).toBe('assistant')
    })
  })
})
