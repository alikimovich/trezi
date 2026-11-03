import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DreamerDigest } from '../main/dreamer-digest'
import { dreamerRedact } from '../main/dreamer-digest'
import { type DreamerFile, dreamerMarkdown } from '../shared/dreamer'

/**
 * LKM-202: Export Dreamer Report…, the Dreamer's only way out (LKM-443 removed Send to
 * Agent OS). It runs only on the user's explicit action and redacts again: the user may
 * have edited the proposals.
 */

/** Every string in `value` redacted (secrets, tokens, emails, home folders). */
export function redactDeep<T>(value: T, home = homedir()): T {
  if (typeof value === 'string') return dreamerRedact(value, home) as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, home)) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item, home)])
    ) as T
  return value
}

const ditto = (folder: string, dest: string) =>
  new Promise<void>((resolve, reject) =>
    execFile(
      '/usr/bin/ditto',
      ['-c', '-k', '--sequesterRsrc', '--keepParent', folder, dest],
      { timeout: 30_000 },
      (error) => (error ? reject(error) : resolve())
    )
  )

/**
 * Zips `report.md`, `proposals.json` and `evidence.json` (the digest's redacted
 * statistics and short quotes; never a transcript or a file's contents) to `dest`.
 */
export async function exportDreamerReport(
  dest: string,
  file: DreamerFile,
  digest: DreamerDigest | null,
  home = homedir()
) {
  const clean = redactDeep(file, home)
  const stage = mkdtempSync(join(tmpdir(), 'trezi-dreamer-'))
  try {
    const folder = join(stage, 'Dreamer Report')
    mkdirSync(folder)
    writeFileSync(join(folder, 'report.md'), dreamerMarkdown(clean))
    writeFileSync(join(folder, 'proposals.json'), `${JSON.stringify(clean, null, 2)}\n`)
    writeFileSync(
      join(folder, 'evidence.json'),
      `${JSON.stringify(digest ? redactDeep(digest, home) : {}, null, 2)}\n`
    )
    rmSync(dest, { force: true })
    try {
      await ditto(folder, dest)
    } catch (error) {
      // A failed zip leaves no half-written file behind.
      rmSync(dest, { force: true })
      throw error
    }
    return { proposals: clean.proposals.length }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
