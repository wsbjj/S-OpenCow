// SPDX-License-Identifier: Apache-2.0

const RESPONSE_BODY_PREVIEW_LIMIT = 1_000

export interface ApiErrorLogContext {
  errorName?: string
  message?: string
  statusCode?: number
  url?: string
  responseBodyPreview?: string
}

export function toApiErrorLogContext(error: unknown): ApiErrorLogContext {
  if (!isRecord(error)) {
    return { message: String(error) }
  }

  const context: ApiErrorLogContext = {}
  const errorName = getString(error.name)
  const message = getString(error.message)
  const statusCode = getNumber(error.statusCode)
  const url = getString(error.url)
  const responseBody = getString(error.responseBody)

  if (errorName) context.errorName = errorName
  if (message) context.message = message
  if (statusCode !== undefined) context.statusCode = statusCode
  if (url) context.url = url
  if (responseBody) context.responseBodyPreview = truncateResponseBody(responseBody)

  return context
}

function truncateResponseBody(value: string): string {
  return value.length > RESPONSE_BODY_PREVIEW_LIMIT
    ? `${value.slice(0, RESPONSE_BODY_PREVIEW_LIMIT)}...`
    : value
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
