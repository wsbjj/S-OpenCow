// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'
import { ProviderService } from '../../../electron/services/provider/providerService'
import type { AIEngineKind, ApiProvider, ProviderSettings } from '../../../src/shared/types'
import type { ProviderAdapter } from '../../../electron/services/provider/types'

function createProviderServiceForModelTest(params: {
  engineKind: AIEngineKind
  mode: ApiProvider
  adapter: ProviderAdapter
  fetch: typeof globalThis.fetch
}): ProviderService {
  const settings: ProviderSettings = {
    byEngine: {
      claude: { activeMode: null },
      codex: { activeMode: null },
    },
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
      get: async () => undefined,
      update: async () => {},
      remove: async () => {},
    },
    getProviderSettings: () => settings,
    getFetch: () => params.fetch,
  }
  service.providersByEngine = new Map<AIEngineKind, Map<ApiProvider, ProviderAdapter>>([
    ['claude', new Map([[params.mode, params.adapter]])],
    ['codex', new Map([[params.mode, params.adapter]])],
  ])
  return service as ProviderService
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

describe('ProviderService.listModels', () => {
  it('fetches Codex models from the OpenAI-compatible /v1/models endpoint', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      data: [
        { id: 'gpt-5.3-codex' },
        { id: 'gpt-5.3-codex' },
        { id: 'gpt-5.2-codex' },
      ],
    })) as unknown as typeof globalThis.fetch
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      getCodexAuthConfig: async () => ({ apiKey: 'sk-openai-test', baseUrl: 'https://api.openai.com' }),
      getHTTPAuth: async () => null,
      logout: async () => {},
    }
    const service = createProviderServiceForModelTest({
      engineKind: 'codex',
      mode: 'custom',
      adapter,
      fetch,
    })

    const result = await service.listModels('codex')
    const [url, init] = vi.mocked(fetch).mock.calls[0]

    expect(url).toBe('https://api.openai.com/v1/models')
    expect(init?.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer sk-openai-test',
    })
    expect(result).toEqual({
      engineKind: 'codex',
      mode: 'custom',
      protocol: 'openai',
      sourceUrl: 'https://api.openai.com/v1/models',
      models: [{ id: 'gpt-5.3-codex' }, { id: 'gpt-5.2-codex' }],
    })
  })

  it('fetches Claude models from the Anthropic-compatible /v1/models endpoint', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      data: [
        { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
      ],
    })) as unknown as typeof globalThis.fetch
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      getHTTPAuth: async () => ({
        apiKey: 'sk-ant-test',
        baseUrl: 'https://api.anthropic.com',
        authStyle: 'x-api-key',
      }),
      logout: async () => {},
    }
    const service = createProviderServiceForModelTest({
      engineKind: 'claude',
      mode: 'api_key',
      adapter,
      fetch,
    })

    const result = await service.listModels('claude')
    const [url, init] = vi.mocked(fetch).mock.calls[0]

    expect(url).toBe('https://api.anthropic.com/v1/models')
    expect(init?.headers).toMatchObject({
      Accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-ant-test',
    })
    expect(result).toEqual({
      engineKind: 'claude',
      mode: 'api_key',
      protocol: 'anthropic',
      sourceUrl: 'https://api.anthropic.com/v1/models',
      models: [{ id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' }],
    })
  })

  it('filters invalid model entries while preserving display metadata', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      data: [
        { id: '  valid-model  ', name: 'Readable Model' },
        { id: '' },
        { name: 'missing id' },
        42,
        'string-model',
      ],
    })) as unknown as typeof globalThis.fetch
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      getCodexAuthConfig: async () => ({ apiKey: 'sk-custom-test', baseUrl: 'https://gateway.example/v1' }),
      getHTTPAuth: async () => null,
      logout: async () => {},
    }
    const service = createProviderServiceForModelTest({
      engineKind: 'codex',
      mode: 'custom',
      adapter,
      fetch,
    })

    await expect(service.listModels('codex')).resolves.toMatchObject({
      models: [
        { id: 'valid-model', displayName: 'Readable Model' },
        { id: 'string-model' },
      ],
    })
  })

  it('does not duplicate /v1 when a custom Codex base URL already includes it', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: [{ id: 'custom-codex-model' }] })) as unknown as typeof globalThis.fetch
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      getCodexAuthConfig: async () => ({ apiKey: 'sk-custom-test', baseUrl: 'https://gateway.example/v1' }),
      getHTTPAuth: async () => null,
      logout: async () => {},
    }
    const service = createProviderServiceForModelTest({
      engineKind: 'codex',
      mode: 'custom',
      adapter,
      fetch,
    })

    await service.listModels('codex')

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://gateway.example/v1/models')
  })

  it('throws a clear error when the provider returns a non-2xx response', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid key',
    } as Response)) as unknown as typeof globalThis.fetch
    const adapter: ProviderAdapter = {
      checkStatus: async () => ({ authenticated: true }),
      getEnv: async () => ({}),
      authenticate: async () => ({ authenticated: true }),
      getCodexAuthConfig: async () => ({ apiKey: 'sk-bad-test', baseUrl: 'https://api.openai.com' }),
      getHTTPAuth: async () => null,
      logout: async () => {},
    }
    const service = createProviderServiceForModelTest({
      engineKind: 'codex',
      mode: 'custom',
      adapter,
      fetch,
    })

    await expect(service.listModels('codex')).rejects.toThrow(
      'Failed to fetch model list from https://api.openai.com/v1/models (HTTP 401): invalid key',
    )
  })
})
