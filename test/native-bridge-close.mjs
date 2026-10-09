import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnHostBridge } from './helpers/host-bridge.mjs'

const directory = mkdtempSync(join(tmpdir(), 'trezi-bridge-close-'))
const executable = join(directory, 'host.mjs')
writeFileSync(
  executable,
  `#!/usr/bin/env bun
import { createInterface } from 'node:readline'
console.log(JSON.stringify({event:'ready'}))
createInterface({input:process.stdin}).on('line', () => {
  console.log(JSON.stringify({event:'persist', value:'last host event'}))
  process.exit(0)
})
`,
  { mode: 0o755 }
)
const bridge = spawnHostBridge(executable, directory, 'ephemeral')
const errors = []
let writes = 0
bridge.on('host-error', (error) => errors.push(error))
bridge.on('persist', (event) => {
  writeFileSync(join(directory, 'workspace.json.tmp'), event.value)
  writes++
})
try {
  await once(bridge, 'ready')
  bridge.send('quit')
  await bridge.closed
  assert.equal(writes, 1, 'Last host persistence event is handled before profile deletion')
  assert.equal(readFileSync(join(directory, 'workspace.json.tmp'), 'utf8'), 'last host event')
  assert.deepEqual(errors, [])
  await bridge.closed // Completion remains awaitable after close.
} finally {
  if (bridge.child.exitCode === null) bridge.child.kill()
  await bridge.closed
  rmSync(directory, { recursive: true, force: true })
}
console.log('NATIVE BRIDGE CLOSE PASS — host output drains before disposable profile deletion')
