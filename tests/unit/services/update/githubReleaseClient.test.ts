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
  it('requests the wsbjj/S-OpenCow releases list endpoint', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse([
        {
          tag_name: 'v0.4.0',
          html_url: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.4.0',
          body: 'Release notes',
          published_at: '2026-03-26T00:00:00Z',
          prerelease: false,
          draft: false,
          assets: [],
        },
      ]),
    ) as unknown as typeof globalThis.fetch

    await fetchLatestRelease(fetchFn)

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/repos/wsbjj/S-OpenCow/releases?per_page=20',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
        }),
      }),
    )
  })

  it('maps GitHub release payload fields into release info', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse([
        {
          tag_name: 'v0.4.0',
          html_url: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.4.0',
          body: 'Release notes',
          published_at: '2026-03-26T00:00:00Z',
          prerelease: false,
          draft: false,
          assets: [
            {
              name: 'S-OpenCow-0.4.0.exe',
              browser_download_url: 'https://github.com/wsbjj/S-OpenCow/releases/download/v0.4.0/S-OpenCow-0.4.0.exe',
              size: 1024,
              content_type: 'application/octet-stream',
            },
          ],
        },
      ]),
    ) as unknown as typeof globalThis.fetch

    const release = await fetchLatestRelease(fetchFn)

    expect(release).toEqual({
      version: '0.4.0',
      tagName: 'v0.4.0',
      htmlUrl: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.4.0',
      body: 'Release notes',
      publishedAt: '2026-03-26T00:00:00Z',
      prerelease: false,
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

  it('returns a prerelease when it is the latest available version', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse([
        {
          tag_name: 'v0.3.23-dev',
          html_url: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.3.23-dev',
          body: 'Unsigned test build',
          published_at: '2026-06-10T11:06:31Z',
          prerelease: true,
          draft: false,
          assets: [],
        },
      ]),
    ) as unknown as typeof globalThis.fetch

    const release = await fetchLatestRelease(fetchFn)

    expect(release).toMatchObject({
      version: '0.3.23-dev',
      tagName: 'v0.3.23-dev',
      prerelease: true,
    })
  })

  it('skips draft releases', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse([
        {
          tag_name: 'v9.9.9',
          html_url: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v9.9.9',
          body: 'Draft',
          published_at: '2026-06-11T00:00:00Z',
          prerelease: false,
          draft: true,
          assets: [],
        },
        {
          tag_name: 'v0.3.23-dev',
          html_url: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.3.23-dev',
          body: 'Pre-release',
          published_at: '2026-06-10T11:06:31Z',
          prerelease: true,
          draft: false,
          assets: [],
        },
      ]),
    ) as unknown as typeof globalThis.fetch

    const release = await fetchLatestRelease(fetchFn)

    expect(release?.version).toBe('0.3.23-dev')
  })

  it('selects the highest semantic version from valid releases', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse([
        {
          tag_name: 'v0.3.22-dev',
          html_url: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.3.22-dev',
          body: 'Older',
          published_at: '2026-06-10T05:00:21Z',
          prerelease: true,
          draft: false,
          assets: [],
        },
        {
          tag_name: 'v0.3.23-dev',
          html_url: 'https://github.com/wsbjj/S-OpenCow/releases/tag/v0.3.23-dev',
          body: 'Newer',
          published_at: '2026-06-10T11:06:31Z',
          prerelease: true,
          draft: false,
          assets: [],
        },
        {
          tag_name: 'not-a-version',
          html_url: 'https://github.com/wsbjj/S-OpenCow/releases/tag/not-a-version',
          body: 'Invalid',
          published_at: '2026-06-11T00:00:00Z',
          prerelease: false,
          draft: false,
          assets: [],
        },
      ]),
    ) as unknown as typeof globalThis.fetch

    const release = await fetchLatestRelease(fetchFn)

    expect(release?.version).toBe('0.3.23-dev')
  })

  it('returns null when the response is not a release list', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        tag_name: 'v0.4.0',
      }),
    ) as unknown as typeof globalThis.fetch

    await expect(fetchLatestRelease(fetchFn)).resolves.toBeNull()
  })

  it('returns null when all releases have invalid tags', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse([
        {
          tag_name: 'not-a-version',
          draft: false,
          prerelease: false,
          assets: [],
        },
      ]),
    ) as unknown as typeof globalThis.fetch

    await expect(fetchLatestRelease(fetchFn)).resolves.toBeNull()
  })

  it('returns null on network errors', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('Network error')
    }) as unknown as typeof globalThis.fetch

    await expect(fetchLatestRelease(fetchFn)).resolves.toBeNull()
  })
})
