// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { HeadlessLLMClientImpl } from '../../../electron/llm/headlessLLMClient'

vi.mock('ai', () => ({
  generateText: vi.fn(),
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(),
}))

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(),
}))

vi.mock('../../../electron/platform/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
  })),
}))

const mockedGenerateText = vi.mocked(generateText)
const mockedCreateOpenAI = vi.mocked(createOpenAI)
const mockedCreateAnthropic = vi.mocked(createAnthropic)

describe('HeadlessLLMClientImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedGenerateText.mockResolvedValue({ text: 'ok' } as Awaited<ReturnType<typeof generateText>>)
  })

  it('uses OpenAI chat completions and passes system prompt to generateText', async () => {
    const openaiChatModel = { provider: 'openai.chat', modelId: 'gpt-5.4-mini' }
    const openaiProvider = Object.assign(vi.fn(), {
      chat: vi.fn(() => openaiChatModel),
    })
    mockedCreateOpenAI.mockReturnValue(openaiProvider as unknown as ReturnType<typeof createOpenAI>)

    const client = new HeadlessLLMClientImpl({
      resolveAuth: async () => ({
        protocol: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://agent.cam01.cn',
        authStyle: 'bearer',
        model: 'gpt-5.4-mini',
      }),
      getFetch: () => fetch,
    })

    const text = await client.query({
      systemPrompt: 'system instructions',
      userMessage: 'user message',
      maxTokens: 123,
      timeoutMs: 5_000,
    })

    expect(text).toBe('ok')
    expect(mockedCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      baseURL: 'https://agent.cam01.cn/v1',
      fetch,
    })
    expect(openaiProvider.chat).toHaveBeenCalledWith('gpt-5.4-mini')
    expect(openaiProvider).not.toHaveBeenCalled()
    expect(mockedGenerateText).toHaveBeenCalledWith(expect.objectContaining({
      model: openaiChatModel,
      system: 'system instructions',
      prompt: 'user message',
      maxOutputTokens: 123,
    }))
  })

  it('keeps Anthropic provider behavior and passes system prompt to generateText', async () => {
    const anthropicModel = { provider: 'anthropic', modelId: 'claude-sonnet' }
    const anthropicProvider = vi.fn(() => anthropicModel)
    mockedCreateAnthropic.mockReturnValue(anthropicProvider as unknown as ReturnType<typeof createAnthropic>)

    const client = new HeadlessLLMClientImpl({
      resolveAuth: async () => ({
        protocol: 'anthropic',
        apiKey: 'anthropic-test',
        baseUrl: 'https://api.anthropic.com',
        authStyle: 'x-api-key',
        model: 'claude-sonnet',
      }),
      getFetch: () => fetch,
    })

    const text = await client.query({
      systemPrompt: 'system instructions',
      userMessage: 'user message',
    })

    expect(text).toBe('ok')
    expect(mockedCreateAnthropic).toHaveBeenCalledWith({
      apiKey: 'anthropic-test',
      baseURL: 'https://api.anthropic.com/v1',
      fetch,
    })
    expect(anthropicProvider).toHaveBeenCalledWith('claude-sonnet')
    expect(mockedGenerateText).toHaveBeenCalledWith(expect.objectContaining({
      model: anthropicModel,
      system: 'system instructions',
      prompt: 'user message',
      maxOutputTokens: 4096,
    }))
  })
})
