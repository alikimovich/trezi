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
  #toolchain { margin-left: auto; font-size: 11px; opacity: .7; }
  #toolchain[data-preview="unsupported"], #toolchain[data-preview="broken"], #toolchain[data-preview="unavailable"] { opacity: 1; color: #b25e00; }
  #status { padding: 3px 10px; border-radius: 999px; font-weight: 600; background: color-mix(in srgb, CanvasText 10%, transparent); }
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
  body[data-status="setup"] #stage { display: none; }
  #project { margin: 0 14px 10px; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 10px; padding: 6px 12px; font-size: 12px; }
  #project summary { cursor: default; font-weight: 600; padding: 2px 0; }
  #project-body { max-height: 40vh; overflow: auto; }
  #project h3 { font-size: 12px; margin: 10px 0 4px; }
  #project ul { margin: 0; padding-left: 18px; }
  #project li { margin: 2px 0; }
  #project code, #project .muted { font: 11px ui-monospace, Menlo, monospace; }
  #project .muted { opacity: .65; }
  #project .blocker { color: #d0342c; }
</style>
</head>
<body data-status="building" data-generation="0">
<header><h1 id="name">Swift previews</h1><nav id="picker"></nav><span id="toolchain"></span><span id="status">Building…</span></header>
<main>
  <div id="stage" tabindex="0" aria-label="Component preview"><img id="frame" alt=""></div>
  <section id="problems" aria-live="polite"><h2 id="problem-title">Build failed</h2><ol id="problem-list"></ol><pre id="problem-output"></pre></section>
</main>
<details id="project"><summary id="project-summary">Project</summary><div id="project-body"></div></details>
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
    const labels = { building: 'Building…', ready: 'Ready', failed: 'Build failed', error: 'Not running', setup: 'No previews yet' }
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
      item.textContent = (d.module ? '[' + d.module + '] ' : '') + d.file + ':' + d.line + ':' + d.column + ': ' + d.message
      return item
    }))
    $('problem-output').textContent = errors.length ? '' : state.output
    $('footer').textContent = state.status === 'ready' ? state.message + ' Click the component to interact; keys go to it while it has focus.' : state.message
    // The toolchain the driver builds with (LKM-274): its name and whether #Preview expands.
    const tc = state.toolchain
    const preview = tc ? (tc.capability ? tc.capability.status : 'none') : ''
    const marks = { supported: '#Preview supported', unsupported: 'no #Preview', broken: '#Preview broken', unavailable: '#Preview not checked here', none: '' }
    $('toolchain').textContent = tc ? [(tc.toolchain ? tc.toolchain.label : 'No toolchain'), marks[preview]].filter(Boolean).join(' · ') : ''
    $('toolchain').title = tc ? tc.message : ''
    $('toolchain').dataset.preview = preview
    document.body.dataset.toolchain = preview
    renderProject(state)
  }

  // The project panel (LKM-273): containers, schemes, targets and the build plan.
  const el = (tag, text, className) => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  const list = (items) => {
    const ul = el('ul')
    ul.append(...items.map((item) => (typeof item === 'string' ? el('li', item) : item)))
    return ul
  }
  let projectShown = ''
  const renderProject = (state) => {
    const native = state.native
    const key = JSON.stringify([native, state.plan, state.build, state.manifest, state.toolchain])
    if (key === projectShown) return
    projectShown = key
    if (state.status === 'setup') $('project').open = true
    const containers = native ? native.containers : []
    const targets = containers.reduce((n, c) => n + c.targets.length, 0)
    $('project-summary').textContent = native
      ? 'Project: ' + containers.length + ' container' + (containers.length === 1 ? '' : 's') + ', ' + targets + ' target' + (targets === 1 ? '' : 's')
      : 'Project'
    const body = []
    const manifest = state.manifest
    body.push(el('h3', 'Manifest'))
    body.push(list([
      manifest.source === 'none' ? 'None yet.' : 'Using ' + (manifest.source === 'trezi' ? "Trezi's copy" : "the repo's") + ': ' + manifest.path,
      ...(manifest.treziPath ? ["Trezi's copy (wins, the repo stays untouched): " + manifest.treziPath] : [])
    ]))
    const tc = state.toolchain
    if (tc) {
      body.push(el('h3', 'Toolchain'))
      const t = tc.toolchain
      body.push(list([
        t ? t.label + ': ' + t.developerDir + ' (Swift ' + (t.swiftVersion || '?') + ', macOS SDK ' + (t.sdkVersion || '?') + ')' : 'None found.',
        'Why: ' + tc.reason,
        el('li', tc.message, tc.capability && tc.capability.status === 'supported' ? '' : 'blocker'),
        el('li', 'For Trezi only (DEVELOPER_DIR); xcode-select stays ' + (tc.systemDefault || 'unset') + '.', 'muted')
      ]))
    }
    if (!native) body.push(el('p', 'The project structure is read when this panel opens.', 'muted'))
    for (const error of native ? native.errors : []) body.push(el('p', error, 'muted'))
    for (const c of containers) {
      body.push(el('h3', c.kind + ' ' + c.path))
      const rows = []
      rows.push('Schemes (' + c.schemesFrom + '): ' + (c.schemes.join(', ') || 'none'))
      if (c.projects.length) rows.push('Projects: ' + c.projects.join(', '))
      if (c.packages.length) rows.push('Packages: ' + c.packages.map((p) => p.location).join(', '))
      for (const t of c.targets) {
        const item = el('li')
        item.append(el('code', t.name), ' ' + t.kind + (t.module !== t.name ? ' (module ' + t.module + ')' : '') + ', ' + t.sources.length + ' Swift files')
        if (t.dependencies.length) item.append(', depends on ' + t.dependencies.join(', '))
        if (t.packageProducts.length) item.append(', packages ' + t.packageProducts.join(', '))
        if (t.resources.length) item.append(', ' + t.resources.length + ' resources')
        for (const note of t.notes) item.append(el('div', note, 'muted'))
        rows.push(item)
      }
      for (const error of c.errors) rows.push(el('li', error, 'muted'))
      body.push(list(rows))
    }
    const plan = state.plan
    if (plan) {
      body.push(el('h3', 'Build plan for ' + plan.target + ' (' + plan.container + ')'))
      body.push(list([
        ...plan.modules.map((m) => m.module + ': ' + m.sources.length + ' files' + (m.dependencies.length ? ', links ' + m.dependencies.join(', ') : '') + (m.entries.length ? ', leaves out ' + m.entries.join(', ') : '')),
        ...plan.blockers.map((b) => el('li', b, 'blocker')),
        ...plan.warnings.map((w) => el('li', w, 'muted'))
      ]))
      // Build authority (LKM-275): resolved settings, dropped flags, dependencies, resources.
      const build = state.build
      const settings = plan.modules.filter((m) => m.settings)
      if (settings.length) {
        body.push(el('h3', 'Build settings'))
        body.push(list(settings.map((m) => {
          const s = m.settings
          const item = el('li')
          item.dataset.module = m.module
          item.append(el('code', m.module), ' from ' + ((build && build.settingsFrom[m.module]) || s.from) + ': Swift ' + (s.swiftVersion || 'default') + ', macOS ' + (s.deploymentTarget || 'default') + ', defines ' + (s.defines.join(' ') || 'none'))
          for (const d of s.dropped) item.append(el('div', 'Dropped ' + d.setting + ' ' + d.flag + ': ' + d.reason, 'muted dropped'))
          for (const note of s.notes) item.append(el('div', note, 'muted'))
          return item
        })))
      }
      const deps = plan.dependencies
      if (deps && (deps.packages.length || deps.binaries.length || deps.unsupported.length)) {
        body.push(el('h3', 'Dependencies'))
        body.push(list([
          ...deps.packages.map((p) => 'Package ' + p.identity + ' (' + p.kind + (p.pin ? ', pinned ' + (p.pin.version || p.pin.revision.slice(0, 12)) : '') + '): ' + p.products.join(', ')),
          ...deps.binaries.map((b) => 'Framework ' + b.framework + ': ' + b.path),
          ...deps.unsupported.map((u) => el('li', 'Not built: ' + u.name + ' (' + u.kind + '): ' + u.reason, u.required ? 'blocker unsupported' : 'muted unsupported')),
          ...(build && build.packages ? [el('li', 'Built in ' + build.packages.bin + (build.packages.cached ? ' (cached)' : ''), 'muted')] : [])
        ]))
      }
      const res = plan.resources
      if (res && (res.catalogs.length || res.copied.length || res.unsupported.length)) {
        body.push(el('h3', 'Resources'))
        body.push(list([
          ...res.catalogs.map((c) => 'Asset catalog ' + c.path + ' (actool)' + (build && build.resources && build.resources.symbols.includes(c.module) ? ', with asset symbols' : '')),
          ...res.copied.map((c) => 'Copied ' + c.path),
          ...res.unsupported.map((u) => el('li', 'Not bundled: ' + u.path + ': ' + u.reason, 'muted unsupported'))
        ]))
      }
      if (build) {
        const cached = build.modules.filter((m) => m.cached).length
        body.push(list([
          el('li', 'Derived data (Trezi-owned): ' + build.derivedData + '; ' + cached + ' of ' + build.modules.length + ' modules from cache', 'muted'),
          ...build.errors.map((e) => el('li', e, 'muted')),
          ...build.leftovers.map((p) => el('li', 'xcodebuild or SwiftPM left ' + p + ' in the project', 'blocker'))
        ]))
      }
    }
    $('project-body').replaceChildren(...body)
  }
  $('project').addEventListener('toggle', () => {
    if ($('project').open && api.state && !api.state.native) fetch('/graph', { cache: 'no-store' }).catch(() => {})
  })

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
          console.error('Swift preview build failed: ' + (first ? first.file + ':' + first.line + ': ' + first.message + (first.module ? ' (module ' + first.module + ')' : '') : state.message))
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
