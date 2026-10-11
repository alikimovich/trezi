import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { reduce } from './chat-state'
import { inspectUntil } from './smoke-wait'

const rect = (value: string) => {
  const [x, y, width, height] = (value.match(/-?[\d.]+(e[-+]?\d+)?/g) ?? []).map(Number)
  return { x, y, width, height }
}

export async function checkIncidentRow(host: NativeBridge, artifacts: string) {
  const chat = nativeChat.get(nativeChat.active)
  const kept = chat.messages.length
  chat.messages.push({
    id: 'incident-user',
    role: 'user',
    at: Date.now(),
    text: 'Reference bubble',
    statuses: [],
    segments: [{ kind: 'text', text: 'Reference bubble' }]
  })
  const reason = 'workspace routing discovery failed'
  reduce(chat, { type: 'error', message: reason })
  reduce(chat, { type: 'error', message: `Codex Exec exited with code 1: ${reason}` })
  nativeChat.changed(chat)
  const rows = chat.messages.slice(kept + 1).filter((m) => m.incident)
  try {
    assert.equal(rows.length, 1, 'two failures collapse into one incident row')
    const id = rows[0].id
    const state = await inspectUntil(
      (method) => host.request(method),
      'chatInspect',
      (snapshot) => snapshot.incidents?.some((incident: { id: string }) => incident.id === id)
    )
    const incident = state.incidents.find((item: { id: string }) => item.id === id)
    assert.equal(incident.line, 'Provider could not connect')
    assert.match(incident.detail, /Codex Exec exited/)
    assert.equal(incident.expanded, false)
    await host.request('chatAcceptance', { prepare: true })
    const closed = await host.request('chatIncidentRow', { message: id })
    writeFileSync(join(artifacts, 'incident-collapsed.png'), Buffer.from(closed.png, 'base64'))
    assert.equal(closed.inView, true)
    assert.ok(rect(closed.frame).height <= 45, 'incident stays one compact row')
    const open = await host.request('chatIncidentRow', { message: id, toggle: true })
    writeFileSync(join(artifacts, 'incident-details.png'), Buffer.from(open.png, 'base64'))
    assert.equal(open.expanded, true)
    assert.ok(rect(open.frame).height > rect(closed.frame).height + 20)
    console.log('Incident row: one collapsed row, copyable Details expanded in foreground.')
  } finally {
    await host.request('chatIncidentRow', { restore: true })
    chat.messages.splice(kept)
    nativeChat.changed(chat)
  }
}
