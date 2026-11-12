import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-657: the host's checks before Quick Look / Reveal in Finder, the preview origin rule
// and the Quick Look panel, on synthetic files in a temporary folder.
if (process.platform !== 'darwin') {
  console.log('LOCAL-FILE-LINKS SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('local-file-links', [
    'test/fixtures/local-file-links/main.swift',
    'src/native/LocalFileLinks.swift',
    'src/native/ArtifactPreview.swift',
    '-framework',
    'Quartz'
  ])
  const folder = mkdtempSync(join(tmpdir(), 'trezi-local-file-links-'))
  try {
    assert.deepEqual(JSON.parse(runFixture(binary, [folder])), { ok: true })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
  console.log('LOCAL-FILE-LINKS PASS')
}
