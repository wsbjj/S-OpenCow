// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, it, expect, vi } from 'vitest'
import { MemoryExtractor } from '../../../electron/memory/memoryExtractor'
import type { InteractionEvent } from '../../../electron/memory/types'
import type { HeadlessLLMClient } from '../../../electron/llm/types'

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../../electron/platform/logger', () => ({
  createLogger: () => logger,
}))

describe('MemoryExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes extraction prompt as systemPrompt and userMessage without instructions param', async () => {
    const query = vi.fn().mockResolvedValue('{"memories":[]}')
    const extractor = new MemoryExtractor({
      llmClient: { query } as unknown as HeadlessLLMClient,
    })
    const interactionContent = 'User: I prefer concise Chinese responses and this project uses Vitest for unit tests.'
    const event: InteractionEvent = {
      type: 'session',
      projectId: 'project-1',
      sessionId: 'session-1',
      content: interactionContent,
      metadata: {
        projectName: 'OpenCow',
      },
      timestamp: Date.now(),
    }

    await extractor.extract(event, { user: [], project: [] })

    expect(query).toHaveBeenCalledTimes(1)
    const params = query.mock.calls[0][0]
    expect(params.systemPrompt).toBe(
      'You are a memory extraction assistant. Return ONLY valid JSON, no markdown fences or explanation.',
    )
    expect(params.userMessage).toContain('## Instructions')
    expect(params.userMessage).toContain('## Output Format')
    expect(params.userMessage).toContain(interactionContent)
    expect(params).not.toHaveProperty('instructions')
  })

  it('treats blank LLM responses as empty extraction results without JSON parse warning', async () => {
    const query = vi.fn().mockResolvedValue('   ')
    const extractor = new MemoryExtractor({
      llmClient: { query } as unknown as HeadlessLLMClient,
    })
    const event: InteractionEvent = {
      type: 'session',
      projectId: 'project-1',
      sessionId: 'session-1',
      content: 'User: I prefer concise Chinese responses and this project uses Vitest for unit tests.',
      metadata: {
        projectName: 'OpenCow',
      },
      timestamp: Date.now(),
    }

    const candidates = await extractor.extract(event, { user: [], project: [] })

    expect(candidates).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith('Empty extraction response from LLM', expect.objectContaining({
      defaultScope: 'project',
    }))
    expect(logger.warn).not.toHaveBeenCalledWith(
      'Failed to parse extraction response as JSON',
      expect.anything(),
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('downgrades HeadlessLLMClient empty text errors to empty extraction results', async () => {
    const queryError = new Error('HeadlessLLMClient received empty text from model "gpt-5.4-mini" via responses')
    const query = vi.fn().mockRejectedValue(queryError)
    const extractor = new MemoryExtractor({
      llmClient: { query } as unknown as HeadlessLLMClient,
    })
    const event: InteractionEvent = {
      type: 'session',
      projectId: 'project-1',
      sessionId: 'session-1',
      content: 'User: I prefer concise Chinese responses and this project uses Vitest for unit tests.',
      metadata: {
        projectName: 'OpenCow',
      },
      timestamp: Date.now(),
    }

    const candidates = await extractor.extract(event, { user: [], project: [] })

    expect(candidates).toEqual([])
    expect(logger.debug).toHaveBeenCalledWith('Extraction skipped because LLM returned empty text', expect.objectContaining({
      message: queryError.message,
    }))
    expect(logger.warn).not.toHaveBeenCalledWith('Extraction skipped because LLM returned empty text', queryError)
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalledWith(
      'Failed to parse extraction response as JSON',
      expect.anything(),
    )
  })

  it('downgrades named HeadlessEmptyTextError instances to empty extraction results', async () => {
    const queryError = new Error('provider returned no extractable text')
    queryError.name = 'HeadlessEmptyTextError'
    const query = vi.fn().mockRejectedValue(queryError)
    const extractor = new MemoryExtractor({
      llmClient: { query } as unknown as HeadlessLLMClient,
    })
    const event: InteractionEvent = {
      type: 'session',
      projectId: 'project-1',
      sessionId: 'session-1',
      content: 'User: I prefer concise Chinese responses and this project uses Vitest for unit tests.',
      metadata: {
        projectName: 'OpenCow',
      },
      timestamp: Date.now(),
    }

    const candidates = await extractor.extract(event, { user: [], project: [] })

    expect(candidates).toEqual([])
    expect(logger.debug).toHaveBeenCalledWith('Extraction skipped because LLM returned empty text', expect.objectContaining({
      message: queryError.message,
    }))
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('keeps non-empty-text LLM errors on the extraction error path', async () => {
    const queryError = new Error('HeadlessLLMClient request timed out')
    const query = vi.fn().mockRejectedValue(queryError)
    const extractor = new MemoryExtractor({
      llmClient: { query } as unknown as HeadlessLLMClient,
    })
    const event: InteractionEvent = {
      type: 'session',
      projectId: 'project-1',
      sessionId: 'session-1',
      content: 'User: I prefer concise Chinese responses and this project uses Vitest for unit tests.',
      metadata: {
        projectName: 'OpenCow',
      },
      timestamp: Date.now(),
    }

    const candidates = await extractor.extract(event, { user: [], project: [] })

    expect(candidates).toEqual([])
    expect(logger.error).toHaveBeenCalledWith('Extraction failed', queryError)
  })
})
