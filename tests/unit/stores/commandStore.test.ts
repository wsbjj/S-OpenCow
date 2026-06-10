// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCommandStore, selectLatestOpenTodos } from '../../../src/renderer/stores/commandStore'
import { makeManagedSession } from '../../helpers'
import type { ManagedSessionMessage } from '../../../src/shared/types'

const apiMock = vi.hoisted(() => ({
  getSessionMessages: vi.fn(),
  getSessionMessagePage: vi.fn(),
}))

vi.mock('@/windowAPI', () => ({
  getAppAPI: () => ({
    'command:get-session-messages': apiMock.getSessionMessages,
    'command:get-session-message-page': apiMock.getSessionMessagePage,
    'command:get-managed-session': vi.fn().mockResolvedValue(null),
    'command:delete-session': vi.fn().mockResolvedValue(true),
    'command:start-session': vi.fn().mockResolvedValue('session-new'),
    'command:send-message': vi.fn().mockResolvedValue(true),
    'command:resume-session': vi.fn().mockResolvedValue(true),
    'command:stop-session': vi.fn().mockResolvedValue(true),
    'command:set-session-model': vi.fn().mockResolvedValue(true),
  }),
}))

function makeAssistantMessage(params: {
  id: string
  isStreaming: boolean
  activeToolUseId?: string | null
  text?: string
}): ManagedSessionMessage {
  return {
    id: params.id,
    role: 'assistant',
    content: [{ type: 'text', text: params.text ?? params.id }],
    timestamp: 1_700_000_000_000,
    isStreaming: params.isStreaming,
    ...(params.activeToolUseId !== undefined ? { activeToolUseId: params.activeToolUseId } : {}),
  }
}

describe('commandStore.batchAppendSessionMessages', () => {
  beforeEach(() => {
    apiMock.getSessionMessages.mockReset()
    apiMock.getSessionMessages.mockResolvedValue([])
    apiMock.getSessionMessagePage.mockReset()
    apiMock.getSessionMessagePage.mockResolvedValue({
      sessionId: 'session-page',
      messages: [],
      oldestOrdinal: null,
      newestOrdinal: null,
      totalCount: 0,
      hasMoreBefore: false,
    })
    useCommandStore.getState().reset()
  })

  it('loads the initial history window through page IPC instead of full messages IPC', async () => {
    const sessionId = 'session-page'
    const snapshot = makeManagedSession({
      id: sessionId,
      state: 'idle',
      messages: [],
    })
    const pageMessages: ManagedSessionMessage[] = [
      {
        id: 'u-latest',
        role: 'user',
        content: [{ type: 'text', text: 'latest window' }],
        timestamp: 1,
      },
    ]
    apiMock.getSessionMessagePage.mockResolvedValueOnce({
      sessionId,
      messages: pageMessages,
      oldestOrdinal: 42,
      newestOrdinal: 42,
      totalCount: 43,
      hasMoreBefore: true,
    })
    useCommandStore.setState({
      managedSessions: [snapshot],
      sessionById: { [sessionId]: snapshot },
    })

    await useCommandStore.getState().ensureSessionMessages(sessionId)

    expect(apiMock.getSessionMessagePage).toHaveBeenCalledWith(sessionId, { limit: 100 })
    expect(apiMock.getSessionMessages).not.toHaveBeenCalled()
    expect(useCommandStore.getState().sessionMessages[sessionId]).toEqual(pageMessages)
    expect(useCommandStore.getState().sessionMessagePages[sessionId]).toMatchObject({
      oldestOrdinal: 42,
      newestOrdinal: 42,
      totalCount: 43,
      hasMoreBefore: true,
    })
  })

  it('keeps non-overlay assistant updates in structural list when multiple assistant updates arrive in one batch', () => {
    const sessionId = 'session-1'
    const baseA = makeAssistantMessage({
      id: 'assistant-a',
      isStreaming: false,
      activeToolUseId: 'tool-a',
      text: 'A old',
    })
    const baseB = makeAssistantMessage({
      id: 'assistant-b',
      isStreaming: true,
      activeToolUseId: 'tool-b',
      text: 'B old',
    })

    const snapshot = makeManagedSession({
      id: sessionId,
      state: 'streaming',
      messages: [baseA, baseB],
    })

    useCommandStore.setState({
      managedSessions: [snapshot],
      sessionById: { [sessionId]: snapshot },
      sessionMessages: { [sessionId]: [baseA, baseB] },
      // Overlay points to assistant-b (single-slot model)
      streamingMessageBySession: { [sessionId]: baseB },
      activeManagedSessionId: sessionId,
    })

    const updatedA = makeAssistantMessage({
      id: 'assistant-a',
      isStreaming: false,
      activeToolUseId: null,
      text: 'A finalized',
    })
    const updatedB = makeAssistantMessage({
      id: 'assistant-b',
      isStreaming: false,
      activeToolUseId: null,
      text: 'B finalized',
    })

    useCommandStore.getState().batchAppendSessionMessages(
      new Map([[sessionId, [updatedA, updatedB]]]),
    )

    const storeAfterBatch = useCommandStore.getState()
    const listAfterBatch = storeAfterBatch.sessionMessages[sessionId] ?? []
    const overlayAfterBatch = storeAfterBatch.streamingMessageBySession[sessionId]

    const aAfterBatch = listAfterBatch.find((m) => m.id === 'assistant-a')
    const bAfterBatch = listAfterBatch.find((m) => m.id === 'assistant-b')

    // assistant-a (non-overlay id) must be written structurally immediately.
    expect(aAfterBatch?.role).toBe('assistant')
    expect((aAfterBatch as Extract<ManagedSessionMessage, { role: 'assistant' }> | undefined)?.activeToolUseId).not.toBe('tool-a')
    expect((aAfterBatch as Extract<ManagedSessionMessage, { role: 'assistant' }> | undefined)?.isStreaming).toBe(false)
    expect((aAfterBatch as Extract<ManagedSessionMessage, { role: 'assistant' }> | undefined)?.content[0]).toEqual({
      type: 'text',
      text: 'A finalized',
    })

    // assistant-b (overlay id) still uses fast path and lives in overlay until merge.
    expect((bAfterBatch as Extract<ManagedSessionMessage, { role: 'assistant' }> | undefined)?.content[0]).toEqual({
      type: 'text',
      text: 'B old',
    })
    expect(overlayAfterBatch?.id).toBe('assistant-b')
    expect((overlayAfterBatch as Extract<ManagedSessionMessage, { role: 'assistant' }> | null)?.isStreaming).toBe(false)
    expect((overlayAfterBatch as Extract<ManagedSessionMessage, { role: 'assistant' }> | null)?.activeToolUseId).not.toBe('tool-b')

    useCommandStore.getState().mergeStreamingOverlay(sessionId)

    const storeAfterMerge = useCommandStore.getState()
    const listAfterMerge = storeAfterMerge.sessionMessages[sessionId] ?? []
    const aAfterMerge = listAfterMerge.find((m) => m.id === 'assistant-a')
    const bAfterMerge = listAfterMerge.find((m) => m.id === 'assistant-b')

    expect((aAfterMerge as Extract<ManagedSessionMessage, { role: 'assistant' }> | undefined)?.content[0]).toEqual({
      type: 'text',
      text: 'A finalized',
    })
    expect((bAfterMerge as Extract<ManagedSessionMessage, { role: 'assistant' }> | undefined)?.content[0]).toEqual({
      type: 'text',
      text: 'B finalized',
    })
    expect((bAfterMerge as Extract<ManagedSessionMessage, { role: 'assistant' }> | undefined)?.activeToolUseId).not.toBe('tool-b')
    expect(storeAfterMerge.streamingMessageBySession[sessionId]).toBeNull()
  })

  it('derives latest open todos from current turn and overlay', () => {
    const sessionId = 'session-todo'
    const snapshot = makeManagedSession({
      id: sessionId,
      state: 'streaming',
      messages: [],
    })

    useCommandStore.setState({
      managedSessions: [snapshot],
      sessionById: { [sessionId]: snapshot },
      sessionMessages: {
        [sessionId]: [
          {
            id: 'u1',
            role: 'user',
            timestamp: 1,
            content: [{ type: 'text', text: 'turn1' }],
          },
          {
            id: 'a1',
            role: 'assistant',
            timestamp: 2,
            content: [
              {
                type: 'tool_use',
                id: 'todo-1',
                name: 'TodoWrite',
                input: {
                  todos: [
                    { content: 'old', status: 'pending' },
                  ],
                },
              },
            ],
            isStreaming: false,
          },
          {
            id: 'u2',
            role: 'user',
            timestamp: 3,
            content: [{ type: 'text', text: 'turn2' }],
          },
        ],
      },
      streamingMessageBySession: {
        [sessionId]: {
          id: 'a2',
          role: 'assistant',
          timestamp: 4,
          isStreaming: true,
          content: [
            {
              type: 'tool_use',
              id: 'todo-2',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'new', status: 'pending' },
                ],
              },
            },
          ],
        },
      },
      latestTodosBySession: {},
      activeManagedSessionId: sessionId,
    })

    const derived = selectLatestOpenTodos(useCommandStore.getState(), sessionId)
    expect(derived).toEqual([{ content: 'new', status: 'pending' }])
  })
})
