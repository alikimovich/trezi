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
  toolbarShown: (icons: ToolbarIcon[]) => Promise<void>
): Promise<void> {
  const evaluate = (code: string, isolated = false) =>
    host.request('evaluate', { view: 'preview', code, isolated })
  const wait = async (code: string): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(code)) return
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
  console.log(
    'Native selection blocks page input; inline caret movement and normal interaction passed.'
  )
}

/** LKM-218: every element toolbar tool has its own glyph in the shared 24 px, 2 px stroke style. */
type ToolbarIcon = { kind: string; svg: string; size: string; box: string; stroke: string }
async function toolbarIcons(evaluate: (code: string) => Promise<any>): Promise<ToolbarIcon[]> {
  const icons: ToolbarIcon[] =
    await evaluate(`[...document.querySelector('[data-trezi-overlay]').shadowRoot
      .querySelectorAll('[data-trezi-toolbar] button[data-kind]')].map((b) => {
        const svg = b.querySelector('svg');
        return { kind: b.dataset.kind, svg: svg.innerHTML, size: svg.getAttribute('width') + 'x' + svg.getAttribute('height'),
          box: svg.getAttribute('viewBox'), stroke: svg.getAttribute('stroke-width') };
      })`)
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
  return icons
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
