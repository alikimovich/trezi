import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type MarkerConflict, versionConflict } from '../shared/dependency-issue'

const execFileP = promisify(execFile)

/** Dependency manifests and lockfiles an install parses (LKM-194). */
export const DEPENDENCY_MANIFESTS = [
  'package.json',
  'bun.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml'
]

/** Git-style unresolved markers: all three lines, each at a line start. */
export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<<( .*)?$/m.test(text) && /^=======$/m.test(text) && /^>>>>>>>( .*)?$/m.test(text)
}

/** 1-based line of the first `<<<<<<<`, or 1. */
export function firstMarkerLine(text: string): number {
  const index = text.split('\n').findIndex((line) => line.startsWith('<<<<<<<'))
  return index < 0 ? 1 : index + 1
}

/** A conflicted package.json where both sides changed `"version"` (diff3 base ignored). */
export function markerVersion(text: string) {
  const version = (lines: string[]) =>
    lines.map((line) => /^\s*"version"\s*:\s*"([^"]+)"/.exec(line)?.[1]).find(Boolean)
  let side: 'ours' | 'base' | 'theirs' | null = null
  let ours: string[] = [],
    theirs: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) {
      side = 'ours'
      ours = []
      theirs = []
    } else if (side && line.startsWith('|||||||')) side = 'base'
    else if (side && line === '=======') side = 'theirs'
    else if (side && line.startsWith('>>>>>>>')) {
      const a = version(ours),
        b = version(theirs)
      const found = a && b ? versionConflict(a, b) : null
      if (found) return found
      side = null
    } else if (side === 'ours') ours.push(line)
    else if (side === 'theirs') theirs.push(line)
  }
  return null
}

async function markedText(root: string, rel: string): Promise<string | null> {
  try {
    const text = await readFile(join(root, rel), 'utf8')
    return hasConflictMarkers(text) ? text : null
  } catch {
    return null
  }
}

/** Manifests or lockfiles in `checkout` that carry unresolved markers. */
export async function manifestMarkers(checkout: string): Promise<string[]> {
  const marked: string[] = []
  for (const rel of DEPENDENCY_MANIFESTS) if (await markedText(checkout, rel)) marked.push(rel)
  return marked
}

/** An install was refused because the manifests have conflict markers. */
export class DependencyConflictError extends Error {
  constructor(readonly files: string[]) {
    super(
      `Unresolved Git conflict markers in ${files.join(', ')}; dependencies were not installed.`
    )
  }
}

/**
 * Every file in `root` (tracked or not ignored) with unresolved markers, manifests
 * first, through one `git grep`; null when there are none. Each hit is confirmed by
 * reading it, so a lone `<<<<<<<` in a doc is not a conflict.
 */
export async function markerConflict(root: string): Promise<MarkerConflict | null> {
  let listed: string[]
  try {
    const { stdout } = await execFileP(
      'git',
      ['-c', 'core.quotePath=false', 'grep', '--untracked', '-l', '-I', '-E', '^<<<<<<<( |$)'],
      { cwd: root, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }
    )
    listed = stdout.split('\n').filter(Boolean)
  } catch {
    // Exit 1: no match. Anything else: no evidence either way.
    listed = []
  }
  const manifests = DEPENDENCY_MANIFESTS.filter((rel) => listed.includes(rel))
  const ordered = [...manifests, ...listed.filter((rel) => !manifests.includes(rel))].slice(0, 50)
  const files: string[] = []
  let first: string | null = null
  let version = null
  for (const rel of ordered) {
    const text = await markedText(root, rel)
    if (!text) continue
    files.push(rel)
    first ??= text
    if (rel === 'package.json') version = markerVersion(text)
  }
  if (!files.length || !first) return null
  return {
    files,
    line: firstMarkerLine(first),
    manifests: files.some((rel) => DEPENDENCY_MANIFESTS.includes(rel)),
    ...(version ? { version } : {})
  }
}
