import type { NativeBridge } from './bridge'

/** Window activation is asynchronous; revealing a chat island alone is not readiness. */
export async function captureForegroundChat(host: NativeBridge): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    await preparePreviewInput(host, true)
    try {
      return await host.request('captureVisibleChat')
    } catch (error) {
      // Readiness cannot hold focus across ScreenCaptureKit's asynchronous work.
      // Swift rejects those pixels; reacquire and take an entirely new capture.
      // The legacy test bridge exposes only localized error strings.
      const foregroundLost =
        error instanceof Error &&
        (error.message === 'Chat window is not in the foreground' ||
          error.message === 'Chat lost foreground during capture')
      if (!foregroundLost || attempt === 3) throw error
      console.warn(`Visible chat capture lost foreground (attempt ${attempt}/3); reacquiring`)
    }
  }
}

/** Real WebKit input: page capture listeners are registered by the HTML fixture. */
export async function checkSelectionInput(
  host: NativeBridge,
  toolbarShown: (shown: ToolbarShown) => Promise<void>,
  lifecycleEvidence?: (state: unknown) => Promise<void>
): Promise<void> {
  const evaluate = (code: string, isolated = false) =>
    host.request('evaluate', { view: 'preview', code, isolated })
  const wait = async (code: string | (() => Promise<boolean>)): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if (await (typeof code === 'string' ? evaluate(code) : code())) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const state = await evaluate(`(() => {
      const el = document.querySelector('#native-title');
      const r = el?.getBoundingClientRect();
      return { focus: document.hasFocus(), active: document.activeElement?.tagName,
        cursor: document.documentElement.style.cursor, html: el?.outerHTML,
        hit: r && document.elementFromPoint(r.x+20,r.y+r.height/2)?.tagName };
    })()`)
    throw new Error(`Preview input timed out: ${code}; ${JSON.stringify(state)}`)
  }
  const input = async (payload: Record<string, unknown>) => {
    // App activation may change on a shared desktop; preserve WebKit's editing
    // responder while ensuring each real gesture reaches the test window.
    await preparePreviewInput(host, true)
    await wait('document.hasFocus()')
    return host.request('previewInput', payload)
  }
  await preparePreviewInput(host)
  await wait(`document.hasFocus()`)
  await wait(`document.documentElement.style.cursor === 'crosshair'`)
  await evaluate('window.previewInputs = []')
  // Synthetic events exercise the complete event family; real key/click input
  // below additionally verifies editing defaults and the trusted gesture path.
  const canceled = await evaluate(`(() => {
    const target = document.querySelector('#native-title');
    return ['keydown','keyup','keypress','pointerdown','mousedown','click','dblclick'].every(type =>
      !target.dispatchEvent(new Event(type, {bubbles:true,cancelable:true})));
  })()`)
  if (!canceled || (await evaluate('window.previewInputs.length')) !== 0)
    throw new Error('Selection input reached page capture listeners')
  const point = await evaluate(`(() => {
    const el = document.querySelector('#native-title'), r = el.getBoundingClientRect();
    const point = {x:r.x+20,y:r.y+r.height/2};
    if (document.elementFromPoint(point.x,point.y) !== el) throw new Error('Heading is not the pointer hit target');
    return point;
  })()`)
  await input(point)
  await wait(
    `document.querySelector('[data-trezi-overlay]')?.shadowRoot?.querySelector('[data-trezi-toolbar]')?.style.display === 'flex'`
  )
  await toolbarShown(await toolbarIcons(evaluate))
  await input({ ...point, clicks: 2 })
  await wait(`document.querySelector('#native-title').isContentEditable`)
  await input({ key: 'ArrowRight' })
  await wait(`getSelection().isCollapsed`)
  await input({ key: 'x' })
  await wait(`document.querySelector('#native-title').textContent === 'Native Trezi fixturex'`)
  if ((await evaluate('window.previewInputs.length')) !== 0)
    throw new Error('Inline editing leaked input to the preview app')
  await input({ key: 'Escape' })
  await wait(
    `!document.querySelector('#native-title').isContentEditable && document.documentElement.style.cursor !== 'crosshair'`
  )
  if (
    await evaluate(`document.querySelector('#native-title').textContent !== 'Native Trezi fixture'`)
  )
    throw new Error('Escape did not restore the inline text')
  await input(point)
  await input({ key: 'ArrowRight' })
  await wait(`window.previewInputs.includes('keydown') && window.previewInputs.includes('click')`)
  await host.request('shellPerform', { action: 'select-object' })
  await wait(`document.documentElement.style.cursor === 'crosshair'`)
  await input({ ...point, clicks: 2 })
  await wait(`document.querySelector('#native-title').isContentEditable`)
  await input({ key: 'Enter' })
  await wait(`!document.querySelector('#native-title').isContentEditable`)
  // A blocked pointer-down must not strand editing until an app switch blurs it.
  // Keep this native path source-neutral; the focused unit regression verifies
  // changed-text commit payloads, and text-edit checks persistence/undo/redo.
  await input({ ...point, clicks: 2 })
  await wait(`document.querySelector('#native-title').isContentEditable`)
  const other = await evaluate(`(() => {
    const el = document.querySelector('p'), r = el.getBoundingClientRect();
    const point = {x:r.right-20,y:r.y+r.height/2};
    if (document.elementFromPoint(point.x,point.y) !== el) throw new Error('Paragraph is not the pointer hit target');
    return point;
  })()`)
  await input(other)
  await wait(
    `!document.querySelector('#native-title').isContentEditable && getSelection().rangeCount === 0`
  )
  await wait(
    `document.querySelector('[data-trezi-overlay]')?.shadowRoot?.querySelector('[data-trezi-selbadge]')?.textContent.startsWith('p')`
  )
  const picked = await evaluate(`(() => {
    const root = document.querySelector('[data-trezi-overlay]').shadowRoot;
    return {badge:root.querySelector('[data-trezi-selbadge]').textContent,
      ranges:getSelection().rangeCount, editing:document.querySelector('#native-title').isContentEditable};
  })()`)
  // Exercise changed text with real WebKit input, without letting a source write
  // hot-reload the page between commit and selection. Intercept only this private
  // leaf's TEXT_EDIT in the isolated world; text-edit covers real writes/undo/redo.
  await evaluate(
    `(() => {
    const handler = window.webkit.messageHandlers.trezi;
    const original = handler.postMessage;
    window.__selectionEditFixture = {original, events:[]};
    handler.postMessage = function(message) {
      if (message.channel === 'trezi:preview:text-edit' && message.args?.[0]?.source === '__selection_fixture__.tsx:1:1') {
        window.__selectionEditFixture.events.push(message.args[0]);
        return;
      }
      return original.call(this, message);
    };
  })()`,
    true
  )
  let changed: unknown
  try {
    const leafPoint = await evaluate(`(() => {
      const leaf = document.createElement('div');
      leaf.id = 'selection-edit-fixture';
      leaf.setAttribute('data-trezi-source','__selection_fixture__.tsx:1:1');
      leaf.textContent = 'Controlled text';
      leaf.style.cssText = 'position:fixed;left:20px;bottom:100px;width:300px;height:40px';
      document.body.append(leaf);
      const r = leaf.getBoundingClientRect(), point = {x:r.x+20,y:r.y+20};
      if (document.elementFromPoint(point.x,point.y) !== leaf) throw new Error('Controlled leaf is not the pointer hit target');
      return point;
    })()`)
    await input({ ...leafPoint, clicks: 2 })
    await wait(`document.querySelector('#selection-edit-fixture').isContentEditable`)
    await input({ key: 'ArrowRight' })
    await input({ key: 'x' })
    await wait(
      `document.querySelector('#selection-edit-fixture').textContent === 'Controlled textx'`
    )
    await input(other)
    await wait(
      `!document.querySelector('#selection-edit-fixture').isContentEditable && getSelection().rangeCount === 0`
    )
    await wait(
      `document.querySelector('[data-trezi-overlay]').shadowRoot.querySelector('[data-trezi-selbadge]')?.textContent.startsWith('p')`
    )
    const first = await evaluate(`window.__selectionEditFixture.events`, true)
    if (first.length !== 1 || first[0].text !== 'Controlled textx')
      throw new Error(`Changed outside-click commit failed: ${JSON.stringify(first)}`)

    await input({ ...leafPoint, clicks: 2 })
    await wait(`document.querySelector('#selection-edit-fixture').isContentEditable`)
    await input({ key: 'ArrowRight' })
    await input({ key: 'y' })
    await wait(
      `document.querySelector('#selection-edit-fixture').textContent === 'Controlled textxy'`
    )
    const before = await host.request('smokeFocusSnapshot')
    if (!(await host.request('smokeActivateFinder'))) throw new Error('Finder is not running')
    await wait(
      async () => (await host.request('smokeFocusSnapshot')).frontmostBundle === 'com.apple.finder'
    )
    const away = await host.request('smokeFocusSnapshot')
    await wait(`!document.hasFocus()`)
    const restored = await host.request('smokeFocus')
    if (!restored.focused) throw new Error(`Focus restore failed: ${JSON.stringify(restored)}`)
    await preparePreviewInput(host, true)
    await wait('document.hasFocus()')
    const returned = await host.request('smokeFocusSnapshot')
    const editingOnReturn = await evaluate(
      `document.querySelector('#selection-edit-fixture').isContentEditable`
    )
    const eventsOnReturn = await evaluate(`window.__selectionEditFixture.events`, true)
    // WebKit may retain the DOM editor across app activation. Enter must finish it
    // in either case, without duplicating a commit already delivered by blur.
    await input({ key: 'Enter' })
    await wait(`!document.querySelector('#selection-edit-fixture').isContentEditable`)
    await input({ ...leafPoint, clicks: 2 })
    await wait(`document.querySelector('#selection-edit-fixture').isContentEditable`)
    await input({ key: 'ArrowRight' })
    await input({ key: 'z' })
    await wait(
      `document.querySelector('#selection-edit-fixture').textContent === 'Controlled textxyz'`
    )
    await input(other)
    await wait(
      `!document.querySelector('#selection-edit-fixture').isContentEditable && getSelection().rangeCount === 0`
    )
    await wait(
      `document.querySelector('[data-trezi-overlay]').shadowRoot.querySelector('[data-trezi-selbadge]')?.textContent.startsWith('p')`
    )
    const events = await evaluate(`window.__selectionEditFixture.events`, true)
    if (
      events.length !== 3 ||
      events[1].text !== 'Controlled textxy' ||
      events[2].text !== 'Controlled textxyz'
    )
      throw new Error(`Blur/refocus/re-entry commit failed: ${JSON.stringify(events)}`)
    changed = { events, before, away, restored, returned, editingOnReturn, eventsOnReturn }
  } finally {
    await evaluate(
      `(() => {
      window.webkit.messageHandlers.trezi.postMessage = window.__selectionEditFixture.original;
      delete window.__selectionEditFixture;
    })()`,
      true
    )
    await evaluate(`document.querySelector('#selection-edit-fixture')?.remove()`)
  }
  await input({ ...point, clicks: 2 })
  await wait(`document.querySelector('#native-title').isContentEditable`)
  await host.request('shellPerform', { action: 'select-object' })
  await wait(
    `!document.querySelector('#native-title').isContentEditable && document.documentElement.style.cursor !== 'crosshair'`
  )
  const exited = await evaluate(`(() => {
    const root = document.querySelector('[data-trezi-overlay]').shadowRoot;
    return {ranges:getSelection().rangeCount, boxes:root.querySelectorAll('[data-trezi-selbox]').length,
      toolbar:root.querySelector('[data-trezi-toolbar]').style.display};
  })()`)
  if (exited.ranges !== 0 || exited.boxes !== 0 || exited.toolbar !== 'none')
    throw new Error(`Selection exit left UI behind: ${JSON.stringify(exited)}`)
  await lifecycleEvidence?.({ picked, changed, exited })
  await host.request('shellPerform', { action: 'select-object' })
  await wait(`document.documentElement.style.cursor === 'crosshair'`)
  await input({ ...point, clicks: 2 })
  await wait(`document.querySelector('#native-title').isContentEditable`)
  await input({ key: 'Escape' })
  await wait(`!document.querySelector('#native-title').isContentEditable`)
  console.log(
    'Native selection blocks page input; inline caret movement and normal interaction passed.'
  )
}

/** LKM-218: every element toolbar tool has its own glyph in the shared 24 px, 2 px stroke style. */
type ToolbarIcon = { kind: string; svg: string; size: string; box: string; stroke: string }
export type ToolbarShown = { icons: ToolbarIcon[]; rect: Record<string, number> }
async function toolbarIcons(evaluate: (code: string) => Promise<any>): Promise<ToolbarShown> {
  const root = `document.querySelector('[data-trezi-overlay]').shadowRoot`
  const icons: ToolbarIcon[] =
    await evaluate(`[...${root}.querySelectorAll('[data-trezi-toolbar] button[data-kind]')].map((b) => {
        const svg = b.querySelector('svg');
        return { kind: b.dataset.kind, svg: svg.innerHTML, size: svg.getAttribute('width') + 'x' + svg.getAttribute('height'),
          box: svg.getAttribute('viewBox'), stroke: svg.getAttribute('stroke-width') };
      })`)
  // Where the toolbar is when the capture is taken, so the artifact proves it was showing.
  const rect = await evaluate(`(() => {
    const r = ${root}.querySelector('[data-trezi-toolbar]').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  })()`)
  if (!(rect.width > 0 && rect.height > 0))
    throw new Error(`Element toolbar has no size: ${JSON.stringify(rect)}`)
  for (const kind of ['three-d', 'states'])
    if (!icons.some((icon) => icon.kind === kind)) throw new Error(`Element toolbar has no ${kind}`)
  for (const icon of icons)
    if (icon.size !== '15x15' || icon.box !== '0 0 24 24' || icon.stroke !== '2')
      throw new Error(
        `Element toolbar icon ${icon.kind} breaks the shared style: ${JSON.stringify(icon)}`
      )
  const shared = icons.filter((icon, i) => icons.findIndex((other) => other.svg === icon.svg) !== i)
  if (shared.length)
    throw new Error(`Element toolbar tools share a glyph: ${shared.map((icon) => icon.kind)}`)
  return { icons, rect }
}

/** Restore the main test window after auxiliary windows before paint/input checks. */
export async function preparePreviewInput(
  host: NativeBridge,
  preserveResponder = false
): Promise<void> {
  let ready: any
  for (let i = 0; i < 100; i++) {
    ready = await host.request('previewInput', { prepare: true, preserveResponder })
    if (ready.active && ready.key && ready.focused && ready.visible) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!ready?.active || !ready.key || !ready.focused || !ready.visible)
    throw new Error(
      `Native preview input could not acquire the foreground window: ${JSON.stringify(ready)}`
    )
}
