// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react'
import { Brain, Check, ChevronDown } from 'lucide-react'
import { PillDropdown } from '@/components/ui/PillDropdown'
import { cn } from '@/lib/utils'
import type { CodexReasoningEffort } from '@shared/types'

export interface ReasoningEffortSwitcherProps {
  value: CodexReasoningEffort | null
  globalDefault: CodexReasoningEffort
  onChange: (effort: CodexReasoningEffort | null) => void
  disabled?: boolean
  size?: 'sm' | 'md'
  dropdownPosition?: 'above' | 'below'
  className?: string
}

interface EffortOption {
  value: CodexReasoningEffort | null
  label: string
}

const EFFORT_OPTIONS: EffortOption[] = [
  { value: null, label: 'Default' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
]

export function ReasoningEffortSwitcher({
  value,
  globalDefault,
  onChange,
  disabled = false,
  size = 'md',
  dropdownPosition = 'below',
  className,
}: ReasoningEffortSwitcherProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const displayLabel = value ?? globalDefault

  const handleSelect = useCallback(
    (effort: CodexReasoningEffort | null) => {
      onChange(effort)
      setOpen(false)
    },
    [onChange],
  )

  return (
    <PillDropdown
      open={open}
      onOpenChange={setOpen}
      position={dropdownPosition}
      align="left"
      className={className}
      dropdownClassName="w-[min(200px,calc(100vw-24px))]"
      trigger={
        <button
          type="button"
          onClick={() => !disabled && setOpen((v) => !v)}
          disabled={disabled}
          aria-label="Reasoning effort"
          aria-haspopup="listbox"
          aria-expanded={open}
          title={`Reasoning effort: ${displayLabel}`}
          className={cn(
            'inline-flex min-w-0 items-center gap-1.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--muted-foreground))] transition-colors',
            'hover:bg-[hsl(var(--foreground)/0.04)] hover:text-[hsl(var(--foreground))]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            size === 'sm' ? 'h-6 max-w-[120px] px-1.5 text-[11px]' : 'h-7 max-w-[160px] px-2 text-xs',
          )}
        >
          <Brain className={cn('shrink-0', size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5')} aria-hidden="true" />
          <span className="min-w-0 truncate font-mono">{displayLabel}</span>
          <ChevronDown className={cn('shrink-0', size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5')} aria-hidden="true" />
        </button>
      }
    >
      <div role="listbox" aria-label="Reasoning effort">
        <p className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground)/0.7)]">
          Reasoning Effort
        </p>
        {EFFORT_OPTIONS.map((option) => {
          const active = option.value === value
          const label = option.value === null ? `Default (${globalDefault})` : option.label
          return (
            <button
              key={option.value ?? 'default'}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => handleSelect(option.value)}
              className={cn(
                'flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[hsl(var(--ring))]',
                active
                  ? 'bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--foreground))]'
                  : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--foreground)/0.04)] hover:text-[hsl(var(--foreground))]',
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
              {active && <Check className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--primary))]" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
    </PillDropdown>
  )
}
