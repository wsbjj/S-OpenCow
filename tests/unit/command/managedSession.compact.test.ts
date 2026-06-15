// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest'
import { ManagedSession } from '../../../electron/command/managedSession'
import type {
  ManagedSessionConfig,
  CompactContinuationContext,
  CompactBoundaryEvent,
} from '../../../src/shared/types'

const baseConfig: ManagedSessionConfig = {
  prompt: 'Fix the auth bug',
  origin: { source: 'issue', issueId: 'issue-1' },
  projectPath: '/tmp/test-project',
}

function makeSession(): ManagedSession {
  return new ManagedSession(baseConfig)
}

const MOCK_CTX: CompactContinuationContext = {
  layer1TurnCount: 3,
  layer2UserPrompts: ['p1'],
  layer2BotBriefs: ['b1'],
  layer3Summary: 'summary',
  layer3IsLLM: true,
  compactedAt: 1000,
  totalTurnsCompacted: 5,
}

describe('ManagedSession.applyCompactContinuation', () => {
  it('sets pendingCompact = true and clears engineRef', () => {
    const session = makeSession()
    session.setEngineSessionRef('old-thread-id')
    session.applyCompactContinuation({
      ctx: MOCK_CTX,
      continuationSystemPrompt: '<ctx/>',
      preTokens: 1000,
      trigger: 'manual',
    })
    expect(session.isPendingCompact()).toBe(true)
    expect(session.getEngineRef()).toBeNull()
  })

  it('replaces contextSystemPrompt with the continuation prompt', () => {
    const session = makeSession()
    session.applyCompactContinuation({
      ctx: MOCK_CTX,
      continuationSystemPrompt: '<continuation/>',
      preTokens: 0,
      trigger: 'manual',
    })
    expect(session.getConfig().contextSystemPrompt).toBe('<continuation/>')
  })

  it('stores continuation context accessible via snapshot and getter', () => {
    const session = makeSession()
    session.applyCompactContinuation({
      ctx: MOCK_CTX,
      continuationSystemPrompt: '<ctx/>',
      preTokens: 0,
      trigger: 'manual',
    })
    const snap = session.snapshot()
    expect(snap.compactContinuationContext).toMatchObject({ layer3Summary: 'summary' })
    expect(snap.pendingCompact).toBe(true)
    expect(session.getCompactContinuationContext()).toMatchObject({ layer3Summary: 'summary' })
  })

  it('inserts a compact_boundary system event with phase done', () => {
    const session = makeSession()
    session.applyCompactContinuation({
      ctx: MOCK_CTX,
      continuationSystemPrompt: '<ctx/>',
      preTokens: 500,
      trigger: 'auto',
    })
    const info = session.toPersistenceRecord()
    const boundary = info.messages.find(
      (m) => m.role === 'system' && m.event.type === 'compact_boundary'
    )
    expect(boundary).toBeDefined()
    const event = (boundary as { event: CompactBoundaryEvent }).event
    expect(event.preTokens).toBe(500)
    expect(event.trigger).toBe('auto')
    expect(event.phase).toBe('done')
  })

  it('clearPendingCompact() resets the flag', () => {
    const session = makeSession()
    session.applyCompactContinuation({
      ctx: MOCK_CTX,
      continuationSystemPrompt: '',
      preTokens: 0,
      trigger: 'manual',
    })
    expect(session.isPendingCompact()).toBe(true)
    session.clearPendingCompact()
    expect(session.isPendingCompact()).toBe(false)
  })
})

describe('ManagedSession.fromInfo compact restoration', () => {
  it('restores pendingCompact=true from persistence record', () => {
    const session = makeSession()
    session.applyCompactContinuation({
      ctx: MOCK_CTX,
      continuationSystemPrompt: '<ctx/>',
      preTokens: 0,
      trigger: 'manual',
    })
    expect(session.isPendingCompact()).toBe(true)

    // Simulate persist + restore
    const record = session.toPersistenceRecord()
    const restored = ManagedSession.fromInfo(record)

    expect(restored.isPendingCompact()).toBe(true)
  })

  it('restores compactContinuationContext from persistence record', () => {
    const session = makeSession()
    session.applyCompactContinuation({
      ctx: MOCK_CTX,
      continuationSystemPrompt: '<ctx/>',
      preTokens: 0,
      trigger: 'manual',
    })

    const record = session.toPersistenceRecord()
    const restored = ManagedSession.fromInfo(record)

    expect(restored.getCompactContinuationContext()).toMatchObject({
      layer3Summary: 'summary',
    })
  })
})
