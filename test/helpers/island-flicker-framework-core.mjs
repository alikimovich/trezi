// Shared drag, departure counts and WebKit evaluate port for LKM-140 framework measurements.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { ChatIslands } from '../../src/main/chat-islands.ts'
import { IslandOverrides } from '../../src/main/island-overrides.ts'
import { enqueueRepoWrite } from '../../src/main/repo-write-queue.ts'
import { shadowLight } from '../../src/main/shadows.ts'

export const initial = {
  x: 0.72,
  y: -0.28,
  distance: 12,
  blur: 24,
  layers: 3,
  decay: 0.6,
  color: 'rgba(0, 0, 0, 0.35)'
}
export const keys = Object.keys(initial)
export const bounds = [
  [-1, 1],
  [-1, 1],
  [0, 64],
  [0, 80],
  [1, 8],
  [0, 1]
]
export const path = Array.from({ length: 12 }, (_, i) => [
  Number((0.2 + i * 0.04).toFixed(2)),
  Number((-0.3 + i * 0.03).toFixed(2))
])
export const derived = (x, y) => shadowLight({ ...initial, x, y }).css
export const steps = [shadowLight(initial).css, ...path.map(([x, y]) => derived(x, y))]

function shadowConstants(initialValues = initial) {
  return (
    keys.map((key) => `const SHADOW_${key} = ${JSON.stringify(initialValues[key])};`).join('\n') +
    `\nconst SHADOW_CSS = ${JSON.stringify(shadowLight(initialValues).css)};\n`
  )
}

export function islandSource(initialValues = initial, format = 'js') {
  const constants = shadowConstants(initialValues)
  const code =
    format === 'tsx'
      ? `'use client'\n\n${constants}\nexport default function ShadowPhone() {
  return (
    <div
      id="shadow-phone"
      style={{
        margin: '80px auto',
        padding: 40,
        width: 180,
        background: 'white',
        borderRadius: 20,
        boxShadow: SHADOW_CSS
      }}
    >
      Shadow phone
    </div>
  )
}
`
      : `${constants}\nexport const shadowCss = SHADOW_CSS;\n`
  return { code, request: buildRequest() }
}

export function buildRequest() {
  return {
    action: 'define',
    engine: 'agent',
    manifest: {
      file: '', // filled by caller
      component: 'Shadow',
      title: 'iPhone Frame Shadow',
      params: [
        ...keys.map((key, i) => ({
          id: key,
          label: key,
          kind: i === 6 ? 'color' : 'number',
          ...(i < 6 ? { min: bounds[i][0], max: bounds[i][1], step: i === 4 ? 1 : 0.01 } : {}),
          apply: { strategy: 'literal', anchor: `const SHADOW_${key} = ` }
        })),
        {
          id: 'output',
          label: 'CSS',
          kind: 'text',
          apply: { strategy: 'literal', anchor: 'const SHADOW_CSS = ' }
        }
      ]
    },
    blocks: [
      { id: 'shadow', title: 'Shadow', kind: 'shadow', output: 'css', params: [...keys, 'output'] }
    ]
  }
}

/** Every frame shows the derived value of the current or previous step, in drag order. */
export function departures(frames, computedSteps) {
  let last = -1
  let gaps = 0
  let outOfOrder = 0
  let foreign = 0
  for (const { step, shown } of frames) {
    if (step < 0) continue
    if (shown === 'none' || shown === '') {
      gaps++
      continue
    }
    let index = -1
    if (step < computedSteps.length && shown === computedSteps[step]) index = step
    else if (step > 0 && shown === computedSteps[step - 1]) index = step - 1
    if (index < 0) {
      foreign++
      continue
    }
    if (index < last) outOfOrder++
    last = Math.max(last, index)
  }
  return { gaps, outOfOrder, foreign }
}

// The harness evaluates in the page world, where the production isolated-world module is not
// reachable; it injects that same module (transpiled, never a hand-kept copy) instead.
const OVERRIDE_MODULE = new Bun.Transpiler({ loader: 'ts' })
  .transformSync(
    readFileSync(new URL('../../src/preview/island-override.ts', import.meta.url), 'utf8')
  )
  .replace(/^export /gm, '')
const OVERRIDE_BOOT = `(() => {
  if (window.__treziIslandOverride) return true;
  ${OVERRIDE_MODULE}
  window.__treziIslandOverride = {
    apply: (key, from, css) => islandOverride({ op: 'apply', key, from, css }),
    settle: (key, css) => islandOverride({ op: 'settle', key, css }),
    clear: key => islandOverride({ op: 'clear', key }),
    clearAll: () => islandOverride({ op: 'clearAll' }),
    holding: () => overrides.size > 0
  };
  return true;
})()`

const PAGE_SHADOW_LAYERS = String.raw`function shadowLayers(value) {
  const layers = [];
  let depth = 0, start = 0;
  for (let i = 0; i <= value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if ((c === ',' && depth === 0) || i === value.length) { layers.push(value.slice(start, i).trim()); start = i + 1; }
  }
  return layers.filter(l => !/^rgba\(0, 0, 0, 0\)( 0px){2,4}$/.test(l)).join(', ');
}`

const SELECTOR = '#shadow-phone'

async function pullFrames(page) {
  try {
    const batch = await page(`(() => {
      const frames = window.__shadowFrames;
      window.__shadowFrames = [];
      return Array.isArray(frames) ? frames : [];
    })()`)
    return batch
  } catch {
    return []
  }
}

function mergeFrames(nodeFrames, batch) {
  for (const row of batch) {
    if (!Array.isArray(row) || row.length < 2) continue
    nodeFrames.push({ step: row[0], shown: row[1] })
  }
}

async function spotSample(page, step, selector = SELECTOR) {
  try {
    return await page(`(() => {
      ${PAGE_SHADOW_LAYERS}
      const card = document.querySelector(${JSON.stringify(selector)});
      if (!card) return null;
      return { step: ${step}, shown: shadowLayers(getComputedStyle(card).boxShadow) };
    })()`)
  } catch {
    return null
  }
}

/** The card's computed shadow next to the computed form of `css`, read in the preview. */
function readShadow(page, css, selector = SELECTOR) {
  return page(`(() => {
    ${PAGE_SHADOW_LAYERS}
    const card = document.querySelector(${JSON.stringify(selector)});
    const probe = document.createElement('div');
    probe.style.boxShadow = ${JSON.stringify(css)};
    document.body.append(probe);
    const expected = shadowLayers(getComputedStyle(probe).boxShadow);
    probe.remove();
    return {
      href: location.href,
      card: !!card,
      shown: card ? shadowLayers(getComputedStyle(card).boxShadow) : null,
      inline: card ? card.style.getPropertyValue('box-shadow') + (card.style.getPropertyPriority('box-shadow') ? ' !important' : '') : null,
      expected
    };
  })()`)
}

/** Wait until the preview card's computed shadow matches the island's derived CSS (post-HMR). */
export async function waitForShadow(
  page,
  css,
  { selector = SELECTOR, timeoutMs = 20000, label = 'preview' } = {}
) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    try {
      last = await readShadow(page, css, selector)
      if (last?.card && last.expected !== 'none' && last.shown === last.expected) return last
    } catch (error) {
      last = { error: String(error?.message ?? error) }
    }
    if (Date.now() > deadline)
      throw new Error(
        `${label}: preview shadow did not match the island source within ${timeoutMs} ms; ` +
          `observed ${JSON.stringify(last)}, expected computed(${JSON.stringify(css)})`
      )
    await Bun.sleep(100)
  }
}

/** Wait until the dev server serves `css` (for Next, in the server-rendered HTML that hydration keeps). */
async function waitServed(served, css, label, timeoutMs = 60000) {
  if (!served) return
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    try {
      last = await served(css)
      if (last === true) return
    } catch (error) {
      last = String(error?.message ?? error)
    }
    if (Date.now() > deadline)
      throw new Error(
        `${label}: the dev server did not serve the island source within ${timeoutMs} ms; ` +
          `expected ${JSON.stringify(css)}, observed ${JSON.stringify(last)}`
      )
    await Bun.sleep(100)
  }
}

/** After a gesture, wait until settle succeeds and the card shows the final shadow. */
export async function waitForGestureSettled(page, css, { selector = SELECTOR, key } = {}) {
  const overrideKey = key ?? ''
  for (let i = 0; i < 240; i++) {
    try {
      const ok = await page(`(() => {
        ${PAGE_SHADOW_LAYERS}
        const css = ${JSON.stringify(css)};
        const key = ${JSON.stringify(overrideKey)};
        if (key && window.__treziIslandOverride?.settle) window.__treziIslandOverride.settle(key, css);
        const card = document.querySelector(${JSON.stringify(selector)});
        if (!card) return false;
        if (window.__treziIslandOverride?.holding?.()) return false;
        if (card.style.getPropertyPriority('box-shadow') === 'important') return false;
        const probe = document.createElement('div');
        probe.style.boxShadow = css;
        document.body.append(probe);
        const expected = shadowLayers(getComputedStyle(probe).boxShadow);
        probe.remove();
        return expected !== 'none' && shadowLayers(getComputedStyle(card).boxShadow) === expected;
      })()`)
      if (ok) return
    } catch {}
    await Bun.sleep(50)
  }
  const observed = await readShadow(page, css, selector).catch((error) => ({
    error: String(error?.message ?? error)
  }))
  const holding = await page('!!window.__treziIslandOverride?.holding?.()').catch(() => null)
  throw new Error(
    `Preview override did not settle after the gesture; holding ${holding}, ` +
      `observed ${JSON.stringify(observed)}, expected computed(${JSON.stringify(css)})`
  )
}

/** Island writes go through the repository queue; reset the fixture source the same way. */
export async function writeSourceFile(root, sourceFile, code) {
  const path = `${root}/${sourceFile}`
  await enqueueRepoWrite(root, async () => {
    await writeFile(path, code, 'utf8')
  })
}

/** Stop sampling and drop page-world override state before a fixture reload. */
export async function clearPreviewMeasurementState(page) {
  await page(OVERRIDE_BOOT)
  await page(`(() => {
    if (typeof window.__treziFlickerStop === 'function') window.__treziFlickerStop();
    window.__shadowStep = -1;
    window.__shadowFrames = [];
    const o = window.__treziIslandOverride;
    if (o?.clearAll) o.clearAll();
  })()`)
}

/**
 * Load the preview (cache-busted) once the dev server serves `css`, until the card shows it.
 * A reload that races the dev server's rebuild can get the last drag value, and hydration
 * does not patch a stale server-rendered style attribute (React keeps it), so that page may
 * never catch up: load again.
 */
export async function openOnSource(page, open, served, css, label) {
  const deadline = Date.now() + 60000
  for (let attempt = 1; ; attempt++) {
    await waitServed(served, css, label)
    await open()
    try {
      const shown = await waitForShadow(page, css, {
        timeoutMs: 5000,
        label: `${label} (load ${attempt})`
      })
      await waitForClientRender(page, css, `${label} (load ${attempt})`)
      return shown
    } catch (error) {
      if (Date.now() > deadline) throw error
    }
  }
}

/**
 * Next only: the server can render the new source while the browser still loads the old
 * client chunk. Hydration then keeps the server's attribute ("This won't be patched up")
 * but React holds the old props, so a later write of those old props changes nothing in
 * the DOM and the gesture never shows its final value. The hydrated props must render
 * `css` too; otherwise the load is retried.
 */
async function waitForClientRender(page, css, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await page(`(() => {
      // The server HTML names Next's chunks; window.next only exists after hydration.
      if (!document.querySelector('script[src*="/_next/"]')) return true;
      const card = document.querySelector(${JSON.stringify(SELECTOR)});
      const key = card && Object.keys(card).find((k) => k.startsWith('__reactProps$'));
      if (!key) return 'not hydrated';
      const props = card[key]?.style?.boxShadow;
      const computed = (value) => {
        const probe = document.createElement('div');
        probe.style.boxShadow = value;
        document.body.append(probe);
        const shown = getComputedStyle(probe).boxShadow;
        probe.remove();
        return shown;
      };
      return computed(props) === computed(${JSON.stringify(css)}) || String(props);
    })()`).catch((error) => String(error?.message ?? error))
    if (last === true) return
    if (Date.now() > deadline)
      throw new Error(
        `${label}: the hydrated client renders ${JSON.stringify(last)}, not the served shadow`
      )
    await Bun.sleep(100)
  }
}

/** After a live-write drag, put the preview back on the initial shadow before the override run. */
export async function resetPreviewSource(page, root, sourceFile, format, open, served) {
  await clearPreviewMeasurementState(page)
  const { code } = islandSource(initial, format)
  await writeSourceFile(root, sourceFile, code)
  await openOnSource(page, open, served, steps[0], 'reset')
  assert.equal(
    await readFile(`${root}/${sourceFile}`, 'utf8'),
    code,
    'reset: no island write lands after the reset'
  )
}

export async function installSampler(page, { fresh = false, selector = SELECTOR } = {}) {
  await page(OVERRIDE_BOOT)
  await page(`(() => {
    const sel = ${JSON.stringify(selector)};
    if (typeof window.__treziFlickerStop === 'function') window.__treziFlickerStop();
    window.__shadowStep = typeof window.__shadowStep === 'number' ? window.__shadowStep : -1;
    window.__shadowFrames = [];
    // A re-install (live writes reattach it after each step) keeps the run's swap count.
    if (${fresh} || typeof window.__hmrStyleSwaps !== 'number') { window.__hmrStyleSwaps = 0; window.__shadowLast = ''; }
    // A full reload (Vite without an HMR boundary) drops every window counter, so the run's
    // reloads are kept in sessionStorage: each new document is one swap of the preview (LKM-167).
    try {
      window.__treziDoc = window.__treziDoc || Math.random().toString(36).slice(2);
      const seen = sessionStorage.getItem('__treziDoc');
      const count = Number(sessionStorage.getItem('__treziReloads')) || 0;
      if (${fresh}) sessionStorage.setItem('__treziReloads', '0');
      else if (seen && seen !== window.__treziDoc) sessionStorage.setItem('__treziReloads', String(count + 1));
      sessionStorage.setItem('__treziDoc', window.__treziDoc);
    } catch {}
    let stopped = false;
    ${PAGE_SHADOW_LAYERS}
    const tick = () => {
      if (stopped) return;
      const card = document.querySelector(sel);
      if (card) {
        const shown = shadowLayers(getComputedStyle(card).boxShadow);
        if (window.__shadowLast && shown !== window.__shadowLast) window.__hmrStyleSwaps++;
        window.__shadowLast = shown;
        window.__shadowFrames.push([window.__shadowStep ?? -1, shown]);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__treziFlickerStop = () => { stopped = true; };
    return !!document.querySelector(sel);
  })()`)
}

export function makePreviewPort(page) {
  const boot = () => page(OVERRIDE_BOOT)
  return {
    apply: async (key, from, css) => {
      await boot()
      const n = await page(
        `window.__treziIslandOverride.apply(${JSON.stringify(key)}, ${JSON.stringify(from)}, ${JSON.stringify(css)})`
      )
      return typeof n === 'number' ? n : 0
    },
    settle: async (key, css) => {
      await boot()
      const done = await page(
        `window.__treziIslandOverride.settle(${JSON.stringify(key)}, ${JSON.stringify(css)})`
      )
      return typeof done === 'boolean' ? done : null
    },
    clear: async (key) => {
      await boot()
      return page(`window.__treziIslandOverride.clear(${JSON.stringify(key)})`)
    }
  }
}

export async function analyzeFrames(page, stepCss, nodeFrames) {
  const fromPage = await page(`(() => {
    ${PAGE_SHADOW_LAYERS}
    const probe = document.createElement('div');
    document.body.append(probe);
    const computedSteps = ${JSON.stringify(stepCss)}.map(css => {
      probe.style.boxShadow = css;
      return shadowLayers(getComputedStyle(probe).boxShadow);
    });
    probe.remove();
    const pulled = window.__shadowFrames;
    window.__shadowFrames = [];
    const raf = Array.isArray(pulled) ? pulled : [];
    let reloads = 0;
    try {
      reloads = Number(sessionStorage.getItem('__treziReloads')) || 0;
      // A document the sampler never ran in (a reload after the last step) counts too.
      const seen = sessionStorage.getItem('__treziDoc');
      if (seen && seen !== window.__treziDoc) reloads++;
    } catch {}
    return {
      computedSteps,
      raf,
      reloads,
      hmrStyleSwaps: typeof window.__hmrStyleSwaps === 'number' ? window.__hmrStyleSwaps : 0
    };
  })()`).catch(() => ({ computedSteps: [], raf: [], reloads: 0, hmrStyleSwaps: 0 }))
  const frames = [...nodeFrames]
  mergeFrames(frames, fromPage.raf)
  mergeFrames(frames, await pullFrames(page))
  return {
    computedSteps: fromPage.computedSteps?.length ? fromPage.computedSteps : [],
    frames,
    hmrStyleSwaps: fromPage.hmrStyleSwaps ?? 0,
    reloads: fromPage.reloads ?? 0
  }
}

export async function runDrag({
  page,
  islands,
  chat,
  island,
  sourceFile,
  initialCode,
  withOverrides,
  label,
  waitMs = 40
}) {
  const nodeFrames = []
  await installSampler(page, { fresh: true })
  mergeFrames(nodeFrames, await pullFrames(page))
  const writes = []
  const view = () => islands.sessions.get(chat).views.get(island)
  for (const [index, [x, y]] of path.entries()) {
    const step = index + 1
    await page(`window.__shadowStep = ${step}`).catch(() => {})
    const v = view()
    await islands.interact({
      chat,
      id: island,
      revision: v.revision,
      sourceRevision: v.sourceRevision,
      operation: crypto.randomUUID(),
      action: 'commit',
      gesture: `${label}-drag`,
      ended: index === path.length - 1,
      values: { x, y }
    })
    const text = await readFile(sourceFile, 'utf8')
    if (text !== initialCode && !writes.includes(text)) writes.push(text)
    const last = index === path.length - 1
    if (withOverrides && last) {
      await waitForGestureSettled(page, steps[path.length], { key: `${chat}\n${island}` })
      await page(
        `(() => { if (typeof window.__treziFlickerStop === 'function') window.__treziFlickerStop(); })()`
      )
      await Bun.sleep(50)
    } else {
      await Bun.sleep(waitMs)
      mergeFrames(nodeFrames, await pullFrames(page))
      const spot = await spotSample(page, step)
      if (spot) nodeFrames.push(spot)
      // Next/Vite HMR can reload the preview world; reattach the sampler when live writes run.
      if (!withOverrides) await installSampler(page)
    }
  }
  if (!withOverrides) {
    await Bun.sleep(300)
    mergeFrames(nodeFrames, await pullFrames(page))
    const spotEnd = await spotSample(page, path.length)
    if (spotEnd) nodeFrames.push(spotEnd)
  } else {
    mergeFrames(nodeFrames, await pullFrames(page))
    const spotEnd = await spotSample(page, path.length)
    if (spotEnd) nodeFrames.push(spotEnd)
  }
  const { frames, hmrStyleSwaps, reloads, computedSteps } = await analyzeFrames(
    page,
    steps,
    nodeFrames
  )
  assert.ok(frames.length > 0, `${label}: record at least one preview shadow sample`)
  assert.ok(computedSteps.length === steps.length, `${label}: derive computed steps in the preview`)
  const counts = {
    steps: path.length,
    hmrStyleSwaps,
    reloads,
    sourceWrites: writes.length,
    ...departures(frames, computedSteps)
  }
  console.log(`ISLAND-FLICKER ${label} ${JSON.stringify(counts)}`)
  return counts
}

export async function setupIsland(chat, root, sourceFile, component, overrides, format = 'js') {
  const { code, request } = islandSource(initial, format)
  request.manifest.file = sourceFile
  request.manifest.component = component
  // Rewriting identical text after a reset would only start a spurious HMR update mid-drag.
  if ((await readFile(`${root}/${sourceFile}`, 'utf8').catch(() => null)) !== code)
    await writeSourceFile(root, sourceFile, code)
  const islands = new ChatIslands(() => {}, undefined, overrides ? { overrides } : {})
  islands.register(chat, root, `${chat}-record`, () => 1)
  const made = await islands.tool(chat, root, request)
  assert.ok(made.id, JSON.stringify(made))
  await islands.settle(chat, true)
  return { islands, island: made.id, code }
}

export async function measureFramework({
  label,
  page,
  waitForCard,
  served,
  root,
  sourceFile,
  component,
  withOverrides
}) {
  const chat = `${label}-${withOverrides ? 'after' : 'before'}-chat`
  const port = withOverrides ? makePreviewPort(page) : null
  const overrides = port
    ? new IslandOverrides(port, { idle: 600, poll: 50, timeout: 8000 })
    : undefined
  const { islands, island, code } = await setupIsland(
    chat,
    root,
    sourceFile,
    component,
    overrides,
    label === 'next' ? 'tsx' : 'js'
  )
  try {
    await openOnSource(
      page,
      waitForCard,
      served,
      steps[0],
      `${label}-${withOverrides ? 'after' : 'before'} start`
    )
    const record = islands.sessions.get(chat)?.records.find((r) => r.id === island)
    assert.equal(record?.status, 'ready', `${label}: island record ready before drag`)
    assert.ok(
      record?.blocks.some((b) => b.kind === 'shadow'),
      `${label}: shadow block present`
    )
    const counts = await runDrag({
      page,
      islands,
      chat,
      island,
      sourceFile: `${root}/${sourceFile}`,
      initialCode: code,
      withOverrides,
      label: `${label}-${withOverrides ? 'after' : 'before'}`
    })
    if (withOverrides) {
      assert.equal(counts.sourceWrites, 1, `${label} after: one source write per gesture`)
      assert.equal(counts.gaps, 0, `${label} after: no gap frames`)
      assert.equal(counts.outOfOrder, 0, `${label} after: no out-of-order values`)
      assert.equal(counts.foreign, 0, `${label} after: no foreign values`)
    } else {
      assert.ok(counts.sourceWrites > 1, `${label} before: multiple source writes`)
      // A reload of the preview document mid-drag is itself the flicker; whether a frame
      // sample lands in the gap depends on machine load (LKM-167), a reload does not.
      assert.ok(
        counts.gaps > 0 ||
          counts.foreign > 0 ||
          counts.hmrStyleSwaps >= path.length ||
          counts.reloads > 0,
        `${label} before: HMR swap gap, reload or transient mismatch`
      )
    }
    return counts
  } finally {
    islands.close(chat)
  }
}
