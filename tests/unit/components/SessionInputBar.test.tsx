// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { SessionInputBar } from '../../../src/renderer/components/DetailPanel/SessionPanel/SessionInputBar'
import type { SessionInputBarHandle } from '../../../src/renderer/components/DetailPanel/SessionPanel/SessionInputBar'
import type { ChatModelOption } from '../../../src/renderer/lib/chatModelOptions'

const modelOptions: ChatModelOption[] = [
  { engineKind: 'codex', model: 'gpt-5.5', label: 'gpt-5.5' },
  { engineKind: 'codex', model: 'gpt-5.4', label: 'gpt-5.4' },
]

/**
 * Helper: wait for the TipTap editor (contenteditable div with role="textbox")
 * to be initialised. `useEditor` is asynchronous — the editor is `null` on the
 * first render, so we need `findByRole` which retries until available.
 */
async function getEditor(): Promise<HTMLElement> {
  return screen.findByRole('textbox')
}

describe('SessionInputBar', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders editor with correct ARIA attributes', async () => {
    render(<SessionInputBar onSend={vi.fn()} disabled={false} />)
    const editor = await getEditor()
    expect(editor).toHaveAttribute('aria-label', 'Type a message to send to Claude Code session')
    expect(editor).toHaveAttribute('autocomplete', 'off')
    expect(editor).toHaveAttribute('spellcheck', 'false')
    expect(editor).toHaveAttribute('role', 'textbox')
    expect(editor).toHaveAttribute('aria-multiline', 'true')
  })

  it('shows placeholder when empty', async () => {
    render(<SessionInputBar onSend={vi.fn()} disabled={false} />)
    const editor = await getEditor()
    // The Placeholder extension renders via a `data-placeholder` attribute on
    // the first <p> inside ProseMirror, but the visible text is shown via CSS
    // ::before. We verify the attribute is set.
    const paragraph = editor.querySelector('p')
    expect(paragraph).toBeTruthy()
    expect(paragraph?.getAttribute('data-placeholder')).toBe('Type a message or attach a file\u2026')
  })

  it('calls onSend with trimmed text on Enter', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    render(<SessionInputBar onSend={onSend} disabled={false} />)
    const editor = await getEditor()
    await userEvent.click(editor)
    await userEvent.type(editor, 'hello world')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('hello world')
    })
  })

  it('does not call onSend on Shift+Enter (allows newline)', async () => {
    const onSend = vi.fn()
    render(<SessionInputBar onSend={onSend} disabled={false} />)
    const editor = await getEditor()
    await userEvent.click(editor)
    await userEvent.type(editor, 'line 1')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send empty/whitespace-only messages', async () => {
    const onSend = vi.fn()
    render(<SessionInputBar onSend={onSend} disabled={false} />)
    const editor = await getEditor()
    await userEvent.click(editor)
    await userEvent.type(editor, '   ')
    await userEvent.keyboard('{Enter}')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('clears input after successful send', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    render(<SessionInputBar onSend={onSend} disabled={false} />)
    const editor = await getEditor()
    await userEvent.click(editor)
    await userEvent.type(editor, 'hello')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => {
      expect(editor).toHaveTextContent('')
    })
  })

  it('keeps input text after failed send', async () => {
    const onSend = vi.fn().mockResolvedValue(false)
    render(<SessionInputBar onSend={onSend} disabled={false} />)
    const editor = await getEditor()
    await userEvent.click(editor)
    await userEvent.type(editor, 'hello')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => {
      expect(editor).toHaveTextContent('hello')
    })
  })

  it('can load a user message draft from an external action', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const ref = React.createRef<SessionInputBarHandle>()
    render(<SessionInputBar ref={ref} onSend={onSend} disabled={false} />)
    const editor = await getEditor()

    act(() => {
      ref.current?.setDraft('Edited prompt')
    })

    await waitFor(() => {
      expect(editor).toHaveTextContent('Edited prompt')
    })

    await userEvent.click(screen.getByRole('button', { name: /send message/i }))
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('Edited prompt')
    })
  })

  it('disables editor and send button when disabled prop is true', async () => {
    render(<SessionInputBar onSend={vi.fn()} disabled={true} />)
    const editor = await getEditor()
    // TipTap sets contenteditable="false" when not editable
    expect(editor).toHaveAttribute('contenteditable', 'false')
    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled()
  })

  it('has send button with aria-label', async () => {
    render(<SessionInputBar onSend={vi.fn()} disabled={false} />)
    await getEditor()
    expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument()
  })

  it('opens the model menu above the bottom-docked input', async () => {
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
      <SessionInputBar
        onSend={vi.fn()}
        disabled={false}
        modelSelection={{
          value: { engineKind: 'codex', model: 'gpt-5.5' },
          options: modelOptions,
          onChange: vi.fn(),
        }}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Switch model' }))

    const listbox = await screen.findByRole('listbox', { name: 'Switch model' })
    await waitFor(() => {
      expect(listbox.parentElement).toHaveStyle({ bottom: '72px' })
    })
  })
})
