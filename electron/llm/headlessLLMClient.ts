// SPDX-License-Identifier: Apache-2.0

/**
 * HeadlessLLMClient — lightweight single-turn text generation via Vercel AI SDK.
 *
 * Uses @ai-sdk/anthropic and @ai-sdk/openai for protocol abstraction.
 * The SDK handles auth headers, API versioning, retries, and response parsing.
 *
 * Provider is created dynamically on each query() call based on the current
 * engine configuration, so engine switches take effect immediately.
 */

import { generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createLogger } from '../platform/logger'
import type { LLMAuthConfig, HeadlessLLMClient, HeadlessQueryParams, HeadlessClientDeps } from './types'
import { toApiErrorLogContext } from './apiErrorLogContext'

const log = createLogger('HeadlessLLMClient')

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_TIMEOUT_MS = 30_000

export class HeadlessLLMClientImpl implements HeadlessLLMClient {
  private readonly deps: HeadlessClientDeps

  constructor(deps: HeadlessClientDeps) {
    this.deps = deps
  }

  async query(params: HeadlessQueryParams): Promise<string> {
    const auth = await this.deps.resolveAuth()
    const fetchFn = this.deps.getFetch()
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS

    log.debug('HeadlessLLMClient query', {
      protocol: auth.protocol,
      model: auth.model,
      baseUrl: auth.baseUrl,
      authStyle: auth.authStyle,
    })

    const model = this.createModel(auth, fetchFn)

    try {
      const { text } = await generateText({
        model,
        system: params.systemPrompt,
        prompt: params.userMessage,
        maxOutputTokens: maxTokens,
        abortSignal: AbortSignal.timeout(timeoutMs),
      })

      return text
    } catch (err) {
      log.error('HeadlessLLMClient query failed', {
        protocol: auth.protocol,
        model: auth.model,
        baseUrl: auth.baseUrl,
        ...toApiErrorLogContext(err),
      }, err)
      throw err
    }
  }

  /**
   * Create an AI SDK model instance based on the resolved auth config.
   *
   * - Anthropic: apiKey → x-api-key header; authToken → Authorization: Bearer
   * - OpenAI: apiKey → Authorization: Bearer
   */
  private createModel(auth: LLMAuthConfig, fetchFn: typeof globalThis.fetch) {
    if (auth.protocol === 'anthropic') {
      // @ai-sdk/anthropic expects baseURL to include /v1 (default: https://api.anthropic.com/v1)
      // and appends /messages to it. Our LLMAuthConfig.baseUrl may not include /v1
      // (e.g. custom proxy "http://proxy.example.com"), so ensure the suffix is present.
      const baseURL = auth.baseUrl.endsWith('/v1')
        ? auth.baseUrl
        : `${auth.baseUrl.replace(/\/+$/, '')}/v1`

      const provider = createAnthropic({
        ...(auth.authStyle === 'x-api-key'
          ? { apiKey: auth.apiKey }
          : { authToken: auth.apiKey }),
        baseURL,
        fetch: fetchFn,
      })
      return provider(auth.model)
    }

    // Use Chat Completions for headless memory extraction. The AI SDK's default
    // OpenAI model path uses Responses API, where some OpenAI-compatible gateways
    // require top-level `instructions`; chat models map `system`/`prompt` to the
    // broadly supported messages shape instead.
    const baseURL = auth.baseUrl.endsWith('/v1')
      ? auth.baseUrl
      : `${auth.baseUrl.replace(/\/+$/, '')}/v1`

    const provider = createOpenAI({
      apiKey: auth.apiKey,
      baseURL,
      fetch: fetchFn,
    })
    return provider.chat(auth.model)
  }
}
