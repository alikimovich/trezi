import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Trezi's version (LKM-143). package.json `version` is the one source (SemVer; before
 * 1.0 a minor release carries features or breaking changes, a patch only fixes). The
 * build number is the commit count of HEAD, so it only grows on main; the short sha
 * names the exact commit. The build stamps all three into Trezi.app, the XPC service
 * and the backend/provider-helper bundles; `trezi --version` and Settings show
 * `versionLabel`. `scripts/release.mjs` bumps and tags, `scripts/check-version.mjs`
 * is the CI check.
 */
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
export const isSemver = version => typeof version === 'string' && SEMVER.test(version)
export const BUMPS = ['major', 'minor', 'patch']

/** The next release version. A prerelease or build suffix is dropped. */
export function bumpVersion(version, part) {
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`Not a SemVer version: ${version}`)
  if (!BUMPS.includes(part)) throw new Error(`Bump must be one of ${BUMPS.join(', ')}, not ${part}`)
  const [major, minor, patch] = match.slice(1, 4).map(Number)
  if (part === 'major') return `${major + 1}.0.0`
  if (part === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export const packageVersion = root => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

const git = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

/** `{ version, build, commit }` of a checkout. Outside Git the build is 0 and the commit "unknown". */
export function buildInfo(root) {
  const version = packageVersion(root)
  if (!isSemver(version)) throw new Error(`package.json version is not SemVer: ${version}`)
  return {
    version,
    build: git(root, ['rev-list', '--count', 'HEAD']) ?? '0',
    commit: git(root, ['rev-parse', '--short=7', 'HEAD']) ?? 'unknown'
  }
}

export const versionLabel = ({ version, build, commit }) => `Trezi ${version} (build ${build}, ${commit})`

// Keep a Changelog: `## [Unreleased]` (brackets optional) up to the next `## ` heading.
const UNRELEASED = /^## \[?Unreleased\]?[ \t]*$/im
const NEXT_SECTION = /^## /m

/** The Unreleased section's body, or null when the changelog has none. */
export function unreleasedBody(text) {
  const heading = UNRELEASED.exec(text)
  if (!heading) return null
  const rest = text.slice(heading.index + heading[0].length)
  const next = NEXT_SECTION.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

/** Problems CI reports: a non-SemVer package version, a changelog without an Unreleased section. */
export function versioningProblems({ version, changelog }) {
  const problems = []
  if (!isSemver(version)) problems.push(`package.json version ${JSON.stringify(version)} is not valid SemVer (e.g. 0.1.0).`)
  if (changelog == null) problems.push('CHANGELOG.md is missing.')
  else if (unreleasedBody(changelog) == null) problems.push('CHANGELOG.md has no "## [Unreleased]" section.')
  return problems
}

/** Moves Unreleased's entries into `## [version] - date` under a fresh, empty Unreleased. */
export function releaseChangelog(text, version, date) {
  const heading = UNRELEASED.exec(text)
  if (!heading) throw new Error('CHANGELOG.md has no "## [Unreleased]" section.')
  const body = unreleasedBody(text)
  if (!body.trim()) throw new Error('CHANGELOG.md has nothing under Unreleased to release.')
  const start = heading.index, end = start + heading[0].length + body.length
  return `${text.slice(0, start)}## [Unreleased]\n\n## [${version}] - ${date}\n\n${body.trim()}\n${end < text.length ? '\n' : ''}${text.slice(end)}`
}

/** package.json with only its `version` value replaced, formatting kept (bin/trezi reads that line). */
export function setPackageVersion(text, version) {
  const pattern = /^(\s*"version"\s*:\s*")[^"]*(")/m
  if (!pattern.test(text)) throw new Error('package.json has no version field.')
  return text.replace(pattern, `$1${version}$2`)
}
