// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_WINDOW_KEY } from '../../../src/shared/appIdentity'

const electronMock = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  exposeInMainWorld: vi.fn((key: string, api: unknown) => {
    electronMock.exposed[key] = api
  }),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electronMock.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: electronMock.on,
    removeListener: electronMock.removeListener,
  },
}))

describe('preload invoke channels', () => {
  beforeEach(() => {
    vi.resetModules()
    electronMock.exposed = {}
    electronMock.invoke.mockReset()
    electronMock.on.mockReset()
    electronMock.removeListener.mockReset()
    electronMock.exposeInMainWorld.mockClear()
  })

  it('exposes background model credential channels to the renderer API', async () => {
    await import('../../../electron/preload')

    const api = electronMock.exposed[APP_WINDOW_KEY] as Record<string, unknown>
    expect(api['background-model:get-credential']).toBeTypeOf('function')
    expect(api['background-model:set-credential']).toBeTypeOf('function')
    expect(api['background-model:clear-credential']).toBeTypeOf('function')
  })

  it('exposes provider model listing and session model selection channels', async () => {
    await import('../../../electron/preload')

    const api = electronMock.exposed[APP_WINDOW_KEY] as Record<string, unknown>
    expect(api['provider:list-models']).toBeTypeOf('function')
    expect(api['command:set-session-model']).toBeTypeOf('function')
  })
})
