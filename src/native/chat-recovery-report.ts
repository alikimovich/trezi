import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gitOut } from '../main/chat-park'
import { states } from '../main/chat-state'
import { integrationGate, lastReplayFailures } from '../main/integration-gate'
import { productLogDirectory, readLogs, redact } from '../main/product-log'
import { appVersion } from './app-version'
import type { Chat } from './chat-state'

/** A private artifact for one chat and one recovery attempt. No transcript or source. */
const reports = new Map<string, string>()
export async function writeRecoveryReport(chat: Chat, requested: string, reason: string) {
  const st = states.get(chat.chat)
  const scope = st && { emitKey: chat.chat, root: st.wt.path, liveRoot: st.liveRoot }
  const gate = scope ? await integrationGate(scope).catch(() => null) : null
  const live = st
    ? await gitOut(st.liveRoot, ['rev-parse', 'HEAD']).then(
        (value) => value.trim(),
        () => null
      )
    : null
  const lines = readLogs(productLogDirectory(), 30 * 60_000)
    .filter((line) => line.includes(`chat=${chat.chat}`))
    .slice(-80)
  const content = redact(
    JSON.stringify(
      {
        app: appVersion(),
        provider: chat.settings.provider,
        chat: chat.chat,
        operation: chat.recoveryId,
        turn: chat.turn ?? null,
        startedAt: chat.recoveryStartedAt ? new Date(chat.recoveryStartedAt).toISOString() : null,
        finishedAt: new Date().toISOString(),
        requested,
        reason,
        held: chat.isolation === 'parked',
        heldRevision: gate?.tree ?? null,
        liveRevision: live,
        check: gate && { need: gate.need, reason: gate.reason, evidence: gate.evidence.slice(-8) },
        replays: scope ? lastReplayFailures(scope) : [],
        logs: lines
      },
      null,
      2
    )
  )
  const folder = mkdtempSync(join(tmpdir(), 'trezi-chat-report-'))
  const path = join(folder, 'support-report.json')
  writeFileSync(path, `${content}\n`, { mode: 0o600 })
  if (readFileSync(path, 'utf8') !== `${content}\n`)
    throw new Error('Support report could not be read back.')
  const previous = reports.get(chat.chat)
  reports.set(chat.chat, path)
  if (previous) rmSync(dirname(previous), { recursive: true, force: true })
  return path
}

export function readableRecoveryReport(chat: string): string | null {
  const path = reports.get(chat)
  if (!path) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
