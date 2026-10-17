/**
 * The page Trezi's preview shows for a Swift project: a preview picker, the selected
 * component's live frame, and the build state with compiler errors. Pointer, wheel
 * and key input on the frame is forwarded to the component. `token` authorizes the
 * page's input and rebuild requests.
 */
export function previewPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swift previews</title>
<style>
  :root { color-scheme: light dark; font: 13px -apple-system, system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: Canvas; color: CanvasText; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); flex-wrap: wrap; }
  header h1 { font-size: 13px; margin: 0 8px 0 0; font-weight: 600; }
  nav { display: flex; gap: 4px; flex-wrap: wrap; }
  nav button { font: inherit; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); background: transparent; color: inherit; border-radius: 6px; padding: 4px 10px; cursor: default; }
  nav button[aria-current="true"] { background: color-mix(in srgb, AccentColor 18%, transparent); border-color: AccentColor; }
  nav button small { opacity: .6; margin-left: 4px; }
  #status { margin-left: auto; padding: 3px 10px; border-radius: 999px; font-weight: 600; background: color-mix(in srgb, CanvasText 10%, transparent); }
  body[data-status="ready"] #status { background: color-mix(in srgb, #2e9d4f 22%, transparent); }
  body[data-status="building"] #status { background: color-mix(in srgb, #d18a00 25%, transparent); }
  body[data-status="failed"] #status, body[data-status="error"] #status { background: color-mix(in srgb, #d0342c 25%, transparent); }
  main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; gap: 24px; flex-wrap: wrap; }
  #stage { outline: none; border-radius: 10px; box-shadow: 0 0 0 1px color-mix(in srgb, CanvasText 14%, transparent), 0 8px 30px rgb(0 0 0 / .12); overflow: hidden; line-height: 0; user-select: none; -webkit-user-select: none; }
  #stage:focus-visible { box-shadow: 0 0 0 2px AccentColor, 0 8px 30px rgb(0 0 0 / .12); }
  #stage img { display: block; -webkit-user-drag: none; }
  body[data-stale="true"] #stage { opacity: .45; }
  #problems { display: none; max-width: 640px; flex: 1 1 360px; border: 1px solid #d0342c; border-radius: 10px; padding: 12px 14px; background: color-mix(in srgb, #d0342c 8%, Canvas); }
  body[data-status="failed"] #problems, body[data-status="error"] #problems { display: block; }
  #problems h2 { font-size: 13px; margin: 0 0 8px; color: #d0342c; }
  #problems ol { margin: 0; padding-left: 18px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  #problems li { margin: 4px 0; white-space: pre-wrap; }
  #problems pre { font: 11px ui-monospace, Menlo, monospace; white-space: pre-wrap; max-height: 220px; overflow: auto; opacity: .8; }
  footer { padding: 6px 14px; opacity: .6; font-size: 11px; }
</style>
</head>
<body data-status="building" data-generation="0">
<header><h1 id="name">Swift previews</h1><nav id="picker"></nav><span id="status">Building…</span></header>
<main>
  <div id="stage" tabindex="0" aria-label="Component preview"><img id="frame" alt=""></div>
  <section id="problems" aria-live="polite"><h2 id="problem-title">Build failed</h2><ol id="problem-list"></ol><pre id="problem-output"></pre></section>
</main>
<footer id="footer">Click the component to interact; keys go to it while it has focus.</footer>
<script>
(() => {
  const token = ${JSON.stringify(token)}
  const $ = (id) => document.getElementById(id)
  const params = new URLSearchParams(location.search)
  const api = { state: null, preview: params.get('preview') || '', frames: 0, failures: 0 }
  window.__treziSwiftPreview = api
  let shown = ''
  let queue = Promise.resolve()
  let reportedBuild = 0

  const send = (event) => {
    if (!api.preview) return
    const preview = api.preview
    queue = queue.then(() => fetch('/input?preview=' + encodeURIComponent(preview), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-trezi-token': token }, body: JSON.stringify(event)
    })).catch(() => {}).then(() => scheduleFrame(60))
  }

  let frameTimer = 0
  const scheduleFrame = (delay) => { clearTimeout(frameTimer); frameTimer = setTimeout(loadFrame, delay) }
  const loadFrame = () => {
    const state = api.state
    if (!state || !api.preview || state.status === 'error') return
    const preview = api.preview
    const src = '/frame?preview=' + encodeURIComponent(preview) + '&g=' + state.generation + '&t=' + Date.now()
    const next = new Image()
    next.onload = () => {
      if (preview !== api.preview) return
      const img = $('frame')
      img.src = next.src
      img.width = next.naturalWidth / 2
      img.height = next.naturalHeight / 2
      api.frames++
      document.body.dataset.frames = String(api.frames)
      document.body.dataset.shown = preview + '@' + state.generation
    }
    next.src = src
  }

  const select = (id) => {
    api.preview = id
    const url = new URL(location.href)
    url.searchParams.set('preview', id)
    history.replaceState(null, '', url)
    render()
    scheduleFrame(0)
  }
  api.select = select

  const render = () => {
    const state = api.state
    if (!state) return
    document.body.dataset.status = state.status
    document.body.dataset.generation = String(state.generation)
    document.body.dataset.stale = String(state.stale)
    document.body.dataset.preview = api.preview
    $('name').textContent = state.name || 'Swift previews'
    const labels = { building: 'Building…', ready: 'Ready', failed: 'Build failed', error: 'Not running' }
    $('status').textContent = labels[state.status] || state.status
    $('status').title = state.message
    const ids = state.previews.map((p) => p.id).join()
    if (ids !== shown) {
      shown = ids
      $('picker').replaceChildren(...state.previews.map((p) => {
        const button = document.createElement('button')
        button.dataset.preview = p.id
        button.append(p.title)
        const kind = document.createElement('small')
        kind.textContent = p.kind
        button.append(kind)
        button.onclick = () => select(p.id)
        return button
      }))
    }
    for (const button of $('picker').children) button.setAttribute('aria-current', String(button.dataset.preview === api.preview))
    const errors = state.diagnostics.filter((d) => d.severity === 'error')
    $('problem-title').textContent = state.message + (state.stale ? ' Showing the last good build.' : '')
    $('problem-list').replaceChildren(...errors.map((d) => {
      const item = document.createElement('li')
      item.textContent = d.file + ':' + d.line + ':' + d.column + ': ' + d.message
      return item
    }))
    $('problem-output').textContent = errors.length ? '' : state.output
    $('footer').textContent = state.status === 'ready' ? state.message + ' Click the component to interact; keys go to it while it has focus.' : state.message
  }

  const poll = async () => {
    try {
      const state = await (await fetch('/state', { cache: 'no-store' })).json()
      const previous = api.state
      api.state = state
      if (!state.previews.some((p) => p.id === api.preview) && state.previews.length) select(state.previews[0].id)
      render()
      if (state.status === 'failed' || state.status === 'error') {
        if (reportedBuild !== state.builds) {
          reportedBuild = state.builds
          api.failures++
          const first = state.diagnostics.find((d) => d.severity === 'error')
          console.error('Swift preview build failed: ' + (first ? first.file + ':' + first.line + ': ' + first.message : state.message))
        }
      }
      if (!previous || previous.generation !== state.generation) scheduleFrame(0)
    } catch {}
    setTimeout(poll, 400)
  }

  const stage = $('stage')
  const point = (e) => {
    const box = $('frame').getBoundingClientRect()
    return { x: e.clientX - box.left, y: e.clientY - box.top }
  }
  const modifiers = (e) => ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey })
  let pressed = -1
  stage.addEventListener('mousedown', (e) => {
    e.preventDefault()
    stage.focus()
    pressed = e.button
    send({ type: 'mousedown', ...point(e), button: e.button, clickCount: e.detail || 1, ...modifiers(e) })
  })
  window.addEventListener('mousemove', (e) => { if (pressed === 0 && e.buttons & 1) send({ type: 'mousedrag', ...point(e), ...modifiers(e) }) })
  window.addEventListener('mouseup', (e) => {
    if (pressed !== e.button) return
    pressed = -1
    send({ type: 'mouseup', ...point(e), button: e.button, clickCount: e.detail || 1, ...modifiers(e) })
  })
  stage.addEventListener('contextmenu', (e) => e.preventDefault())
  stage.addEventListener('wheel', (e) => { e.preventDefault(); send({ type: 'scroll', ...point(e), dx: e.deltaX, dy: e.deltaY }) }, { passive: false })
  for (const type of ['keydown', 'keyup']) stage.addEventListener(type, (e) => {
    if (e.metaKey && type === 'keydown' && ['r', 'w', 'q'].includes(e.key)) return
    e.preventDefault()
    send({ type, key: e.key, x: 0, y: 0, ...modifiers(e) })
  })
  setInterval(() => { if (document.visibilityState === 'visible' && api.state?.status !== 'building') scheduleFrame(0) }, 1000)
  poll()
})()
</script>
</body>
</html>`
}
