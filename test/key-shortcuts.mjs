import assert from 'node:assert/strict'
import { latinKey } from '../src/preview/latin-key.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-219: shortcuts match the physical key under non-Latin layouts and keep Dvorak's own.

// In-page keys (states switcher, select mode): `key` when it is Latin, else `code`.
assert.equal(latinKey({ key: 'ы', code: 'KeyS' }), 's', 'Russian S toggles select mode')
assert.equal(latinKey({ key: 'Ы', code: 'KeyS' }), 's')
assert.equal(latinKey({ key: 'р', code: 'KeyH' }), 'h', 'Russian H hides the states switcher')
assert.equal(latinKey({ key: 'י', code: 'KeyH' }), 'h', 'Hebrew H')
assert.equal(latinKey({ key: 'η', code: 'KeyH' }), 'h', 'Greek H')
assert.equal(latinKey({ key: 'х', code: 'BracketLeft' }), '[')
assert.equal(latinKey({ key: '1', code: 'Digit1' }), '1')
assert.equal(latinKey({ key: '&', code: 'Digit1' }), '&', 'a Latin character is the key itself')
assert.equal(latinKey({ key: 'é', code: 'Digit2' }), '2', 'AZERTY digits by position')
assert.equal(latinKey({ key: 'd', code: 'KeyH' }), 'd', 'Dvorak keeps its own letters')
assert.equal(latinKey({ key: 'Escape', code: 'Escape' }), 'Escape', 'named keys pass through')
assert.equal(latinKey({ key: 'ArrowLeft', code: 'ArrowLeft' }), 'ArrowLeft')
assert.equal(latinKey({ key: 'ß', code: 'Minus' }), '-')
console.log('ok - in-page latinKey')

if (process.platform !== 'darwin') {
  console.log('KEY-SHORTCUTS SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('key-shortcuts', [
    'test/fixtures/key-shortcuts/main.swift',
    'src/native/KeyShortcuts.swift'
  ])
  console.log(runFixture(binary).trim())
}
