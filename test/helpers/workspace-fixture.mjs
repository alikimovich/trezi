// The real Swift workspace owner for Bun-side suites: compiles the workspace-owner
// fixture (WorkspaceOwner + OperationLedger) once per process and serves a profile
// folder over the same pipe protocol as the supervised service, so a suite drives
// `serviceWorkspace` exactly as Trezi does. It is the only workspace writer (LKM-111).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { serviceWorkspace } from '../../src/native/workspace-service.ts'
import { skipUnlessDarwin } from './darwin.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const live = new Set()
let binary
process.on('exit', () => {
  for (const child of live) child.kill('SIGKILL')
})

function compile() {
  skipUnlessDarwin('the Swift workspace owner')
  const scratch = mkdtempSync(join(tmpdir(), 'trezi-workspace-fixture-'))
  process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
  const sources = [
    'ServiceContract',
    'LedgerStore',
    'OperationLedger',
    'PreferencesFile',
    'PreferencesOwner',
    'WorkspaceFile',
    'WorkspaceOwner',
    'DomainChannel'
  ].map((name) => `src/service/${name}.swift`)
  const out = join(scratch, 'workspace-fixture')
  const result = spawnSync(
    'xcrun',
    [
      'swiftc',
      '-module-cache-path',
      join(scratch, 'module-cache'),
      ...sources,
      'test/fixtures/workspace-owner/main.swift',
      '-o',
      out
    ],
    { cwd: root, encoding: 'utf8', timeout: 300_000 }
  )
  assert.equal(
    result.status,
    0,
    `swiftc: ${result.error || ''}\n${result.stdout}\n${result.stderr}`
  )
  return out
}

/** A running owner for `profile` and Bun's client on it; `close` ends the service. */
export async function workspaceService(profile, timeout = 5_000) {
  binary ??= compile()
  const child = spawn(binary, [profile], { stdio: ['pipe', 'pipe', 'inherit'] })
  live.add(child)
  child.on('exit', () => live.delete(child))
  const link = new EventEmitter()
  const started = new Promise((resolve) => {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.ready) resolve()
      else link.emit(message.event, message)
    })
  })
  link.sendService = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`)
  await started
  const store = await serviceWorkspace(link, timeout)
  return {
    store,
    async close() {
      child.stdin.end()
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
}
