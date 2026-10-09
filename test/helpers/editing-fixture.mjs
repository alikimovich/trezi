// The real Swift EditingOwner (S12) compiled into a line-driven fixture process with the
// conversation, repository and source owners it works with, and Bun's real clients
// wired to it. Used by test/editing-owner.mjs and test/helpers/with-service-owners.mjs,
// which runs the island, controls and notes suites on the Swift owners.
import { serviceEditing } from '../../src/native/editing-service.ts'
import {
  SOURCES as CONVERSATION_SOURCES,
  startConversationFixture
} from './conversation-fixture.mjs'
import { skipUnlessDarwin } from './darwin.mjs'
import { swiftBuild } from './swift-build.mjs'

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
  return swiftBuild('editing-owner', [...SOURCES, 'test/fixtures/editing-owner/main.swift'])
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
