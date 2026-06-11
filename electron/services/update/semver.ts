// SPDX-License-Identifier: Apache-2.0

/**
 * semver — Lightweight semantic version parsing and comparison.
 *
 * Zero dependencies. Handles the subset of semver used by GitHub Release tags:
 *   - "0.3.0", "v0.3.0", "v1.2.3-beta.1"
 *   - Pre-release suffixes participate in same-core comparison
 *
 * @module
 */

export interface SemVer {
  major: number
  minor: number
  patch: number
  prerelease: string | null
}

/** Parse a version string like "0.3.0" or "v0.3.0" into components. */
export function parseSemVer(version: string): SemVer | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  }
}

/**
 * Compare semantic versions.
 * Returns positive when `a` is newer, negative when `b` is newer, and 0 when equal.
 */
export function compareSemVer(a: string, b: string): number {
  const left = parseSemVer(a)
  const right = parseSemVer(b)
  if (!left || !right) return 0

  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch

  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  return left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true })
}

/** Returns true if `remote` is strictly newer than `current`. */
export function isNewerVersion(current: string, remote: string): boolean {
  if (!parseSemVer(current) || !parseSemVer(remote)) return false
  return compareSemVer(remote, current) > 0
}
