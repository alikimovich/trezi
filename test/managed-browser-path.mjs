import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { managedBrowserDirectory, managedBrowserPath } = await import(
  '../src/main/backends/managed-browser-path.ts'
)

// A checkout-shaped tree: <root>/bin/managed/agent-browser, bundle in out/native,
// source in src/main/backends.
const root = mkdtempSync(join(tmpdir(), 'trezi-managed-path-'))
const managed = join(root, 'bin/managed')
mkdirSync(managed, { recursive: true })
writeFileSync(join(managed, 'agent-browser'), '')
chmodSync(join(managed, 'agent-browser'), 0o755)
const bundle = join(root, 'out/native')
const source = join(root, 'src/main/backends')
mkdirSync(bundle, { recursive: true })
mkdirSync(source, { recursive: true })

assert.equal(managedBrowserDirectory(bundle), managed, 'bundled helper base (out/native)')
assert.equal(managedBrowserDirectory(source), managed, 'source-tree base (src/main/backends)')
const empty = mkdtempSync(join(tmpdir(), 'trezi-managed-path-empty-'))
assert.equal(
  managedBrowserDirectory(join(empty, 'out/native')),
  undefined,
  'no wrapper, no directory'
)
assert.equal(
  managedBrowserDirectory(join(root, 'out/native'), () => false),
  undefined,
  'an absent wrapper is never advertised'
)

// The managed directory wins over a global agent-browser; the helper's own Bun is reachable.
const path = managedBrowserPath(
  managed,
  '/opt/homebrew/bin:/usr/bin:/bin',
  '/Applications/Trezi.app/Contents/Helpers/bun'
)
const entries = path.split(':')
assert.equal(entries[0], managed)
assert.ok(entries.indexOf(managed) < entries.indexOf('/opt/homebrew/bin'))
assert.equal(entries.at(-1), '/Applications/Trezi.app/Contents/Helpers')
assert.equal(managedBrowserPath(managed, undefined, '/x/bun'), `${managed}:/x`)
assert.equal(
  managedBrowserPath(managed, '/usr/bin:/x', '/x/bun'),
  `${managed}:/usr/bin:/x`,
  'the interpreter directory is not duplicated'
)
console.log(
  'MANAGED BROWSER PATH OK — bundle and source bases, managed-first PATH, interpreter reachable'
)
