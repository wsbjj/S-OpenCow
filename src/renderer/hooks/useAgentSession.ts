// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useAppStore } from '@/stores/appStore'
import { useCommandStore } from '@/stores/commandStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionBase } from '@/hooks/useSessionBase'
import type { UseMessageQueueReturn } from '@/hooks/useMessageQueue'
import {
  buildChatModelOptions,
  hasChatModelOption,
  resolveDefaultChatModelSelection,
  resolveSessionChatModelSelection,
  type ChatModelOption,
} from '@/lib/chatModelOptions'
import type { SessionSnapshot, ManagedSessionState, SetSessionModelInput, UserMessageContent, CodexReasoningEffort } from '@shared/types'

/**
 * Session origin sources eligible for the [Chat] tab.
 * Includes the UI agent + all IM bots (Telegram, Feishu, Discord, WeChat).
 */
const CHAT_ELIGIBLE_SOURCES: ReadonlySet<string> = new Set([
  'agent',
  'telegram',
  'feishu',
  'discord',
  'weixin',
])

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface AgentSessionHandle {
  /** Current managed session (null if no session selected or session removed). */
  session: SessionSnapshot | null
  /** Whether a new session is being created. */
  isStarting: boolean
  /** Whether the agent is actively processing (creating or streaming). */
  isProcessing: boolean
  /** Whether the session is paused (idle / stopped / error). */
  isPaused: boolean
  /** Current session state shortcut. */
  state: ManagedSessionState | null
  /** Selected project path (for scoped operations). */
  projectPath: string | undefined
  /** Selected project ID (for Capability Center resolution). */
  projectId: string | null
  /** Selected project name (for display). */
  projectName: string | null

  /**
   * Send or queue a message. Handles:
   * - Starting a new session (if no active session)
   * - Sending to an active session
   * - Resuming a paused session
   * - Queuing when the agent is busy (streaming/creating)
   */
  sendOrQueue: (message: UserMessageContent) => Promise<boolean>
  /** Stop the current session. */
  stop: () => void
  /** Message queue handle for queue UI display. */
  messageQueue: UseMessageQueueReturn
  /** Model options/selection for empty and active chat inputs. */
  modelSelection: {
    value: SetSessionModelInput | null
    options: ChatModelOption[]
    onChange: (selection: SetSessionModelInput) => void
    disabled?: boolean
  } | null
  /** Reasoning effort selection for Codex sessions (null when not applicable). */
  reasoningEffortSelection: {
    value: CodexReasoningEffort | null
    globalDefault: CodexReasoningEffort
    onChange: (effort: CodexReasoningEffort | null) => void
    disabled?: boolean
  } | null

  // ── Session navigation ────────────────────────────────────────

  /** Chat-eligible sessions (agent + IM bots) sorted by most recent. */
  sessions: SessionSnapshot[]
  /** Switch to a different session (or null to clear → shows empty chat). */
  selectSession: (sessionId: string | null) => void
}

// ═══════════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════════

/**
 * Structural equality for session lists — re-renders only when the list
 * membership (IDs) or display-relevant fields (state) change.
 *
 * During streaming, session.state stays 'streaming' and the set of
 * chat-eligible sessions is stable, so this returns `true` and the
 * component skips re-render.  Token/cost metadata changes (the
 * majority of streaming updates) are invisible to this comparator.
 *
 * Note: `lastActivity` is intentionally excluded. It changes on every
 * metadata flush, which would defeat the optimization. The downstream
 * `SidebarSessionItem` shows `formatRelativeTime(session.lastActivity)`
 * which displays "just now" during streaming (correct) and updates when
 * the session state transitions (state change triggers comparator failure).
 */
function sessionListEqual(a: SessionSnapshot[], b: SessionSnapshot[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].state !== b[i].state) return false
  }
  return true
}

/**
 * useAgentSession — Encapsulates agent chat session lifecycle.
 *
 * Built on top of `useSessionBase` for shared session operations,
 * adding agent-specific concerns:
 *   - Session list filtering (agent + IM bot origins)
 *   - Global session ID persistence (via appStore)
 *   - Session selection / navigation
 */
export function useAgentSession(): AgentSessionHandle {
  const chatSessionId = useAppStore((s) => s.agentChatSessionId)
  const setChatSessionId = useAppStore((s) => s.setAgentChatSessionId)
  const settings = useSettingsStore((s) => s.settings)
  const setSessionModel = useCommandStore((s) => s.setSessionModel)
  const setSessionReasoningEffort = useCommandStore((s) => s.setSessionReasoningEffort)

  const clearSessionId = useCallback(() => setChatSessionId(null), [setChatSessionId])

  const base = useSessionBase({
    sessionId: chatSessionId,
    onSessionIdClear: clearSessionId
  })

  // Chat-eligible sessions: agent (UI) + all IM bots, scoped to selected project.
  // Uses a structural equality comparator (id + state) so the component
  // only re-renders when sessions are added/removed or their state transitions —
  // NOT on every metadata flush (cost, tokens, context) during streaming.
  const selectedProjectId = base.selectedProjectId
  const sessions: SessionSnapshot[] = useStoreWithEqualityFn(
    useCommandStore,
    (s) =>
      s.managedSessions
        .filter(
          (ms) =>
            CHAT_ELIGIBLE_SOURCES.has(ms.origin.source) &&
            (!selectedProjectId || ms.projectId === selectedProjectId)
        )
        .sort((a, b) => b.createdAt - a.createdAt),
    sessionListEqual,
  )

  const selectSession = useCallback(
    (sessionId: string | null) => setChatSessionId(sessionId),
    [setChatSessionId]
  )

  // ── Model selection ───────────────────────────────────────────

  const modelOptions = useMemo(() => buildChatModelOptions(settings), [settings])
  const defaultModelSelection = useMemo(
    () => resolveDefaultChatModelSelection(settings, modelOptions),
    [settings, modelOptions],
  )
  const [pendingModelSelection, setPendingModelSelection] = useState<SetSessionModelInput | null>(null)

  const effectiveNewModelSelection = useMemo(() => {
    if (hasChatModelOption(modelOptions, pendingModelSelection)) return pendingModelSelection
    return defaultModelSelection
  }, [defaultModelSelection, modelOptions, pendingModelSelection])

  const currentModelSelection = useMemo(() => {
    if (base.session) return resolveSessionChatModelSelection(base.session, settings, modelOptions)
    return effectiveNewModelSelection
  }, [base.session, effectiveNewModelSelection, modelOptions, settings])

  const currentSessionId = base.session?.id ?? null
  const handleModelSelectionChange = useCallback(
    (selection: SetSessionModelInput) => {
      if (currentSessionId) {
        void setSessionModel(currentSessionId, selection)
        return
      }
      setPendingModelSelection(selection)
    },
    [currentSessionId, setSessionModel],
  )

  const modelSelection = useMemo<AgentSessionHandle['modelSelection']>(() => {
    if (modelOptions.length === 0) return null
    return {
      value: currentModelSelection,
      options: modelOptions,
      onChange: handleModelSelectionChange,
      disabled: base.isStarting,
    }
  }, [base.isStarting, currentModelSelection, handleModelSelectionChange, modelOptions])

  // ── Reasoning effort selection ────────────────────────────────

  const globalReasoningDefault: CodexReasoningEffort =
    (settings?.provider?.byEngine?.codex?.defaultReasoningEffort) ?? 'medium'

  const [pendingReasoningEffort, setPendingReasoningEffort] = useState<CodexReasoningEffort | null>(null)

  const handleReasoningEffortChange = useCallback(
    (effort: CodexReasoningEffort | null) => {
      if (base.session?.id) {
        void setSessionReasoningEffort(base.session.id, effort)
      } else {
        setPendingReasoningEffort(effort)
      }
    },
    [base.session?.id, setSessionReasoningEffort],
  )

  const effectiveEngineKind = base.session?.desiredEngineKind ?? base.session?.engineKind
  const emptyEngineKind = effectiveNewModelSelection?.engineKind
  const reasoningEffortSelection = useMemo<AgentSessionHandle['reasoningEffortSelection']>(() => {
    if (base.session) {
      if (effectiveEngineKind !== 'codex') return null
      return {
        value: base.session.modelReasoningEffort ?? null,
        globalDefault: globalReasoningDefault,
        onChange: handleReasoningEffortChange,
        disabled: base.isStarting,
      }
    }
    // Empty chat state: show when the selected engine will be codex
    if (emptyEngineKind !== 'codex') return null
    return {
      value: pendingReasoningEffort,
      globalDefault: globalReasoningDefault,
      onChange: handleReasoningEffortChange,
      disabled: base.isStarting,
    }
  }, [base.session, base.isStarting, effectiveEngineKind, emptyEngineKind, globalReasoningDefault, handleReasoningEffortChange, pendingReasoningEffort])

  // ── Start new session ─────────────────────────────────────────

  const handleStartChat = useCallback(
    async (message: UserMessageContent): Promise<boolean> => {
      if (base.isStarting) return false
      base.setIsStarting(true)
      try {
        const sessionId = await base.startSession({
          prompt: message,
          workspace: base.startWorkspace,
          ...(effectiveNewModelSelection ? { engineKind: effectiveNewModelSelection.engineKind } : {}),
          ...(effectiveNewModelSelection?.model ? { model: effectiveNewModelSelection.model } : {}),
        })
        if (sessionId) {
          setChatSessionId(sessionId)
          if (pendingReasoningEffort !== null) {
            void setSessionReasoningEffort(sessionId, pendingReasoningEffort)
          }
          return true
        }
        return false
      } catch {
        return false
      } finally {
        base.setIsStarting(false)
      }
    },
    [base, effectiveNewModelSelection, setChatSessionId, pendingReasoningEffort, setSessionReasoningEffort]
  )

  // ── Unified send/queue (with start) ───────────────────────────

  const sendOrQueue = useCallback(
    async (message: UserMessageContent): Promise<boolean> => {
      if (!base.session && !base.isStarting) {
        return handleStartChat(message)
      }
      return base.sendOrQueueExisting(message)
    },
    [base, handleStartChat]
  )

  return {
    session: base.session,
    isStarting: base.isStarting,
    isProcessing: base.isProcessing,
    isPaused: base.isPaused,
    state: base.state,
    projectPath: base.projectPath,
    projectId: base.selectedProjectId,
    projectName: base.projectName,
    sendOrQueue,
    stop: base.handleStop,
    messageQueue: base.messageQueue,
    modelSelection,
    reasoningEffortSelection,
    sessions,
    selectSession
  }
}
