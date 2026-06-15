// SPDX-License-Identifier: Apache-2.0

import { useMemo, useRef } from 'react'
import type { Editor, Range } from '@tiptap/core'
import type { SuggestionOptions } from '@tiptap/suggestion'
import { useSlashCommands } from './useSlashCommands'
import { createSlashCommandRenderer } from '../extensions/slashCommandSuggestion'
import { filterSlashItems } from '@shared/slashItems'
import type { SlashItem } from '@shared/slashItems'
import type { AIEngineKind } from '@shared/types'
import { buildSlashMentionInsertContent } from '../lib/slashMentionContent'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UseSlashSuggestionReturn {
  /** TipTap Suggestion config — pass directly to `usePlainTextEditor({ slashSuggestion })` */
  suggestion: Omit<SuggestionOptions<SlashItem, SlashItem>, 'editor'>
  /** All available slash items (for click-triggered popover with its own search) */
  allItems: SlashItem[]
  /** Whether the Capability Center snapshot is still loading */
  loading: boolean
}

export interface UseSlashSuggestionOptions {
  engineKind?: AIEngineKind
  /** Called when a slash item with a nativeAction is selected. Receives the item. */
  onNativeAction?: (item: SlashItem) => void
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * Provides a reusable TipTap slash command suggestion configuration.
 *
 * Encapsulates:
 * - Data source (`useSlashCommands` → Capability Center snapshot)
 * - Renderer (tippy.js popup via `createSlashCommandRenderer`)
 * - Suggestion config (char, items filter, command handler)
 *
 * Used by `useMessageComposer` (Console) and `useNoteEditor` (Notes) to
 * avoid duplicating slash command setup logic.
 */
export function useSlashSuggestion(options?: UseSlashSuggestionOptions): UseSlashSuggestionReturn {
  const slash = useSlashCommands(options?.engineKind ?? 'claude')

  // Stable renderer reference — created once per hook instance
  const rendererRef = useRef(createSlashCommandRenderer())

  // Ref for latest items — allows the stable `items` callback to read fresh data
  const itemsRef = useRef(slash.allItems)
  itemsRef.current = slash.allItems

  // Ref for latest onNativeAction — allows the stable `command` callback to call
  // the latest handler without adding it to the useMemo dependency array
  const onNativeActionRef = useRef(options?.onNativeAction)
  onNativeActionRef.current = options?.onNativeAction

  const suggestion = useMemo(
    () => ({
      char: '/',
      allowSpaces: false,
      startOfLine: false,
      items: ({ query }: { query: string }) => filterSlashItems(itemsRef.current, query),
      render: rendererRef.current,
      command: ({ editor, range, props: item }: { editor: Editor; range: Range; props: SlashItem }) => {
        if (item.nativeAction && onNativeActionRef.current) {
          editor.chain().focus().deleteRange(range).run()
          onNativeActionRef.current(item)
          return
        }
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent(buildSlashMentionInsertContent(item))
          .run()
      },
    }),
    [] // stable — uses refs for mutable data
  )

  return { suggestion, allItems: slash.allItems, loading: slash.loading }
}
