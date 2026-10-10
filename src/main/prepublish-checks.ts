import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const SAFE = new Set(['lint', 'typecheck', 'typecheck:native', 'test:unit', 'check'])

/** Commands explicitly named by CI or a dated project rule; no shell interpolation. */
export function prepublishCommands(
  workflows: string[],
  memory: string
): { run: string[]; warn: string[] } {
  const found = new Set<string>()
  for (const text of [...workflows, memory])
    for (const match of text.matchAll(/\bbun run ([\w:-]+)/g)) found.add(match[1])
  return {
    run: [...found].filter((name) => SAFE.has(name)).slice(0, 4),
    warn: [...found]
      .filter((name) => !SAFE.has(name))
      .map((name) => `CI step bun run ${name} needs a local check`)
  }
}

export async function prepublishChecks(
  root: string,
  memory: string
): Promise<{ warnings: string[] }> {
  let workflows: string[] = []
  try {
    const folder = join(root, '.github', 'workflows')
    const files = (await readdir(folder)).filter((file) => /\.ya?ml$/.test(file)).slice(0, 12)
    workflows = await Promise.all(
      files.map(async (file) => (await readFile(join(folder, file), 'utf8')).slice(0, 128_000))
    )
  } catch {}
  const { run, warn } = prepublishCommands(workflows, memory)
  const warnings = [...warn]
  for (const script of run) {
    try {
      await exec('bun', ['run', script], { cwd: root, timeout: 90_000, maxBuffer: 64 * 1024 })
    } catch (error) {
      warnings.push(`Pre-publish check bun run ${script} failed: ${String(error).slice(0, 300)}`)
    }
  }
  return { warnings }
}
