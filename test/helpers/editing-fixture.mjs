// The real Swift EditingOwner (S12) compiled into a line-driven fixture process with the
// conversation, repository and source owners it works with, and Bun's real clients
// wired to it. Used by test/editing-owner.mjs and test/helpers/with-service-owners.mjs,
// which runs the island, controls and notes suites on the Swift owners.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serviceEditing } from '../../src/native/editing-service.ts'
import {
  SOURCES as CONVERSATION_SOURCES,
  startConversationFixture
} from './conversation-fixture.mjs'
import { skipUnlessDarwin } from './darwin.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
export const SOURCES = [
  ...CONVERSATION_SOURCES,
  ...[
    'EditingIslands',
    'EditingStores',
    'EditingProject',
    'EditingLegacyNames',
    'EditingOwner'
  ].map((name) => `src/service/${name}.swift`)
]

/** Compiles the fixture once per source hash and compiler version; returns the binary path. */
export function compileEditingFixture() {
  skipUnlessDarwin('the Swift editing owner')
  const files = [...SOURCES, 'test/fixtures/editing-owner/main.swift']
  const compiler = spawnSync('xcrun', ['swiftc', '--version'], { encoding: 'utf8' })
  const key = createHash('sha256')
  key.update(`${compiler.stdout}${compiler.stderr}`)
  for (const file of files) key.update(`${file}\0`).update(readFileSync(join(root, file)))
  const cache = join(tmpdir(), 'trezi-editing-owner-cache')
  mkdirSync(cache, { recursive: true })
  const cached = join(cache, `fixture-${key.digest('hex').slice(0, 24)}`)
  if (!existsSync(cached)) {
    const building = `${cached}.${process.pid}.tmp`
    const result = spawnSync(
      'xcrun',
      ['swiftc', '-module-cache-path', join(cache, 'module-cache'), ...files, '-o', building],
      { cwd: root, encoding: 'utf8', timeout: 400_000 }
    )
    assert.equal(
      result.status,
      0,
      `swiftc: ${result.error || ''}\n${result.stdout}\n${result.stderr}`
    )
    renameSync(building, cached)
  }
  return cached
}

/** A fixture process on `profile` (same line protocol as the conversation fixture). */
export async function startEditingFixture(binary, profile, env = {}) {
  const fixture = await startConversationFixture(binary, profile, env)
  // Four clients (and raw frames) listen on one link.
  fixture.link.setMaxListeners(64)
  const owners = fixture.owners.bind(fixture)
  /** Every client (editing, conversation, repository, source), wired like src/native/index.ts. */
  fixture.owners = (options = {}) => {
    const all = owners(options)
    return {
      ...all,
      editing: serviceEditing(fixture.link, {
        ...options,
        leases: () => all.repository.heldLeases()
      })
    }
  }
  /** One raw editing frame; resolves with the reply's result. */
  let raw = 0
  fixture.editingFrame = (method, body, request = {}, top = {}) => {
    const id = 800_000 + ++raw
    return new Promise((resolve) => {
      const listener = (message) => {
        if (message.service === 'editing' && message.id === id) {
          fixture.link.off('service-reply', listener)
          resolve(message.reply.result)
        }
      }
      fixture.link.on('service-reply', listener)
      fixture.link.sendService({
        service: 'editing',
        id,
        request: {
          connection: crypto.randomUUID(),
          requestID: crypto.randomUUID(),
          operationID: crypto.randomUUID(),
          scope: {},
          mode: ['islands', 'navigationState'].includes(method) ? 'read' : 'mutation',
          service: 'editing',
          method,
          body,
          ...request
        },
        ...top
      })
    })
  }
  return fixture
}
