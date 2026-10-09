import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChatIslandTool } from '../main/chat-islands'
import type { IslandReadiness } from '../shared/chat-islands'
import type { NativeBridge } from './bridge'
import { nativeChat, nativeIslands } from './chat-runtime'
import { nativeWorkspace } from './workspace-runtime'

const FILE = 'island-new-chat.js'
let state: { first: string; created?: string } | undefined

/**
 * LKM-199: a chat made by New chat (LKM-182's instant path: listed before its worktree,
 * provider and record exist) defines an island through the agent's tool. The define waits
 * for the chat's workspace and registers its island session; it never answers "not
 * available for interactive islands yet".
 */
export async function checkIslandNewChat(
  host: NativeBridge,
  fixture: string,
  wait: (check: () => any, label: string, timeout?: number) => Promise<unknown>,
  inspect: (method: string, check: (s: any) => boolean) => Promise<unknown>
) {
  const first = nativeChat.active
  state = { first }
  writeFileSync(join(fixture, FILE), 'const DURATION = 0.4;\nconst EASE_IN = true;\n')
  // A draft keeps the first chat from being reused as the "new" one.
  await host.request('composerPerform', { text: 'Island new-chat draft' })
  await inspect('composerInspect', (s) => s.text === 'Island new-chat draft')
  host.emit('shell-action', { action: 'new-chat', project: nativeWorkspace.state.activeKey })
  await wait(() => nativeChat.active !== first, 'new chat')
  const created = nativeChat.active
  state.created = created
  // At once, as an agent's first tool call can be: the workspace may still be preparing.
  // The catalog answers without waiting: ready, or `workspace_pending` with its recovery.
  const early = (await runChatIslandTool(created, fixture, { action: 'catalog' })) as {
    readiness?: IslandReadiness
  }
  assert.ok(
    early.readiness?.ready ||
      (early.readiness?.code === 'workspace_pending' && early.readiness.recovery),
    `New chat catalog readiness: ${JSON.stringify(early.readiness)}`
  )
  const result = (await runChatIslandTool(created, fixture, {
    action: 'define',
    engine: 'agent',
    manifest: {
      file: FILE,
      component: 'ProjectCard',
      title: 'Project animation',
      params: [
        {
          id: 'duration',
          label: 'Duration',
          kind: 'number',
          min: 0,
          max: 2,
          step: 0.05,
          apply: { strategy: 'literal', anchor: 'const DURATION = ' }
        },
        {
          id: 'ease',
          label: 'Ease in',
          kind: 'toggle',
          apply: { strategy: 'literal', anchor: 'const EASE_IN = ' }
        }
      ]
    },
    blocks: [{ id: 'motion', title: 'Motion', kind: 'group', params: ['duration', 'ease'] }]
  })) as { id?: string; error?: string }
  assert.equal(result.error, undefined, `New chat island define: ${JSON.stringify(result)}`)
  assert.ok(result.id, 'The island is defined in the brand-new chat')
  const session = nativeIslands.sessions.get(created)
  assert.ok(session?.recordId, 'The new chat has an island session against its record')
  const ready = (await runChatIslandTool(created, fixture, { action: 'catalog' })) as {
    readiness?: IslandReadiness
  }
  assert.equal(ready.readiness?.ready, true, JSON.stringify(ready.readiness))
  assert.equal(ready.readiness?.recordId, session.recordId, 'The catalog names the record')
  assert.ok(
    nativeIslands.attachments(created).some((a) => a.view?.id === result.id),
    'The island is attached to the new chat'
  )
}

export async function restoreIslandNewChat(fixture: string, clearComposer: () => Promise<void>) {
  rmSync(join(fixture, FILE), { force: true })
  const saved = state
  state = undefined
  const key = nativeWorkspace.state.activeKey
  if (!saved || !key) return
  if (saved.created)
    await nativeWorkspace.command({ type: 'close-chat', key, session: saved.created })
  if (nativeChat.active !== saved.first)
    await nativeWorkspace.command({ type: 'chat', key, session: saved.first })
  await clearComposer()
}
