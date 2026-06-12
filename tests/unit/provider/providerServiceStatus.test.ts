// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { ProviderService } from '../../../electron/services/provider/providerService'
import type { AIEngineKind, ApiProvider, ProviderSettings } from '../../../src/shared/types'
import type { ProviderAdapter } from '../../../electron/services/provider/types'

function createProviderServiceForStatusTest(params: {
  engineKind: AIEngineKind
  mode: ApiProvider | null
  adapter: ProviderAdapter
  settingsPatch?: Partial<ProviderSettings>
  backgroundApiKey?: string
  backgroundApiKeyByEngine?: Partial<Record<AIEngineKind, string>>
}): ProviderService {
  const settings: ProviderSettings = {
    byEngine: {
      claude: { activeMode: null },
      codex: { activeMode: null },
    },
    ...params.settingsPatch,
  }
  settings.byEngine[params.engineKind].activeMode = params.mode

  const service = Object.create(ProviderService.prototype) as ProviderService & {
    deps: unknown
    providersByEngine: unknown
  }
  service.deps = {
    dispatch: () => {},
    credentialStoreByEngine: {} as never,
    backgroundCredentialStore: {
      get: async (key: string) => {
        if (key === 'claudeApiKey') return params.backgroundApiKeyByEngine?.claude
        if (key === 'codexApiKey') return params.backgroundApiKeyByEngine?.codex
        return key === 'apiKey' ? params.backgroundApiKey : undefined
      },
      update: async () => {},
      remove: async () => {},
    },
    getProviderSettings: () => settings,
  }
  service.providersByEngine = new Map<AIEngineKind, Map<ApiProvider, ProviderAdapter>>([
    ['claude', new Map(params.mode ? [[params.mode, params.adapter]] : [])],
    ['codex', new Map(params.mode ? [[params.mode, params.adapter]] : [])],
  ])
  return service as ProviderService
}

describe('ProviderService.getStatus', () => {
  it('marks codex mode unauthenticated when adapter has no codex auth mapping', async () => {
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      logout: async () => {},
    }
    const service = createProviderServiceForStatusTest({
      engineKind: 'codex',
      mode: 'custom',
      adapter,
    })

    const status = await service.getStatus('codex')
    expect(status.state).toBe('unauthenticated')
    expect(status.mode).toBe('custom')
  })

  it('marks codex mode unauthenticated when codex auth mapping has no apiKey', async () => {
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      getCodexAuthConfig: async () => null,
      logout: async () => {},
    }
    const service = createProviderServiceForStatusTest({
      engineKind: 'codex',
      mode: 'openrouter',
      adapter,
    })

    const status = await service.getStatus('codex')
    expect(status.state).toBe('unauthenticated')
    expect(status.mode).toBe('openrouter')
  })

  it('keeps codex mode authenticated when codex auth mapping is available', async () => {
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      getCodexAuthConfig: async () => ({ apiKey: 'sk-test', baseUrl: 'https://example.com/v1' }),
      logout: async () => {},
    }
    const service = createProviderServiceForStatusTest({
      engineKind: 'codex',
      mode: 'custom',
      adapter,
    })

    const status = await service.getStatus('codex')
    expect(status.state).toBe('authenticated')
    expect(status.mode).toBe('custom')
  })
})

describe('ProviderService.resolveBackgroundHTTPAuth', () => {
  it('inherits active engine HTTP auth when background model is not custom', async () => {
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      getHTTPAuth: async () => ({
        apiKey: 'sk-ant-active',
        baseUrl: 'https://api.anthropic.com',
        authStyle: 'x-api-key',
      }),
      logout: async () => {},
    }
    const service = createProviderServiceForStatusTest({
      engineKind: 'claude',
      mode: 'api_key',
      adapter,
      settingsPatch: {
        byEngine: {
          claude: { activeMode: 'api_key', defaultModel: 'claude-active-model' },
          codex: { activeMode: null },
        },
        backgroundModel: { mode: 'inherit' },
      },
    })

    await expect(service.resolveBackgroundHTTPAuth('claude')).resolves.toEqual({
      protocol: 'anthropic',
      apiKey: 'sk-ant-active',
      baseUrl: 'https://api.anthropic.com',
      authStyle: 'x-api-key',
      model: 'claude-active-model',
    })
  })

  it('inherits current engine credentials and overrides only the background model name', async () => {
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      getHTTPAuth: async () => ({
        apiKey: 'sk-ant-active',
        baseUrl: 'https://api.anthropic.com',
        authStyle: 'x-api-key',
      }),
      logout: async () => {},
    }
    const service = createProviderServiceForStatusTest({
      engineKind: 'claude',
      mode: 'api_key',
      adapter,
      settingsPatch: {
        byEngine: {
          claude: { activeMode: 'api_key', defaultModel: 'claude-active-model' },
          codex: { activeMode: null },
        },
        backgroundModel: {
          mode: 'inherit-model',
          model: 'claude-background-override',
        } as unknown as ProviderSettings['backgroundModel'],
      },
    })

    await expect(service.resolveBackgroundHTTPAuth('claude')).resolves.toEqual({
      protocol: 'anthropic',
      apiKey: 'sk-ant-active',
      baseUrl: 'https://api.anthropic.com',
      authStyle: 'x-api-key',
      model: 'claude-background-override',
    })
  })

  it('keeps inherited Codex model when inherit-model background model is blank', async () => {
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      getCodexAuthConfig: async () => ({
        apiKey: 'sk-openai-active',
        baseUrl: 'https://openai-gateway.example/v1',
      }),
      logout: async () => {},
    }
    const service = createProviderServiceForStatusTest({
      engineKind: 'codex',
      mode: 'custom',
      adapter,
      settingsPatch: {
        byEngine: {
          claude: { activeMode: null },
          codex: { activeMode: 'custom', defaultModel: 'gpt-5.5' },
        },
        backgroundModel: {
          mode: 'inherit-model',
        } as unknown as ProviderSettings['backgroundModel'],
      },
    })

    await expect(service.resolveBackgroundHTTPAuth('codex')).resolves.toEqual({
      protocol: 'openai',
      apiKey: 'sk-openai-active',
      baseUrl: 'https://openai-gateway.example/v1',
      authStyle: 'bearer',
      model: 'gpt-5.5',
    })
  })

  it('keeps inherited Claude model when inherit-model background model is blank', async () => {
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      getHTTPAuth: async () => ({
        apiKey: 'sk-ant-active',
        baseUrl: 'https://api.anthropic.com',
        authStyle: 'x-api-key',
      }),
      logout: async () => {},
    }
    const service = createProviderServiceForStatusTest({
      engineKind: 'claude',
      mode: 'api_key',
      adapter,
      settingsPatch: {
        byEngine: {
          claude: { activeMode: 'api_key', defaultModel: 'claude-active-model' },
          codex: { activeMode: null },
        },
        backgroundModel: {
          mode: 'inherit-model',
        } as unknown as ProviderSettings['backgroundModel'],
      },
    })

    await expect(service.resolveBackgroundHTTPAuth('claude')).resolves.toEqual({
      protocol: 'anthropic',
      apiKey: 'sk-ant-active',
      baseUrl: 'https://api.anthropic.com',
      authStyle: 'x-api-key',
      model: 'claude-active-model',
    })
  })

  it('resolves custom OpenAI-compatible background model auth', async () => {
    const service = createProviderServiceForStatusTest({
      engineKind: 'claude',
      mode: null,
      adapter: {} as ProviderAdapter,
      backgroundApiKey: 'bg-openai-key',
      settingsPatch: {
        byEngine: {
          claude: { activeMode: null },
          codex: { activeMode: null },
        },
        backgroundModel: {
          mode: 'custom',
          protocol: 'openai',
          baseUrl: 'https://gateway.example/v1',
          model: 'gpt-background-mini',
        },
      },
    })

    await expect(service.resolveBackgroundHTTPAuth('claude')).resolves.toEqual({
      protocol: 'openai',
      apiKey: 'bg-openai-key',
      baseUrl: 'https://gateway.example/v1',
      authStyle: 'bearer',
      model: 'gpt-background-mini',
    })
  })

  it('resolves custom Anthropic background model auth with default x-api-key style', async () => {
    const service = createProviderServiceForStatusTest({
      engineKind: 'claude',
      mode: null,
      adapter: {} as ProviderAdapter,
      backgroundApiKey: 'bg-anthropic-key',
      settingsPatch: {
        byEngine: {
          claude: { activeMode: null },
          codex: { activeMode: null },
        },
        backgroundModel: {
          mode: 'custom',
          protocol: 'anthropic',
          baseUrl: 'https://anthropic-gateway.example/v1',
          model: 'claude-background-mini',
        },
      },
    })

    await expect(service.resolveBackgroundHTTPAuth('claude')).resolves.toEqual({
      protocol: 'anthropic',
      apiKey: 'bg-anthropic-key',
      baseUrl: 'https://anthropic-gateway.example/v1',
      authStyle: 'x-api-key',
      model: 'claude-background-mini',
    })
  })

  it('resolves custom Anthropic background model auth with bearer style', async () => {
    const service = createProviderServiceForStatusTest({
      engineKind: 'claude',
      mode: null,
      adapter: {} as ProviderAdapter,
      backgroundApiKey: 'bg-anthropic-bearer',
      settingsPatch: {
        byEngine: {
          claude: { activeMode: null },
          codex: { activeMode: null },
        },
        backgroundModel: {
          mode: 'custom',
          protocol: 'anthropic',
          baseUrl: 'https://anthropic-gateway.example/v1',
          model: 'claude-background-mini',
          authStyle: 'bearer',
        },
      },
    })

    await expect(service.resolveBackgroundHTTPAuth('claude')).resolves.toMatchObject({
      protocol: 'anthropic',
      apiKey: 'bg-anthropic-bearer',
      authStyle: 'bearer',
    })
  })

  it('throws a clear error when custom background model is missing an API key', async () => {
    const service = createProviderServiceForStatusTest({
      engineKind: 'claude',
      mode: null,
      adapter: {} as ProviderAdapter,
      settingsPatch: {
        byEngine: {
          claude: { activeMode: null },
          codex: { activeMode: null },
        },
        backgroundModel: {
          mode: 'custom',
          protocol: 'openai',
          baseUrl: 'https://gateway.example/v1',
          model: 'gpt-background-mini',
        },
      },
    })

    await expect(service.resolveBackgroundHTTPAuth('claude')).rejects.toThrow('Background model is custom but missing API key')
  })

  it('uses the background model configured for the requested engine', async () => {
    const service = createProviderServiceForStatusTest({
      engineKind: 'claude',
      mode: null,
      adapter: {} as ProviderAdapter,
      backgroundApiKey: 'legacy-bg-key',
      backgroundApiKeyByEngine: {
        claude: 'claude-bg-key',
        codex: 'codex-bg-key',
      },
      settingsPatch: {
        byEngine: {
          claude: {
            activeMode: null,
            backgroundModel: {
              mode: 'custom',
              protocol: 'anthropic',
              baseUrl: 'https://anthropic-background.example/v1',
              model: 'claude-background-mini',
            },
          },
          codex: {
            activeMode: null,
            backgroundModel: {
              mode: 'custom',
              protocol: 'openai',
              baseUrl: 'https://openai-background.example/v1',
              model: 'gpt-background-mini',
            },
          },
        },
        backgroundModel: {
          mode: 'custom',
          protocol: 'openai',
          baseUrl: 'https://legacy-background.example/v1',
          model: 'legacy-background-model',
        },
      },
    })

    await expect(service.resolveBackgroundHTTPAuth('claude')).resolves.toEqual({
      protocol: 'anthropic',
      apiKey: 'claude-bg-key',
      baseUrl: 'https://anthropic-background.example/v1',
      authStyle: 'x-api-key',
      model: 'claude-background-mini',
    })
    await expect(service.resolveBackgroundHTTPAuth('codex')).resolves.toEqual({
      protocol: 'openai',
      apiKey: 'codex-bg-key',
      baseUrl: 'https://openai-background.example/v1',
      authStyle: 'bearer',
      model: 'gpt-background-mini',
    })
  })
})

describe('ProviderService background model credentials', () => {
  it('stores, reads, and clears the background model API key via the credential store', async () => {
    const state: { apiKey?: string } = {}
    const service = Object.create(ProviderService.prototype) as ProviderService & {
      deps: unknown
      providersByEngine: unknown
    }
    service.deps = {
      dispatch: () => {},
      credentialStoreByEngine: {} as never,
      backgroundCredentialStore: {
        get: async (key: 'apiKey') => state[key],
        update: async (key: 'apiKey', value: string) => {
          state[key] = value
        },
        remove: async (key: 'apiKey') => {
          delete state[key]
        },
      },
      getProviderSettings: () => ({
        byEngine: {
          claude: { activeMode: null },
          codex: { activeMode: null },
        },
        backgroundModel: { mode: 'inherit' },
      }),
    }
    service.providersByEngine = new Map()

    await expect(service.setBackgroundModelCredential({ apiKey: '  bg-key  ' })).resolves.toEqual({ apiKey: 'bg-key' })
    await expect(service.getBackgroundModelCredential()).resolves.toEqual({ apiKey: 'bg-key' })
    await expect(service.clearBackgroundModelCredential()).resolves.toBeUndefined()
    await expect(service.getBackgroundModelCredential()).resolves.toBeNull()
  })

  it('stores engine-scoped background model API keys independently', async () => {
    const state: Record<string, string | undefined> = {}
    const service = Object.create(ProviderService.prototype) as ProviderService & {
      deps: unknown
      providersByEngine: unknown
    }
    service.deps = {
      dispatch: () => {},
      credentialStoreByEngine: {} as never,
      backgroundCredentialStore: {
        get: async (key: string) => state[key],
        update: async (key: string, value: string) => {
          state[key] = value
        },
        remove: async (key: string) => {
          delete state[key]
        },
      },
      getProviderSettings: () => ({
        byEngine: {
          claude: { activeMode: null },
          codex: { activeMode: null },
        },
        backgroundModel: { mode: 'inherit' },
      }),
    }
    service.providersByEngine = new Map()

    await expect(service.setBackgroundModelCredential('claude', { apiKey: '  claude-bg-key  ' })).resolves.toEqual({ apiKey: 'claude-bg-key' })
    await expect(service.setBackgroundModelCredential('codex', { apiKey: '  codex-bg-key  ' })).resolves.toEqual({ apiKey: 'codex-bg-key' })

    await expect(service.getBackgroundModelCredential('claude')).resolves.toEqual({ apiKey: 'claude-bg-key' })
    await expect(service.getBackgroundModelCredential('codex')).resolves.toEqual({ apiKey: 'codex-bg-key' })

    await expect(service.clearBackgroundModelCredential('claude')).resolves.toBeUndefined()
    await expect(service.getBackgroundModelCredential('claude')).resolves.toBeNull()
    await expect(service.getBackgroundModelCredential('codex')).resolves.toEqual({ apiKey: 'codex-bg-key' })
  })
})
