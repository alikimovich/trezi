import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'

type Page = (code: string) => Promise<unknown>
type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>
const PARAM = 'lkm219'

/**
 * LKM-219: the preview's Back/Forward. Two client-side routes (`pushState`), then ⌘[ and
 * ⌘] typed on a Russian layout (⌘ + key 33 reads "х", key 30 "ъ") through the window's
 * key equivalents and the main menu, ⌘← / ⌘→ outside text fields (and not in the
 * composer), the View menu's enabled state and the address bar after every step. A page
 * an agent opened (`preview:load` with `agent`) is never stepped to.
 */
export async function checkPreviewHistory(
  host: NativeBridge,
  page: Page,
  invoke: Invoke,
  start: string,
  artifacts: string
) {
  const evidence: State[] = []
  const state = async (label: string) => {
    const s = (await host.request('previewHistory')) as State
    evidence.push({ label, ...s, address: (await host.request('shellInspect')).address })
    return s
  }
  const key = async (keyCode: number, characters = '', focus?: string) =>
    (await host.request('previewHistory', { keyCode, characters, focus })) as State
  const route = (value: string) => {
    const url = new URL(start)
    url.searchParams.set(PARAM, value)
    return url.href
  }
  const at = async (value: string, label: string) => {
    await waitFor(
      async () =>
        (await page('location.href')) === route(value) &&
        (await host.request('shellInspect')).address === route(value),
      `${label}: the page and address bar at ${PARAM}=${value}`,
      10000
    )
    return state(label)
  }
  const push = (value: string) =>
    page(`(history.pushState(null, '', ${JSON.stringify(route(value))}), location.href)`)

  // Two routes: Back is possible, Forward is not.
  await push('a')
  await push('b')
  let s = await at('b', 'pushed a, b')
  assert.equal(s.gestures, true, 'the two-finger swipe navigates')
  assert.equal(s.canBack, true)
  assert.equal(s.canForward, false)
  assert.deepEqual(s.menu.Back, { enabled: true, key: '[', modifiers: 1 << 20 }, 'View → Back ⌘[')
  assert.deepEqual(s.menu.Forward, { enabled: false, key: ']', modifiers: 1 << 20 })

  // ⌘[ on a Russian layout ("х" on the [ key) goes Back; the address bar follows.
  let typed = await key(33, 'х')
  assert.ok(typed.handled && typed.latin === '[', `⌘х is ⌘[: ${JSON.stringify(typed)}`)
  s = await at('a', 'back with ⌘х')
  assert.equal(s.canForward, true)
  assert.equal(s.menu.Forward.enabled, true, 'View → Forward is enabled after a step back')
  typed = await key(30, 'ъ')
  assert.ok(typed.handled && typed.latin === ']', `⌘ъ is ⌘]: ${JSON.stringify(typed)}`)
  await at('b', 'forward with ⌘ъ')

  // ⌘← / ⌘→ outside text fields; in the composer they stay text navigation.
  assert.equal((await key(123)).handled, true, '⌘← steps back with no text field focused')
  await at('a', 'back with ⌘←')
  assert.equal((await key(124, '', 'composer')).handled, false, '⌘→ in the composer is text')
  assert.equal(await page('location.href'), route('a'))
  assert.equal((await key(124)).handled, true)
  await at('b', 'forward with ⌘→')

  // An agent's page is not the user's history: Back from a later route skips it.
  await invoke('preview:load', route('agent'), { agent: true })
  await waitFor(
    async () => (await state('agent page')).agentItems.includes(route('agent')),
    'the agent page to be marked',
    10000
  )
  await waitFor(
    async () => (await page('document.readyState')) === 'complete',
    'the agent page to load',
    10000
  )
  await push('c')
  await at('c', 'pushed c over the agent page')
  assert.ok((await key(33, 'х')).handled)
  s = await at('b', 'back skips the agent page')
  assert.ok((await key(30, 'ъ')).handled)
  s = await at('c', 'forward skips the agent page')
  assert.equal(s.agentItems.length, 1)
  writeFileSync(join(artifacts, 'preview-history.json'), JSON.stringify(evidence, null, 2))
  console.log(
    'Native preview history: pushState routes, ⌘[ / ⌘] as Russian ⌘х / ⌘ъ, ⌘← / ⌘→ outside fields, View menu state, address bar and agent pages skipped pass.'
  )
}

/** Back to the page the check started on. */
export async function restorePreviewHistory(page: Page, invoke: Invoke, start: string) {
  if (!start || (await page('location.href').catch(() => start)) === start) return
  await invoke('preview:load', start)
  await waitFor(async () => (await page('location.href')) === start, 'the start page', 10000)
}
