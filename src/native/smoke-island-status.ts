import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeIslands } from './chat-runtime'

/** Anything that reads as exception text instead of one plain line. */
const RAW = /Error\b|\bat \S+ \(|\bE[A-Z]{3,}\b|undefined|NaN|\/Users\/|\/tmp\//

/**
 * LKM-181 in the islands group: the code stops supporting one binding (a token), then all
 * of them (the declarations are gone); the user hides the island and shows it again.
 * Captures `chat-island-disabled.png` and `chat-island-hidden.png`. Leaves `code` in `file`.
 */
export async function checkIslandStatus(
  host: NativeBridge,
  chat: string,
  island: string,
  file: string,
  code: string,
  artifacts: string,
  wait: (check: () => Promise<boolean> | boolean) => Promise<void>
) {
  const inspect = async () =>
    ((await host.request('chatInspect')).islands as any[]).find((i) => i.id === island)
  const until = (check: (view: any) => boolean) =>
    wait(async () => {
      const view = await inspect()
      return !!view && check(view)
    })
  const capture = async (name: string) => {
    await host.request('revealChatIsland', { island }).catch(() => {})
    writeFileSync(join(artifacts, name), Buffer.from(await host.request('captureShell'), 'base64'))
  }
  try {
    const ready = await inspect()
    assert.match(ready.name, /^#island-card-\d+$/, 'Islands carry a stable short name')
    // A token replaces one literal: only that field is disabled, with its reason.
    writeFileSync(
      file,
      code.replace('const SOFTNESS = 20;', "const SOFTNESS = 'var(--shadow-softness)';")
    )
    await nativeIslands.refresh(chat)
    await until((view) => view.status === 'partially-disabled')
    assert.deepEqual((await inspect()).disabledFields, ['blur'])
    // The declarations are gone: the whole island is disabled, with one plain line.
    writeFileSync(
      file,
      code
        .replace(/^const (LIGHT_X|LIGHT_Y|SOFTNESS|EASING) = [^\n]*\n/gm, '')
        .replace(/LIGHT_X|LIGHT_Y/g, '0')
        .replace(/SOFTNESS/g, '20')
    )
    await nativeIslands.refresh(chat)
    await until((view) => view.status === 'disabled' && view.disabledBy === 'code')
    const disabled = await inspect()
    assert.equal(disabled.reason, 'The code these controls edited is no longer in island-light.js.')
    assert.doesNotMatch(disabled.reason, RAW)
    assert.equal(disabled.disabledFields.length, 4)
    await capture('chat-island-disabled.png')
    // Hide leaves a one-line placeholder; Show all hidden brings the island back.
    await host.request('islandPerform', { island, action: 'hide' })
    await until((view) => view.status === 'hidden')
    await capture('chat-island-hidden.png')
    await host.request('islandPerform', { island, action: 'show-hidden' })
    await until((view) => view.status === 'disabled')
    // Disable by the user, then Enable once the code supports the controls again.
    writeFileSync(file, code)
    await nativeIslands.refresh(chat)
    await until((view) => view.status === 'ready')
    await host.request('islandPerform', { island, action: 'disable' })
    await until((view) => view.status === 'disabled' && view.disabledBy === 'user')
    assert.doesNotMatch((await inspect()).reason, RAW)
    await host.request('islandPerform', { island, action: 'enable' })
    await until((view) => view.status === 'ready')
  } finally {
    writeFileSync(file, code)
  }
}
