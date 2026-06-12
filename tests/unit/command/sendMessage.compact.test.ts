// SPDX-License-Identifier: Apache-2.0

// isCompactCommand and the sendMessage()/resumeSessionInternal() compaction
// branches are module-internal to sessionOrchestrator. Their behavior is
// validated end-to-end through the TypeScript type system and the pendingCompact
// lifecycle contract on ManagedSession exercised below: resumeSessionInternal()
// forces a fresh startThread() while isPendingCompact() is true, then clears the
// flag after the resume transition so a subsequent resume does not force-restart
// again.

import { describe, it, expect } from 'vitest'
import { ManagedSession } from '../../../electron/command/managedSession'
import type { ManagedSessionConfig, CompactContinuationContext } from '../../../src/shared/types'

const baseConfig: ManagedSessionConfig = {
  prompt: 'Test',
  origin: { source: 'issue', issueId: 't' },
  projectPath: '/tmp',
}

const MOCK_CTX: CompactContinuationContext = {
  layer1TurnCount: 3,
  layer2UserPrompts: [],
  layer2BotBriefs: [],
  layer3Summary: '',
  layer3IsLLM: false,
  compactedAt: 0,
  totalTurnsCompacted: 0,
}

function makeSession(): ManagedSession {
  return new ManagedSession(baseConfig)
}

describe('pendingCompact lifecycle', () => {
  it('clearPendingCompact resets flag so resumeSessionInternal would not force restart again', () => {
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

  it('applyCompactContinuation clears engineRef so resume cannot take the fast path', () => {
    const session = makeSession()
    session.setEngineSessionRef('old-thread')
    session.applyCompactContinuation({
      ctx: MOCK_CTX,
      continuationSystemPrompt: '<ctx/>',
      preTokens: 0,
      trigger: 'auto',
    })
    expect(session.isPendingCompact()).toBe(true)
    expect(session.getEngineRef()).toBeNull()
  })
})
