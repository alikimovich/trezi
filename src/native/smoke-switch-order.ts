import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectEntry } from '../shared/workspace'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const distinct = (keys: (string | null)[]) => keys.filter((key, i) => key !== keys[i - 1])

/** LKM-204: a sidebar pick is one direct transition. The host records the projects its
 *  sidebar highlighted and its window showed, Bun the active project of every state it
 *  rendered: A → B must read [A, B], and rapid A → B → C must end on C with nothing after it. */
export async function checkSwitchOrder(
  host: NativeBridge,
  fixture: string,
  first: ProjectEntry,
  second: ProjectEntry,
  artifacts: string
) {
  const thirdRoot = join(fixture, '../Folder Delta')
  mkdirSync(thirdRoot, { recursive: true })
  writeFileSync(join(thirdRoot, 'index.html'), '<h1 id="third-project">Third project</h1>')
  await nativeWorkspace.command({ type: 'open', root: thirdRoot })
  const third = nativeWorkspace.active!
  const selectors = new Map([
    [first.key, '#native-title'],
    [second.key, '#second-project'],
    [third.key, '#third-project']
  ])
  const settled = (entry: ProjectEntry) =>
    waitFor(
      async () => {
        const shell = await host.request('shellInspect')
        return (
          nativeWorkspace.active?.key === entry.key &&
          nativeWorkspace.state.status.kind === 'running' &&
          nativeChat.active === entry.activeSessionKey &&
          shell.selected === `chat:${entry.activeSessionKey}` &&
          (await host.request('evaluate', {
            view: 'preview',
            code: `!!document.querySelector('${selectors.get(entry.key)}')`
          })) &&
          shell
        )
      },
      `${entry.name} shown`,
      20000,
      () => ({ active: nativeWorkspace.state.activeKey, status: nativeWorkspace.state.status })
    )
  const pick = (entry: ProjectEntry) =>
    host.request('shellPerform', { action: 'select-row', row: `project:${entry.key}` })
  const rendered: (string | null)[] = []
  const render = nativeWorkspace.services.render
  nativeWorkspace.services.render = (state) => {
    rendered.push(state.activeKey)
    render(state)
  }
  const send = host.send
  let shell: Record<string, unknown> | undefined
  host.send = (method, data = {}) => {
    if (method === 'shellState') shell = (data as { state: Record<string, unknown> }).state
    return send.call(host, method, data)
  }
  const evidence: Record<string, unknown> = {}
  try {
    assert.equal(await pick(first), true)
    await settled(first)
    // A → B, held at B's "Opening …" so the transition itself is visible.
    const original = nativeWorkspace.services.invoke
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    nativeWorkspace.services.invoke = async (channel, ...args) => {
      if (channel === 'project:detect' && args[0] === second.root) await held
      return original(channel, ...args)
    }
    try {
      await host.request('shellPerform', { action: 'selection-trail-reset' })
      rendered.length = 0
      rendered.push(nativeWorkspace.state.activeKey)
      assert.equal(await pick(second), true)
      evidence.opening = await waitFor(async () => {
        const shell = await host.request('shellInspect'),
          status = nativeWorkspace.state.status
        return (
          nativeWorkspace.state.activeKey === second.key &&
          status.kind === 'busy' &&
          status.label.startsWith('Opening') &&
          shell.sidebarTrail.at(-1) === second.key &&
          shell.windowTrail.at(-1) === second.key && {
            status,
            sidebarTrail: shell.sidebarTrail,
            windowTrail: shell.windowTrail
          }
        )
      }, 'B selected and shown while it opens')
      writeFileSync(
        join(artifacts, 'switch-order-opening.png'),
        Buffer.from(await host.request('captureShell'), 'base64')
      )
    } finally {
      release()
      nativeWorkspace.services.invoke = original
    }
    await settled(second)
    await delay(400)
    const single = await host.request('shellInspect')
    evidence.single = {
      sidebar: single.sidebarTrail,
      window: single.windowTrail,
      rendered: distinct(rendered)
    }
    assert.deepEqual(
      single.sidebarTrail,
      [first.key, second.key],
      'Sidebar: A then B, no A after B'
    )
    assert.deepEqual(single.windowTrail, [first.key, second.key], 'Window: A then B, no A after B')
    assert.deepEqual(distinct(rendered), [first.key, second.key], 'States: A then B')
    writeFileSync(
      join(artifacts, 'switch-order.png'),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
    // Rapid A → B → C: two picks before B has opened.
    assert.equal(await pick(first), true)
    await settled(first)
    await host.request('shellPerform', { action: 'selection-trail-reset' })
    rendered.length = 0
    rendered.push(nativeWorkspace.state.activeKey)
    assert.equal(await pick(second), true)
    assert.equal(await pick(third), true)
    await settled(third)
    await delay(600)
    const rapid = await host.request('shellInspect')
    const trails = {
      sidebar: rapid.sidebarTrail as string[],
      window: rapid.windowTrail as string[],
      rendered: distinct(rendered) as string[]
    }
    evidence.rapid = trails
    for (const [name, trail] of Object.entries(trails)) {
      assert.equal(trail[0], first.key, `${name}: starts on A`)
      assert.equal(trail.at(-1), third.key, `${name}: ends on C`)
      assert.equal(trail.indexOf(third.key), trail.length - 1, `${name}: nothing after C`)
    }
    writeFileSync(
      join(artifacts, 'switch-order-rapid.png'),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
    // A state older than the pick whose rows changed reloads the outline: the picked
    // row must stay highlighted, not blink to nothing until a newer state answers.
    const latest = shell!
    const rows = latest.rows as { title: string }[]
    await host.request('shellPerform', { action: 'selection-trail-reset' })
    host.send('shellState', {
      state: {
        ...latest,
        selection: -1,
        rows: rows.map((row, i) => (i ? row : { ...row, title: `${row.title} ` }))
      }
    })
    const reloaded = (await host.request('shellInspect')).sidebarTrail
    host.send('shellState', { state: latest })
    evidence.staleReload = reloaded
    assert.deepEqual(reloaded, [third.key], 'Sidebar: a stale reload keeps C highlighted')
    assert.equal(await pick(first), true)
    await settled(first)
  } finally {
    host.send = send
    nativeWorkspace.services.render = render
    writeFileSync(join(artifacts, 'switch-order.json'), JSON.stringify(evidence, null, 2))
    await nativeWorkspace.command({ type: 'close', key: third.key })
  }
  console.log('Native project switch order: A → B is [A, B]; rapid A → B → C ends on C.')
}
