// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest'
import { ManagedSession } from '../../../electron/command/managedSession'
import type {
  CompactContinuationContext,
  ManagedSessionConfig,
  CompactBoundaryEvent,
} from '../../../src/shared/types'

// NOTE: SessionOrchestrator has too many dependencies to construct directly in
// a focused unit test. The compactSession() flow ultimately delegates the
// observable state transition to ManagedSession.applyCompactContinuation(), so
// these tests verify that integration contract through ManagedSession — the
// same pattern used by managedSession.compact.test.ts.

const baseConfig: ManagedSessionConfig = {
  prompt: 'Test prompt',
  origin: { source: 'issue', issueId: 'test-1' },
  projectPath: '/tmp/test',
}

function makeSession(): ManagedSession {
  return new ManagedSession(baseConfig)
}

const MOCK_CTX: CompactContinuationContext = {
  layer1TurnCount: 3,
  layer2UserPrompts: [],
  layer2BotBriefs: [],
  layer3Summary: 'mocked',
  layer3IsLLM: true,
  compactedAt: Date.now(),
  totalTurnsCompacted: 5,
}

describe('ManagedSession compact integration (sessionOrchestrator task)', () => {
  it('after applyCompactContinuation, getEngineRef() is null and isPendingCompact() is true', () => {
    const session = makeSession()
    session.setEngineSessionRef('thread-123')
    session.applyCompactContinuation({
      ctx: MOCK_CTX,
      continuationSystemPrompt: '<ctx/>',
      preTokens: 1000,
      trigger: 'manual',
    })
    expect(session.getEngineRef()).toBeNull()
    expect(session.isPendingCompact()).toBe(true)
  })

  it('snapshot includes pendingCompact=true and compactContinuationContext', () => {
    const session = makeSession()
    session.applyCompactContinuation({
      ctx: { ...MOCK_CTX, layer3Summary: 'x' },
      continuationSystemPrompt: '',
      preTokens: 0,
      trigger: 'manual',
    })
    const snap = session.snapshot()
    expect(snap.pendingCompact).toBe(true)
    expect(snap.compactContinuationContext?.layer3Summary).toBe('x')
  })

  it('replaces contextSystemPrompt with the continuation prompt', () => {
    const session = makeSession()
    session.applyCompactContinuation({
      ctx: MOCK_CTX,
      continuationSystemPrompt: '<continuation/>',
      preTokens: 0,
      trigger: 'auto',
    })
    expect(session.getConfig().contextSystemPrompt).toBe('<continuation/>')
  })

  it('inserts a compact_boundary system event with phase done and the trigger', () => {
    const session = makeSession()
    session.applyCompactContinuation({
      ctx: MOCK_CTX,
      continuationSystemPrompt: '<ctx/>',
      preTokens: 750,
      trigger: 'auto',
    })
    const info = session.toPersistenceRecord()
    const boundary = info.messages.find(
      (m) => m.role === 'system' && m.event.type === 'compact_boundary',
    )
    expect(boundary).toBeDefined()
    const event = (boundary as { event: CompactBoundaryEvent }).event
    expect(event.preTokens).toBe(750)
    expect(event.trigger).toBe('auto')
    expect(event.phase).toBe('done')
  })

  it('addSystemEvent can emit a compacting-phase boundary (UI loading state)', () => {
    // compactSession() emits a 'compacting' boundary before the LLM call so the
    // UI can render a loading indicator while Layer 3 summarization runs.
    const session = makeSession()
    session.addSystemEvent({
      type: 'compact_boundary',
      trigger: 'manual',
      preTokens: 1234,
      phase: 'compacting',
    })
    const info = session.toPersistenceRecord()
    const boundary = info.messages.find(
      (m) => m.role === 'system' && m.event.type === 'compact_boundary',
    )
    expect(boundary).toBeDefined()
    const event = (boundary as { event: CompactBoundaryEvent }).event
    expect(event.phase).toBe('compacting')
    expect(event.preTokens).toBe(1234)
  })
})
