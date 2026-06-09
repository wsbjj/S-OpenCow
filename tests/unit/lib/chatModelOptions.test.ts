// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import {
  buildChatModelOptions,
  resolveDefaultChatModelSelection,
  resolveSessionChatModelSelection,
} from '../../../src/renderer/lib/chatModelOptions'
import type { AppSettings, SessionSnapshot } from '../../../src/shared/types'

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    theme: { mode: 'system', scheme: 'zinc', texture: 'plain' },
    language: 'system',
    proxy: { httpsProxy: '', httpProxy: '', noProxy: '' },
    command: {
      defaultEngine: 'codex',
      permissionMode: 'bypassPermissions',
      maxTurns: 10000,
    },
    provider: {
      byEngine: {
        claude: {
          activeMode: 'api_key',
          defaultModel: 'claude-sonnet-4-6',
          modelSelectionsByMode: {
            api_key: {
              selectedModels: [
                { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet', source: 'provider' },
                { id: 'claude-opus-4-6', source: 'manual' },
              ],
              defaultModel: 'claude-sonnet-4-6',
            },
          },
        },
        codex: {
          activeMode: 'custom',
          defaultModel: 'gpt-5.3-codex',
          defaultReasoningEffort: 'high',
          modelSelectionsByMode: {
            custom: {
              selectedModels: [
                { id: 'gpt-5.3-codex', source: 'provider' },
                { id: 'gpt-5.4', source: 'manual' },
              ],
              defaultModel: 'gpt-5.4',
            },
          },
        },
      },
      backgroundModel: { mode: 'inherit' },
    },
    webhooks: { endpoints: [] },
    messaging: { connections: [] },
    schedule: {
      enabled: true,
      maxConcurrentExecutions: 3,
      quietHours: {
        enabled: false,
        start: '23:00',
        end: '07:00',
      },
    },
    evose: { apiKey: '', baseUrl: '', workspaceIds: [], apps: [] },
    eventSubscriptions: {
      enabled: true,
      onError: true,
      onComplete: true,
      onStatusChange: true,
    },
    updates: {
      autoCheckUpdates: true,
      updateCheckInterval: '24h',
    },
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'session-1',
    engineKind: 'claude',
    engineSessionRef: null,
    engineState: null,
    state: 'idle',
    stopReason: null,
    origin: { source: 'agent' },
    projectPath: null,
    projectId: null,
    model: 'claude-sonnet-4-6',
    createdAt: 1,
    lastActivity: 1,
    activeDurationMs: 0,
    activeStartedAt: null,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastInputTokens: 0,
    activity: null,
    error: null,
    executionContext: null,
    ...overrides,
  }
}

describe('chatModelOptions', () => {
  it('builds grouped chat model options from active provider mode selections', () => {
    const settings = makeSettings()
    expect(buildChatModelOptions(settings)).toEqual([
      {
        engineKind: 'claude',
        model: 'claude-sonnet-4-6',
        label: 'Claude Sonnet (claude-sonnet-4-6)',
        source: 'provider',
        isDefault: true,
      },
      {
        engineKind: 'claude',
        model: 'claude-opus-4-6',
        label: 'claude-opus-4-6',
        source: 'manual',
        isDefault: false,
      },
      {
        engineKind: 'codex',
        model: 'gpt-5.3-codex',
        label: 'gpt-5.3-codex',
        source: 'provider',
        isDefault: false,
      },
      {
        engineKind: 'codex',
        model: 'gpt-5.4',
        label: 'gpt-5.4',
        source: 'manual',
        isDefault: true,
      },
    ])
  })

  it('uses legacy defaultModel as a single fallback option', () => {
    const settings = makeSettings({
      provider: {
        byEngine: {
          claude: { activeMode: 'api_key', defaultModel: 'claude-legacy' },
          codex: { activeMode: null, defaultReasoningEffort: 'high' },
        },
        backgroundModel: { mode: 'inherit' },
      },
    })

    expect(buildChatModelOptions(settings)).toEqual([
      {
        engineKind: 'claude',
        model: 'claude-legacy',
        label: 'claude-legacy',
        source: 'legacy',
        isDefault: true,
      },
    ])
  })

  it('resolves the default chat selection from the default engine first', () => {
    const settings = makeSettings()
    const options = buildChatModelOptions(settings)
    expect(resolveDefaultChatModelSelection(settings, options)).toEqual({
      engineKind: 'codex',
      model: 'gpt-5.4',
    })
  })

  it('resolves session desired selection before observed runtime model', () => {
    const settings = makeSettings()
    const options = buildChatModelOptions(settings)
    const session = makeSession({
      desiredEngineKind: 'codex',
      desiredModel: 'gpt-5.3-codex',
      model: 'claude-sonnet-4-6',
    })

    expect(resolveSessionChatModelSelection(session, settings, options)).toEqual({
      engineKind: 'codex',
      model: 'gpt-5.3-codex',
    })
  })
})
