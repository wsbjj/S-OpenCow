// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { useSettingsStore } from '@/stores/settingsStore'
import { getAppAPI } from '@/windowAPI'
import type {
  AIEngineKind,
  ApiProvider,
  AppSettings,
  BackgroundModelAuthStyle,
  BackgroundModelProtocol,
  BackgroundModelSettings,
  CodexReasoningEffort,
  ProviderCredentialInfo,
  ProviderModelChoice,
  ProviderModelInfo,
  ProviderModelListResult,
  ProviderStatus,
} from '@shared/types'
import {
  CODEX_REASONING_EFFORT_OPTIONS,
  ENGINE_TABS,
  getModeLabelKey,
  PROVIDER_MODES_BY_ENGINE,
} from './provider/constants'
import { DefaultEngineSelect } from './provider/DefaultEngineSelect'
import { ModeCredentialStep } from './provider/ModeCredentialStep'
import { StatusBadge } from './provider/StatusBadge'

interface StepHeaderProps {
  step: number
  title: string
  description: string
}

interface EngineTabPreviewProps {
  engineKind: AIEngineKind
  labelKey: string
  isDefault: boolean
  status: ProviderStatus | null
  activeMode: ApiProvider | null
  defaultModel?: string
}

interface BackgroundModelSectionProps {
  settings: AppSettings
  updateSettings: (settings: AppSettings) => Promise<void>
}

function StepHeader({ step, title, description }: StepHeaderProps): React.JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className="mb-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground)/0.8)]">
        {t('provider.steps.stepLabel', { step })}
      </p>
      <h5 className="text-sm font-medium">{title}</h5>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">{description}</p>
    </div>
  )
}

function resolveBadgeState(status: ProviderStatus | null): 'authenticated' | 'authenticating' | 'error' | 'unauthenticated' {
  if (!status) return 'unauthenticated'
  if (status.state === 'authenticated') return 'authenticated'
  if (status.state === 'authenticating') return 'authenticating'
  if (status.state === 'error') return 'error'
  return 'unauthenticated'
}

function buildEngineModeSet(engineKind: AIEngineKind): Set<ApiProvider> {
  return new Set(PROVIDER_MODES_BY_ENGINE[engineKind].map((modeOption) => modeOption.mode))
}

function buildBackgroundModelSettings(
  current: BackgroundModelSettings | undefined,
  patch: Partial<BackgroundModelSettings>,
): BackgroundModelSettings {
  const next = { mode: 'inherit' as BackgroundModelSettings['mode'], ...current, ...patch }
  if (next.mode === 'inherit') return { mode: 'inherit' }

  const model = typeof next.model === 'string' && next.model.trim() ? next.model.trim() : undefined
  if (next.mode === 'inherit-model') {
    return {
      mode: 'inherit-model',
      ...(model ? { model } : {}),
    }
  }

  const protocol = next.protocol ?? 'openai'
  const baseUrl = typeof next.baseUrl === 'string' && next.baseUrl.trim() ? next.baseUrl.trim() : undefined
  return {
    mode: 'custom',
    protocol,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(protocol === 'anthropic' ? { authStyle: next.authStyle ?? 'x-api-key' } : {}),
  }
}

function modelChoiceFromInfo(model: ProviderModelInfo, source: ProviderModelChoice['source'] = 'provider'): ProviderModelChoice {
  return {
    id: model.id,
    ...(model.displayName ? { displayName: model.displayName } : {}),
    source,
  }
}

function dedupeModelChoices(models: ProviderModelChoice[]): ProviderModelChoice[] {
  const seen = new Set<string>()
  const result: ProviderModelChoice[] = []
  for (const model of models) {
    const id = model.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      ...(model.displayName?.trim() ? { displayName: model.displayName.trim() } : {}),
      source: model.source ?? 'manual',
    })
  }
  return result
}

function getModeModelSettings(
  engineSettings: AppSettings['provider']['byEngine'][AIEngineKind],
  mode: ApiProvider | null,
): { selectedModels: ProviderModelChoice[]; defaultModel: string } {
  if (!mode) {
    return {
      selectedModels: engineSettings.defaultModel
        ? [{ id: engineSettings.defaultModel, source: 'legacy' }]
        : [],
      defaultModel: engineSettings.defaultModel ?? '',
    }
  }

  const stored = engineSettings.modelSelectionsByMode?.[mode]
  const selectedModels = dedupeModelChoices(
    stored?.selectedModels?.length
      ? stored.selectedModels
      : engineSettings.defaultModel
        ? [{ id: engineSettings.defaultModel, source: 'legacy' }]
        : [],
  )
  const defaultModel = stored?.defaultModel?.trim()
    || engineSettings.defaultModel?.trim()
    || selectedModels[0]?.id
    || ''

  return {
    selectedModels,
    defaultModel: selectedModels.some((model) => model.id === defaultModel)
      ? defaultModel
      : selectedModels[0]?.id ?? '',
  }
}

function buildEngineSettingsWithModelSelection(params: {
  engineSettings: AppSettings['provider']['byEngine'][AIEngineKind]
  mode: ApiProvider
  selectedModels: ProviderModelChoice[]
  defaultModel?: string
  sourceUrl?: string
  lastFetchedAt?: number
}): AppSettings['provider']['byEngine'][AIEngineKind] {
  const selectedModels = dedupeModelChoices(params.selectedModels)
  const requestedDefault = params.defaultModel?.trim()
  const defaultModel = requestedDefault && selectedModels.some((model) => model.id === requestedDefault)
    ? requestedDefault
    : selectedModels[0]?.id
  const currentByMode = params.engineSettings.modelSelectionsByMode ?? {}

  return {
    ...params.engineSettings,
    defaultModel,
    modelSelectionsByMode: {
      ...currentByMode,
      [params.mode]: {
        selectedModels,
        ...(defaultModel ? { defaultModel } : {}),
        ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
        ...(params.lastFetchedAt !== undefined ? { lastFetchedAt: params.lastFetchedAt } : {}),
      },
    },
  }
}

function resolveInitialOpenEngine(
  settings: ReturnType<typeof useSettingsStore.getState>['settings'],
): AIEngineKind {
  const claudeMode = settings?.provider.byEngine.claude?.activeMode
  const codexMode = settings?.provider.byEngine.codex?.activeMode
  if (claudeMode) return 'claude'
  if (codexMode) return 'codex'
  return 'claude'
}

function EngineTabPreview({
  engineKind,
  labelKey,
  isDefault,
  status,
  activeMode,
  defaultModel,
}: EngineTabPreviewProps): React.JSX.Element {
  const { t } = useTranslation('settings')
  const modeLabelKey = getModeLabelKey(engineKind, activeMode)

  return (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold truncate">{t(labelKey)}</span>
          {isDefault && (
            <span className="rounded border border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.12)] px-2 py-0.5 text-[10px] font-medium text-[hsl(var(--primary))]">
              {t('provider.overview.defaultBadge')}
            </span>
          )}
        </span>
        <StatusBadge state={resolveBadgeState(status)} />
      </span>
      <span className="mt-1 block text-xs text-[hsl(var(--muted-foreground))]">
        {t('provider.overview.modeLabel')}:{' '}
        <span className="text-[hsl(var(--foreground))]">
          {modeLabelKey ? t(modeLabelKey) : t('provider.overview.notConfigured')}
        </span>
      </span>
      <span className="mt-0.5 block text-xs text-[hsl(var(--muted-foreground))]">
        {t('provider.overview.defaultModelLabel')}:{' '}
        <span className="font-mono text-[hsl(var(--foreground))]">
          {defaultModel?.trim() ? defaultModel : t('provider.overview.notSet')}
        </span>
      </span>
    </>
  )
}

function BackgroundModelSection({
  settings,
  updateSettings,
}: BackgroundModelSectionProps): React.JSX.Element {
  const { t } = useTranslation('settings')
  const backgroundModel = useMemo<BackgroundModelSettings>(
    () => settings.provider.backgroundModel ?? { mode: 'inherit' },
    [settings.provider.backgroundModel],
  )
  const isCustom = backgroundModel.mode === 'custom'
  const isInheritModel = backgroundModel.mode === 'inherit-model'
  const protocol = isCustom ? (backgroundModel.protocol ?? 'openai') : 'openai'
  const [apiKey, setApiKey] = useState('')
  const [loadingCredential, setLoadingCredential] = useState(false)
  const [savingCredential, setSavingCredential] = useState(false)
  const [credentialError, setCredentialError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadingCredential(true)
    getAppAPI()['background-model:get-credential']()
      .then((credential) => {
        if (!cancelled) setApiKey(credential?.apiKey ?? '')
      })
      .catch((eventError: unknown) => {
        if (!cancelled) setCredentialError(eventError instanceof Error ? eventError.message : String(eventError))
      })
      .finally(() => {
        if (!cancelled) setLoadingCredential(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const updateBackgroundModel = useCallback(async (patch: Partial<BackgroundModelSettings>) => {
    const nextBackgroundModel = buildBackgroundModelSettings(backgroundModel, patch)
    await updateSettings({
      ...settings,
      provider: {
        ...settings.provider,
        backgroundModel: nextBackgroundModel,
      },
    })
  }, [backgroundModel, settings, updateSettings])

  const handleSaveCredential = useCallback(async () => {
    const trimmed = apiKey.trim()
    if (!trimmed) return
    setSavingCredential(true)
    setCredentialError(null)
    try {
      const credential = await getAppAPI()['background-model:set-credential']({ apiKey: trimmed })
      setApiKey(credential?.apiKey ?? '')
    } catch (eventError) {
      setCredentialError(eventError instanceof Error ? eventError.message : String(eventError))
    } finally {
      setSavingCredential(false)
    }
  }, [apiKey])

  const handleClearCredential = useCallback(async () => {
    setSavingCredential(true)
    setCredentialError(null)
    try {
      await getAppAPI()['background-model:clear-credential']()
      setApiKey('')
    } catch (eventError) {
      setCredentialError(eventError instanceof Error ? eventError.message : String(eventError))
    } finally {
      setSavingCredential(false)
    }
  }, [])

  return (
    <section className="rounded-lg bg-[hsl(var(--foreground)/0.03)] p-4">
      <div className="mb-4">
        <h4 className="text-sm font-medium">{t('provider.backgroundModel.title')}</h4>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('provider.backgroundModel.description')}</p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">{t('provider.backgroundModel.mode')}</label>
          <select
            value={backgroundModel.mode}
            onChange={(event) => {
              const mode = event.target.value as BackgroundModelSettings['mode']
              if (mode === 'custom') {
                void updateBackgroundModel({ mode: 'custom', protocol })
                return
              }
              if (mode === 'inherit-model') {
                void updateBackgroundModel({ mode: 'inherit-model', model: backgroundModel.model })
                return
              }
              void updateBackgroundModel({ mode: 'inherit' })
            }}
            className={cn(
              'w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] pl-3 pr-8 py-1.5 text-sm outline-none',
              'focus:ring-2 focus:ring-[hsl(var(--ring))]',
            )}
          >
            <option value="inherit">{t('provider.backgroundModel.inherit')}</option>
            <option value="inherit-model">{t('provider.backgroundModel.inheritModel')}</option>
            <option value="custom">{t('provider.backgroundModel.custom')}</option>
          </select>
          <p className="mt-1.5 text-xs text-[hsl(var(--muted-foreground))]">
            {t('provider.backgroundModel.modeHint')}
          </p>
        </div>

        {isInheritModel && (
          <div>
            <label className="block text-sm font-medium mb-1">{t('provider.backgroundModel.model')}</label>
            <input
              type="text"
              value={backgroundModel.model ?? ''}
              onChange={(event) => void updateBackgroundModel({ mode: 'inherit-model', model: event.target.value || undefined })}
              placeholder={t('provider.backgroundModel.inheritModelPlaceholder')}
              className={cn(
                'w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-sm outline-none font-mono',
                'focus:ring-2 focus:ring-[hsl(var(--ring))]',
              )}
            />
            <p className="mt-1.5 text-xs text-[hsl(var(--muted-foreground))]">
              {t('provider.backgroundModel.inheritModelHint')}
            </p>
          </div>
        )}

        {isCustom && (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium mb-1">{t('provider.backgroundModel.protocol')}</label>
              <select
                value={protocol}
                onChange={(event) => {
                  const nextProtocol = event.target.value as BackgroundModelProtocol
                  void updateBackgroundModel({
                    mode: 'custom',
                    protocol: nextProtocol,
                    authStyle: nextProtocol === 'anthropic' ? (backgroundModel.authStyle ?? 'x-api-key') : undefined,
                  })
                }}
                className={cn(
                  'w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] pl-3 pr-8 py-1.5 text-sm outline-none',
                  'focus:ring-2 focus:ring-[hsl(var(--ring))]',
                )}
              >
                <option value="openai">{t('provider.backgroundModel.protocolOpenAI')}</option>
                <option value="anthropic">{t('provider.backgroundModel.protocolAnthropic')}</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">{t('provider.backgroundModel.model')}</label>
              <input
                type="text"
                value={backgroundModel.model ?? ''}
                onChange={(event) => void updateBackgroundModel({ mode: 'custom', model: event.target.value || undefined })}
                placeholder={t('provider.backgroundModel.modelPlaceholder')}
                className={cn(
                  'w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-sm outline-none font-mono',
                  'focus:ring-2 focus:ring-[hsl(var(--ring))]',
                )}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">{t('provider.backgroundModel.baseUrl')}</label>
              <input
                type="url"
                value={backgroundModel.baseUrl ?? ''}
                onChange={(event) => void updateBackgroundModel({ mode: 'custom', baseUrl: event.target.value || undefined })}
                placeholder={t('provider.backgroundModel.baseUrlPlaceholder')}
                className={cn(
                  'w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-sm outline-none font-mono',
                  'focus:ring-2 focus:ring-[hsl(var(--ring))]',
                )}
              />
              <p className="mt-1.5 text-xs text-[hsl(var(--muted-foreground))]">
                {t('provider.backgroundModel.baseUrlHint')}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">{t('provider.backgroundModel.apiKey')}</label>
              <input
                type="password"
                value={apiKey}
                disabled={loadingCredential}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={t('provider.backgroundModel.apiKeyPlaceholder')}
                className={cn(
                  'w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-sm outline-none font-mono',
                  'focus:ring-2 focus:ring-[hsl(var(--ring))]',
                  loadingCredential && 'opacity-60 cursor-not-allowed',
                )}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleSaveCredential()
                }}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleSaveCredential()}
                  disabled={savingCredential || loadingCredential || !apiKey.trim()}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                    'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:bg-[hsl(var(--primary)/0.9)]',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                >
                  {savingCredential && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  {t('provider.backgroundModel.saveApiKey')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleClearCredential()}
                  disabled={savingCredential || loadingCredential || !apiKey}
                  className={cn(
                    'rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-xs font-medium transition-colors',
                    'hover:border-[hsl(var(--ring)/0.6)] disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                >
                  {t('provider.backgroundModel.clearApiKey')}
                </button>
              </div>
              {credentialError && <p className="mt-1.5 text-xs text-red-400">{credentialError}</p>}
            </div>

            {protocol === 'anthropic' && (
              <div>
                <label className="block text-sm font-medium mb-1">{t('provider.backgroundModel.authStyle')}</label>
                <select
                  value={backgroundModel.authStyle ?? 'x-api-key'}
                  onChange={(event) => void updateBackgroundModel({
                    mode: 'custom',
                    authStyle: event.target.value as BackgroundModelAuthStyle,
                  })}
                  className={cn(
                    'w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] pl-3 pr-8 py-1.5 text-sm outline-none',
                    'focus:ring-2 focus:ring-[hsl(var(--ring))]',
                  )}
                >
                  <option value="x-api-key">{t('provider.backgroundModel.authStyleXApiKey')}</option>
                  <option value="bearer">{t('provider.backgroundModel.authStyleBearer')}</option>
                </select>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

export function ProviderSection(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore((store) => store.settings)!
  const providerStatusByEngine = useSettingsStore((store) => store.providerStatusByEngine)
  const setSettings = useSettingsStore((store) => store.setSettings)
  const setProviderStatusForEngine = useSettingsStore((store) => store.setProviderStatusForEngine)
  const loadProviderStatus = useSettingsStore((store) => store.loadProviderStatus)
  const updateSettings = useSettingsStore((store) => store.updateSettings)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editValues, setEditValues] = useState<ProviderCredentialInfo | null>(null)
  const [activeEngine, setActiveEngine] = useState<AIEngineKind>(() => resolveInitialOpenEngine(settings))
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [fetchedModelResultByEngine, setFetchedModelResultByEngine] = useState<Record<AIEngineKind, ProviderModelListResult | null>>({
    claude: null,
    codex: null,
  })
  const [fetchingModelEngine, setFetchingModelEngine] = useState<AIEngineKind | null>(null)
  const [modelFetchErrorByEngine, setModelFetchErrorByEngine] = useState<Record<AIEngineKind, string | null>>({
    claude: null,
    codex: null,
  })

  const defaultEngine = settings.command.defaultEngine
  const providerByEngine = settings.provider.byEngine
  const activeEngineConfig = providerByEngine[activeEngine] ?? { activeMode: null, defaultModel: undefined, defaultReasoningEffort: 'high' }
  const activeMode = activeEngineConfig.activeMode
  const providerModes = PROVIDER_MODES_BY_ENGINE[activeEngine]
  const activeEngineStatus = providerStatusByEngine[activeEngine]
  const activeModeSet = useMemo(() => buildEngineModeSet(activeEngine), [activeEngine])
  const effectiveActiveMode = activeMode && activeModeSet.has(activeMode) ? activeMode : null
  const modeSupportedForActiveEngine = !activeMode || activeModeSet.has(activeMode)

  const isStatusForActiveMode = activeEngineStatus?.mode === effectiveActiveMode
  const isAuthenticated = isStatusForActiveMode && activeEngineStatus?.state === 'authenticated'
  const isAuthenticating = !isAuthenticated
    && ((isStatusForActiveMode && activeEngineStatus?.state === 'authenticating') || loading)
  const fetchedModelsForActiveEngine = fetchedModelResultByEngine[activeEngine]?.models ?? []
  const fetchedSourceUrl = fetchedModelResultByEngine[activeEngine]?.sourceUrl
  const modelFetchError = modelFetchErrorByEngine[activeEngine]
  const isFetchingModels = fetchingModelEngine === activeEngine
  const activeModeModels = getModeModelSettings(activeEngineConfig, effectiveActiveMode)
  const selectedModelsForActiveMode = activeModeModels.selectedModels
  const selectedModelIdsForActiveMode = useMemo(
    () => new Set(selectedModelsForActiveMode.map((model) => model.id)),
    [selectedModelsForActiveMode],
  )
  const defaultModelForActiveMode = activeModeModels.defaultModel
  const [manualModelInput, setManualModelInput] = useState('')

  const resetTransientState = useCallback(() => {
    setError(null)
    setIsEditing(false)
    setEditValues(null)
  }, [])

  const refreshEngineStatus = useCallback(async (
    input: { engineKind: AIEngineKind; syncGlobal?: boolean; force?: boolean },
  ) => loadProviderStatus(input), [loadProviderStatus])

  useEffect(() => {
    setCheckingStatus(true)
    void refreshEngineStatus({ engineKind: activeEngine, syncGlobal: true }).finally(() => setCheckingStatus(false))
  }, [activeEngine, refreshEngineStatus])

  useEffect(() => {
    const inactiveEngineKinds = ENGINE_TABS.map((engine) => engine.kind).filter((engineKind) => engineKind !== activeEngine)
    void Promise.all(
      inactiveEngineKinds.map((engineKind) => (
        refreshEngineStatus({ engineKind, syncGlobal: false })
      )),
    )
  }, [activeEngine, refreshEngineStatus])

  const handleSelectEngineTab = useCallback((engineKind: AIEngineKind) => {
    if (engineKind === activeEngine) return
    setActiveEngine(engineKind)
    resetTransientState()
  }, [activeEngine, resetTransientState])

  const handleTabValueChange = useCallback((nextValue: string) => {
    handleSelectEngineTab(nextValue as AIEngineKind)
  }, [handleSelectEngineTab])

  const handleDefaultEngineChange = useCallback(async (engineKind: AIEngineKind) => {
    if (settings.command.defaultEngine === engineKind) return
    await updateSettings({
      ...settings,
      command: {
        ...settings.command,
        defaultEngine: engineKind,
      },
    })
    await refreshEngineStatus({ engineKind, syncGlobal: true })
  }, [refreshEngineStatus, settings, updateSettings])

  const handleModeSelect = useCallback(async (mode: ApiProvider) => {
    resetTransientState()
    setCheckingStatus(true)

    if (activeMode === mode) {
      await refreshEngineStatus({ engineKind: activeEngine, syncGlobal: true, force: true })
      setCheckingStatus(false)
      return
    }

    const optimisticStatus: ProviderStatus = { state: 'unauthenticated', mode }
    setProviderStatusForEngine({ engineKind: activeEngine, status: optimisticStatus, syncGlobal: true })

    try {
      const nextSettings = {
        ...settings,
        provider: {
          ...settings.provider,
          byEngine: {
            ...settings.provider.byEngine,
            [activeEngine]: {
              ...(settings.provider.byEngine[activeEngine] ?? { activeMode: null }),
              activeMode: mode,
            },
          },
        },
      }
      setSettings(nextSettings)
      await getAppAPI()['update-settings'](nextSettings)
      await refreshEngineStatus({ engineKind: activeEngine, syncGlobal: true, force: true })
    } catch (eventError) {
      setError(eventError instanceof Error ? eventError.message : String(eventError))
    } finally {
      setCheckingStatus(false)
    }
  }, [activeEngine, activeMode, refreshEngineStatus, resetTransientState, setProviderStatusForEngine, setSettings, settings])

  const handleStartEditing = useCallback(async () => {
    if (!effectiveActiveMode) return
    const credential = await getAppAPI()['provider:get-credential'](activeEngine, effectiveActiveMode).catch(() => null)
    setEditValues(credential)
    setIsEditing(true)
  }, [activeEngine, effectiveActiveMode])

  const handleLogin = useCallback(async (mode: ApiProvider, params?: Record<string, unknown>) => {
    setLoading(true)
    setError(null)
    try {
      const status = await getAppAPI()['provider:login'](activeEngine, mode, params)
      setProviderStatusForEngine({ engineKind: activeEngine, status, syncGlobal: true })
      if (status.state === 'error' && status.error) {
        setError(status.error)
      } else {
        setIsEditing(false)
      }
    } catch (eventError) {
      setError(eventError instanceof Error ? eventError.message : String(eventError))
    } finally {
      setLoading(false)
    }
  }, [activeEngine, setProviderStatusForEngine])

  const handleCancelLogin = useCallback(async () => {
    if (!effectiveActiveMode) return
    setLoading(true)
    try {
      await getAppAPI()['provider:cancel-login'](activeEngine, effectiveActiveMode)
      await refreshEngineStatus({ engineKind: activeEngine, syncGlobal: true, force: true })
    } catch (eventError) {
      setError(eventError instanceof Error ? eventError.message : String(eventError))
    } finally {
      setLoading(false)
    }
  }, [activeEngine, effectiveActiveMode, refreshEngineStatus])

  const handleLogout = useCallback(async () => {
    if (!effectiveActiveMode) return
    setLoading(true)
    resetTransientState()
    try {
      await getAppAPI()['provider:logout'](activeEngine, effectiveActiveMode)
      const unauthenticatedStatus: ProviderStatus = { state: 'unauthenticated', mode: effectiveActiveMode }
      setProviderStatusForEngine({
        engineKind: activeEngine,
        status: unauthenticatedStatus,
        syncGlobal: true,
      })
    } catch (eventError) {
      setError(eventError instanceof Error ? eventError.message : String(eventError))
    } finally {
      setLoading(false)
    }
  }, [activeEngine, effectiveActiveMode, resetTransientState, setProviderStatusForEngine])

  const updateModelSelectionSetting = useCallback(async (
    selectedModels: ProviderModelChoice[],
    defaultModel?: string,
    metadata?: { sourceUrl?: string; lastFetchedAt?: number },
  ) => {
    if (!effectiveActiveMode) return
    const nextEngineSettings = buildEngineSettingsWithModelSelection({
      engineSettings: settings.provider.byEngine[activeEngine] ?? { activeMode: null },
      mode: effectiveActiveMode,
      selectedModels,
      defaultModel,
      sourceUrl: metadata?.sourceUrl ?? activeEngineConfig.modelSelectionsByMode?.[effectiveActiveMode]?.sourceUrl,
      lastFetchedAt: metadata?.lastFetchedAt ?? activeEngineConfig.modelSelectionsByMode?.[effectiveActiveMode]?.lastFetchedAt,
    })

    await updateSettings({
      ...settings,
      provider: {
        ...settings.provider,
        byEngine: {
          ...settings.provider.byEngine,
          [activeEngine]: nextEngineSettings,
        },
      },
    })
  }, [activeEngine, activeEngineConfig.modelSelectionsByMode, effectiveActiveMode, settings, updateSettings])

  const handleToggleFetchedModel = useCallback((model: ProviderModelInfo, checked: boolean) => {
    const nextSelected = checked
      ? dedupeModelChoices([...selectedModelsForActiveMode, modelChoiceFromInfo(model, 'provider')])
      : selectedModelsForActiveMode.filter((candidate) => candidate.id !== model.id)
    const nextDefault = checked
      ? (defaultModelForActiveMode || model.id)
      : (defaultModelForActiveMode === model.id ? nextSelected[0]?.id : defaultModelForActiveMode)
    void updateModelSelectionSetting(nextSelected, nextDefault, {
      sourceUrl: fetchedSourceUrl,
      lastFetchedAt: fetchedSourceUrl ? Date.now() : undefined,
    })
  }, [defaultModelForActiveMode, fetchedSourceUrl, selectedModelsForActiveMode, updateModelSelectionSetting])

  const handleRemoveSelectedModel = useCallback((modelId: string) => {
    const nextSelected = selectedModelsForActiveMode.filter((candidate) => candidate.id !== modelId)
    const nextDefault = defaultModelForActiveMode === modelId ? nextSelected[0]?.id : defaultModelForActiveMode
    void updateModelSelectionSetting(nextSelected, nextDefault)
  }, [defaultModelForActiveMode, selectedModelsForActiveMode, updateModelSelectionSetting])

  const handleDefaultModelSelect = useCallback((modelId: string) => {
    if (!modelId) return
    void updateModelSelectionSetting(selectedModelsForActiveMode, modelId)
  }, [selectedModelsForActiveMode, updateModelSelectionSetting])

  const handleAddManualModel = useCallback(() => {
    const modelId = manualModelInput.trim()
    if (!modelId) return
    const nextSelected = dedupeModelChoices([
      ...selectedModelsForActiveMode,
      { id: modelId, source: 'manual' },
    ])
    void updateModelSelectionSetting(nextSelected, defaultModelForActiveMode || modelId)
    setManualModelInput('')
  }, [defaultModelForActiveMode, manualModelInput, selectedModelsForActiveMode, updateModelSelectionSetting])

  const handleFetchModels = useCallback(async () => {
    if (!effectiveActiveMode || isFetchingModels) return

    setFetchingModelEngine(activeEngine)
    setModelFetchErrorByEngine((current) => ({ ...current, [activeEngine]: null }))

    try {
      const result = await getAppAPI()['provider:list-models'](activeEngine)
      setFetchedModelResultByEngine((current) => ({ ...current, [activeEngine]: result }))
      if (result.models.length === 0) {
        setModelFetchErrorByEngine((current) => ({
          ...current,
          [activeEngine]: t('provider.modelFetch.empty'),
        }))
      }
    } catch (eventError) {
      setModelFetchErrorByEngine((current) => ({
        ...current,
        [activeEngine]: eventError instanceof Error ? eventError.message : String(eventError),
      }))
    } finally {
      setFetchingModelEngine((current) => (current === activeEngine ? null : current))
    }
  }, [activeEngine, effectiveActiveMode, isFetchingModels, t])

  const handleDefaultReasoningEffortChange = useCallback((nextValue: CodexReasoningEffort) => {
    if (activeEngine !== 'codex') return
    updateSettings({
      ...settings,
      provider: {
        ...settings.provider,
        byEngine: {
          ...settings.provider.byEngine,
          codex: {
            ...(settings.provider.byEngine.codex ?? { activeMode: null }),
            defaultReasoningEffort: nextValue,
          },
        },
      },
    })
  }, [activeEngine, settings, updateSettings])

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-1">{t('provider.title')}</h3>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('provider.description')}</p>
      </div>

      <section className="rounded-lg bg-[hsl(var(--foreground)/0.03)] p-4">
        <label className="block text-sm font-medium mb-1">{t('provider.defaultEngine')}</label>
        <DefaultEngineSelect
          value={defaultEngine}
          statusByEngine={providerStatusByEngine}
          onChange={handleDefaultEngineChange}
        />
        <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">{t('provider.defaultEngineHint')}</p>
      </section>

      <section className="space-y-3">
        <div>
          <h4 className="text-sm font-medium">{t('provider.overview.title')}</h4>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('provider.overview.description')}</p>
        </div>

        <Tabs value={activeEngine} onValueChange={handleTabValueChange} className="space-y-3">
          <TabsList className="grid grid-cols-1 md:grid-cols-2 gap-2" ariaLabel={t('provider.overview.title')}>
            {ENGINE_TABS.map((engine) => (
              <TabsTrigger
                key={`overview-tab-${engine.kind}`}
                value={engine.kind}
                className="rounded-md px-3 py-2 text-left transition-colors"
                activeClassName="bg-[hsl(var(--primary)/0.10)]"
                inactiveClassName="bg-[hsl(var(--foreground)/0.03)] hover:bg-[hsl(var(--foreground)/0.05)]"
              >
                <EngineTabPreview
                  engineKind={engine.kind}
                  labelKey={engine.labelKey}
                  isDefault={defaultEngine === engine.kind}
                  status={providerStatusByEngine[engine.kind]}
                  activeMode={providerByEngine[engine.kind]?.activeMode ?? null}
                  defaultModel={providerByEngine[engine.kind]?.defaultModel}
                />
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value={activeEngine} className="rounded-lg bg-[hsl(var(--foreground)/0.03)] p-4">
            <h5 className="mb-4 text-sm font-medium">{t(`provider.configTitles.${activeEngine}`)}</h5>

            <section className="rounded-lg bg-[hsl(var(--background))] p-4">
              <StepHeader
                step={1}
                title={t('provider.steps.modeCredential.title')}
                description={t('provider.steps.modeCredential.description')}
              />
              <ModeCredentialStep
                engineKind={activeEngine}
                providerModes={providerModes}
                activeMode={activeMode}
                effectiveActiveMode={effectiveActiveMode}
                modeSupported={modeSupportedForActiveEngine}
                onModeSelect={handleModeSelect}
                credential={{
                  state: {
                    checkingStatus,
                    isAuthenticated: Boolean(isAuthenticated),
                    isAuthenticating: Boolean(isAuthenticating),
                    isEditing,
                    status: activeEngineStatus,
                    initialValues: editValues,
                  },
                  actions: {
                    onLogin: handleLogin,
                    onLogout: handleLogout,
                    onCancelLogin: handleCancelLogin,
                    onStartEditing: handleStartEditing,
                    onCancelEditing: resetTransientState,
                  },
                }}
              />
            </section>

            <section className="mt-4 rounded-lg bg-[hsl(var(--background))] p-4">
              <StepHeader
                step={2}
                title={t('provider.steps.model.title')}
                description={t('provider.steps.model.description')}
              />
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1">
                    <label className="block text-sm font-medium mb-1">
                      {t('provider.defaultModel')}
                      <span className="ml-1.5 text-xs font-normal text-[hsl(var(--muted-foreground))]">{t('provider.optional')}</span>
                    </label>
                    <select
                      disabled={!effectiveActiveMode || selectedModelsForActiveMode.length === 0}
                      value={defaultModelForActiveMode}
                      onChange={(event) => handleDefaultModelSelect(event.target.value)}
                      className={cn(
                        'w-full rounded-md border bg-[hsl(var(--background))] pl-3 pr-8 py-1.5 text-sm outline-none font-mono',
                        'focus:ring-2 focus:ring-[hsl(var(--ring))]',
                        'border-[hsl(var(--border))]',
                        (!effectiveActiveMode || selectedModelsForActiveMode.length === 0) && 'opacity-60 cursor-not-allowed',
                      )}
                    >
                      {selectedModelsForActiveMode.length === 0 ? (
                        <option value="">{t('provider.modelSelection.noSelected')}</option>
                      ) : (
                        selectedModelsForActiveMode.map((model) => (
                          <option key={`default-${activeEngine}-${model.id}`} value={model.id}>
                            {model.displayName ? `${model.displayName} (${model.id})` : model.id}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleFetchModels()}
                    disabled={!effectiveActiveMode || isFetchingModels}
                    title={t('provider.modelFetch.button')}
                    className={cn(
                      'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors',
                      'border-[hsl(var(--border))] hover:bg-[hsl(var(--foreground)/0.04)]',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                  >
                    {isFetchingModels ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>{isFetchingModels ? t('provider.modelFetch.loading') : t('provider.modelFetch.button')}</span>
                  </button>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">{t('provider.modelSelection.manualLabel')}</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      disabled={!effectiveActiveMode}
                      value={manualModelInput}
                      onChange={(event) => setManualModelInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') handleAddManualModel()
                      }}
                      placeholder={t('provider.defaultModelPlaceholder')}
                      className={cn(
                        'min-w-0 flex-1 rounded-md border bg-[hsl(var(--background))] px-3 py-1.5 text-sm outline-none font-mono',
                        'focus:ring-2 focus:ring-[hsl(var(--ring))]',
                        'border-[hsl(var(--border))]',
                        !effectiveActiveMode && 'opacity-60 cursor-not-allowed',
                      )}
                    />
                    <button
                      type="button"
                      onClick={handleAddManualModel}
                      disabled={!effectiveActiveMode || !manualModelInput.trim()}
                      className={cn(
                        'inline-flex h-9 shrink-0 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors',
                        'border-[hsl(var(--border))] hover:bg-[hsl(var(--foreground)/0.04)]',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                      )}
                      aria-label={t('provider.modelSelection.addManual')}
                      title={t('provider.modelSelection.addManual')}
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div>
                  <p className="mb-1.5 text-xs font-medium text-[hsl(var(--muted-foreground))]">
                    {t('provider.modelSelection.selectedLabel', { count: selectedModelsForActiveMode.length })}
                  </p>
                  {selectedModelsForActiveMode.length === 0 ? (
                    <p className="rounded-md border border-dashed border-[hsl(var(--border))] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">
                      {effectiveActiveMode ? t('provider.modelSelection.emptySelected') : t('provider.steps.model.empty')}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {selectedModelsForActiveMode.map((model) => (
                        <span
                          key={`selected-${activeEngine}-${model.id}`}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--foreground)/0.03)] px-2 py-1 text-xs"
                        >
                          <span className="min-w-0 truncate font-mono">
                            {model.displayName ? `${model.displayName} (${model.id})` : model.id}
                          </span>
                          {defaultModelForActiveMode === model.id && (
                            <span className="rounded bg-[hsl(var(--primary)/0.12)] px-1 text-[10px] text-[hsl(var(--primary))]">
                              {t('provider.modelSelection.defaultBadge')}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRemoveSelectedModel(model.id)}
                            className="rounded p-0.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--foreground)/0.08)] hover:text-[hsl(var(--foreground))]"
                            aria-label={t('provider.modelSelection.removeModel', { model: model.id })}
                            title={t('provider.modelSelection.removeModel', { model: model.id })}
                          >
                            <X className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {fetchedModelsForActiveEngine.length > 0 && (
                  <div className="rounded-md border border-[hsl(var(--border))]">
                    <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2">
                      <p className="text-xs font-medium">
                        {t('provider.modelFetch.selectPlaceholder', { count: fetchedModelsForActiveEngine.length })}
                      </p>
                      {fetchedSourceUrl && (
                        <p className="max-w-[50%] truncate text-[10px] text-[hsl(var(--muted-foreground))]" title={fetchedSourceUrl}>
                          {fetchedSourceUrl}
                        </p>
                      )}
                    </div>
                    <div className="max-h-48 overflow-y-auto p-1.5">
                      {fetchedModelsForActiveEngine.map((model) => (
                        <label
                          key={`fetched-${activeEngine}-${model.id}`}
                          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-[hsl(var(--foreground)/0.04)]"
                        >
                          <input
                            type="checkbox"
                            checked={selectedModelIdsForActiveMode.has(model.id)}
                            onChange={(event) => handleToggleFetchedModel(model, event.target.checked)}
                            className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                          />
                          <span className="min-w-0 flex-1 truncate font-mono">
                            {model.displayName ? `${model.displayName} (${model.id})` : model.id}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <p className="mt-1.5 text-xs text-[hsl(var(--muted-foreground))]">
                {effectiveActiveMode ? t('provider.defaultModelHint') : t('provider.steps.model.empty')}
              </p>
              {modelFetchError && (
                <p className="mt-1.5 text-xs text-red-400">{modelFetchError}</p>
              )}

              {activeEngine === 'codex' && (
                <div className="mt-4">
                  <label className="block text-sm font-medium mb-1">
                    {t('provider.defaultReasoningEffort')}
                  </label>
                  <select
                    disabled={!effectiveActiveMode}
                    value={activeEngineConfig.defaultReasoningEffort ?? 'high'}
                    onChange={(event) => handleDefaultReasoningEffortChange(event.target.value as CodexReasoningEffort)}
                    className={cn(
                      'w-full rounded-md border bg-[hsl(var(--background))] px-3 py-1.5 text-sm outline-none',
                      'focus:ring-2 focus:ring-[hsl(var(--ring))]',
                      'border-[hsl(var(--border))]',
                      !effectiveActiveMode && 'opacity-60 cursor-not-allowed',
                    )}
                  >
                    {CODEX_REASONING_EFFORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-xs text-[hsl(var(--muted-foreground))]">
                    {effectiveActiveMode ? t('provider.defaultReasoningEffortHint') : t('provider.steps.model.empty')}
                  </p>
                </div>
              )}
            </section>

            {checkingStatus && (
              <div className="mt-4 flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {t('provider.status.checking')}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </section>

      <BackgroundModelSection settings={settings} updateSettings={updateSettings} />

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
    </div>
  )
}
