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

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../../electron/platform/logger', () => ({
  createLogger: vi.fn(() => logger),
}))

const mockedGenerateText = vi.mocked(generateText)
const mockedCreateOpenAI = vi.mocked(createOpenAI)
const mockedCreateAnthropic = vi.mocked(createAnthropic)

describe('HeadlessLLMClientImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedGenerateText.mockReset()
    mockedCreateOpenAI.mockReset()
    mockedCreateAnthropic.mockReset()
    mockedGenerateText.mockResolvedValue({ text: 'ok' } as Awaited<ReturnType<typeof generateText>>)
  })

  it('uses OpenAI chat completions and passes system prompt to generateText', async () => {
    const openaiChatModel = { provider: 'openai.chat', modelId: 'gpt-5.4-mini' }
    const openaiProvider = Object.assign(vi.fn(), {
      chat: vi.fn(() => openaiChatModel),
      responses: vi.fn(),
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
    expect(openaiProvider.responses).not.toHaveBeenCalled()
    expect(openaiProvider).not.toHaveBeenCalled()
    expect(mockedGenerateText).toHaveBeenCalledWith(expect.objectContaining({
      model: openaiChatModel,
      system: 'system instructions',
      prompt: 'user message',
      maxOutputTokens: 123,
    }))
  })

  it('normalizes OpenAI base URLs with a trailing /v1 slash', async () => {
    const openaiChatModel = { provider: 'openai.chat', modelId: 'gpt-4o-mini' }
    const openaiProvider = Object.assign(vi.fn(), {
      chat: vi.fn(() => openaiChatModel),
      responses: vi.fn(),
    })
    mockedCreateOpenAI.mockReturnValue(openaiProvider as unknown as ReturnType<typeof createOpenAI>)

    const client = new HeadlessLLMClientImpl({
      resolveAuth: async () => ({
        protocol: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://agent.cam01.cn/v1/',
        authStyle: 'bearer',
        model: 'gpt-4o-mini',
      }),
      getFetch: () => fetch,
    })

    await client.query({
      systemPrompt: 'system instructions',
      userMessage: 'user message',
    })

    expect(mockedCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      baseURL: 'https://agent.cam01.cn/v1',
      fetch,
    })
  })

  it('falls back to OpenAI responses for gpt-5 chat completions with empty text', async () => {
    const openaiChatModel = { provider: 'openai.chat', modelId: 'gpt-5.4-mini' }
    const openaiResponsesModel = { provider: 'openai.responses', modelId: 'gpt-5.4-mini' }
    const openaiProvider = Object.assign(vi.fn(), {
      chat: vi.fn(() => openaiChatModel),
      responses: vi.fn(() => openaiResponsesModel),
    })
    mockedCreateOpenAI.mockReturnValue(openaiProvider as unknown as ReturnType<typeof createOpenAI>)
    mockedGenerateText
      .mockResolvedValueOnce({
        text: '',
        finishReason: 'stop',
        content: [],
        totalUsage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      } as Awaited<ReturnType<typeof generateText>>)
      .mockResolvedValueOnce({ text: '{"memories":[]}' } as Awaited<ReturnType<typeof generateText>>)

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
    })

    expect(text).toBe('{"memories":[]}')
    expect(openaiProvider.chat).toHaveBeenCalledWith('gpt-5.4-mini')
    expect(openaiProvider.responses).toHaveBeenCalledWith('gpt-5.4-mini')
    expect(mockedGenerateText).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: openaiChatModel }))
    expect(mockedGenerateText).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: openaiResponsesModel,
      providerOptions: {
        openai: {
          instructions: 'system instructions',
          systemMessageMode: 'remove',
        },
      },
    }))
  })

  it('propagates OpenAI responses fallback API failures after empty chat text', async () => {
    const openaiChatModel = { provider: 'openai.chat', modelId: 'gpt-5.4-mini' }
    const openaiResponsesModel = { provider: 'openai.responses', modelId: 'gpt-5.4-mini' }
    const openaiProvider = Object.assign(vi.fn(), {
      chat: vi.fn(() => openaiChatModel),
      responses: vi.fn(() => openaiResponsesModel),
    })
    const apiError = Object.assign(new Error('Bad Request'), {
      name: 'AI_APICallError',
      statusCode: 400,
      responseBody: '{"detail":"Instructions are required"}',
      url: 'https://agent.cam01.cn/v1/responses',
    })
    mockedCreateOpenAI.mockReturnValue(openaiProvider as unknown as ReturnType<typeof createOpenAI>)
    mockedGenerateText
      .mockResolvedValueOnce({
        text: '',
        finishReason: 'stop',
        content: [],
        response: {
          body: {
            id: 'resp-chat-empty',
            choices: [{ message: { content: null } }],
          },
        },
      } as unknown as Awaited<ReturnType<typeof generateText>>)
      .mockRejectedValueOnce(apiError)

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

    await expect(client.query({
      systemPrompt: 'system instructions',
      userMessage: 'user message',
    })).rejects.toThrow('Bad Request')

    expect(logger.error).toHaveBeenCalledWith(
      'HeadlessLLMClient query failed',
      expect.objectContaining({
        protocol: 'openai',
        model: 'gpt-5.4-mini',
        errorName: 'AI_APICallError',
        statusCode: 400,
      }),
      apiError,
    )
  })

  it('uses OpenAI chat content text parts when result text is empty', async () => {
    const openaiChatModel = { provider: 'openai.chat', modelId: 'gpt-5.4-mini' }
    const openaiProvider = Object.assign(vi.fn(), {
      chat: vi.fn(() => openaiChatModel),
      responses: vi.fn(),
    })
    mockedCreateOpenAI.mockReturnValue(openaiProvider as unknown as ReturnType<typeof createOpenAI>)
    mockedGenerateText.mockResolvedValueOnce({
      text: '',
      finishReason: 'stop',
      content: [{ type: 'text', text: '{"memories":[]}' }],
    } as unknown as Awaited<ReturnType<typeof generateText>>)

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
    })

    expect(text).toBe('{"memories":[]}')
    expect(openaiProvider.responses).not.toHaveBeenCalled()
  })

  it('uses OpenAI chat raw response JSON when result text is empty', async () => {
    const openaiChatModel = { provider: 'openai.chat', modelId: 'gpt-4o-mini' }
    const openaiProvider = Object.assign(vi.fn(), {
      chat: vi.fn(() => openaiChatModel),
      responses: vi.fn(),
    })
    mockedCreateOpenAI.mockReturnValue(openaiProvider as unknown as ReturnType<typeof createOpenAI>)
    mockedGenerateText.mockResolvedValueOnce({
      text: '',
      finishReason: 'stop',
      content: [],
      response: {
        body: {
          id: 'chatcmpl-1',
          model: 'gpt-4o-mini',
          choices: [
            {
              message: {
                content: '{"memories":[]}',
              },
            },
          ],
        },
      },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const client = new HeadlessLLMClientImpl({
      resolveAuth: async () => ({
        protocol: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://agent.cam01.cn',
        authStyle: 'bearer',
        model: 'gpt-4o-mini',
      }),
      getFetch: () => fetch,
    })

    const text = await client.query({
      systemPrompt: 'system instructions',
      userMessage: 'user message',
    })

    expect(text).toBe('{"memories":[]}')
    expect(openaiProvider.responses).not.toHaveBeenCalled()
  })

  it('uses OpenAI responses output_text raw response JSON when parsed text is empty', async () => {
    const openaiChatModel = { provider: 'openai.chat', modelId: 'gpt-5.4-mini' }
    const openaiResponsesModel = { provider: 'openai.responses', modelId: 'gpt-5.4-mini' }
    const openaiProvider = Object.assign(vi.fn(), {
      chat: vi.fn(() => openaiChatModel),
      responses: vi.fn(() => openaiResponsesModel),
    })
    mockedCreateOpenAI.mockReturnValue(openaiProvider as unknown as ReturnType<typeof createOpenAI>)
    mockedGenerateText
      .mockResolvedValueOnce({ text: '', finishReason: 'stop', content: [] } as Awaited<ReturnType<typeof generateText>>)
      .mockResolvedValueOnce({
        text: '',
        finishReason: 'stop',
        content: [],
        response: {
          body: {
            id: 'resp-1',
            model: 'gpt-5.4-mini',
            output_text: '```json\n{"memories":[]}\n```',
          },
        },
      } as unknown as Awaited<ReturnType<typeof generateText>>)

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
    })

    expect(text).toBe('```json\n{"memories":[]}\n```')
  })

  it('uses OpenAI responses nested output content raw response JSON when parsed text is empty', async () => {
    const openaiChatModel = { provider: 'openai.chat', modelId: 'gpt-5.4-mini' }
    const openaiResponsesModel = { provider: 'openai.responses', modelId: 'gpt-5.4-mini' }
    const openaiProvider = Object.assign(vi.fn(), {
      chat: vi.fn(() => openaiChatModel),
      responses: vi.fn(() => openaiResponsesModel),
    })
    mockedCreateOpenAI.mockReturnValue(openaiProvider as unknown as ReturnType<typeof createOpenAI>)
    mockedGenerateText
      .mockResolvedValueOnce({ text: '', finishReason: 'stop', content: [] } as Awaited<ReturnType<typeof generateText>>)
      .mockResolvedValueOnce({
        text: '',
        finishReason: 'stop',
        content: [],
        response: {
          body: {
            id: 'resp-2',
            model: 'gpt-5.4-mini',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: '{"memories":[]}',
                  },
                ],
              },
            ],
          },
        },
      } as unknown as Awaited<ReturnType<typeof generateText>>)

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
    })

    expect(text).toBe('{"memories":[]}')
  })

  it('throws a clear error when gpt-5 responses fallback also returns empty text', async () => {
    const openaiChatModel = { provider: 'openai.chat', modelId: 'gpt-5.4-mini' }
    const openaiResponsesModel = { provider: 'openai.responses', modelId: 'gpt-5.4-mini' }
    const openaiProvider = Object.assign(vi.fn(), {
      chat: vi.fn(() => openaiChatModel),
      responses: vi.fn(() => openaiResponsesModel),
    })
    mockedCreateOpenAI.mockReturnValue(openaiProvider as unknown as ReturnType<typeof createOpenAI>)
    mockedGenerateText
      .mockResolvedValueOnce({ text: '', finishReason: 'stop', content: [] } as Awaited<ReturnType<typeof generateText>>)
      .mockResolvedValueOnce({
        text: '   ',
        finishReason: 'stop',
        content: [],
        response: {
          body: {
            id: 'resp-empty',
            model: 'gpt-5.4-mini',
            output_text: 'plain text that is not valid JSON ' + 'x'.repeat(500),
          },
        },
      } as unknown as Awaited<ReturnType<typeof generateText>>)

    const client = new HeadlessLLMClientImpl({
      resolveAuth: async () => ({
        protocol: 'openai',
        apiKey: 'sk-test-secret',
        baseUrl: 'https://agent.cam01.cn',
        authStyle: 'bearer',
        model: 'gpt-5.4-mini',
      }),
      getFetch: () => fetch,
    })

    await expect(client.query({
      systemPrompt: 'system instructions',
      userMessage: 'private prompt phrase',
    })).rejects.toThrow('HeadlessLLMClient received empty text from model "gpt-5.4-mini"')

    const debugPayload = JSON.stringify(logger.debug.mock.calls)
    expect(debugPayload).not.toContain('sk-test-secret')
    expect(debugPayload).not.toContain('private prompt phrase')
    expect(debugPayload).not.toContain('x'.repeat(200))
    expect(debugPayload).not.toContain('plain text that is not valid JSON')
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
    expect(openaiProvider.responses).toHaveBeenCalledWith('gpt-5.4-mini')
  })

  it('logs raw response shape without leaking choice text', async () => {
    const openaiChatModel = { provider: 'openai.chat', modelId: 'gpt-4o-mini' }
    const openaiProvider = Object.assign(vi.fn(), {
      chat: vi.fn(() => openaiChatModel),
      responses: vi.fn(),
    })
    mockedCreateOpenAI.mockReturnValue(openaiProvider as unknown as ReturnType<typeof createOpenAI>)
    mockedGenerateText.mockResolvedValueOnce({
      text: '',
      finishReason: 'stop',
      rawFinishReason: 'stop',
      content: [],
      response: {
        body: {
          id: 'chatcmpl-empty',
          model: 'gpt-4o-mini',
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
            completion_tokens_details: {
              reasoning_tokens: 1,
              accepted_prediction_tokens: 2,
              rejected_prediction_tokens: 0,
            },
          },
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                refusal: 'sensitive refusal text',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'extract_memory',
                      arguments: '{"secret":"memory content"}',
                    },
                  },
                ],
              },
              logprobs: {
                content: [{ token: 'secret-token' }],
                refusal: [{ token: 'refusal-token' }],
              },
            },
          ],
        },
      },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const client = new HeadlessLLMClientImpl({
      resolveAuth: async () => ({
        protocol: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://agent.cam01.cn',
        authStyle: 'bearer',
        model: 'gpt-4o-mini',
      }),
      getFetch: () => fetch,
    })

    await expect(client.query({
      systemPrompt: 'system instructions',
      userMessage: 'user message',
    })).rejects.toThrow('HeadlessLLMClient received empty text from model "gpt-4o-mini"')

    const debugPayload = JSON.stringify(logger.debug.mock.calls)
    expect(debugPayload).toContain('choiceSummaries')
    expect(debugPayload).toContain('toolCallsCount')
    expect(debugPayload).toContain('argumentsLength')
    expect(debugPayload).toContain('rawUsage')
    expect(debugPayload).not.toContain('sensitive refusal text')
    expect(debugPayload).not.toContain('memory content')
    expect(debugPayload).not.toContain('secret-token')
    expect(logger.warn).not.toHaveBeenCalled()
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
