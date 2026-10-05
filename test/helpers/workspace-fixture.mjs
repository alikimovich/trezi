// The real Swift workspace owner for Bun-side suites: compiles the workspace-owner
// fixture (WorkspaceOwner + OperationLedger, the build test/workspace-owner.mjs uses)
// once per source hash and serves a profile folder over the same pipe protocol as the
// supervised service, so a suite drives `serviceWorkspace` exactly as Trezi does. It is
// the only workspace writer (LKM-111).
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { serviceWorkspace } from '../../src/native/workspace-service.ts'
import { skipUnlessDarwin } from './darwin.mjs'
import { swiftBuild } from './swift-build.mjs'

const live = new Set()
let binary
process.on('exit', () => {
  for (const child of live) child.kill('SIGKILL')
})

export const WORKSPACE_FIXTURE = [
  ...[
    'ServiceContract',
    'LedgerStore',
    'OperationLedger',
    'PreferencesFile',
    'PreferencesOwner',
    'WorkspaceFile',
    'WorkspaceOwner',
    'DomainChannel'
  ].map((name) => `src/service/${name}.swift`),
  'test/fixtures/workspace-owner/main.swift'
]

function compile() {
  skipUnlessDarwin('the Swift workspace owner')
  return swiftBuild('workspace-owner', WORKSPACE_FIXTURE)
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
