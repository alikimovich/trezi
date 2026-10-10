import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const CHECK_TIMEOUT_MS = 10_000
const SAFE = new Set(['lint', 'typecheck', 'typecheck:native', 'test:unit', 'check'])

/** Commands explicitly named by CI or a dated project rule; no shell interpolation. */
export function prepublishCommands(
  workflows: string[],
  memory: string,
  scripts: Record<string, string>
): { run: string[]; warn: string[] } {
  const found = new Set<string>()
  for (const workflow of workflows) {
    const lines = workflow.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const match = /^\s*(?:-\s*)?run:\s*(.*)$/.exec(lines[i])
      if (!match) continue
      const command = match[1].trim().replace(/^['"]|['"]$/g, '')
      if (command === '|' || command === '>') {
        const indent = lines[i].search(/\S/)
        while (i + 1 < lines.length && lines[i + 1].search(/\S/) > indent) {
          const line = lines[++i].trim()
          if (line && !line.startsWith('#')) found.add(line)
        }
      } else if (command) found.add(command)
    }
  }
  for (const match of memory.matchAll(/\bbun run ([\w:-]+)/g)) found.add(`bun run ${match[1]}`)
  const run = new Set<string>(),
    warn: string[] = []
  for (const step of found) {
    const script = /^(?:bun run |npm run |pnpm (?:run )?|yarn (?:run )?)([\w:-]+)$/.exec(step)?.[1]
    if (script && SAFE.has(script) && Object.hasOwn(scripts, script)) run.add(script)
    else warn.push(`CI step ${step.slice(0, 120)} needs a local check`)
  }
  return {
    run: [...run].slice(0, 4),
    warn
  }
}

/** A failed local run: a timeout means it was too slow to be cheap, not that it failed. */
export function prepublishRunWarning(script: string, error: unknown): string {
  const { killed, signal } = (error ?? {}) as { killed?: boolean; signal?: string }
  if (killed || signal === 'SIGTERM')
    return `Pre-publish check bun run ${script} did not finish locally within ${CHECK_TIMEOUT_MS / 1000} s; CI will run it`
  return `Pre-publish check bun run ${script} failed: ${String(error).slice(0, 300)}`
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
  let scripts: Record<string, string> = {}
  try {
    scripts = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts ?? {}
  } catch {}
  const { run, warn } = prepublishCommands(workflows, memory, scripts)
  const warnings = [...warn]
  for (const script of run) {
    try {
      await exec('bun', ['run', script], {
        cwd: root,
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: 64 * 1024
      })
    } catch (error) {
      warnings.push(prepublishRunWarning(script, error))
    }
  }
  return { warnings }
}
