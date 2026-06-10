// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { ChatHeroInput } from '../../../src/renderer/components/ChatView/ChatHeroInput'
import type { ChatModelOption } from '../../../src/renderer/lib/chatModelOptions'

const modelOptions: ChatModelOption[] = [
  { engineKind: 'codex', model: 'gpt-5.5', label: 'gpt-5.5' },
  { engineKind: 'codex', model: 'gpt-5.4', label: 'gpt-5.4' },
]

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof globalThis.ResizeObserver
}

describe('ChatHeroInput', () => {
  beforeEach(() => {
    ;(window as any).opencow = {
      'capability:snapshot': vi.fn().mockResolvedValue({
        skills: [],
        agents: [],
        commands: [],
        rules: [],
        hooks: [],
        mcpServers: [],
        diagnostics: [],
        version: 1,
        timestamp: Date.now(),
      }),
      'on:opencow:event': vi.fn(() => () => {}),
      'list-project-files': vi.fn().mockResolvedValue([]),
      'search-project-files': vi.fn().mockResolvedValue([]),
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the model menu above the bottom action row', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 16,
      y: 700,
      width: 130,
      height: 22,
      top: 700,
      right: 146,
      bottom: 722,
      left: 16,
      toJSON: () => ({}),
    } as DOMRect)

    render(
      <ChatHeroInput
        onSend={vi.fn()}
        modelSelection={{
          value: { engineKind: 'codex', model: 'gpt-5.5' },
          options: modelOptions,
          onChange: vi.fn(),
        }}
      />,
    )

    await screen.findByRole('textbox')
    await userEvent.click(screen.getByRole('button', { name: 'Switch model' }))

    const listbox = await screen.findByRole('listbox', { name: 'Switch model' })
    await waitFor(() => {
      expect(listbox.parentElement).toHaveStyle({ bottom: '72px' })
    })
  })
})
