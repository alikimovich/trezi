import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  leftoverTerms,
  parseWorkbench,
  WORKBENCH_MANIFEST,
  type Workbench
} from '../shared/states-workbench'

// LKM-207: bounded read-only scans of the live checkout. The workbench record is its
// manifest, so nothing here writes; removal goes through the Swift source owner.

/** Generated or installed trees: never a workbench, and their copies are not leftovers. */
const SKIPPED = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  'Pods',
  'DerivedData'
])
const TEXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|css|scss|json|mdx?|ya?ml|toml|php|rb|py)$/i
const MAX_DIRS = 4000
const MAX_FILES = 6000
const MAX_BYTES = 512 * 1024

async function walk(
  root: string,
  visit: (rel: string, entry: Dirent) => Promise<void>,
  maxDepth: number
): Promise<void> {
  const queue: [string, number][] = [['', 0]]
  let dirs = 0
  while (queue.length && dirs++ < MAX_DIRS) {
    const [rel, depth] = queue.shift() as [string, number]
    let entries: Dirent[]
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push([path, depth + 1])
      } else if (entry.isFile()) await visit(path, entry)
    }
  }
}

/** Every workbench recorded in `root`, by folder. */
export async function scanWorkbenches(root: string): Promise<Workbench[]> {
  const found: Workbench[] = []
  await walk(
    root,
    async (rel, entry) => {
      if (entry.name !== WORKBENCH_MANIFEST || found.length >= 32) return
      const folder = rel.slice(0, -WORKBENCH_MANIFEST.length - 1)
      if (!folder) return
      try {
        const bench = parseWorkbench(await readFile(join(root, rel), 'utf8'), folder)
        if (bench) found.push(bench)
      } catch {
        /* unreadable: not listed */
      }
    },
    6
  )
  return found.sort((a, b) => a.folder.localeCompare(b.folder))
}

/** `file: term` for each text file still naming the removed workbench (bounded). */
export async function findLeftovers(root: string, workbench: Workbench): Promise<string[]> {
  const terms = leftoverTerms(workbench)
  const hits: string[] = []
  let files = 0
  await walk(
    root,
    async (rel) => {
      if (hits.length >= 20 || files >= MAX_FILES || !TEXT.test(rel)) return
      files++
      try {
        if ((await stat(join(root, rel))).size > MAX_BYTES) return
        const content = await readFile(join(root, rel), 'utf8')
        const term = terms.find((candidate) => content.includes(candidate))
        if (term) hits.push(`${rel}: ${term}`)
      } catch {
        /* vanished or unreadable */
      }
    },
    8
  )
  return hits
}
