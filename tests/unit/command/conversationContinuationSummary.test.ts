// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  groupMessagesIntoTurns,
  assembleContinuationLayers,
} from '../../../electron/command/conversationContinuationSummary'
import type { ManagedSessionMessage } from '../../../src/shared/types'

// ── helpers ───────────────────────────────────────────────────────────────────
function makeUser(id: string, text: string): ManagedSessionMessage {
  return { id, role: 'user', content: [{ type: 'text', text }], timestamp: 0 } as ManagedSessionMessage
}
function makeAssistant(id: string, text: string): ManagedSessionMessage {
  return { id, role: 'assistant', content: [{ type: 'text', text }], timestamp: 0 } as ManagedSessionMessage
}
function makeSystem(id: string): ManagedSessionMessage {
  return { id, role: 'system', event: { type: 'compact_boundary', trigger: 'manual', preTokens: 0, phase: 'done' }, timestamp: 0 } as unknown as ManagedSessionMessage
}

// Build N turns of user+assistant messages (newest last in array)
function buildTurns(n: number): ManagedSessionMessage[] {
  const msgs: ManagedSessionMessage[] = []
  for (let i = 1; i <= n; i++) {
    msgs.push(makeUser(`u${i}`, `user prompt ${i}`))
    msgs.push(makeAssistant(`a${i}`, 'a'.repeat(300) + ` response ${i}`))
  }
  return msgs
}

// ── groupMessagesIntoTurns ────────────────────────────────────────────────────
describe('groupMessagesIntoTurns', () => {
  it('groups user+assistant pairs into turns, newest last', () => {
    const msgs = buildTurns(3)
    const turns = groupMessagesIntoTurns(msgs)
    expect(turns).toHaveLength(3)
    expect(turns[0].userText).toBe('user prompt 1')
    expect(turns[2].userText).toBe('user prompt 3')
  })

  it('skips system events', () => {
    const msgs = [makeSystem('s1'), makeUser('u1', 'hello'), makeAssistant('a1', 'world')]
    const turns = groupMessagesIntoTurns(msgs)
    expect(turns).toHaveLength(1)
  })

  it('handles messages without assistant reply (incomplete turn)', () => {
    const msgs = [makeUser('u1', 'hello')]
    const turns = groupMessagesIntoTurns(msgs)
    expect(turns).toHaveLength(1)
    expect(turns[0].botBrief).toBe('')
  })
})

// ── assembleContinuationLayers ────────────────────────────────────────────────
describe('assembleContinuationLayers', () => {
  it('Layer 1 = last 3 turns (indices 30-32 in a 33-turn session)', () => {
    const turns = groupMessagesIntoTurns(buildTurns(33))
    const layers = assembleContinuationLayers(turns)
    expect(layers.layer1TurnCount).toBe(3)
    // Layer 1 contains the 3 newest turns (prompt 31, 32, 33)
    expect(layers.layer1TurnMessages.some(m => m.role === 'user' &&
      m.content[0].type === 'text' && (m.content[0] as {type:'text';text:string}).text === 'user prompt 31'
    )).toBe(true)
  })

  it('Layer 2 = turns 4-13 (10 turns), user prompts verbatim + bot 150-char brief', () => {
    const turns = groupMessagesIntoTurns(buildTurns(33))
    const layers = assembleContinuationLayers(turns)
    expect(layers.layer2UserPrompts).toHaveLength(10)
    // Bot brief ≤ 150 chars + ellipsis
    for (const brief of layers.layer2BotBriefs) {
      expect(brief.length).toBeLessThanOrEqual(153) // 150 + "…"
    }
    // User prompts are verbatim (turns 21-30 in forward order = turns 4-13 from end)
    expect(layers.layer2UserPrompts[0]).toBe('user prompt 21') // oldest of layer 2
    expect(layers.layer2UserPrompts[9]).toBe('user prompt 30') // newest of layer 2
  })

  it('Layer 3 input = turns 14-33 from end (up to 20 turns), oldest first', () => {
    const turns = groupMessagesIntoTurns(buildTurns(33))
    const layers = assembleContinuationLayers(turns)
    expect(layers.layer3InputTurns).toHaveLength(20)
    expect(layers.layer3InputTurns[0].userText).toBe('user prompt 1')  // oldest
    expect(layers.layer3InputTurns[19].userText).toBe('user prompt 20') // turn 14 from end in 33-turn session
  })

  it('fewer than 33 turns: only fills available', () => {
    const turns = groupMessagesIntoTurns(buildTurns(5))
    const layers = assembleContinuationLayers(turns)
    expect(layers.layer1TurnCount).toBe(3)
    expect(layers.layer2UserPrompts).toHaveLength(2) // only 2 turns left for layer 2
    expect(layers.layer3InputTurns).toHaveLength(0)  // nothing left for layer 3
  })

  it('exactly 3 turns: all go to Layer 1, layers 2 and 3 empty', () => {
    const turns = groupMessagesIntoTurns(buildTurns(3))
    const layers = assembleContinuationLayers(turns)
    expect(layers.layer1TurnCount).toBe(3)
    expect(layers.layer2UserPrompts).toHaveLength(0)
    expect(layers.layer3InputTurns).toHaveLength(0)
  })
})
