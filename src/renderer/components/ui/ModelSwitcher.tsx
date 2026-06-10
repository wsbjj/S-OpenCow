// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Cpu } from 'lucide-react'
import { PillDropdown } from '@/components/ui/PillDropdown'
import { cn } from '@/lib/utils'
import type { AIEngineKind, SetSessionModelInput } from '@shared/types'
import type { ChatModelOption } from '@/lib/chatModelOptions'

export interface ModelSwitcherProps {
  value: SetSessionModelInput | null
  options: ChatModelOption[]
  onChange: (selection: SetSessionModelInput) => void
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
}

const ENGINE_ORDER: readonly AIEngineKind[] = ['claude', 'codex']

function optionKey(option: ChatModelOption): string {
  return `${option.engineKind}:${option.model}`
}

function selectionKey(selection: SetSessionModelInput | null): string | null {
  return selection?.model ? `${selection.engineKind}:${selection.model}` : null
}

export function ModelSwitcher({
  value,
  options,
  onChange,
  disabled = false,
  size = 'md',
  className,
}: ModelSwitcherProps): React.JSX.Element | null {
  const { t } = useTranslation('sessions')
  const [open, setOpen] = useState(false)
  const selectedKey = selectionKey(value)
  const selectedOption = options.find((option) => optionKey(option) === selectedKey) ?? null
  const isDisabled = disabled || options.length === 0

  const groupedOptions = useMemo(
    () =>
      ENGINE_ORDER.map((engineKind) => ({
        engineKind,
        options: options.filter((option) => option.engineKind === engineKind),
      })).filter((group) => group.options.length > 0),
    [options],
  )

  const handleSelect = useCallback(
    (option: ChatModelOption) => {
      onChange({ engineKind: option.engineKind, model: option.model })
      setOpen(false)
    },
    [onChange],
  )

  if (options.length === 0) return null

  return (
    <PillDropdown
      open={open}
      onOpenChange={setOpen}
      position="below"
      align="left"
      className={className}
      dropdownClassName="w-[min(340px,calc(100vw-24px))]"
      trigger={
        <button
          type="button"
          onClick={() => !isDisabled && setOpen((v) => !v)}
          disabled={isDisabled}
          aria-label={t('modelSwitcher.aria')}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={selectedOption?.label ?? t('modelSwitcher.aria')}
          className={cn(
            'inline-flex min-w-0 items-center gap-1.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--muted-foreground))] transition-colors',
            'hover:bg-[hsl(var(--foreground)/0.04)] hover:text-[hsl(var(--foreground))]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            size === 'sm' ? 'h-6 max-w-[150px] px-1.5 text-[11px]' : 'h-7 max-w-[220px] px-2 text-xs',
          )}
        >
          <Cpu className={cn('shrink-0', size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5')} aria-hidden="true" />
          <span className="min-w-0 truncate font-mono">
            {selectedOption?.label ?? value?.model ?? t('modelSwitcher.fallback')}
          </span>
          <ChevronDown className={cn('shrink-0', size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5')} aria-hidden="true" />
        </button>
      }
    >
      <div role="listbox" aria-label={t('modelSwitcher.aria')}>
        {groupedOptions.map((group, groupIndex) => (
          <div key={group.engineKind}>
            {groupIndex > 0 && <div className="my-1 h-px bg-[hsl(var(--border))]" role="separator" />}
            <p className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground)/0.7)]">
              {t(`modelSwitcher.engines.${group.engineKind}`)}
            </p>
            {group.options.map((option) => {
              const active = optionKey(option) === selectedKey
              return (
                <button
                  key={optionKey(option)}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => handleSelect(option)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[hsl(var(--ring))]',
                    active
                      ? 'bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--foreground))]'
                      : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--foreground)/0.04)] hover:text-[hsl(var(--foreground))]',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{option.label}</span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--primary))]" aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </PillDropdown>
  )
}
