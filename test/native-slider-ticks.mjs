import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

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
  const binary = swiftBuild('slider-ticks', [
    'test/fixtures/slider-ticks/main.swift',
    ...['EditingInspector', 'SnappedSlider'].map((name) => `src/native/${name}.swift`)
  ])
  console.log(runFixture(binary).trim())
}
