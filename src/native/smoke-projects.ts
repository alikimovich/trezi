import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectEntry } from '../shared/workspace'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { dispatchIPC, serviceEvents } from './platform'
import { checkVisibleSidebar } from './smoke-sidebar'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

/** Exercise AppKit's selection callback through the real host/backend bridge. */
export async function checkProjectSwitching(
  host: NativeBridge,
  fixture: string,
  artifacts: string
) {
  const first = nativeWorkspace.active!
  const secondRoot = join(fixture, '../Folder Beta')
  mkdirSync(secondRoot, { recursive: true })
  writeFileSync(join(secondRoot, 'index.html'), '<h1 id="second-project">Second project</h1>')
  // Leave this project without artwork to cover the former animal fallback.
  await nativeWorkspace.command({ type: 'open', root: secondRoot })
  const second = nativeWorkspace.active!
  assert.notEqual(first.key, second.key)
  const selections: object[] = []
  for (const entry of [first, second, first]) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      await host.request('shellPerform', { action: 'select-row', row: `project:${entry.key}` }),
      true
    )
    const deadline = Date.now() + 10000
    let switched = false
    while (Date.now() < deadline) {
      const shell = await host.request('shellInspect')
      const selector = entry === first ? '#native-title' : '#second-project'
      const preview = await host.request('evaluate', {
        view: 'preview',
        code: `!!document.querySelector('${selector}')`
      })
      if (
        nativeWorkspace.active?.key === entry.key &&
        nativeChat.active === entry.activeSessionKey &&
        shell.selected === `chat:${entry.activeSessionKey}` &&
        preview
      ) {
        switched = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    assert.ok(switched, `Sidebar selection must activate project, chat and preview: ${entry.name}`)
    selections.push({
      project: entry.key,
      chat: entry.activeSessionKey,
      previewSelector: entry === first ? '#native-title' : '#second-project',
      switched
    })
  }
  writeFileSync(join(artifacts, 'sidebar-selection.json'), JSON.stringify(selections, null, 2))
  await checkVisibleSidebar(host, artifacts)
  await host.request('shellPerform', { action: 'select-row', row: `project:${first.key}` })
  let restored = false
  for (let i = 0; i < 100; i++) {
    if (
      nativeWorkspace.active?.key === first.key &&
      nativeChat.active === first.activeSessionKey &&
      (await host.request('evaluate', {
        view: 'preview',
        code: '!!document.querySelector("#native-title")'
      }))
    ) {
      restored = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  assert.ok(restored, 'Restore original project/chat/preview after sidebar checks')
  await checkSwitchDropsSelection(host, first, second, artifacts)
  await nativeWorkspace.command({ type: 'close', key: second.key })
}

/** LKM-172: the selection, its chat chip, the editing island and the page's selection and
 *  hover boxes belong to one project. A switch drops them all while "Opening …" still
 *  shows (the second project's open is held there), and coming back restores none. */
async function checkSwitchDropsSelection(
  host: NativeBridge,
  from: ProjectEntry,
  to: ProjectEntry,
  artifacts: string
) {
  const invoke = (channel: string, ...args: unknown[]) =>
    dispatchIPC('main', { type: 'invoke', channel, args })
  const send = (channel: string, ...args: unknown[]) =>
    dispatchIPC('main', { type: 'send', channel, args })
  // The shadow overlay's children: selection outlines, then the hover box (preload.ts).
  const overlay = () =>
    host.request('evaluate', {
      view: 'preview',
      code: `(() => {
        const root = document.querySelector('[data-trezi-overlay]')?.shadowRoot
        const shown = (el) => !!el && el.style.display !== 'none'
        return {
          page: !!document.querySelector('#native-title'),
          boxes: root ? [...root.querySelectorAll('[data-trezi-selbox]')].filter(shown).length : 0,
          hover: !!root && shown(root.children[1]),
          toolbar: !!root && shown(root.querySelector('[data-trezi-toolbar]'))
        }
      })()`
    })
  const chips = () =>
    [from, to].map((entry) => nativeChat.get(entry.activeSessionKey)?.context?.selection ?? null)
  const evidence: Record<string, unknown> = {}
  const layers = await invoke('layers:read'),
    heading = layers?.nodes?.find((n: { id?: string }) => n.id === 'native-title')
  assert.ok(heading, 'The first project shows its heading')
  const target = { path: heading.path, fingerprint: { tag: heading.tag, source: heading.source } }
  await send('layers:select', target)
  await waitFor(() => chips()[0], 'the picked heading as a chat chip')
  serviceEvents.emit('event', 'preview:toolbar-action', 'props')
  evidence.selected = await waitFor(async () => {
    const island = await host.request('inspectorInspect')
    return island.visible && island.title !== 'Project controls' && island
  }, 'the editing island open on the heading')
  await send('layers:hover', target)
  evidence.selectedPage = await waitFor(async () => {
    const page = await overlay()
    return page.boxes > 0 && page.hover && page.toolbar && page
  }, 'selection outline, toolbar and hover box in the page')
  const original = nativeWorkspace.services.invoke
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  nativeWorkspace.services.invoke = async (channel, ...args) => {
    if (channel === 'project:detect' && args[0] === to.root) await held
    return original(channel, ...args)
  }
  try {
    assert.equal(
      await host.request('shellPerform', { action: 'select-row', row: `project:${to.key}` }),
      true
    )
    const opening = () => {
      const status = nativeWorkspace.state.status
      return (
        nativeWorkspace.state.activeKey === to.key &&
        status.kind === 'busy' &&
        status.label.startsWith('Opening')
      )
    }
    await waitFor(opening, 'the second project held at Opening')
    evidence.opening = await waitFor(async () => {
      const island = await host.request('inspectorInspect'),
        page = await overlay()
      return (
        !island.visible &&
        island.title === 'Project controls' &&
        chips().every((chip) => chip === null) &&
        page.page &&
        !page.boxes &&
        !page.hover &&
        !page.toolbar && { island, page, chips: chips() }
      )
    }, 'island, chips and page boxes cleared while Opening shows')
    assert.ok(opening(), 'The checks ran while the second project was still opening')
    writeFileSync(
      join(artifacts, 'switch-selection-opening.png'),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
  } finally {
    release()
    nativeWorkspace.services.invoke = original
  }
  await waitFor(
    async () =>
      nativeWorkspace.active?.key === to.key &&
      (await host.request('evaluate', {
        view: 'preview',
        code: `!!document.querySelector('#second-project')`
      })),
    'the second project opened'
  )
  await host.request('shellPerform', { action: 'select-row', row: `project:${from.key}` })
  evidence.back = await waitFor(async () => {
    if (nativeWorkspace.active?.key !== from.key || nativeWorkspace.state.status.kind !== 'running')
      return false
    const island = await host.request('inspectorInspect'),
      page = await overlay()
    return (
      page.page &&
      !island.visible &&
      chips()[0] === null &&
      !page.boxes &&
      !page.toolbar && { island, page }
    )
  }, 'back in the first project, nothing restored')
  writeFileSync(join(artifacts, 'switch-selection.json'), JSON.stringify(evidence, null, 2))
  console.log(
    'Native project switch: selection, chat chip, editing island and page boxes cleared during Opening; none restored on return.'
  )
}
