// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from 'vitest'
import { MemoryExtractor } from '../../../electron/memory/memoryExtractor'
import type { InteractionEvent } from '../../../electron/memory/types'
import type { HeadlessLLMClient } from '../../../electron/llm/types'

vi.mock('../../../electron/platform/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('MemoryExtractor', () => {
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
})
