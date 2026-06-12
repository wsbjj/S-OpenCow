// SPDX-License-Identifier: Apache-2.0

/**
 * ProviderService — Central orchestrator for all API provider modes.
 *
 * Responsibilities:
 *   1. Maintain the active provider adapter based on user settings
 *   2. Provide `getProviderEnv()` for SessionOrchestrator to inject into SDK env
 *   3. Expose login/logout/status for the IPC layer and frontend
 *   4. Broadcast provider status changes via DataBus
 *
 * Architecture:
 *   - Strategy pattern: each ApiProvider maps to a ProviderAdapter implementation
 *   - Engine-scoped active provider (`provider.byEngine.{claude|codex}.activeMode`)
 *   - Sensitive credentials in CredentialStore (encrypted)
 *   - Non-sensitive config in SettingsService (plaintext JSON)
 */

import type {
  AIEngineKind,
  ApiProvider,
  BackgroundModelCredentialInfo,
  BackgroundModelSettings,
  ProviderSettings,
  ProviderStatus,
  ProviderCredentialInfo,
  ProviderModelInfo,
  ProviderModelListResult,
  DataBusEvent,
} from '@shared/types'
import type { CodexAuthConfig, ProviderAdapter } from './types'
import type { LLMAuthConfig } from '../../llm/types'
import { CredentialStore } from './credentialStore'
import { SubscriptionProvider } from './providers/subscription'
import { AnthropicApiKeyProvider, OpenAIApiKeyProvider } from './providers/apiKey'
import { OpenRouterProvider } from './providers/openRouter'
import { CustomProvider } from './providers/custom'
import { createLogger } from '../../platform/logger'

const log = createLogger('ProviderService')

const ANTHROPIC_VERSION = '2023-06-01'

export interface ProviderServiceDeps {
  dispatch: (event: DataBusEvent) => void
  credentialStoreByEngine: Record<AIEngineKind, CredentialStore>
  backgroundCredentialStore: CredentialStore<{
    apiKey?: string
    claudeApiKey?: string
    codexApiKey?: string
  }>
  /** Returns current provider settings (non-sensitive config). */
  getProviderSettings: () => ProviderSettings
  /** Returns a proxy-aware fetch implementation for external provider APIs. */
  getFetch?: () => typeof globalThis.fetch
  /** Bring the app window to the foreground (called after successful auth). */
  focusApp?: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function buildProviderModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const pathname = url.pathname.replace(/\/+$/, '')

  if (!pathname || pathname === '/') {
    url.pathname = '/v1/models'
  } else if (pathname.endsWith('/models')) {
    url.pathname = pathname
  } else if (pathname.endsWith('/v1')) {
    url.pathname = `${pathname}/models`
  } else {
    url.pathname = `${pathname}/v1/models`
  }

  url.search = ''
  url.hash = ''
  return url.toString()
}

function parseProviderModelResponse(raw: unknown): ProviderModelInfo[] {
  const items = isRecord(raw) && Array.isArray(raw.data)
    ? raw.data
    : Array.isArray(raw)
      ? raw
      : []

  const seen = new Set<string>()
  const models: ProviderModelInfo[] = []

  for (const item of items) {
    const id = typeof item === 'string'
      ? item
      : isRecord(item) && typeof item.id === 'string'
        ? item.id
        : ''

    const trimmedId = id.trim()
    if (!trimmedId || seen.has(trimmedId)) continue
    seen.add(trimmedId)

    const displayName = isRecord(item)
      ? [item.display_name, item.displayName, item.name]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : undefined

    models.push({
      id: trimmedId,
      ...(displayName ? { displayName } : {}),
    })
  }

  return models
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return ''
  }
}

function backgroundCredentialKey(engineKind: AIEngineKind): 'claudeApiKey' | 'codexApiKey' {
  return engineKind === 'codex' ? 'codexApiKey' : 'claudeApiKey'
}

function normalizeCredentialArgs(
  engineOrCredential?: AIEngineKind | BackgroundModelCredentialInfo,
  maybeCredential?: BackgroundModelCredentialInfo,
): { engineKind?: AIEngineKind; credential: BackgroundModelCredentialInfo } {
  if (engineOrCredential === 'claude' || engineOrCredential === 'codex') {
    return { engineKind: engineOrCredential, credential: maybeCredential ?? {} }
  }
  return { credential: engineOrCredential ?? {} }
}

export class ProviderService {
  private readonly deps: ProviderServiceDeps
  private readonly providersByEngine: Map<AIEngineKind, Map<ApiProvider, ProviderAdapter>>

  constructor(deps: ProviderServiceDeps) {
    this.deps = deps
    this.providersByEngine = new Map<AIEngineKind, Map<ApiProvider, ProviderAdapter>>([
      ['claude', this.createProviders('claude', deps.credentialStoreByEngine.claude)],
      ['codex', this.createProviders('codex', deps.credentialStoreByEngine.codex)],
    ])
  }

  private createProviders(engineKind: AIEngineKind, store: CredentialStore): Map<ApiProvider, ProviderAdapter> {
    return new Map<ApiProvider, ProviderAdapter>([
      ['subscription', new SubscriptionProvider(store)],
      ['api_key', engineKind === 'codex'
        ? new OpenAIApiKeyProvider(store)
        : new AnthropicApiKeyProvider(store)],
      ['openrouter', new OpenRouterProvider(store)],
      ['custom', new CustomProvider(store)],
    ])
  }

  private getEngineProviders(engineKind: AIEngineKind): Map<ApiProvider, ProviderAdapter> {
    return this.providersByEngine.get(engineKind) ?? this.providersByEngine.get('claude')!
  }

  private getEngineProviderSettings(engineKind: AIEngineKind): ProviderSettings['byEngine']['claude'] {
    const settings = this.deps.getProviderSettings()
    return settings.byEngine[engineKind] ?? { activeMode: null }
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Get the current provider status for the active mode.
   * Returns `unauthenticated` if no mode is configured.
   */
  async getStatus(engineKind: AIEngineKind = 'claude'): Promise<ProviderStatus> {
    const mode = this.getEngineProviderSettings(engineKind).activeMode
    if (!mode) {
      return { state: 'unauthenticated', mode: null }
    }

    const provider = this.getEngineProviders(engineKind).get(mode)
    if (!provider) {
      return { state: 'error', mode, error: `Unknown provider mode: ${mode}` }
    }

    const adapterStatus = await provider.checkStatus()

    // Codex readiness is stricter than generic credential existence:
    // we must be able to resolve OpenAI-compatible auth options (apiKey/baseUrl).
    // Otherwise UI can show "configured" while runtime cannot start Codex turns.
    if (engineKind === 'codex' && adapterStatus.authenticated) {
      if (!provider.getCodexAuthConfig) {
        return {
          state: 'unauthenticated',
          mode,
          error: `Provider mode "${mode}" does not expose Codex-compatible auth mapping`,
        }
      }
      const codexAuth = await provider.getCodexAuthConfig()
      if (!codexAuth?.apiKey) {
        return {
          state: 'unauthenticated',
          mode,
          error: `Provider mode "${mode}" has no usable Codex API key mapping`,
        }
      }
    }

    return {
      state: adapterStatus.authenticated ? 'authenticated' : 'unauthenticated',
      mode,
      detail: adapterStatus.detail,
      error: adapterStatus.error,
    }
  }

  /**
   * Get environment variables for the SDK subprocess.
   *
   * Called by SessionOrchestrator before spawning each SDK process.
   * Returns an empty object if no provider mode is configured (SDK falls back
   * to system-level credentials).
   */
  async getProviderEnv(engineKind: AIEngineKind): Promise<Record<string, string>> {
    const engineSettings = this.getEngineProviderSettings(engineKind)
    const mode = engineSettings.activeMode
    if (!mode) {
      if (engineKind === 'claude') {
        log.warn(`getProviderEnv(${engineKind}): no activeMode configured — session will use system credentials`)
      }
      return {}
    }

    const provider = this.getEngineProviders(engineKind).get(mode)
    if (!provider) {
      log.warn(`getProviderEnv: no adapter for mode "${mode}" — returning empty env`)
      return {}
    }

    try {
      const env = await provider.getEnv()

      // Claude SDK default model is controlled via ANTHROPIC_DEFAULT_SONNET_MODEL.
      if (engineKind === 'claude' && engineSettings.defaultModel) {
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = engineSettings.defaultModel
      }

      // Warn if the provider returned empty env — this almost certainly means
      // the session will fail with "Not Logged in" from the SDK.
      const hasAuthKey = Object.keys(env).some(
        (k) => k === 'CLAUDE_CODE_OAUTH_TOKEN' || k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN'
      )
      if (engineKind === 'claude' && !hasAuthKey) {
        log.warn(`getProviderEnv(${engineKind}): mode "${mode}" returned no auth credentials — session may fail`)
      }

      return env
    } catch (err) {
      log.error(`getProviderEnv(${engineKind}): failed for mode "${mode}"`, err)
      return {}
    }
  }

  /**
   * Resolve Codex SDK auth options from the current active provider mode.
   *
   * Returns null when:
   * - no active mode is configured
   * - the active provider does not expose Codex-compatible credentials
   * - credential lookup fails
   */
  async getCodexAuthConfig(engineKind: AIEngineKind): Promise<CodexAuthConfig | null> {
    const mode = this.getEngineProviderSettings(engineKind).activeMode
    if (!mode) return null

    const provider = this.getEngineProviders(engineKind).get(mode)
    if (!provider?.getCodexAuthConfig) return null

    try {
      const resolved = await provider.getCodexAuthConfig()
      if (!resolved?.apiKey) return null
      return resolved
    } catch (err) {
      log.error(`getCodexAuthConfig(${engineKind}): failed for mode "${mode}"`, err)
      return null
    }
  }

  /**
   * Perform authentication for the given mode.
   *
   * For subscription: triggers the OAuth PKCE browser flow.
   * For api_key: validates and stores the provided key.
   * For openrouter: validates and stores the OpenRouter API key.
   */
  async login(engineKind: AIEngineKind, mode: ApiProvider, params?: Record<string, unknown>): Promise<ProviderStatus> {
    const provider = this.getEngineProviders(engineKind).get(mode)
    if (!provider) {
      return { state: 'error', mode, error: `Unknown provider mode: ${mode}` }
    }

    // Broadcast authenticating state
    this.broadcastStatus({ state: 'authenticating', mode })

    try {
      const result = await provider.authenticate(params)

      const status: ProviderStatus = {
        state: result.authenticated ? 'authenticated' : 'error',
        mode,
        detail: result.detail,
        error: result.error,
      }

      this.broadcastStatus(status)
      log.info(`Login completed for mode "${mode}": ${status.state}`)

      // Restore app focus after authentication completes (especially important
      // for OAuth flows where the user was redirected to a browser).
      if (result.authenticated) {
        this.deps.focusApp?.()
      }

      return status
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status: ProviderStatus = { state: 'error', mode, error: message }
      this.broadcastStatus(status)
      log.error(`Login failed for mode "${mode}"`, err)
      return status
    }
  }

  /**
   * Cancel an in-progress login flow for the given mode.
   * Delegates to the adapter's cancelLogin() if it supports cancellation.
   */
  async cancelLogin(engineKind: AIEngineKind, mode: ApiProvider): Promise<void> {
    const provider = this.getEngineProviders(engineKind).get(mode)
    if (provider?.cancelLogin) {
      await provider.cancelLogin()
      this.broadcastStatus({ state: 'unauthenticated', mode })
      log.info(`Login cancelled for mode "${mode}"`)
    }
  }

  /**
   * Logout from a specific provider mode.
   * Clears credentials and broadcasts unauthenticated status.
   */
  async logout(engineKind: AIEngineKind, mode: ApiProvider): Promise<void> {
    const provider = this.getEngineProviders(engineKind).get(mode)
    if (provider) {
      await provider.logout()
    }

    // Broadcast with the actual mode — the user is still IN this mode, just unauthenticated.
    // This ensures isStatusForActiveMode guard on the frontend works correctly by design,
    // not by coincidence (null !== activeMode).
    this.broadcastStatus({ state: 'unauthenticated', mode })
    log.info(`Logged out from mode "${mode}"`)
  }

  /**
   * Return stored credential fields for the given mode (for edit form pre-fill).
   * Returns null if the provider doesn't support it or no credential is stored.
   */
  async getCredential(engineKind: AIEngineKind, mode: ApiProvider): Promise<ProviderCredentialInfo | null> {
    const provider = this.getEngineProviders(engineKind).get(mode)
    if (!provider?.getCredential) return null
    return provider.getCredential()
  }

  /**
   * Fetch model IDs from the currently selected provider's model-list endpoint.
   *
   * Claude uses Anthropic-compatible auth against the active provider's /v1/models.
   * Codex uses OpenAI-compatible auth against the active provider's /v1/models.
   */
  async listModels(engineKind: AIEngineKind): Promise<ProviderModelListResult> {
    const engineSettings = this.getEngineProviderSettings(engineKind)
    const mode = engineSettings.activeMode

    if (!mode) {
      throw new Error(`No active provider mode configured for engine "${engineKind}"`)
    }

    const provider = this.getEngineProviders(engineKind).get(mode)
    if (!provider) {
      throw new Error(`No adapter found for provider mode "${mode}"`)
    }

    if (engineKind === 'codex') {
      const codexAuth = provider.getCodexAuthConfig
        ? await provider.getCodexAuthConfig()
        : null
      if (!codexAuth?.apiKey) {
        throw new Error(`Provider mode "${mode}" is not compatible with Codex/OpenAI protocol`)
      }

      return this.fetchProviderModels({
        engineKind,
        mode,
        protocol: 'openai',
        apiKey: codexAuth.apiKey,
        baseUrl: codexAuth.baseUrl ?? 'https://api.openai.com',
        authStyle: 'bearer',
      })
    }

    const httpAuth = await provider.getHTTPAuth()
    if (!httpAuth?.apiKey) {
      throw new Error(`Provider mode "${mode}" returned no HTTP auth credentials`)
    }

    return this.fetchProviderModels({
      engineKind,
      mode,
      protocol: 'anthropic',
      apiKey: httpAuth.apiKey,
      baseUrl: httpAuth.baseUrl,
      authStyle: httpAuth.authStyle,
    })
  }

  async getBackgroundModelCredential(engineKind?: AIEngineKind): Promise<BackgroundModelCredentialInfo | null> {
    const apiKey = engineKind
      ? (await this.deps.backgroundCredentialStore.get(backgroundCredentialKey(engineKind)))
        ?? await this.deps.backgroundCredentialStore.get('apiKey')
      : await this.deps.backgroundCredentialStore.get('apiKey')
    return apiKey ? { apiKey } : null
  }

  async setBackgroundModelCredential(
    credential: BackgroundModelCredentialInfo,
  ): Promise<BackgroundModelCredentialInfo | null>
  async setBackgroundModelCredential(
    engineKind: AIEngineKind,
    credential: BackgroundModelCredentialInfo,
  ): Promise<BackgroundModelCredentialInfo | null>
  async setBackgroundModelCredential(
    engineOrCredential: AIEngineKind | BackgroundModelCredentialInfo,
    maybeCredential?: BackgroundModelCredentialInfo,
  ): Promise<BackgroundModelCredentialInfo | null> {
    const { engineKind, credential } = normalizeCredentialArgs(engineOrCredential, maybeCredential)
    const key = engineKind ? backgroundCredentialKey(engineKind) : 'apiKey'
    const apiKey = typeof credential.apiKey === 'string' ? credential.apiKey.trim() : ''
    if (!apiKey) {
      await this.deps.backgroundCredentialStore.remove(key)
      return null
    }
    await this.deps.backgroundCredentialStore.update(key, apiKey)
    return { apiKey }
  }

  async clearBackgroundModelCredential(engineKind?: AIEngineKind): Promise<void> {
    await this.deps.backgroundCredentialStore.remove(engineKind ? backgroundCredentialKey(engineKind) : 'apiKey')
  }

  /**
   * Resolve structured HTTP auth for direct LLM API calls.
   *
   * Combines adapter-level credentials with engine-level config
   * (protocol, model) to produce a complete auth config suitable
   * for constructing HTTP headers in direct fetch() calls.
   *
   * Resolution strategy per engine:
   * - Claude: adapter.getHTTPAuth() — all adapters support Anthropic protocol
   * - Codex:  adapter.getCodexAuthConfig() — only compatible adapters support OpenAI protocol
   *
   * @throws When no active provider, adapter not found, or credentials unavailable
   */
  async resolveHTTPAuth(engineKind: AIEngineKind): Promise<LLMAuthConfig> {
    const engineSettings = this.getEngineProviderSettings(engineKind)
    const mode = engineSettings.activeMode

    if (!mode) {
      throw new Error(`No active provider mode configured for engine "${engineKind}"`)
    }

    const provider = this.getEngineProviders(engineKind).get(mode)
    if (!provider) {
      throw new Error(`No adapter found for provider mode "${mode}"`)
    }

    // Codex engine: use getCodexAuthConfig() which already encodes
    // "is this adapter compatible with OpenAI protocol?" semantics.
    // Not all adapters support OpenAI — ApiKeyProvider (sk-ant-*) and
    // SubscriptionProvider (OAuth) return null.
    if (engineKind === 'codex') {
      const codexAuth = provider.getCodexAuthConfig
        ? await provider.getCodexAuthConfig()
        : null
      if (!codexAuth?.apiKey) {
        throw new Error(`Provider mode "${mode}" is not compatible with Codex/OpenAI protocol`)
      }
      return {
        protocol: 'openai',
        apiKey: codexAuth.apiKey,
        baseUrl: codexAuth.baseUrl ?? 'https://api.openai.com',
        authStyle: 'bearer',
        model: engineSettings.defaultModel ?? 'gpt-4o-mini',
      }
    }

    // Claude engine: use getHTTPAuth() for structured Anthropic-protocol auth
    const httpAuth = await provider.getHTTPAuth()
    if (!httpAuth) {
      throw new Error(`Provider mode "${mode}" returned no HTTP auth credentials`)
    }

    return {
      protocol: 'anthropic',
      apiKey: httpAuth.apiKey,
      baseUrl: httpAuth.baseUrl,
      authStyle: httpAuth.authStyle,
      model: engineSettings.defaultModel ?? 'claude-sonnet-4-20250514',
    }
  }

  async resolveBackgroundHTTPAuth(fallbackEngine: AIEngineKind): Promise<LLMAuthConfig> {
    const settings = this.deps.getProviderSettings()
    const backgroundModel = this.getBackgroundModelSettings(settings, fallbackEngine)

    if (backgroundModel.mode === 'inherit') {
      return this.resolveHTTPAuth(fallbackEngine)
    }

    if (backgroundModel.mode === 'inherit-model') {
      const inheritedAuth = await this.resolveHTTPAuth(fallbackEngine)
      const model = typeof backgroundModel.model === 'string' && backgroundModel.model.trim()
        ? backgroundModel.model.trim()
        : undefined
      if (model) {
        return { ...inheritedAuth, model }
      }
      return inheritedAuth
    }

    if (!backgroundModel.protocol) {
      throw new Error('Background model is custom but missing protocol')
    }
    if (!backgroundModel.baseUrl) {
      throw new Error('Background model is custom but missing base URL')
    }
    if (!backgroundModel.model) {
      throw new Error('Background model is custom but missing model')
    }

    const credential = await this.getBackgroundModelCredential(fallbackEngine)
    if (!credential?.apiKey) {
      throw new Error('Background model is custom but missing API key')
    }

    return {
      protocol: backgroundModel.protocol,
      apiKey: credential.apiKey,
      baseUrl: backgroundModel.baseUrl,
      authStyle: backgroundModel.protocol === 'openai'
        ? 'bearer'
        : (backgroundModel.authStyle ?? 'x-api-key'),
      model: backgroundModel.model,
    }
  }

  // ── Private ─────────────────────────────────────────────────────────

  private getBackgroundModelSettings(
    settings: ProviderSettings,
    engineKind: AIEngineKind,
  ): BackgroundModelSettings {
    return settings.byEngine[engineKind]?.backgroundModel
      ?? settings.backgroundModel
      ?? { mode: 'inherit' }
  }

  private async fetchProviderModels(auth: {
    engineKind: AIEngineKind
    mode: ApiProvider
    protocol: LLMAuthConfig['protocol']
    apiKey: string
    baseUrl: string
    authStyle: LLMAuthConfig['authStyle']
  }): Promise<ProviderModelListResult> {
    const sourceUrl = buildProviderModelsUrl(auth.baseUrl)
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }

    if (auth.protocol === 'anthropic') {
      headers['anthropic-version'] = ANTHROPIC_VERSION
      if (auth.authStyle === 'bearer') {
        headers.Authorization = `Bearer ${auth.apiKey}`
      } else {
        headers['x-api-key'] = auth.apiKey
      }
    } else {
      headers.Authorization = `Bearer ${auth.apiKey}`
    }

    const fetchFn = this.deps.getFetch?.() ?? globalThis.fetch
    const response = await fetchFn(sourceUrl, {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      const body = await readErrorBody(response)
      throw new Error(
        `Failed to fetch model list from ${sourceUrl} (HTTP ${response.status})${body ? `: ${body}` : ''}`,
      )
    }

    const raw = await response.json()
    return {
      engineKind: auth.engineKind,
      mode: auth.mode,
      protocol: auth.protocol,
      sourceUrl,
      models: parseProviderModelResponse(raw),
    }
  }

  private broadcastStatus(status: ProviderStatus): void {
    this.deps.dispatch({ type: 'provider:status', payload: status })
  }
}
