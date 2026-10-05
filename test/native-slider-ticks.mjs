import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// A `step:` on a SwiftUI Slider makes AppKit draw one tick mark per step (LKM-115).
// Only the Slider's own top-level arguments count, not nested calls.
const topLevelArguments = (source, open) => {
  let depth = 0,
    text = ''
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') {
      if (--depth === 0) return text
    } else if (depth === 1) text += c
  }
  return text
}
let checked = 0
for (const name of readdirSync(join(root, 'src/native')).filter((name) =>
  name.endsWith('.swift')
)) {
  const source = readFileSync(join(root, 'src/native', name), 'utf8')
  for (const match of source.matchAll(/(?<![A-Za-z])Slider\(/g)) {
    checked++
    const args = topLevelArguments(source, match.index + match[0].length - 1)
    assert.ok(
      !/\bstep\s*:/.test(args),
      `${name}: stepped Slider draws tick marks; use SnappedSlider\n${args}`
    )
  }
}
assert.ok(checked > 0, 'Found the SwiftUI Slider inside SnappedSlider')
for (const name of ['EditingInspector', 'ChatIsland']) {
  assert.match(
    readFileSync(join(root, `src/native/${name}.swift`), 'utf8'),
    /SnappedSlider\(/,
    `${name} uses SnappedSlider`
  )
}

if (process.platform !== 'darwin') {
  console.log('NATIVE-SLIDER-TICKS SKIP — macOS AppKit required')
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'trezi-slider-ticks-'))
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
    const binary = join(scratch, 'slider-ticks')
    run([
      'xcrun',
      'swiftc',
      '-module-cache-path',
      cache,
      'test/fixtures/slider-ticks/main.swift',
      ...['EditingInspector', 'SnappedSlider'].map((name) => `src/native/${name}.swift`),
      '-o',
      binary
    ])
    console.log(run([binary]).trim())
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
