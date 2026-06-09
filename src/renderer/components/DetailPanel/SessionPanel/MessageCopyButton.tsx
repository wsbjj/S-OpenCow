// SPDX-License-Identifier: Apache-2.0

import { Copy } from 'lucide-react'
import { getAppAPI } from '@/windowAPI'

interface MessageCopyButtonProps {
  ariaLabel: string
  text: string
}

export function MessageCopyButton({ ariaLabel, text }: MessageCopyButtonProps): React.JSX.Element | null {
  if (!text.trim()) return null

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={() => getAppAPI()['clipboard:write-text'](text)}
      className="shrink-0 rounded-md p-1 text-[hsl(var(--muted-foreground))] opacity-70 transition hover:bg-[hsl(var(--foreground)/0.06)] hover:text-[hsl(var(--foreground))] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
    >
      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  )
}
