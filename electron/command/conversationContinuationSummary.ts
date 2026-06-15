// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedSessionMessage,
  ContentBlock,
  CompactContinuationContext,
} from '../../src/shared/types'
import type { HeadlessLLMClient } from '../llm/types'
import { createLogger } from '../platform/logger'

const log = createLogger('ContinuationSummary')

// ─── Constants ─────────────────────────────────────────────────────────────

const LAYER_1_TURNS = 3
const LAYER_2_TURNS = 10
const LAYER_3_TURNS = 20
const BOT_BRIEF_LIMIT = 150
const LAYER_3_SUMMARY_MAX_TOKENS = 600
const LAYER_3_FALLBACK_MAX_CHARS = 2000
const LLM_TIMEOUT_MS = 30_000
const TOOL_INPUT_MAX_CHARS = 300
const TOOL_RESULT_MAX_CHARS = 200

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
  const parts: string[] = []
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push(b.text)
    } else if (b.type === 'tool_use') {
      const inputStr = JSON.stringify(b.input)
      const inputBrief =
        inputStr.length > TOOL_INPUT_MAX_CHARS
          ? inputStr.slice(0, TOOL_INPUT_MAX_CHARS) + '…'
          : inputStr
      parts.push(`[tool:${b.name}] ${inputBrief}`)
    } else if (b.type === 'tool_result') {
      const resultBrief =
        b.content.length > TOOL_RESULT_MAX_CHARS
          ? b.content.slice(0, TOOL_RESULT_MAX_CHARS) + '…'
          : b.content
      parts.push(`[result] ${resultBrief}`)
    }
  }
  return parts.join('\n').trim()
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

// ─── Layer 3 LLM summary ─────────────────────────────────────────────────

interface Layer3SummaryResult {
  text: string
  isLLM: boolean
}

/**
 * Call the HeadlessLLMClient to summarize Layer 3 turns.
 * Falls back to deterministic user-prompt concatenation on error.
 */
export async function buildLayer3Summary(
  inputTurns: ConversationTurn[],
  llmClient: HeadlessLLMClient,
): Promise<Layer3SummaryResult> {
  if (inputTurns.length === 0) return { text: '', isLLM: false }

  const formatted = inputTurns
    .map((t, i) => `[Turn ${i + 1}]\nUser: ${t.userText}\nAssistant: ${t.botFullText}`)
    .join('\n\n')

  const userMessage = [
    '你是一个对话压缩助手。以下是一段用户与 AI 的对话历史（从最旧到最近）。',
    '请将其压缩为一段不超过 600 字的摘要，需包含：',
    '1. 任务背景与目标',
    '2. 已完成的关键操作（文件修改、功能实现等）',
    '3. 当前状态与遗留问题',
    '',
    '不要重复用户的原始提问，聚焦于"做了什么、结果如何"。',
    '',
    formatted,
  ].join('\n')

  try {
    const text = await llmClient.query({
      systemPrompt: '你是一个简洁、准确的对话摘要助手。',
      userMessage,
      maxTokens: LAYER_3_SUMMARY_MAX_TOKENS,
      timeoutMs: LLM_TIMEOUT_MS,
    })
    return { text: text.trim(), isLLM: true }
  } catch (err) {
    log.info('Layer 3 LLM summary failed, using deterministic fallback', err)
    return { text: buildDeterministicFallback(inputTurns), isLLM: false }
  }
}

function buildDeterministicFallback(inputTurns: ConversationTurn[]): string {
  const joined = inputTurns.map((t) => t.userText).join('\n')
  if (joined.length <= LAYER_3_FALLBACK_MAX_CHARS) return joined
  return joined.slice(0, LAYER_3_FALLBACK_MAX_CHARS) + '…（更早内容已省略）'
}

// ─── Main entry point ─────────────────────────────────────────────────────

export interface BuildCompactContinuationParams {
  messages: readonly ManagedSessionMessage[]
  llmClient: HeadlessLLMClient
}

/**
 * Build a CompactContinuationContext from the session's full message history.
 * Pure data assembly + one LLM call (with deterministic fallback).
 */
export async function buildCompactContinuationContext(
  params: BuildCompactContinuationParams,
): Promise<CompactContinuationContext> {
  const { messages, llmClient } = params

  const turns = groupMessagesIntoTurns(messages)
  const layers = assembleContinuationLayers(turns)
  const layer3Result = await buildLayer3Summary(layers.layer3InputTurns, llmClient)

  return {
    layer1TurnCount: layers.layer1TurnCount,
    layer2UserPrompts: layers.layer2UserPrompts,
    layer2BotBriefs: layers.layer2BotBriefs,
    layer3Summary: layer3Result.text,
    layer3IsLLM: layer3Result.isLLM,
    compactedAt: Date.now(),
    totalTurnsCompacted: layers.layer3InputTurns.length,
  }
}

// ─── System prompt formatter ─────────────────────────────────────────────

/**
 * Serialize a CompactContinuationContext into an XML system prompt block.
 * Layer 3 summary + Layer 2 turns + Layer 1 as recent_turns.
 *
 * Layer 1 messages are included as <recent_turns> for both Claude and Codex
 * because startThread() creates a fresh thread with no message replay.
 *
 * @param ctx - The continuation context
 * @param layer1Messages - Layer 1 raw messages to include as recent turns
 */
export function formatContinuationAsSystemPrompt(
  ctx: CompactContinuationContext,
  layer1Messages: ManagedSessionMessage[],
): string {
  const parts: string[] = ['<context_continuation>']

  if (ctx.layer3Summary) {
    parts.push('  <summary>')
    parts.push(escapeXml(ctx.layer3Summary))
    parts.push('  </summary>')
    parts.push('')
  }

  if (ctx.layer2UserPrompts.length > 0) {
    parts.push('  <previous_turns>')
    for (let i = 0; i < ctx.layer2UserPrompts.length; i++) {
      const n = i + 1
      parts.push(`    <turn n="${n}">`)
      parts.push(`      <user>${escapeXml(ctx.layer2UserPrompts[i])}</user>`)
      if (ctx.layer2BotBriefs[i]) {
        parts.push(`      <assistant_brief>${escapeXml(ctx.layer2BotBriefs[i])}</assistant_brief>`)
      }
      parts.push('    </turn>')
    }
    parts.push('  </previous_turns>')
    parts.push('')
  }

  if (layer1Messages.length > 0) {
    parts.push('  <recent_turns>')
    let turnN = 0
    let currentUser: string | null = null
    let assistantParts: string[] = []

    for (const msg of layer1Messages) {
      if (msg.role === 'user') {
        if (currentUser !== null) {
          turnN++
          parts.push(`    <turn n="${turnN}">`)
          parts.push(`      <user>${escapeXml(currentUser)}</user>`)
          if (assistantParts.length > 0) {
            parts.push(`      <assistant>${escapeXml(assistantParts.join('\n'))}</assistant>`)
          }
          parts.push('    </turn>')
          assistantParts = []
        }
        currentUser = extractText(msg.content)
      } else if (msg.role === 'assistant' && currentUser !== null) {
        assistantParts = [...assistantParts, extractText(msg.content)]
      }
    }
    if (currentUser !== null) {
      turnN++
      parts.push(`    <turn n="${turnN}">`)
      parts.push(`      <user>${escapeXml(currentUser)}</user>`)
      if (assistantParts.length > 0) {
        parts.push(`      <assistant>${escapeXml(assistantParts.join('\n'))}</assistant>`)
      }
      parts.push('    </turn>')
    }
    parts.push('  </recent_turns>')
  }

  parts.push('</context_continuation>')
  return parts.join('\n')
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
