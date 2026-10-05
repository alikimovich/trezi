import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Compiles the host's pure reveal-acknowledgement logic without a window.
if (process.platform !== 'darwin') {
  console.log('NATIVE-CHAT-REVEAL SKIP — macOS Swift toolchain required')
} else {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const scratch = mkdtempSync(join(tmpdir(), 'trezi-chat-reveal-'))
  const cache = join(root, 'out/native/module-cache')
  mkdirSync(cache, { recursive: true })
  const run = (args) => {
    const result = spawnSync(args[0], args.slice(1), {
      cwd: root,
      encoding: 'utf8',
      timeout: 180_000
    })
    assert.equal(
      result.status,
      0,
      `${args[0]}: ${result.error || result.signal || ''}\n${result.stdout}\n${result.stderr}`
    )
    return result.stdout
  }
  try {
    const binary = join(scratch, 'chat-reveal')
    run([
      'xcrun',
      'swiftc',
      '-module-cache-path',
      cache,
      'test/fixtures/chat-reveal/main.swift',
      'src/native/ChatReveal.swift',
      '-o',
      binary
    ])
    console.log(run([binary]).trim())
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
