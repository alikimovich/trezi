import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { PROJECT_MENU, restoreSidebarFocus } from './smoke-sidebar'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

/**
 * LKM-388: the project row's "…" and New chat are the same control, and History lives behind the
 * "…" menu. Runs at the end of `checkVisibleSidebar`, in its three projects: `full` and `other`
 * get seeded closed chats (four and one), `empty` has none. The rows, menu and project isolation
 * are asserted; the `sidebar-history-*.png` captures are what a person inspects. A real archive
 * and reopen through History is in `smoke-sidebar-chats.ts`.
 */
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Shell = any

const ACTION_KEYS = ['bordered', 'bezel', 'imageOnly']
const ACTION_STATES = ['alpha', 'tint', 'enabled', 'focusRing', 'highlighted', 'role']
const closed = (project: string, index: number) => ({
  id: `sidebar-history-${project}-${index}`,
  title: `Closed chat ${index + 1}`,
  startedAt: Date.now() - (index + 1) * 86400000,
  transcript: []
})

export async function checkSidebarHistory(
  host: NativeBridge,
  artifacts: string,
  { full, other, empty }: { full: string; other: string; empty: string }
) {
  const { history, projects } = nativeWorkspace.state
  const saved = new Map([full, other, empty].map((key) => [key, history[key]]))
  const home = nativeWorkspace.state.activeKey
  // Activating a project lists its closed chats again, so the seed answers that list too.
  const seeded = new Map([
    [full, [0, 1, 2, 3].map((index) => closed(full, index))],
    [other, [closed(other, 0)]],
    [empty, []]
  ])
  const original = nativeWorkspace.services.invoke
  const shell = (): Promise<Shell> => host.request('shellInspect')
  const verify = (command = {}): Promise<Shell> => host.request('sidebarVerification', command)
  const perform = (action: string, row: string) => host.request('shellPerform', { action, row })
  const menu = (key: string, command = {}) => verify({ menu: `project:${key}`, ...command })
  const rows = (state: Shell, ...kinds: string[]): Shell[] =>
    (state.sidebarChats ?? []).filter((item: Shell) => kinds.includes(item.kind))

  const select = async (key: string) => {
    assert.equal(await perform('select-row', `project:${key}`), true, `selected ${key}`)
    await waitFor(() => nativeWorkspace.active?.key === key, `project ${key} active`)
  }
  /** The nested History rows settle on what the project shows, and `open` lists who revealed it. */
  const expectHistory = (stage: string, key: string, shown: number, open: string[]) =>
    waitFor(
      async () => {
        const state = await shell()
        const items = rows(state, 'history-toggle', 'history', 'history-more')
        return (
          JSON.stringify(state.historyOpen) === JSON.stringify([...open].sort()) &&
          items.every((item) => item.project === key) &&
          rows(state, 'history').length === shown &&
          rows(state, 'history-toggle').length === (shown ? 1 : 0) &&
          state
        )
      },
      `History ${stage}`,
      10000,
      async () => (await shell()).sidebarChats
    )
  const capture = async (name: string, extra: Shell = {}) => {
    if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
      console.log(`Sidebar history: background run, ${name} not captured.`)
      return
    }
    const image = await host.request('captureVisibleSidebar')
    const stem = `sidebar-history-${name}`
    writeFileSync(join(artifacts, `${stem}.png`), Buffer.from(image.png, 'base64'))
    const state = { ...(await verify()), sidebarChats: (await shell()).sidebarChats, ...extra }
    writeFileSync(join(artifacts, `${stem}.json`), JSON.stringify(state, null, 2))
  }
  /** Both controls of a project row, in the current state: one geometry, one set of states. */
  const assertActionsMatch = (state: Shell, key: string, stage: string) => {
    const row = state.rows.find((item: Shell) => item.id === `project:${key}`)
    assert.ok(row, `${stage}: project row ${key}`)
    for (const name of [...ACTION_KEYS, ...ACTION_STATES])
      assert.equal(
        row.more[name],
        row.newChat[name],
        `${stage}: "…" and New chat differ on ${name}`
      )
    assert.doesNotMatch(row.more.class, /PopUp/, `${stage}: "…" is a plain button, not a pop-up`)
    assert.equal(row.more.bordered, false, `${stage}: "…" has no pill`)
    assert.ok(Math.abs(row.more.width - row.newChat.width) <= 1, `${stage}: hit target width`)
    assert.ok(row.more.hitHeight >= row.newChat.hitHeight, `${stage}: "…" hit target is shorter`)
    assert.equal(row.more.role, 'AXButton', `${stage}: VoiceOver reads "…" as a button`)
    assert.equal(row.more.label, `Actions for ${row.title}`, `${stage}: "…" label`)
    assert.equal(row.newChat.label, `New chat in ${row.title}`, `${stage}: New chat label`)
    return row
  }

  try {
    await perform('sidebar-width', '260')
    nativeWorkspace.services.invoke = async (channel, ...args) => {
      const key = projects.find((entry) => entry.root === args[0])?.key
      const records = channel === 'sessions:list' && key && seeded.get(key)
      return records ? (records as never) : original(channel, ...args)
    }
    for (const [key, records] of seeded) history[key] = records as never
    nativeWorkspace.changed()
    await select(full)
    await waitFor(
      async () => (await shell()).rows.filter((row: Shell) => row.kind === 'history').length >= 5,
      'seeded closed chats in the rows'
    )

    // Default: no History row, and "…" matches New chat at rest, hovered and focused.
    await expectHistory('default', full, 0, [])
    await restoreSidebarFocus(host, 'History default')
    assert.equal(assertActionsMatch(await verify(), full, 'idle').more.alpha, 1)
    await capture('default')
    await capture('header-idle')
    const hovered = assertActionsMatch(await verify({ hover: `project:${other}` }), other, 'hover')
    assert.equal(hovered.more.alpha, 1, 'hover shows the actions')
    await capture('header-hover')
    await verify({ hover: '' })
    const focus = await verify({ focus: full, control: 'more' })
    const focusNew = await verify({ focus: full, control: 'new-chat' })
    assert.equal(focus.focused, focusNew.focused, '"…" and New chat take focus alike')
    await verify({ focus: full, control: 'more' })
    assertActionsMatch(await verify(), full, 'focus')
    await capture('header-focus', { focus })
    await restoreSidebarFocus(host, 'header focus')

    // The menu offers Show History; a capture of its own window is evidence, not an assertion.
    const open = await menu(full, { capture: true })
    assert.deepEqual(open.titles, PROJECT_MENU)
    assert.deepEqual(open.states, PROJECT_MENU)
    assert.ok(open.opened && open.closed, 'the "…" press opened and closed the menu')
    if (open.shot?.png)
      writeFileSync(
        join(artifacts, 'sidebar-history-menu.png'),
        Buffer.from(open.shot.png, 'base64')
      )
    else console.log(`Sidebar history: menu not captured: ${open.shotError}`)
    writeFileSync(
      join(artifacts, 'sidebar-history-menu.json'),
      JSON.stringify({ ...open, shot: undefined }, null, 2)
    )
    await restoreSidebarFocus(host, 'History menu')

    // Show History reveals this project's closed chats and the count, and only here.
    await menu(full, { pick: 'Show History' })
    const revealed = await expectHistory('revealed', full, 3, [full])
    const [header] = rows(revealed, 'history-toggle')
    assert.equal(header.label, 'History, 4 closed chats, expanded', 'the header keeps the count')
    assert.equal(rows(revealed, 'history-more')[0]?.title, 'Show 1 more')
    assert.ok(
      rows(revealed, 'chat').some((item) => item.selected),
      'revealing History keeps the selected chat'
    )
    await restoreSidebarFocus(host, 'History revealed')
    await capture('revealed')
    assert.equal((await menu(full)).titles[1], 'Hide History')
    await restoreSidebarFocus(host, 'History revealed menu')

    // Multiple projects: the other project stays default, and revealing it from its own "…"
    // selects it, leaves the first as it was and hides on its own.
    await select(other)
    await expectHistory('other project', other, 0, [full])
    assert.equal((await menu(other)).titles[1], 'Show History')
    await restoreSidebarFocus(host, 'other project')
    await capture('projects')
    await select(full)
    await expectHistory('back on the first project', full, 3, [full])
    await menu(other, { pick: 'Show History' })
    await waitFor(() => nativeWorkspace.active?.key === other, 'Show History selected its project')
    const both = await expectHistory('other revealed', other, 1, [full, other])
    assert.equal(rows(both, 'history-more').length, 0, 'one closed chat needs no "Show N more"')
    await restoreSidebarFocus(host, 'other revealed')
    await capture('projects-both')
    await menu(other, { pick: 'Hide History' })
    await expectHistory('other hidden', other, 0, [full])
    await select(full)
    await expectHistory('first keeps its state', full, 3, [full])

    // Hidden again, from the header and from the menu, returns to the default sidebar.
    assert.equal(await perform('history-more', ''), true, 'Show more pressed')
    await waitFor(
      async () => rows(await shell(), 'history').length === 4,
      'every closed chat shown'
    )
    assert.equal(await perform('history-toggle', ''), true, 'History header pressed')
    await expectHistory('hidden from the header', full, 0, [])
    await menu(full, { pick: 'Show History' })
    await expectHistory('the next reveal starts at the preview', full, 3, [full])
    await menu(full, { pick: 'Hide History' })
    const hidden = await expectHistory('hidden from the menu', full, 0, [])
    assert.deepEqual(hidden.historyAll, [], 'hiding returns to the default')
    await restoreSidebarFocus(host, 'History hidden again')
    await capture('hidden-again')

    // No closed chats: nothing to show, so the selected project's item is disabled.
    await select(empty)
    await expectHistory('empty', empty, 0, [])
    const none = await menu(empty, { pick: 'Show History' })
    assert.deepEqual(none.titles, PROJECT_MENU)
    assert.equal(none.states[1], 'Show History (disabled)')
    await expectHistory('the disabled item does nothing', empty, 0, [])
    await restoreSidebarFocus(host, 'empty History')
    await capture('empty')
  } finally {
    for (const key of (await shell()).historyOpen ?? [])
      await menu(key, { pick: 'Hide History' }).catch(() => {})
    nativeWorkspace.services.invoke = original
    for (const [key, records] of saved) {
      if (records) history[key] = records
      else delete history[key]
    }
    nativeWorkspace.changed()
    if (home) await select(home).catch(() => {})
  }
}
