// SPDX-License-Identifier: Apache-2.0

import type {
  AIEngineKind,
  AppSettings,
  ProviderModelChoice,
  SessionSnapshot,
  SetSessionModelInput,
} from '@shared/types'

export interface ChatModelOption {
  engineKind: AIEngineKind
  model: string
  label: string
  source?: ProviderModelChoice['source']
  isDefault?: boolean
}

const ENGINE_ORDER: readonly AIEngineKind[] = ['claude', 'codex']

function modelLabel(model: ProviderModelChoice): string {
  const displayName = model.displayName?.trim()
  return displayName ? `${displayName} (${model.id})` : model.id
}

function normalizeSelectedModels(models: ProviderModelChoice[] | undefined): ProviderModelChoice[] {
  const seen = new Set<string>()
  const result: ProviderModelChoice[] = []
  for (const model of models ?? []) {
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

export function buildChatModelOptions(settings: AppSettings | null): ChatModelOption[] {
  if (!settings) return []

  const options: ChatModelOption[] = []
  for (const engineKind of ENGINE_ORDER) {
    const engineSettings = settings.provider.byEngine[engineKind]
    const activeMode = engineSettings.activeMode
    const modeSettings = activeMode ? engineSettings.modelSelectionsByMode?.[activeMode] : undefined
    const selectedModels = normalizeSelectedModels(
      modeSettings?.selectedModels?.length
        ? modeSettings.selectedModels
        : engineSettings.defaultModel
          ? [{ id: engineSettings.defaultModel, source: 'legacy' }]
          : [],
    )
    const defaultModel = modeSettings?.defaultModel?.trim() || engineSettings.defaultModel?.trim()

    for (const model of selectedModels) {
      options.push({
        engineKind,
        model: model.id,
        label: modelLabel(model),
        source: model.source,
        isDefault: Boolean(defaultModel && defaultModel === model.id),
      })
    }
  }

  return options
}

export function hasChatModelOption(
  options: readonly ChatModelOption[],
  selection: SetSessionModelInput | null | undefined,
): boolean {
  if (!selection?.model) return false
  return options.some(
    (option) => option.engineKind === selection.engineKind && option.model === selection.model,
  )
}

export function resolveDefaultChatModelSelection(
  settings: AppSettings | null,
  options: readonly ChatModelOption[],
): SetSessionModelInput | null {
  if (options.length === 0) return null
  const defaultEngine = settings?.command.defaultEngine ?? 'claude'
  const engineDefault = options.find((option) => option.engineKind === defaultEngine && option.isDefault)
  const engineFirst = options.find((option) => option.engineKind === defaultEngine)
  const option = engineDefault ?? engineFirst ?? options[0]
  return { engineKind: option.engineKind, model: option.model }
}

export function resolveSessionChatModelSelection(
  session: SessionSnapshot,
  settings: AppSettings | null,
  options: readonly ChatModelOption[],
): SetSessionModelInput | null {
  if (options.length === 0) return null

  const engineKind = session.desiredEngineKind ?? session.engineKind
  const desiredModel = session.desiredModel?.trim() || undefined
  if (desiredModel) return { engineKind, model: desiredModel }

  const observedModel = session.model?.trim()
  if (observedModel && options.some((option) => option.engineKind === engineKind && option.model === observedModel)) {
    return { engineKind, model: observedModel }
  }

  const engineSettings = settings?.provider.byEngine[engineKind]
  const activeMode = engineSettings?.activeMode
  const modeDefault = activeMode ? engineSettings?.modelSelectionsByMode?.[activeMode]?.defaultModel?.trim() : undefined
  const defaultModel = modeDefault || engineSettings?.defaultModel?.trim()
  if (defaultModel && options.some((option) => option.engineKind === engineKind && option.model === defaultModel)) {
    return { engineKind, model: defaultModel }
  }

  const firstForEngine = options.find((option) => option.engineKind === engineKind)
  if (firstForEngine) return { engineKind, model: firstForEngine.model }

  const fallback = options[0]
  return { engineKind: fallback.engineKind, model: fallback.model }
}
