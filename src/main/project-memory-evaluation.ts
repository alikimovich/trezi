import { execFile } from 'node:child_process'
import { dropUnbuiltTokenRules, memoryDate, stampProvenance } from './project-memory-format'

/**
 * Does any of `roots` contain `text` in its code? `git grep` over tracked and
 * untracked (not ignored) files, so `node_modules` and build output never count.
 * Only "searched and not found" is `false`; a failed search (no Git, not a
 * repository, timeout) is `true`, so this check can only ever keep a rule out.
 */
export async function textInProject(roots: string[], text: string): Promise<boolean> {
  let searched = false
  for (const root of new Set(roots)) {
    const code = await new Promise<number | null>((resolve) => {
      execFile(
        'git',
        ['grep', '--untracked', '-q', '-F', '-I', '-e', text],
        { cwd: root, timeout: 5_000, maxBuffer: 64 * 1024 },
        (error) => resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0)
      )
    })
    if (code === 0) return true
    if (code === 1) searched = true
  }
  return !searched
}

/**
 * Trezi's part of an evaluation, after the model proposed `next`: drop new rules
 * that rely on design tokens the code does not have yet (memory never stands in
 * for the change itself), then give every rule its source tag.
 */
export async function refineProjectMemory(
  before: string,
  next: string | null,
  opts: { roots: string[]; date?: string; exists?: (token: string) => Promise<boolean> }
): Promise<string | null> {
  if (next === null) return null
  const exists = opts.exists ?? ((token: string) => textInProject(opts.roots, token))
  const built = await dropUnbuiltTokenRules(before, next, exists)
  if (!built.trim()) return null
  return stampProvenance(before, built, opts.date ?? memoryDate())
}
