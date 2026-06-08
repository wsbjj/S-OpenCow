// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { toApiErrorLogContext } from '../../../electron/llm/apiErrorLogContext'

describe('toApiErrorLogContext', () => {
  it('extracts safe API error fields without request body or credentials', () => {
    const context = toApiErrorLogContext({
      name: 'AI_APICallError',
      message: 'Bad Request',
      statusCode: 400,
      url: 'https://agent.cam01.cn/v1/responses',
      responseBody: '{"error":{"message":"model not found"}}',
      requestBodyValues: {
        input: 'user prompt content',
        apiKey: 'sk-secret',
      },
      headers: {
        authorization: 'Bearer sk-secret',
      },
      apiKey: 'sk-secret',
    })

    expect(context).toEqual({
      errorName: 'AI_APICallError',
      message: 'Bad Request',
      statusCode: 400,
      url: 'https://agent.cam01.cn/v1/responses',
      responseBodyPreview: '{"error":{"message":"model not found"}}',
    })

    const serialized = JSON.stringify(context)
    expect(serialized).not.toContain('sk-secret')
    expect(serialized).not.toContain('user prompt content')
    expect(serialized).not.toContain('requestBodyValues')
    expect(serialized).not.toContain('authorization')
  })

  it('keeps 400 instructions-required errors safe for JSON logging', () => {
    const context = toApiErrorLogContext({
      name: 'AI_APICallError',
      message: 'Bad Request',
      statusCode: 400,
      url: 'https://api.openai.com/v1/responses',
      responseBody:
        '{"error":{"message":"Instructions are required","type":"invalid_request_error"}}',
      requestBodyValues: {
        instructions: undefined,
        input: 'user prompt asking for private repo details',
        prompt: 'user prompt asking for private repo details',
      },
      headers: {
        Authorization: 'Bearer sk-secret',
        authorization: 'Bearer sk-secret',
      },
      apiKey: 'sk-secret',
    })

    expect(context).toEqual({
      errorName: 'AI_APICallError',
      message: 'Bad Request',
      statusCode: 400,
      url: 'https://api.openai.com/v1/responses',
      responseBodyPreview:
        '{"error":{"message":"Instructions are required","type":"invalid_request_error"}}',
    })

    const serialized = JSON.stringify(context)
    expect(serialized).not.toContain('sk-secret')
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('authorization')
    expect(serialized).not.toContain('requestBodyValues')
    expect(serialized).not.toContain('user prompt asking for private repo details')
  })

  it('truncates long response bodies', () => {
    const context = toApiErrorLogContext({
      message: 'Bad Request',
      responseBody: 'x'.repeat(1_500),
    })

    expect(context.responseBodyPreview).toHaveLength(1_003)
    expect(context.responseBodyPreview).toMatch(/\.\.\.$/)
  })
})
