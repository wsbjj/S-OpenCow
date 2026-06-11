// SPDX-License-Identifier: Apache-2.0

/**
 * githubReleaseClient — Fetches the latest detectable GitHub Release.
 *
 * Responsibilities:
 *   - HTTP request with timeout and abort handling
 *   - JSON response parsing and validation
 *   - GitHub API authentication headers
 *
 * This module has NO scheduling, version comparison, or UI dispatch logic.
 *
 * @module
 */

import { createLogger } from '../../platform/logger'
import { compareSemVer, parseSemVer } from './semver'
import type { ReleaseInfo, ReleaseAsset } from './releaseTypes'

const log = createLogger('GitHubReleaseClient')

// ─── Constants ──────────────────────────────────────────────────────

const GITHUB_OWNER = 'wsbjj'
const GITHUB_REPO = 'S-OpenCow'
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`
const REQUEST_TIMEOUT_MS = 15_000

// ─── GitHub API Headers ─────────────────────────────────────────────

/**
 * Build GitHub API request headers.
 *
 * Self-contained — does NOT import from marketplace utilities.
 * The update checker only needs public read access to Releases;
 * no PAT token is required (public repo).
 */
function buildGitHubHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

// ─── Client ─────────────────────────────────────────────────────────

/**
 * Fetch the highest-version non-draft GitHub Release, including prereleases.
 * Returns null on network error or if the response is invalid.
 */
export async function fetchLatestRelease(
  fetchFn: typeof globalThis.fetch,
): Promise<ReleaseInfo | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetchFn(RELEASES_URL, {
      headers: buildGitHubHeaders(),
      signal: controller.signal,
    })

    if (!response.ok) {
      log.warn(`GitHub API responded with ${response.status} ${response.statusText}`)
      return null
    }

    const data = await response.json()
    if (!Array.isArray(data)) {
      log.warn('GitHub API response was not a release list')
      return null
    }

    const releases = data
      .map((item) => mapReleaseInfo(item as Record<string, unknown>))
      .filter((release): release is ReleaseInfo => release !== null)

    if (releases.length === 0) {
      log.warn('No valid releases found in GitHub API response')
      return null
    }

    return releases.reduce((best, release) =>
      compareSemVer(release.version, best.version) > 0 ? release : best,
    )
  } catch (err) {
    // Silently handle network errors — update check is best-effort
    if (err instanceof Error && err.name === 'AbortError') {
      log.warn('GitHub API request timed out')
    } else {
      log.warn('Failed to fetch latest release', err)
    }
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

function mapReleaseInfo(data: Record<string, unknown>): ReleaseInfo | null {
  if (data.draft === true) return null

  const tagName = typeof data.tag_name === 'string' ? data.tag_name : ''
  const version = tagName.replace(/^v/, '')

  if (!parseSemVer(version)) {
    log.warn(`Invalid tag version: ${tagName}`)
    return null
  }

  const assets: ReleaseAsset[] = Array.isArray(data.assets)
    ? (data.assets as Record<string, unknown>[]).map((a) => ({
        name: String(a.name ?? ''),
        downloadUrl: String(a.browser_download_url ?? ''),
        size: Number(a.size ?? 0),
        contentType: String(a.content_type ?? ''),
      }))
    : []

  return {
    version,
    tagName,
    htmlUrl: String(data.html_url ?? ''),
    body: String(data.body ?? ''),
    publishedAt: String(data.published_at ?? ''),
    prerelease: data.prerelease === true,
    assets,
  }
}
