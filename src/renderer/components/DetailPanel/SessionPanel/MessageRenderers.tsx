// SPDX-License-Identifier: Apache-2.0

/**
 * MessageRenderers — User message components for both CLI and chat variants.
 *
 * Extracted from SessionMessageList.tsx for single-responsibility:
 * these components handle pure rendering of user messages with no
 * scroll, virtualization, or data pipeline concerns.
 */

import { memo } from 'react'
import { PencilLine, RotateCcw, UserRound } from 'lucide-react'
import { LinkifiedText } from '@/components/ui/LinkifiedText'
import { ContentBlockRenderer } from './ContentBlockRenderer'
import { MessageCopyButton } from './MessageCopyButton'
import { ContextFileChips } from '@/components/ui/ContextFileChips'
import { parseContextFiles } from '@/lib/contextFilesParsing'
import { getSlashDisplayLabel } from '@shared/slashDisplay'
import { extractUserText, getUserMessageDisplayInfo } from './messageDisplayUtils'
import type { ContentBlock, SlashCommandBlock, UserMessageContent } from '@shared/types'

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function UserTextWithContext({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const { files, rest } = parseContextFiles(text)
  return (
    <>
      {files.length > 0 && (
        <div className="mb-1">
          <ContextFileChips files={files} />
        </div>
      )}
      {rest.trim() && <LinkifiedText text={rest} className={className} />}
    </>
  )
}

function SlashCommandChip({ block }: { block: SlashCommandBlock }): React.JSX.Element {
  const label = getSlashDisplayLabel(block)
  return (
    <span className="slash-mention" role="img" aria-label={`Slash command: ${label}`}>
      /{label}
    </span>
  )
}

type UserMessageContentBlock = Exclude<UserMessageContent, string>[number]

function toUserMessageContent(content: ContentBlock[]): UserMessageContent {
  const blocks: UserMessageContentBlock[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        blocks.push({ type: 'text', text: block.text })
        break
      case 'image':
        blocks.push({
          type: 'image',
          mediaType: block.mediaType,
          data: block.data,
          sizeBytes: block.sizeBytes,
        })
        break
      case 'document':
        blocks.push({
          type: 'document',
          mediaType: block.mediaType,
          data: block.data,
          sizeBytes: block.sizeBytes,
          title: block.title,
        })
        break
      case 'slash_command':
        blocks.push({
          type: 'slash_command',
          name: block.name,
          category: block.category,
          label: block.label,
          ...(block.execution ? { execution: block.execution } : {}),
          expandedText: block.expandedText,
        })
        break
    }
  }
  return blocks
}

function MessageActionButton({
  ariaLabel,
  onClick,
  children,
}: {
  ariaLabel: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element | null {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] opacity-80 transition hover:bg-[hsl(var(--foreground)/0.06)] hover:text-[hsl(var(--foreground))] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
    >
      {children}
    </button>
  )
}

function MessageActions({
  ariaLabel,
  text,
  content,
  align = 'start',
  onEdit,
  onResend,
}: {
  ariaLabel: string
  text: string
  content: UserMessageContent
  align?: 'start' | 'end'
  onEdit?: (content: UserMessageContent) => void
  onResend?: (content: UserMessageContent) => void
}): React.JSX.Element | null {
  if (!text.trim() && !onEdit && !onResend) return null

  return (
    <div className={`mt-1 flex h-7 items-center gap-0.5 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      {onEdit && (
        <MessageActionButton ariaLabel="Edit user prompt" onClick={() => onEdit(content)}>
          <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />
        </MessageActionButton>
      )}
      {onResend && (
        <MessageActionButton ariaLabel="Resend user message" onClick={() => onResend(content)}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        </MessageActionButton>
      )}
      <MessageCopyButton ariaLabel={ariaLabel} text={text} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared rendering — deduplicates the image-grouping IIFE that was
// previously copy-pasted in UserMessage and ChatBubbleUserMessage.
// ---------------------------------------------------------------------------

function renderUserContentBlocks(
  content: ContentBlock[],
  textClassName?: string,
): React.ReactNode[] {
  const elements: React.ReactNode[] = []
  let imageGroup: React.ReactNode[] = []

  const flushImages = () => {
    if (imageGroup.length > 0) {
      elements.push(
        <div key={`img-group-${elements.length}`} className="flex flex-wrap gap-1.5 py-0.5">
          {imageGroup}
        </div>,
      )
      imageGroup = []
    }
  }

  content.forEach((block, i) => {
    if (block.type === 'image') {
      imageGroup.push(<ContentBlockRenderer key={i} block={block} />)
    } else {
      flushImages()
      if (block.type === 'text') elements.push(<UserTextWithContext key={i} text={block.text} className={textClassName} />)
      else if (block.type === 'slash_command') elements.push(<SlashCommandChip key={i} block={block} />)
      else if (block.type === 'document') elements.push(<div key={i} className="py-0.5"><ContentBlockRenderer block={block} /></div>)
    }
  })
  flushImages()

  return elements
}

// ---------------------------------------------------------------------------
// CLI variant — monospace with a compact user icon prefix
// ---------------------------------------------------------------------------

export const UserMessage = memo(function UserMessage({
  id,
  content,
  onEdit,
  onResend,
}: {
  id: string
  content: ContentBlock[]
  onEdit?: (content: UserMessageContent) => void
  onResend?: (content: UserMessageContent) => void
}) {
  const hasRichContent = content.some((b) => b.type === 'slash_command' || b.type === 'image' || b.type === 'document')
  const plainText = hasRichContent ? '' : extractUserText(content)
  const copyText = getUserMessageDisplayInfo(content).displayText ?? ''
  const actionContent = toUserMessageContent(content)

  return (
    <div data-msg-id={id} data-msg-role="user" className="relative flex gap-2 py-1 -ml-3 pl-3 before:absolute before:left-0 before:top-[6px] before:bottom-[6px] before:w-0.5 before:bg-[hsl(var(--primary)/0.2)]">
      <span
        data-testid="user-message-icon"
        className="mt-0.5 flex h-4 w-4 shrink-0 select-none items-center justify-center text-[hsl(var(--muted-foreground))]"
        role="img"
        aria-label="User message"
      >
        <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        {hasRichContent ? (
          <div className="text-sm font-mono text-[hsl(var(--foreground))] break-words min-w-0 leading-5">
            {renderUserContentBlocks(content)}
          </div>
        ) : (
          <>
            {plainText && (
              <div className="text-sm font-mono text-[hsl(var(--foreground))] break-words min-w-0 leading-5">
                <UserTextWithContext text={plainText} />
              </div>
            )}
          </>
        )}
        <MessageActions
          ariaLabel="Copy user message"
          text={copyText}
          content={actionContent}
          onEdit={onEdit}
          onResend={onResend}
        />
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Chat variant — right-aligned bubble
// ---------------------------------------------------------------------------

const CHAT_LINK_CLASS = '[&_a]:text-[hsl(var(--primary))] [&_a]:underline [&_a]:decoration-[hsl(var(--primary)/0.4)]'

export const ChatBubbleUserMessage = memo(function ChatBubbleUserMessage({
  id,
  content,
  onEdit,
  onResend,
}: {
  id: string
  content: ContentBlock[]
  onEdit?: (content: UserMessageContent) => void
  onResend?: (content: UserMessageContent) => void
}) {
  const hasRichContent = content.some((b) => b.type === 'slash_command' || b.type === 'image' || b.type === 'document')
  const plainText = hasRichContent ? '' : extractUserText(content)
  const copyText = getUserMessageDisplayInfo(content).displayText ?? ''
  const actionContent = toUserMessageContent(content)

  return (
    <div data-msg-id={id} data-msg-role="user" className="flex justify-end py-1.5">
      <div className="max-w-[80%] min-w-0">
        <div className="px-4 py-2.5 rounded-2xl bg-[hsl(var(--foreground)/0.06)] dark:bg-white/10 text-[hsl(var(--foreground))]">
          {hasRichContent ? (
            <div className="text-sm break-words min-w-0 leading-relaxed">
              {renderUserContentBlocks(content, CHAT_LINK_CLASS)}
            </div>
          ) : (
            <>
              {plainText && (
                <div className="text-sm break-words min-w-0 leading-relaxed">
                  <UserTextWithContext text={plainText} className={CHAT_LINK_CLASS} />
                </div>
              )}
            </>
          )}
        </div>
        <MessageActions
          ariaLabel="Copy user message"
          text={copyText}
          content={actionContent}
          align="end"
          onEdit={onEdit}
          onResend={onResend}
        />
      </div>
    </div>
  )
})
