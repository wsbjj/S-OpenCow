// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useUpdateStore } from '../../../src/renderer/stores/updateStore'
import { UpdateSection } from '../../../src/renderer/components/Settings/UpdateSection'

const updateSettingsMock = vi.fn()

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: {
        updates: {
          autoCheckUpdates: true,
          updateCheckInterval: '4h',
        },
      },
      updateSettings: updateSettingsMock,
    }),
}))

describe('UpdateSection', () => {
  beforeEach(() => {
    updateSettingsMock.mockClear()
    useUpdateStore.setState({
      updateAvailable: false,
      latestVersion: null,
      releaseUrl: null,
      releaseNotes: null,
      downloadUrl: null,
      publishedAt: null,
      dismissedVersion: null,
      lastCheckedAt: null,
      checking: false,
    })
  })

  it('shows the latest available release version from GitHub', () => {
    useUpdateStore.setState({
      updateAvailable: false,
      latestVersion: '0.4.0',
      releaseUrl: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.4.0',
      lastCheckedAt: '2026-03-26T10:00:00Z',
    })

    render(<UpdateSection />)

    expect(screen.getByText('Latest available version')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'v0.4.0' })).toHaveAttribute(
      'href',
      'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.4.0',
    )
  })
})
