import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('SIDEBAR-ICON SKIP — macOS AppKit required')
} else {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const scratch = mkdtempSync(join(tmpdir(), 'trezi-sidebar-icon-'))
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
    const binary = join(scratch, 'sidebar-icon')
    run([
      'xcrun',
      'swiftc',
      '-module-cache-path',
      cache,
      'test/fixtures/sidebar-icon/main.swift',
      'src/native/SidebarIcon.swift',
      '-o',
      binary
    ])
    console.log(run([binary]).trim())
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
