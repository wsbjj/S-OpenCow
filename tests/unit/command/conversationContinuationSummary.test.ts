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

// ── LLM 摘要与上下文构建测试 ─────────────────────────────────────────────────
import { buildLayer3Summary, buildCompactContinuationContext, formatContinuationAsSystemPrompt } from '../../../electron/command/conversationContinuationSummary'
import type { HeadlessLLMClient } from '../../../electron/llm/types'
import type { ConversationTurn } from '../../../electron/command/conversationContinuationSummary'
import type { CompactContinuationContext } from '../../../src/shared/types'

describe('buildLayer3Summary', () => {
  it('returns LLM result when client succeeds', async () => {
    const mockClient: HeadlessLLMClient = {
      query: async () => 'LLM summary output',
    }
    const inputTurns: ConversationTurn[] = [
      { userText: 'question', botBrief: 'answer', botFullText: 'answer', rawMessages: [] },
    ]
    const result = await buildLayer3Summary(inputTurns, mockClient)
    expect(result.text).toBe('LLM summary output')
    expect(result.isLLM).toBe(true)
  })

  it('falls back to deterministic summary when LLM throws', async () => {
    const mockClient: HeadlessLLMClient = {
      query: async () => { throw new Error('API error') },
    }
    const inputTurns: ConversationTurn[] = [
      { userText: 'question 1', botBrief: 'answer', botFullText: 'answer', rawMessages: [] },
      { userText: 'question 2', botBrief: 'answer', botFullText: 'answer', rawMessages: [] },
    ]
    const result = await buildLayer3Summary(inputTurns, mockClient)
    expect(result.isLLM).toBe(false)
    expect(result.text).toContain('question 1')
    expect(result.text).toContain('question 2')
  })

  it('truncates deterministic fallback to 2000 chars', async () => {
    const mockClient: HeadlessLLMClient = {
      query: async () => { throw new Error('fail') },
    }
    const inputTurns: ConversationTurn[] = Array.from({ length: 20 }, (_, i) => ({
      userText: 'x'.repeat(200) + ` turn ${i}`,
      botBrief: '',
      botFullText: '',
      rawMessages: [],
    }))
    const result = await buildLayer3Summary(inputTurns, mockClient)
    expect(result.isLLM).toBe(false)
    expect(result.text.length).toBeLessThanOrEqual(2010) // 2000 + ellipsis
  })

  it('returns empty string when no input turns', async () => {
    const mockClient: HeadlessLLMClient = { query: async () => 'never called' }
    const result = await buildLayer3Summary([], mockClient)
    expect(result.text).toBe('')
    expect(result.isLLM).toBe(false)
  })
})

describe('buildCompactContinuationContext', () => {
  it('assembles full context with LLM summary', async () => {
    const mockClient: HeadlessLLMClient = { query: async () => 'summary text' }
    const messages = buildTurns(15)
    const ctx = await buildCompactContinuationContext({ messages, llmClient: mockClient })
    expect(ctx.layer3Summary).toBe('summary text')
    expect(ctx.layer3IsLLM).toBe(true)
    expect(ctx.layer1TurnCount).toBe(3)
    expect(ctx.layer2UserPrompts).toHaveLength(10)
    expect(ctx.totalTurnsCompacted).toBe(2) // turns 14–15 = 2 turns in layer 3
  })
})

describe('formatContinuationAsSystemPrompt', () => {
  it('produces XML output containing summary and layer 2 turns', () => {
    const ctx: CompactContinuationContext = {
      layer1TurnCount: 3,
      layer2UserPrompts: ['prompt A', 'prompt B'],
      layer2BotBriefs: ['brief A', 'brief B'],
      layer3Summary: 'the summary',
      layer3IsLLM: true,
      compactedAt: 0,
      totalTurnsCompacted: 5,
    }
    const output = formatContinuationAsSystemPrompt(ctx, [])
    expect(output).toContain('<context_continuation>')
    expect(output).toContain('the summary')
    expect(output).toContain('prompt A')
    expect(output).toContain('brief A')
    expect(output).toContain('</context_continuation>')
  })

  it('encodes XML special characters in user prompts', () => {
    const ctx: CompactContinuationContext = {
      layer1TurnCount: 1,
      layer2UserPrompts: ['<script>alert("xss")</script>'],
      layer2BotBriefs: ['safe'],
      layer3Summary: '',
      layer3IsLLM: false,
      compactedAt: 0,
      totalTurnsCompacted: 0,
    }
    const output = formatContinuationAsSystemPrompt(ctx, [])
    expect(output).not.toContain('<script>')
    expect(output).toContain('&lt;script&gt;')
  })
})
