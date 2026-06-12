// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SettingsService } from '../../../electron/services/settingsService'
import { join } from 'path'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { DEFAULT_EVOSE_SETTINGS } from '../../../src/shared/types'

let tempDir: string
let service: SettingsService

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'opencow-settings-'))
  service = new SettingsService(join(tempDir, 'settings.json'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('SettingsService', () => {
  it('returns default settings when file does not exist', async () => {
    const settings = await service.load()
    expect(settings.theme).toEqual({ mode: 'system', scheme: 'zinc', texture: 'plain' })
    expect(settings.proxy.httpsProxy).toBe('')
    expect(settings.proxy.httpProxy).toBe('')
    expect(settings.proxy.noProxy).toBe('')
    expect(settings.command.maxTurns).toBe(10000)
    expect(settings.command.permissionMode).toBe('bypassPermissions')
    expect(settings.command.defaultEngine).toBe('claude')
    expect(settings.eventSubscriptions.enabled).toBe(true)
    expect(settings.eventSubscriptions.onError).toBe(true)
    expect(settings.eventSubscriptions.onComplete).toBe(true)
    expect(settings.eventSubscriptions.onStatusChange).toBe(true)
    expect(settings.provider.backgroundModel).toEqual({ mode: 'inherit' })
    expect(settings.provider.byEngine.claude.backgroundModel).toEqual({ mode: 'inherit' })
    expect(settings.provider.byEngine.codex.backgroundModel).toEqual({ mode: 'inherit' })
    expect(settings.provider.byEngine.codex.defaultReasoningEffort).toBe('high')
  })

  it('normalizes blank evose baseUrl to default endpoint', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        evose: {
          apiKey: 'k',
          baseUrl: '   ',
          workspaceIds: [],
          apps: [],
        },
      }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()
    expect(settings.evose.baseUrl).toBe(DEFAULT_EVOSE_SETTINGS.baseUrl)
  })

  it('saves and loads settings', async () => {
    const settings = await service.load()
    settings.theme = { mode: 'dark', scheme: 'blue', texture: 'plain' }
    settings.proxy.httpsProxy = 'http://127.0.0.1:7890'
    const updated = await service.update(settings)
    expect(updated.theme).toEqual({ mode: 'dark', scheme: 'blue', texture: 'plain' })
    expect(updated.proxy.httpsProxy).toBe('http://127.0.0.1:7890')

    // Reload from disk
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const reloaded = await fresh.load()
    expect(reloaded.theme).toEqual({ mode: 'dark', scheme: 'blue', texture: 'plain' })
    expect(reloaded.proxy.httpsProxy).toBe('http://127.0.0.1:7890')
  })

  it('preserves unmodified fields on update', async () => {
    const settings = await service.load()
    settings.command.maxTurns = 100
    await service.update(settings)
    const reloaded = await service.load()
    expect(reloaded.command.maxTurns).toBe(100)
    expect(reloaded.eventSubscriptions.enabled).toBe(true)
  })

  it('writes valid JSON to disk', async () => {
    await service.update(await service.load())
    const raw = await readFile(join(tempDir, 'settings.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed).toHaveProperty('theme')
    expect(parsed.theme).toHaveProperty('mode')
    expect(parsed.theme).toHaveProperty('scheme')
    expect(parsed).toHaveProperty('proxy')
    expect(parsed).toHaveProperty('command')
    expect(parsed).toHaveProperty('eventSubscriptions')
  })

  it('getProxyEnv returns non-empty entries only', async () => {
    const settings = await service.load()
    expect(service.getProxyEnv()).toEqual({})

    settings.proxy.httpsProxy = 'http://proxy:8080'
    await service.update(settings)
    const env = service.getProxyEnv()
    expect(env).toEqual({
      https_proxy: 'http://proxy:8080',
      HTTPS_PROXY: 'http://proxy:8080'
    })
  })

  it('getCommandDefaults returns current command settings', async () => {
    const settings = await service.load()
    settings.command.maxTurns = 30
    settings.command.defaultEngine = 'codex'
    await service.update(settings)
    const defaults = service.getCommandDefaults()
    expect(defaults.maxTurns).toBe(30)
    expect(defaults.defaultEngine).toBe('codex')
  })

  it('falls back to bypassPermissions when persisted command.permissionMode is invalid', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        command: {
          permissionMode: 'ask_every_time'
        }
      }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()
    expect(settings.command.permissionMode).toBe('bypassPermissions')
  })

  it('migrates legacy command.defaultModel to provider.byEngine.claude.defaultModel', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({ command: { defaultModel: 'claude-opus-4-6' } }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()
    expect(settings.provider.byEngine.claude.defaultModel).toBe('claude-opus-4-6')
    expect(settings.provider.byEngine.codex.activeMode).toBeNull()
  })

  it('migrates legacy provider.activeMode into provider.byEngine.claude.activeMode', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({ provider: { activeMode: 'api_key' } }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()
    expect(settings.provider.byEngine.claude.activeMode).toBe('api_key')
    expect(settings.provider.byEngine.codex.activeMode).toBeNull()
    expect(settings.provider.byEngine.codex.defaultReasoningEffort).toBe('high')
  })

  it('provider.byEngine default model is preserved via getProviderSettings', async () => {
    const settings = await service.load()
    settings.provider.byEngine.claude.defaultModel = 'claude-opus-4-6'
    settings.provider.byEngine.codex.activeMode = 'openrouter'
    settings.provider.byEngine.codex.defaultReasoningEffort = 'high'
    await service.update(settings)
    const provider = service.getProviderSettings()
    expect(provider.byEngine.claude.defaultModel).toBe('claude-opus-4-6')
    expect(provider.byEngine.codex.activeMode).toBe('openrouter')
    expect(provider.byEngine.codex.defaultReasoningEffort).toBe('high')
  })

  it('migrates legacy defaultModel into mode-scoped selected models', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        provider: {
          activeMode: 'api_key',
          defaultModel: ' claude-sonnet-4-6 ',
        },
      }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()

    expect(settings.provider.byEngine.claude.defaultModel).toBe('claude-sonnet-4-6')
    expect(settings.provider.byEngine.claude.modelSelectionsByMode?.api_key).toEqual({
      selectedModels: [{ id: 'claude-sonnet-4-6', source: 'legacy' }],
      defaultModel: 'claude-sonnet-4-6',
    })
  })

  it('normalizes model selections by provider mode and keeps engines isolated', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        provider: {
          byEngine: {
            claude: {
              activeMode: 'custom',
              defaultModel: 'claude-a',
              modelSelectionsByMode: {
                custom: {
                  selectedModels: [
                    { id: ' claude-a ', displayName: 'Claude A', source: 'provider' },
                    { id: 'claude-a', source: 'manual' },
                    { id: '', source: 'provider' },
                    { id: 'claude-b', source: 'unexpected' },
                  ],
                  defaultModel: ' claude-b ',
                  sourceUrl: 'https://claude-gateway.example/v1/models',
                  lastFetchedAt: 123,
                },
              },
            },
            codex: {
              activeMode: 'openrouter',
              defaultReasoningEffort: 'xhigh',
              modelSelectionsByMode: {
                openrouter: {
                  selectedModels: [
                    { id: 'openai/gpt-5', displayName: 'GPT-5', source: 'provider' },
                  ],
                  defaultModel: 'openai/gpt-5',
                },
              },
            },
          },
        },
      }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()

    expect(settings.provider.byEngine.claude.modelSelectionsByMode?.custom).toEqual({
      selectedModels: [
        { id: 'claude-a', displayName: 'Claude A', source: 'provider' },
        { id: 'claude-b', source: 'manual' },
      ],
      defaultModel: 'claude-b',
      sourceUrl: 'https://claude-gateway.example/v1/models',
      lastFetchedAt: 123,
    })
    expect(settings.provider.byEngine.codex.modelSelectionsByMode?.openrouter?.selectedModels).toEqual([
      { id: 'openai/gpt-5', displayName: 'GPT-5', source: 'provider' },
    ])
    expect(settings.provider.byEngine.codex.defaultReasoningEffort).toBe('xhigh')
  })

  it('drops invalid codex defaultReasoningEffort while keeping valid values', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        provider: {
          byEngine: {
            claude: { activeMode: null },
            codex: { activeMode: 'custom', defaultReasoningEffort: 'ultra' }
          }
        }
      }),
      'utf-8'
    )
    let fresh = new SettingsService(join(tempDir, 'settings.json'))
    let settings = await fresh.load()
    expect(settings.provider.byEngine.codex.defaultReasoningEffort).toBeUndefined()

    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        provider: {
          byEngine: {
            claude: { activeMode: null },
            codex: { activeMode: 'custom', defaultReasoningEffort: 'xhigh' }
          }
        }
      }),
      'utf-8'
    )
    fresh = new SettingsService(join(tempDir, 'settings.json'))
    settings = await fresh.load()
    expect(settings.provider.byEngine.codex.defaultReasoningEffort).toBe('xhigh')
  })

  it('preserves valid background model settings', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        provider: {
          backgroundModel: {
            mode: 'custom',
            protocol: 'anthropic',
            baseUrl: 'https://gateway.example/v1',
            model: 'claude-3-5-haiku-latest',
            authStyle: 'bearer',
          },
        },
      }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()

    expect(settings.provider.backgroundModel).toEqual({
      mode: 'custom',
      protocol: 'anthropic',
      baseUrl: 'https://gateway.example/v1',
      model: 'claude-3-5-haiku-latest',
      authStyle: 'bearer',
    })
    expect(settings.provider.byEngine.claude.backgroundModel).toEqual({
      mode: 'custom',
      protocol: 'anthropic',
      baseUrl: 'https://gateway.example/v1',
      model: 'claude-3-5-haiku-latest',
      authStyle: 'bearer',
    })
    expect(settings.provider.byEngine.codex.backgroundModel).toEqual({
      mode: 'custom',
      protocol: 'anthropic',
      baseUrl: 'https://gateway.example/v1',
      model: 'claude-3-5-haiku-latest',
      authStyle: 'bearer',
    })
  })

  it('keeps engine-scoped background model settings isolated', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        provider: {
          byEngine: {
            claude: {
              activeMode: 'api_key',
              backgroundModel: {
                mode: 'inherit-model',
                model: ' claude-background ',
              },
            },
            codex: {
              activeMode: 'custom',
              defaultReasoningEffort: 'medium',
              backgroundModel: {
                mode: 'custom',
                protocol: 'openai',
                baseUrl: ' https://openai-gateway.example/v1 ',
                model: ' gpt-background-mini ',
              },
            },
          },
        },
      }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()

    expect(settings.provider.byEngine.claude.backgroundModel).toEqual({
      mode: 'inherit-model',
      model: 'claude-background',
    })
    expect(settings.provider.byEngine.codex.backgroundModel).toEqual({
      mode: 'custom',
      protocol: 'openai',
      baseUrl: 'https://openai-gateway.example/v1',
      model: 'gpt-background-mini',
    })
  })

  it('preserves inherit-model background model settings and trims model', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        provider: {
          backgroundModel: {
            mode: 'inherit-model',
            model: '  gpt-background-inherited  ',
            protocol: 'openai',
            baseUrl: 'https://should-not-be-kept.example/v1',
            authStyle: 'bearer',
          },
        },
      }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()

    expect(settings.provider.backgroundModel).toEqual({
      mode: 'inherit-model',
      model: 'gpt-background-inherited',
    })
  })

  it('normalizes invalid background model settings to inherit', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        provider: {
          backgroundModel: {
            mode: 'custom',
            protocol: 'ollama',
            baseUrl: 123,
            model: '',
            authStyle: 'basic',
          },
        },
      }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()

    expect(settings.provider.backgroundModel).toEqual({ mode: 'inherit' })
  })

  it('getEventSubscriptionSettings returns current event subscription settings', async () => {
    const settings = await service.load()
    settings.eventSubscriptions.enabled = false
    await service.update(settings)
    const prefs = service.getEventSubscriptionSettings()
    expect(prefs.enabled).toBe(false)
  })

  it('handles corrupted JSON gracefully', async () => {
    await writeFile(join(tempDir, 'settings.json'), '{ broken json', 'utf-8')
    const settings = await service.load()
    expect(settings.theme).toEqual({ mode: 'system', scheme: 'zinc', texture: 'plain' })
  })

  // --- Theme migration tests ---

  it('migrates legacy string theme format to ThemeConfig', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({ theme: 'dark' }),
      'utf-8'
    )
    const settings = await service.load()
    expect(settings.theme).toEqual({ mode: 'dark', scheme: 'zinc', texture: 'plain' })
  })

  it('migrates legacy "light" string theme format', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({ theme: 'light' }),
      'utf-8'
    )
    const settings = await service.load()
    expect(settings.theme).toEqual({ mode: 'light', scheme: 'zinc', texture: 'plain' })
  })

  it('falls back to defaults for invalid theme values', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({ theme: { mode: 'invalid', scheme: 'nope' } }),
      'utf-8'
    )
    const settings = await service.load()
    expect(settings.theme).toEqual({ mode: 'system', scheme: 'zinc', texture: 'plain' })
  })

  it('preserves valid new-format theme config', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({ theme: { mode: 'dark', scheme: 'violet' } }),
      'utf-8'
    )
    const settings = await service.load()
    expect(settings.theme).toEqual({ mode: 'dark', scheme: 'violet', texture: 'plain' })
  })

  // --- Messaging connection config tests ---

  it('loads default messaging config (empty connections list) when file is empty', async () => {
    const settings = await service.load()
    expect(settings.messaging).toEqual({ connections: [] })
  })

  it('auto-migrates legacy telegramBot standalone config to messaging.connections', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({ telegramBot: { enabled: true, botToken: '123:ABC' } }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()
    // After migration, connections array contains one Telegram entry
    expect(settings.messaging.connections).toHaveLength(1)
    const conn = settings.messaging.connections[0]
    expect(conn.platform).toBe('telegram')
    expect(conn.enabled).toBe(true)
    if (conn.platform === 'telegram') {
      expect(conn.botToken).toBe('123:ABC')
    }
    expect(conn.allowedUserIds).toEqual([])
    expect(conn.defaultWorkspace).toEqual({ scope: 'global' })
    // After migration, a UUID should be generated
    expect(typeof conn.id).toBe('string')
    expect(conn.id.length).toBeGreaterThan(0)
  })

  it('auto-migrates legacy telegramBots.bots format to messaging.connections', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        telegramBots: {
          bots: [{
            id: 'test-id',
            name: 'Test Bot',
            enabled: true,
            botToken: '456:DEF',
            allowedUserIds: [123],
            defaultProjectId: 'proj_legacy',
          }]
        }
      }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()
    expect(settings.messaging.connections).toHaveLength(1)
    const conn = settings.messaging.connections[0]
    expect(conn.id).toBe('test-id')
    expect(conn.platform).toBe('telegram')
    expect(conn.name).toBe('Test Bot')
    // allowedUserIds: number[] → string[] migration
    expect(conn.allowedUserIds).toEqual(['123'])
    expect(conn.defaultWorkspace).toEqual({ scope: 'project', projectId: 'proj_legacy' })
  })

  it('migrates messaging.connections legacy defaultProjectId to defaultWorkspace', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        messaging: {
          connections: [
            {
              id: 'conn-1',
              name: 'Telegram A',
              platform: 'telegram',
              enabled: true,
              botToken: '789:GHI',
              allowedUserIds: ['10001'],
              defaultProjectId: 'proj-msg-1',
            },
            {
              id: 'conn-2',
              name: 'Telegram B',
              platform: 'telegram',
              enabled: false,
              botToken: '111:XYZ',
              allowedUserIds: [],
            },
            {
              id: 'conn-3',
              name: 'Telegram C',
              platform: 'telegram',
              enabled: false,
              botToken: '222:XYZ',
              allowedUserIds: [],
              defaultWorkspace: { scope: 'project', projectId: 'proj-new' },
              defaultProjectId: 'proj-legacy-ignored',
            },
          ],
        },
      }),
      'utf-8'
    )
    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()
    expect(settings.messaging.connections).toHaveLength(3)

    const [a, b, c] = settings.messaging.connections
    expect(a.defaultWorkspace).toEqual({ scope: 'project', projectId: 'proj-msg-1' })
    expect(b.defaultWorkspace).toEqual({ scope: 'global' })
    expect(c.defaultWorkspace).toEqual({ scope: 'project', projectId: 'proj-new' })
  })

  it('normalizes legacy imBridge connections to include defaultWorkspace', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        imBridge: {
          connections: [
            {
              id: 'discord-legacy',
              name: 'Discord Legacy',
              platform: 'discord',
              enabled: true,
              botToken: 'discord-token',
              allowedUserIds: ['u1'],
              defaultProjectId: 'proj-imbridge',
            },
            {
              id: 'feishu-legacy',
              name: 'Feishu Legacy',
              platform: 'feishu',
              enabled: false,
              appId: 'app-id',
              appSecret: 'app-secret',
              allowedUserIds: [],
            },
          ],
        },
      }),
      'utf-8'
    )

    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    const settings = await fresh.load()
    expect(settings.messaging.connections).toHaveLength(2)

    const [discord, feishu] = settings.messaging.connections
    expect(discord.platform).toBe('discord')
    expect(discord.defaultWorkspace).toEqual({ scope: 'project', projectId: 'proj-imbridge' })
    expect(feishu.platform).toBe('feishu')
    expect(feishu.defaultWorkspace).toEqual({ scope: 'global' })
  })

  it('getTelegramBotSettings extracts and converts from messaging.connections', async () => {
    await writeFile(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        messaging: {
          connections: [
            {
              id: 'tg-1',
              name: 'Telegram 1',
              platform: 'telegram',
              enabled: true,
              botToken: '123:ABC',
              allowedUserIds: ['123', '456', 'not-a-number'],
              defaultWorkspace: { scope: 'project', projectId: 'proj-a' },
            },
            {
              id: 'discord-1',
              name: 'Discord 1',
              platform: 'discord',
              enabled: true,
              botToken: 'discord-token',
              allowedUserIds: [],
              defaultWorkspace: { scope: 'global' },
            },
          ],
        },
      }),
      'utf-8'
    )

    const fresh = new SettingsService(join(tempDir, 'settings.json'))
    await fresh.load()
    const settings = fresh.getTelegramBotSettings()
    expect(settings).toEqual({
      bots: [
        {
          id: 'tg-1',
          name: 'Telegram 1',
          enabled: true,
          botToken: '123:ABC',
          allowedUserIds: [123, 456],
          defaultWorkspace: { scope: 'project', projectId: 'proj-a' },
        },
      ],
    })
  })
})
