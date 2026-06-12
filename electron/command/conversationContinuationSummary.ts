// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedSessionMessage,
  ContentBlock,
} from '../../src/shared/types'
import { createLogger } from '../platform/logger'

const log = createLogger('ContinuationSummary')

// ─── Constants ─────────────────────────────────────────────────────────────

const LAYER_1_TURNS = 3
const LAYER_2_TURNS = 10
const LAYER_3_TURNS = 20
const BOT_BRIEF_LIMIT = 150

// ─── Internal types ─────────────────────────────────────────────────────────

export interface ConversationTurn {
  userText: string
  botBrief: string           // first BOT_BRIEF_LIMIT chars of assistant response
  botFullText: string        // full assistant text (for LLM summarization)
  rawMessages: ManagedSessionMessage[] // original message objects (user + assistant)
}

export interface AssembledLayers {
  layer1TurnCount: number
  layer1TurnMessages: ManagedSessionMessage[] // raw messages for Layer 1 (verbatim)
  layer2UserPrompts: string[]    // oldest-first within layer 2
  layer2BotBriefs: string[]      // index-aligned with layer2UserPrompts
  layer3InputTurns: ConversationTurn[] // oldest-first, input for LLM summarization
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

function extractText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function brief(text: string): string {
  if (text.length <= BOT_BRIEF_LIMIT) return text
  return text.slice(0, BOT_BRIEF_LIMIT) + '…'
}

// ─── groupMessagesIntoTurns ───────────────────────────────────────────────

/**
 * Group flat message array into (user, assistant*) turn objects.
 * System events are skipped. Returns turns in chronological order (oldest first).
 */
export function groupMessagesIntoTurns(messages: readonly ManagedSessionMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  let currentTurn: {
    userText: string
    assistantBlocks: readonly ContentBlock[]
    rawMessages: ManagedSessionMessage[]
  } | null = null

  for (const msg of messages) {
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      if (currentTurn) {
        const fullText = extractText(currentTurn.assistantBlocks)
        turns.push({
          userText: currentTurn.userText,
          botBrief: brief(fullText),
          botFullText: fullText,
          rawMessages: currentTurn.rawMessages,
        })
      }
      const userText = extractText(msg.content)
      currentTurn = { userText, assistantBlocks: [], rawMessages: [msg] }
    } else if (msg.role === 'assistant' && currentTurn) {
      currentTurn.assistantBlocks = [...currentTurn.assistantBlocks, ...msg.content]
      currentTurn.rawMessages = [...currentTurn.rawMessages, msg]
    }
  }

  if (currentTurn) {
    const fullText = extractText(currentTurn.assistantBlocks)
    turns.push({
      userText: currentTurn.userText,
      botBrief: brief(fullText),
      botFullText: fullText,
      rawMessages: currentTurn.rawMessages,
    })
  }

  log.debug('grouped messages into turns', { turnCount: turns.length })

  return turns
}

// ─── assembleContinuationLayers ──────────────────────────────────────────

/**
 * Split turns (chronological order, oldest first) into three layers.
 *
 * Layer 1 = last LAYER_1_TURNS turns (verbatim)
 * Layer 2 = next LAYER_2_TURNS turns back (user verbatim + bot brief)
 * Layer 3 = next LAYER_3_TURNS turns back (LLM summary input)
 * Older = discarded
 */
export function assembleContinuationLayers(turns: ConversationTurn[]): AssembledLayers {
  const total = turns.length

  // Layer 1: last LAYER_1_TURNS turns
  const l1Start = Math.max(0, total - LAYER_1_TURNS)
  const layer1Turns = turns.slice(l1Start)
  const layer1TurnMessages = layer1Turns.flatMap((t) => t.rawMessages)

  // Layer 2: the LAYER_2_TURNS turns before Layer 1
  const l2End = l1Start
  const l2Start = Math.max(0, l2End - LAYER_2_TURNS)
  const layer2Turns = turns.slice(l2Start, l2End)
  const layer2UserPrompts = layer2Turns.map((t) => t.userText)
  const layer2BotBriefs = layer2Turns.map((t) => t.botBrief)

  // Layer 3: the LAYER_3_TURNS turns before Layer 2
  const l3End = l2Start
  const l3Start = Math.max(0, l3End - LAYER_3_TURNS)
  const layer3InputTurns = turns.slice(l3Start, l3End)

  return {
    layer1TurnCount: layer1Turns.length,
    layer1TurnMessages,
    layer2UserPrompts,
    layer2BotBriefs,
    layer3InputTurns,
  }
}
