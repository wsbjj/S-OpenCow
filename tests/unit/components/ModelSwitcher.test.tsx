// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { ModelSwitcher } from '../../../src/renderer/components/ui/ModelSwitcher'
import type { ChatModelOption } from '../../../src/renderer/lib/chatModelOptions'

const options: ChatModelOption[] = [
  { engineKind: 'codex', model: 'gpt-5.5', label: 'gpt-5.5' },
  { engineKind: 'codex', model: 'gpt-5.4', label: 'gpt-5.4' },
]

describe('ModelSwitcher', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the model menu below the trigger', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 16,
      y: 20,
      width: 130,
      height: 22,
      top: 20,
      right: 146,
      bottom: 42,
      left: 16,
      toJSON: () => ({}),
    } as DOMRect)

    render(
      <ModelSwitcher
        value={{ engineKind: 'codex', model: 'gpt-5.5' }}
        options={options}
        onChange={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Switch model' }))

    const listbox = await screen.findByRole('listbox', { name: 'Switch model' })
    await waitFor(() => {
      expect(listbox.parentElement).toHaveStyle({ top: '46px' })
    })
  })
})
