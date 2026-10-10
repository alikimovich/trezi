import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentBuildLine } from '../main/build-status'
import { type CatalogBackend, harnessStamp, installedVersion } from '../main/model-catalog'
import { productLog, productLogDirectory, readLogs, redact } from '../main/product-log'
import { detectProject } from '../main/project-detect'
import { appVersion } from './app-version'
import type { NativeBridge } from './bridge'
import { app } from './platform'

/**
 * LKM-168: Help → Copy Logs for Support and Export Logs…, and the preview bridge's
 * summary lines. The host shows the menu, writes the pasteboard and runs the save
 * panel (`HostLogs.swift`); Bun reads the product log (`product-log.ts`) and builds
 * the text and the zip. Show Logs in Finder is native only.
 */

export const SUPPORT_WINDOW = 30 * 60_000
export const EXPORT_WINDOW = 24 * 60 * 60_000
/** Copy Logs for Support stays small enough to paste into an issue or a message. */
export const SUPPORT_CHARS = 60_000
const PREVIEW_SUMMARY_MS = 60_000

/** The lines as pasteable text: debug lines dropped, the newest kept within `max`. */
export function supportText(lines: string[], header: string, max = SUPPORT_CHARS) {
  const kept = lines.filter((line) => !/^\S+ debug /.test(line))
  const body: string[] = []
  let size = 0
  for (let i = kept.length - 1; i >= 0; i--) {
    size += kept[i].length + 1
    if (size > max) break
    body.unshift(kept[i])
  }
  const omitted = kept.length - body.length
  if (omitted) body.unshift(`… (${omitted} earlier lines omitted)`)
  return `${header}\n\n${body.join('\n') || '(no log lines in this window)'}\n`
}

const run = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(command, args, { timeout: 30_000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout).trim())
    )
  )

const macOS = () =>
  run('/usr/bin/sw_vers', ['-productVersion']).then(
    (version) => version,
    () => `unknown (Darwin ${release()})`
  )

/** App version, macOS, provider harness versions and the open project's framework. */
export async function systemSummary(root: string | null, appRoot = app.getAppPath()) {
  const provider = (backend: CatalogBackend) =>
    harnessStamp(backend, (pkg) => installedVersion(appRoot, pkg)) || 'not installed'
  const framework = root
    ? await detectProject(root).then(
        (project) => project.framework,
        () => 'unknown'
      )
    : 'no project open'
  return redact(
    [
      `App: ${appVersion()}`,
      currentBuildLine(),
      `macOS: ${await macOS()} (${process.arch})`,
      `Bun: ${process.versions.bun ?? 'unknown'}`,
      `Claude: ${provider('claude')}`,
      `Codex: ${provider('codex')}`,
      `Project framework: ${framework}`,
      `Log folder: ${productLogDirectory()}`
    ].join('\n')
  )
}

/** Zips the last 24 hours of the log and the system summary to `dest` (ditto). */
export async function exportLogs(
  dest: string,
  summary: string,
  { dir = productLogDirectory(), now = Date.now() } = {}
) {
  const lines = readLogs(dir, EXPORT_WINDOW, now)
  const stage = mkdtempSync(join(tmpdir(), 'trezi-logs-'))
  try {
    const folder = join(stage, 'Trezi Logs')
    mkdirSync(folder)
    writeFileSync(join(folder, 'summary.txt'), `${summary}\n`)
    writeFileSync(join(folder, 'trezi.log'), lines.length ? `${lines.join('\n')}\n` : '')
    rmSync(dest, { force: true })
    await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', folder, dest])
    return { lines: lines.length }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

const previewCounts = new Map<string, number>()
let previewRefused = 0
let previewTimer: ReturnType<typeof setTimeout> | null = null

/** Counts one preview → app message; a summary line is written once a minute at most. */
export function notePreviewMessage(channel: unknown, refused = false) {
  const name = typeof channel === 'string' ? channel : 'invalid'
  previewCounts.set(name, (previewCounts.get(name) ?? 0) + 1)
  if (refused) previewRefused++
  if (previewTimer) return
  previewTimer = setTimeout(flushPreviewSummary, PREVIEW_SUMMARY_MS)
  previewTimer.unref?.()
}

export function flushPreviewSummary() {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = null
  if (!previewCounts.size) return
  const total = [...previewCounts.values()].reduce((sum, n) => sum + n, 0)
  const channels = [...previewCounts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, n]) => `${name}:${n}`)
    .join(',')
  const level = previewRefused ? 'warn' : 'info'
  productLog[level](
    'bridge',
    'Preview messages',
    { total, refused: previewRefused, channels },
    'preview'
  )
  previewCounts.clear()
  previewRefused = 0
}

/** Handles the Help menu's `copy-logs` and `export-logs` actions. */
export function installLogSupport(
  host: NativeBridge,
  notify: (text: string, kind: 'info' | 'error') => void,
  activeRoot: () => string | null
) {
  const failed = (what: string) => (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    productLog.error('support', `${what} failed`, { error: message })
    notify(`${what} failed: ${message}`, 'error')
  }
  const copy = async () => {
    const lines = readLogs(productLogDirectory(), SUPPORT_WINDOW)
    const header = `Trezi log, last 30 minutes. ${appVersion()}, Darwin ${release()}\n${currentBuildLine()}`
    await host.request('copyText', { text: supportText(lines, header) })
    productLog.info('support', 'Logs copied for support', { lines: lines.length })
    notify(`Copied ${lines.length} log lines from the last 30 minutes.`, 'info')
  }
  const exportAll = async () => {
    const day = new Date().toISOString().slice(0, 10)
    // The save panel waits for the user: no timeout.
    const dest = await host.request('pickLogExport', { name: `Trezi Logs ${day}.zip` }, 0x7fffffff)
    if (typeof dest !== 'string' || !dest) return
    const { lines } = await exportLogs(dest, await systemSummary(activeRoot()))
    productLog.info('support', 'Logs exported', { lines })
    notify(`Exported ${lines} log lines from the last 24 hours to ${dest}.`, 'info')
  }
  app.on('before-quit', flushPreviewSummary)
  host.on('menu', ({ action }) => {
    if (action === 'copy-logs') void copy().catch(failed('Copy Logs for Support'))
    else if (action === 'export-logs') void exportAll().catch(failed('Export Logs'))
  })
}
