// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataBus } from '../../../electron/core/dataBus'
import { registerIPCHandlers, type IPCDeps } from '../../../electron/ipc/channels'

const electronMocks = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  getAllWindows: vi.fn(() => []),
  appGetLocale: vi.fn(() => 'en-US'),
  appRelaunch: vi.fn(),
  appQuit: vi.fn(),
  clipboardWriteText: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.ipcHandle },
  BrowserWindow: { getAllWindows: electronMocks.getAllWindows },
  app: {
    getLocale: electronMocks.appGetLocale,
    relaunch: electronMocks.appRelaunch,
    quit: electronMocks.appQuit,
  },
  clipboard: {
    writeText: electronMocks.clipboardWriteText,
  },
}))

type RegisteredHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

const registeredHandlers = new Map<string, RegisteredHandler>()

function createDeps(overrides: Partial<IPCDeps> = {}): IPCDeps {
  return {
    bus: new DataBus(),
    onboarding: {
      load: vi.fn(async () => ({ completed: false, hooksInstalled: false })),
      complete: vi.fn(async () => ({ completed: true, hooksInstalled: true })),
      setHooksInstalled: vi.fn(async (installed: boolean) => ({
        completed: false,
        hooksInstalled: installed,
      })),
    } as unknown as IPCDeps['onboarding'],
    dataPaths: {
      root: '/tmp',
      hooks: '/tmp',
      eventLogger: '/tmp/event-logger.sh',
      eventsLog: '/tmp/events.jsonl',
      database: '/tmp/db.sqlite',
      settings: '/tmp/settings.json',
      onboarding: '/tmp/onboarding.json',
      logs: '/tmp/logs',
      credentials: '/tmp/credentials.enc',
      capabilities: '/tmp/capabilities',
      repoSourceCredentials: '/tmp/repo-credentials.enc',
    },
    hookEnv: 'development',
    ...overrides,
  }
}

function registerAndGet(channel: string, overrides: Partial<IPCDeps> = {}): RegisteredHandler {
  registerIPCHandlers(createDeps(overrides))
  const handler = registeredHandlers.get(channel)
  if (!handler) throw new Error(`${channel} handler was not registered`)
  return handler
}

describe('IPC model channels', () => {
  beforeEach(() => {
    registeredHandlers.clear()
    electronMocks.ipcHandle.mockReset()
    electronMocks.ipcHandle.mockImplementation((channel: string, handler: RegisteredHandler) => {
      registeredHandlers.set(channel, handler)
    })
  })

  it('routes provider:list-models to the provider service', async () => {
    const listModels = vi.fn(async () => ({
      engineKind: 'codex',
      mode: 'custom',
      protocol: 'openai',
      sourceUrl: 'https://gateway.example/v1/models',
      models: [{ id: 'gpt-5.3-codex' }],
    }))
    const handler = registerAndGet('provider:list-models', {
      providerService: { listModels } as unknown as IPCDeps['providerService'],
    })

    const result = await handler({}, 'codex')

    expect(listModels).toHaveBeenCalledWith('codex')
    expect(result).toMatchObject({ sourceUrl: 'https://gateway.example/v1/models' })
  })

  it('routes command:set-session-model to the session orchestrator', async () => {
    const setSessionModel = vi.fn(async () => true)
    const handler = registerAndGet('command:set-session-model', {
      orchestrator: { setSessionModel } as unknown as IPCDeps['orchestrator'],
    })

    const result = await handler({}, 'session-1', { engineKind: 'claude', model: 'claude-opus-4-6' })

    expect(result).toBe(true)
    expect(setSessionModel).toHaveBeenCalledWith('session-1', {
      engineKind: 'claude',
      model: 'claude-opus-4-6',
    })
  })
})
