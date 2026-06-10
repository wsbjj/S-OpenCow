// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'
import { fetchLatestRelease } from '../../../../electron/services/update/githubReleaseClient'

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
  } as Response
}

describe('fetchLatestRelease', () => {
  it('requests the wsbjj/S-OpenCow latest release endpoint', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        tag_name: 'v0.4.0',
        html_url: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.4.0',
        body: 'Release notes',
        published_at: '2026-03-26T00:00:00Z',
        assets: [],
      }),
    ) as unknown as typeof globalThis.fetch

    await fetchLatestRelease(fetchFn)

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/repos/wsbjj/S-OpenCow/releases/latest',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
        }),
      }),
    )
  })

  it('maps GitHub release payload fields into release info', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        tag_name: 'v0.4.0',
        html_url: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.4.0',
        body: 'Release notes',
        published_at: '2026-03-26T00:00:00Z',
        assets: [
          {
            name: 'S-OpenCow-0.4.0.exe',
            browser_download_url: 'https://github.com/wsbjj/S-OpenCow/releases/download/v0.4.0/S-OpenCow-0.4.0.exe',
            size: 1024,
            content_type: 'application/octet-stream',
          },
        ],
      }),
    ) as unknown as typeof globalThis.fetch

    const release = await fetchLatestRelease(fetchFn)

    expect(release).toEqual({
      version: '0.4.0',
      tagName: 'v0.4.0',
      htmlUrl: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.4.0',
      body: 'Release notes',
      publishedAt: '2026-03-26T00:00:00Z',
      assets: [
        {
          name: 'S-OpenCow-0.4.0.exe',
          downloadUrl: 'https://github.com/wsbjj/S-OpenCow/releases/download/v0.4.0/S-OpenCow-0.4.0.exe',
          size: 1024,
          contentType: 'application/octet-stream',
        },
      ],
    })
  })
})
