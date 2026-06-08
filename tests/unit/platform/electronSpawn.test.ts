// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

import {
  getElectronAsNodePath,
  buildAsarAwareEnv,
  needsAsarBridge,
} from '../../../electron/platform/electronSpawn'

describe('electronSpawn (dev mode)', () => {
  describe('needsAsarBridge', () => {
    it('returns false in dev mode', () => {
      expect(needsAsarBridge()).toBe(false)
    })
  })

  describe('getElectronAsNodePath', () => {
    it('returns a node-compatible path', () => {
      const nodePath = getElectronAsNodePath()
      expect(typeof nodePath).toBe('string')
      expect(nodePath.length).toBeGreaterThan(0)
    })
  })

  describe('buildAsarAwareEnv', () => {
    it('does not inject ELECTRON_RUN_AS_NODE in dev mode', () => {
      const base = { PATH: '/usr/bin', HOME: '/home/user' }
      const result = buildAsarAwareEnv(base)

      expect(result.ELECTRON_RUN_AS_NODE).toBeUndefined()
      expect(result.PATH).toBe('/usr/bin')
      // Returns the same object (no copy needed)
      expect(result).toBe(base)
    })
  })
})
