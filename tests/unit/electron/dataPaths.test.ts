// SPDX-License-Identifier: Apache-2.0

import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true },
}))

describe('dataPaths', () => {
  afterEach(() => {
    vi.resetModules()
    delete process.env.OPENCOW_ENV
  })

  it('uses ~/.s_opencow as the production data root', async () => {
    process.env.OPENCOW_ENV = 'production'
    const { resolveDataPaths } = await import('../../../electron/platform/dataPaths')

    expect(resolveDataPaths().root).toBe(path.join(os.homedir(), '.s_opencow'))
  })

  it('uses ~/.s_opencow-dev as the development data root', async () => {
    process.env.OPENCOW_ENV = 'development'
    const { resolveDataPaths, resolveProjectCapabilitiesPath } = await import('../../../electron/platform/dataPaths')

    expect(resolveDataPaths().root).toBe(path.join(os.homedir(), '.s_opencow-dev'))
    expect(resolveProjectCapabilitiesPath('/project')).toBe(path.join('/project', '.s_opencow-dev'))
  })
})
