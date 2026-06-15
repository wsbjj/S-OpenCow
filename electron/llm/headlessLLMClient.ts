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
import type {
  LLMAuthConfig,
  HeadlessLLMClient,
  HeadlessQueryParams,
  HeadlessClientDeps
} from './types'
import { toApiErrorLogContext } from './apiErrorLogContext'

const log = createLogger('HeadlessLLMClient')

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_TIMEOUT_MS = 30_000

type GenerateTextOptions = Parameters<typeof generateText>[0]
type GenerateTextResult = Awaited<ReturnType<typeof generateText>>
type UnknownRecord = Record<string, unknown>
type TextCandidate = {
  source: string
  text: string
}
type OpenAIProvider = ReturnType<typeof createOpenAI>

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
      authStyle: auth.authStyle
    })

    try {
      if (auth.protocol === 'openai') {
        return await this.queryOpenAI(auth, fetchFn, params, maxTokens, timeoutMs)
      }

      const result = await this.generateWithModel(
        this.createAnthropicModel(auth, fetchFn),
        params,
        maxTokens,
        timeoutMs
      )
      return this.requireNonEmptyText(result, auth, 'messages')
    } catch (err) {
      if (this.isEmptyTextError(err)) {
        throw err
      }
      log.error(
        'HeadlessLLMClient query failed',
        {
          protocol: auth.protocol,
          model: auth.model,
          baseUrl: auth.baseUrl,
          ...toApiErrorLogContext(err)
        },
        err
      )
      throw err
    }
  }

  /**
   * Create an AI SDK model instance based on the resolved auth config.
   *
   * - Anthropic: apiKey → x-api-key header; authToken → Authorization: Bearer
   * - OpenAI: apiKey → Authorization: Bearer
   */
  private createAnthropicModel(
    auth: LLMAuthConfig,
    fetchFn: typeof globalThis.fetch
  ): GenerateTextOptions['model'] {
    const provider = createAnthropic({
      ...(auth.authStyle === 'x-api-key' ? { apiKey: auth.apiKey } : { authToken: auth.apiKey }),
      baseURL: this.normalizeBaseURL(auth.baseUrl),
      fetch: fetchFn
    })
    return provider(auth.model)
  }

  private async queryOpenAI(
    auth: LLMAuthConfig,
    fetchFn: typeof globalThis.fetch,
    params: HeadlessQueryParams,
    maxTokens: number,
    timeoutMs: number
  ): Promise<string> {
    const provider = this.createOpenAIProvider(auth, fetchFn)
    if (this.shouldPreferResponsesFirst(auth)) {
      return this.queryOpenAIResponsesFirst(auth, provider, params, maxTokens, timeoutMs)
    }

    return this.queryOpenAIChatFirst(auth, provider, params, maxTokens, timeoutMs)
  }

  private async queryOpenAIChatFirst(
    auth: LLMAuthConfig,
    provider: OpenAIProvider,
    params: HeadlessQueryParams,
    maxTokens: number,
    timeoutMs: number
  ): Promise<string> {
    const chatResult = await this.generateWithModel(
      provider.chat(auth.model),
      params,
      maxTokens,
      timeoutMs
    )

    const chatText = this.extractNonEmptyText(chatResult)
    if (chatText) {
      return chatText
    }

    if (!this.shouldFallbackToResponses(auth)) {
      return this.requireNonEmptyText(chatResult, auth, 'chat/completions')
    }

    // Chat Completions remains the default. Retry through Responses only for
    // GPT-5-family models that returned a successful but empty chat response.
    this.logEmptyTextResult(auth, 'chat/completions', chatResult)
    const responsesResult = await this.generateWithOpenAIResponses(
      auth,
      provider,
      params,
      maxTokens,
      timeoutMs
    )
    return this.requireNonEmptyText(responsesResult, auth, 'responses')
  }

  private async queryOpenAIResponsesFirst(
    auth: LLMAuthConfig,
    provider: OpenAIProvider,
    params: HeadlessQueryParams,
    maxTokens: number,
    timeoutMs: number
  ): Promise<string> {
    try {
      const responsesResult = await this.generateWithOpenAIResponses(
        auth,
        provider,
        params,
        maxTokens,
        timeoutMs
      )
      const responsesText = this.extractNonEmptyText(responsesResult)
      if (responsesText) {
        return responsesText
      }
      this.logEmptyTextResult(auth, 'responses', responsesResult)
    } catch (err) {
      if (!this.isResponsesCompatibilityError(err)) {
        throw err
      }
      log.debug('HeadlessLLMClient falling back from responses to chat completions', {
        protocol: auth.protocol,
        model: auth.model,
        baseUrl: auth.baseUrl,
        ...toApiErrorLogContext(err)
      })
    }

    const chatResult = await this.generateWithModel(
      provider.chat(auth.model),
      params,
      maxTokens,
      timeoutMs
    )
    return this.requireNonEmptyText(chatResult, auth, 'chat/completions')
  }

  private createOpenAIProvider(
    auth: LLMAuthConfig,
    fetchFn: typeof globalThis.fetch
  ): OpenAIProvider {
    return createOpenAI({
      apiKey: auth.apiKey,
      baseURL: this.normalizeBaseURL(auth.baseUrl),
      fetch: fetchFn
    })
  }

  private generateWithOpenAIResponses(
    auth: LLMAuthConfig,
    provider: OpenAIProvider,
    params: HeadlessQueryParams,
    maxTokens: number,
    timeoutMs: number
  ): Promise<GenerateTextResult> {
    return this.generateWithModel(
      provider.responses(auth.model),
      params,
      this.shouldPassMaxOutputTokensToResponses(auth) ? maxTokens : undefined,
      timeoutMs,
      {
        openai: {
          instructions: params.systemPrompt,
          systemMessageMode: 'remove'
        }
      }
    )
  }

  private async generateWithModel(
    model: GenerateTextOptions['model'],
    params: HeadlessQueryParams,
    maxTokens: number | undefined,
    timeoutMs: number,
    providerOptions?: GenerateTextOptions['providerOptions']
  ): Promise<GenerateTextResult> {
    return generateText({
      model,
      system: params.systemPrompt,
      prompt: params.userMessage,
      ...(typeof maxTokens === 'number' ? { maxOutputTokens: maxTokens } : {}),
      abortSignal: AbortSignal.timeout(timeoutMs),
      ...(providerOptions ? { providerOptions } : {})
    })
  }

  private normalizeBaseURL(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, '')
    return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
  }

  private shouldFallbackToResponses(auth: LLMAuthConfig): boolean {
    return auth.protocol === 'openai' && auth.model.toLowerCase().startsWith('gpt-5')
  }

  private shouldPreferResponsesFirst(auth: LLMAuthConfig): boolean {
    return auth.protocol === 'openai' && this.isSmallOpenAIModel(auth.model)
  }

  private isSmallOpenAIModel(model: string): boolean {
    return /(?:^|[-_.:/])(mini|nano|small)(?:$|[-_.:/])/i.test(model)
  }

  private shouldPassMaxOutputTokensToResponses(auth: LLMAuthConfig): boolean {
    try {
      return (
        new URL(this.normalizeBaseURL(auth.baseUrl)).hostname.toLowerCase() === 'api.openai.com'
      )
    } catch {
      return false
    }
  }

  private isResponsesCompatibilityError(err: unknown): boolean {
    const record = this.asRecord(err)
    if (!record) return false

    const url = this.stringField(record.url) ?? ''
    const statusCode = this.numberField(record.statusCode)
    const message = this.stringField(record.message) ?? ''
    const responseBody = this.stringField(record.responseBody) ?? ''
    const text = `${message}\n${responseBody}`.toLowerCase()

    if (!url.includes('/responses')) return false
    if (statusCode === 405 || statusCode === 501) return true

    // HTTP 200 but SDK schema validation failed — third-party OpenAI-compatible proxies
    // may return a Responses API structure that passes JSON.parse but fails the SDK's
    // internal zod schema, causing AI_APICallError with "Invalid JSON response" on a 200.
    if (message === 'Invalid JSON response') return true

    if (statusCode !== 400) return false

    return (
      text.includes('unsupported parameter') ||
      text.includes('unknown parameter') ||
      text.includes('unrecognized parameter') ||
      text.includes('unsupported api') ||
      text.includes('unsupported endpoint') ||
      text.includes('invalid endpoint')
    )
  }

  private requireNonEmptyText(
    result: GenerateTextResult,
    auth: LLMAuthConfig,
    apiPath: string
  ): string {
    const text = this.extractNonEmptyText(result)
    if (text) {
      return text
    }

    this.logEmptyTextResult(auth, apiPath, result)
    throw this.createEmptyTextError(auth, apiPath)
  }

  private createEmptyTextError(auth: LLMAuthConfig, apiPath: string, cause?: unknown): Error {
    const err = new Error(
      `HeadlessLLMClient received empty text from model "${auth.model}" via ${apiPath}`
    )
    err.name = 'HeadlessEmptyTextError'
    if (cause !== undefined) {
      const errWithCause = err as Error & { cause?: unknown }
      errWithCause.cause = cause
    }
    return err
  }

  private isEmptyTextError(err: unknown): boolean {
    if (err instanceof Error && err.name === 'HeadlessEmptyTextError') return true
    const message = err instanceof Error ? err.message.toLowerCase() : ''
    return (
      message.includes('headlessllmclient') && message.includes('empty') && message.includes('text')
    )
  }

  private extractNonEmptyText(result: GenerateTextResult): string | null {
    if (!this.isBlank(result.text)) {
      return result.text
    }

    const contentText = this.extractTextFromContentParts(result.content)
    if (contentText) {
      return contentText
    }

    return this.extractJsonLikeRawText(result.response?.body)
  }

  private extractTextFromContentParts(content: unknown): string | null {
    if (!Array.isArray(content)) return null

    const texts = content
      .map((part) => {
        const record = this.asRecord(part)
        return record?.type === 'text' && typeof record.text === 'string' ? record.text : null
      })
      .filter((text): text is string => typeof text === 'string' && !this.isBlank(text))

    return texts.length > 0 ? texts.join('\n') : null
  }

  private extractJsonLikeRawText(body: unknown): string | null {
    for (const candidate of this.getRawTextCandidates(body)) {
      if (!this.isBlank(candidate.text) && this.isJsonLikeText(candidate.text)) {
        return candidate.text
      }
    }
    return null
  }

  private getRawTextCandidates(body: unknown): TextCandidate[] {
    const root = this.asRecord(body)
    if (!root) return []

    const candidates: TextCandidate[] = []
    this.addStringCandidate(candidates, 'response.output_text', root.output_text)
    this.addStringCandidate(candidates, 'response.text', root.text)

    const choices = Array.isArray(root.choices) ? root.choices : []
    choices.forEach((choice, index) => {
      const choiceRecord = this.asRecord(choice)
      const message = this.asRecord(choiceRecord?.message)
      this.addStringCandidate(
        candidates,
        `response.choices[${index}].message.content`,
        message?.content
      )
      this.addTextCandidatesFromValue(
        candidates,
        `response.choices[${index}].message.content`,
        message?.content
      )
    })

    const output = Array.isArray(root.output) ? root.output : []
    output.forEach((item, outputIndex) => {
      const itemRecord = this.asRecord(item)
      this.addStringCandidate(candidates, `response.output[${outputIndex}].text`, itemRecord?.text)

      const content = Array.isArray(itemRecord?.content) ? itemRecord.content : []
      content.forEach((part, contentIndex) => {
        const partRecord = this.asRecord(part)
        this.addStringCandidate(
          candidates,
          `response.output[${outputIndex}].content[${contentIndex}].text`,
          partRecord?.text
        )
      })
    })

    return candidates
  }

  private addStringCandidate(candidates: TextCandidate[], source: string, value: unknown): void {
    if (typeof value === 'string') {
      candidates.push({ source, text: value })
    }
  }

  private addTextCandidatesFromValue(
    candidates: TextCandidate[],
    source: string,
    value: unknown
  ): void {
    if (!Array.isArray(value)) return

    value.forEach((part, index) => {
      const partRecord = this.asRecord(part)
      this.addStringCandidate(candidates, `${source}[${index}].text`, partRecord?.text)
    })
  }

  private isJsonLikeText(text: string): boolean {
    const stripped = this.stripMarkdownFence(text).trim()
    return stripped.startsWith('{') || stripped.startsWith('[')
  }

  private stripMarkdownFence(text: string): string {
    const trimmed = text.trim()
    if (!trimmed.startsWith('```')) return trimmed
    return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  }

  private isBlank(text: string | null | undefined): boolean {
    return !text || text.trim().length === 0
  }

  private logEmptyTextResult(
    auth: LLMAuthConfig,
    apiPath: string,
    result: GenerateTextResult
  ): void {
    log.debug('HeadlessLLMClient received empty text', {
      protocol: auth.protocol,
      model: auth.model,
      baseUrl: auth.baseUrl,
      apiPath,
      finishReason: result.finishReason,
      rawFinishReason: result.rawFinishReason,
      contentTypes: this.getContentTypes(result.content),
      rawResponse: this.summarizeRawResponseBody(result.response?.body),
      usage: result.usage,
      totalUsage: result.totalUsage
    })
  }

  private summarizeRawResponseBody(body: unknown): UnknownRecord | undefined {
    const root = this.asRecord(body)
    if (!root) return body === undefined || body === null ? undefined : { type: typeof body }

    const choices = Array.isArray(root.choices) ? root.choices : []
    const output = Array.isArray(root.output) ? root.output : []
    const candidates = this.getRawTextCandidates(body)

    return {
      topLevelKeys: Object.keys(root).slice(0, 20),
      id: typeof root.id === 'string' ? root.id : undefined,
      model: typeof root.model === 'string' ? root.model : undefined,
      choicesCount: choices.length,
      choiceSummaries: choices
        .slice(0, 3)
        .map((choice, index) => this.summarizeChoice(choice, index)),
      outputCount: output.length,
      outputTypes: this.uniqueStrings(output.map((item) => this.asRecord(item)?.type)),
      rawUsage: this.summarizeRawUsage(root.usage),
      textCandidates: candidates.map((candidate) => ({
        source: candidate.source,
        length: candidate.text.length,
        jsonLike: this.isJsonLikeText(candidate.text)
      }))
    }
  }

  private summarizeChoice(choice: unknown, index: number): UnknownRecord {
    const choiceRecord = this.asRecord(choice)
    const message = this.asRecord(choiceRecord?.message)
    const delta = this.asRecord(choiceRecord?.delta)
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []

    return {
      index,
      choiceKeys: choiceRecord ? Object.keys(choiceRecord).slice(0, 20) : [],
      finishReason: this.stringField(choiceRecord?.finish_reason ?? choiceRecord?.finishReason),
      messageKeys: message ? Object.keys(message).slice(0, 20) : undefined,
      messageRole: this.stringField(message?.role),
      messageContentShape: this.summarizeValueShape(message?.content),
      refusalShape: this.summarizeValueShape(message?.refusal),
      toolCallsCount: toolCalls.length,
      toolCallSummaries: toolCalls.slice(0, 3).map((toolCall) => this.summarizeToolCall(toolCall)),
      functionCallSummary: this.summarizeFunctionCall(message?.function_call),
      logprobsSummary: this.summarizeLogprobs(choiceRecord?.logprobs),
      choiceTextShape: this.summarizeValueShape(choiceRecord?.text),
      deltaSummary: delta
        ? {
            deltaKeys: Object.keys(delta).slice(0, 20),
            contentShape: this.summarizeValueShape(delta.content),
            refusalShape: this.summarizeValueShape(delta.refusal)
          }
        : undefined,
      extraKnownFieldShapes: {
        reasoningContent: this.summarizeValueShape(message?.reasoning_content),
        reasoning: this.summarizeValueShape(message?.reasoning),
        reasoningDetails: this.summarizeValueShape(message?.reasoning_details),
        parsed: this.summarizeValueShape(message?.parsed),
        audio: this.summarizeValueShape(message?.audio)
      }
    }
  }

  private summarizeToolCall(toolCall: unknown): UnknownRecord {
    const record = this.asRecord(toolCall)
    const fn = this.asRecord(record?.function)
    const args = fn?.arguments

    return {
      type: this.stringField(record?.type),
      hasId: typeof record?.id === 'string' && record.id.length > 0,
      functionName: this.stringField(fn?.name),
      argumentsLength: typeof args === 'string' ? args.length : undefined,
      argumentsJsonLike: typeof args === 'string' ? this.isJsonLikeText(args) : undefined
    }
  }

  private summarizeFunctionCall(functionCall: unknown): UnknownRecord | undefined {
    const record = this.asRecord(functionCall)
    if (!record) return undefined
    const args = record.arguments

    return {
      name: this.stringField(record.name),
      argumentsLength: typeof args === 'string' ? args.length : undefined,
      argumentsJsonLike: typeof args === 'string' ? this.isJsonLikeText(args) : undefined
    }
  }

  private summarizeLogprobs(logprobs: unknown): UnknownRecord | undefined {
    const record = this.asRecord(logprobs)
    if (!record) return undefined

    return {
      contentCount: Array.isArray(record.content) ? record.content.length : undefined,
      refusalCount: Array.isArray(record.refusal) ? record.refusal.length : undefined
    }
  }

  private summarizeRawUsage(usage: unknown): UnknownRecord | undefined {
    const record = this.asRecord(usage)
    if (!record) return undefined
    const completionDetails = this.asRecord(record.completion_tokens_details)
    const outputDetails = this.asRecord(record.output_tokens_details)

    return {
      promptTokens: this.numberField(record.prompt_tokens ?? record.input_tokens),
      completionTokens: this.numberField(record.completion_tokens ?? record.output_tokens),
      reasoningTokens: this.numberField(
        completionDetails?.reasoning_tokens ?? outputDetails?.reasoning_tokens
      ),
      textTokensFromRaw: this.numberField(outputDetails?.text_tokens),
      acceptedPredictionTokens: this.numberField(completionDetails?.accepted_prediction_tokens),
      rejectedPredictionTokens: this.numberField(completionDetails?.rejected_prediction_tokens)
    }
  }

  private summarizeValueShape(value: unknown): UnknownRecord {
    if (typeof value === 'string') {
      return {
        type: 'string',
        length: value.length,
        blank: this.isBlank(value),
        jsonLike: this.isJsonLikeText(value)
      }
    }
    if (Array.isArray(value)) {
      return {
        type: 'array',
        arrayLength: value.length,
        partTypes: this.uniqueStrings(value.map((item) => this.asRecord(item)?.type)),
        partKeys: value
          .slice(0, 3)
          .map((item) => this.asRecord(item))
          .filter((item): item is UnknownRecord => item !== null)
          .map((item) => Object.keys(item).slice(0, 20))
      }
    }
    const record = this.asRecord(value)
    if (record) {
      return {
        type: 'object',
        keys: Object.keys(record).slice(0, 20)
      }
    }
    return { type: value === null ? 'null' : typeof value }
  }

  private stringField(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
  }

  private numberField(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined
  }

  private uniqueStrings(values: unknown[]): string[] {
    return [...new Set(values.filter((value): value is string => typeof value === 'string'))]
  }

  private getContentTypes(content: unknown): string[] {
    if (!Array.isArray(content)) return []
    return content
      .map((part) => this.asRecord(part)?.type)
      .filter((type): type is string => typeof type === 'string')
  }

  private asRecord(value: unknown): UnknownRecord | null {
    return typeof value === 'object' && value !== null ? (value as UnknownRecord) : null
  }
}
