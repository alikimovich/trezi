import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('NATIVE-COMPOSER-LAYOUT SKIP — macOS AppKit required')
} else {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const scratch = mkdtempSync(join(tmpdir(), 'trezi-composer-layout-'))
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
    const binary = join(scratch, 'composer-layout')
    run([
      'xcrun',
      'swiftc',
      '-module-cache-path',
      cache,
      'test/fixtures/composer-layout/main.swift',
      ...[
        'ChatScrollStyle',
        'ChatEnvironment',
        'ScrollerDrag',
        'ChatLatestButton',
        'Composer',
        'ComposerVerification',
        'ComposerAttachments',
        'AttachmentThumbnail',
        'ComposerQueue',
        'ComposerBeam'
      ].map((name) => `src/native/${name}.swift`),
      '-o',
      binary
    ])
    console.log(run([binary]).trim())
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
