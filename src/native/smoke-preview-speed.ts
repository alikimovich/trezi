import assert from 'node:assert/strict'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPreviewAgentTool } from '../main/preview-agent-tools'
import { previewSpeed } from '../main/preview-speed'
import type { NativeBridge } from './bridge'
import { capture } from './smoke-toolbar'
import { expandedIs } from './smoke-toolbar-overflow'
import { waitFor } from './smoke-wait'

type Page = (code: string) => Promise<unknown>
type Durations = Record<'transition' | 'keyframes' | 'waapi' | 'raf' | 'timeout', number>
const FIXTURE = 'trezi-speed-fixture'
const MS = 400

/**
 * Builds the four kinds of animation in the page world and resolves with how long each
 * took in real time. `document.timeline.currentTime` is the one clock slow motion leaves
 * native, so it measures wall time inside the same document.
 */
const run = `(() => {
  document.getElementById('${FIXTURE}')?.remove();
  const root = document.createElement('div'); root.id = '${FIXTURE}';
  root.innerHTML = '<style>@keyframes ${FIXTURE}{from{opacity:.2}to{opacity:1}}' +
    '#${FIXTURE} .k{animation:${FIXTURE} ${MS}ms linear}</style>' +
    '<div class="t" style="width:8px;height:8px;transition:transform ${MS}ms linear"></div>' +
    '<div class="k-target" style="width:8px;height:8px"></div><div class="w" style="width:8px;height:8px"></div>';
  document.body.append(root);
  const wall = () => document.timeline.currentTime;
  const start = wall(), took = () => Math.round(wall() - start);
  const t = root.querySelector('.t'), k = root.querySelector('.k-target');
  t.getBoundingClientRect();
  return Promise.all([
    new Promise((r) => { t.addEventListener('transitionend', () => r(took()), { once: true }); t.style.transform = 'translateX(40px)' }),
    new Promise((r) => { k.addEventListener('animationend', () => r(took()), { once: true }); k.classList.add('k') }),
    root.querySelector('.w').animate([{ opacity: 0.2 }, { opacity: 1 }], ${MS}).finished.then(took),
    new Promise((r) => { let first; const tick = (time) => { first ??= time; time - first >= ${MS} ? r(took()) : requestAnimationFrame(tick) }; requestAnimationFrame(tick) }),
    new Promise((r) => setTimeout(() => r(took()), ${MS}))
  ]).then(([transition, keyframes, waapi, raf, timeout]) => { root.remove(); return { transition, keyframes, waapi, raf, timeout } })
})()`

/** Folders that are not the user's project files (dependencies, Git, Trezi's sidecar). */
const SKIP = new Set(['node_modules', '.git', '.trezi'])

/** Project files with their size and mtime: slow motion must leave every one as it was. */
function snapshot(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) snapshot(path, out)
    else out.push(`${path}:${stat.size}:${stat.mtimeMs}`)
  }
  return out
}

type Box = { x: number; y: number; width: number; height: number }
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Speed = Record<string, any>
/** Below this window width `fitMore` removes the slow-motion segment and "…" (ToolbarMore.swift). */
const NARROW_WINDOW = 960
/** The page's bottom-left corner, where the badge sat before LKM-385. */
const CORNER = { width: 160, height: 80 }

/** What is wrong with the badge's place against the toolbar control it hangs under. */
export function badgeProblem(state: Speed, anchor: string): string | undefined {
  const badge: Box = state.frame
  const control: Box | null = state.anchorFrame
  const page: Box = state.page
  if (!state.visible) return 'the badge is hidden'
  if (state.anchor !== anchor || !control) return `anchored to "${state.anchor}", not "${anchor}"`
  const bottom = control.y + control.height
  if (badge.y < Math.max(bottom, 0)) return `y ${badge.y} is not below the toolbar (${bottom})`
  if (badge.y - Math.max(bottom, 0) > 10) return `y ${badge.y} is far below the toolbar (${bottom})`
  const off = badge.x + badge.width / 2 - (control.x + control.width / 2)
  if (Math.abs(off) > 2) return `centered ${off} pt off the control`
  const bottomLeft = badge.x < page.x + CORNER.width && badge.x + badge.width > page.x
  if (bottomLeft && badge.y + badge.height > page.y + page.height - CORNER.height)
    return 'over the page bottom-left corner'
}

/**
 * LKM-385: the badge follows its toolbar control through a window resize, the sidebar and chat
 * changing width, "expand preview", full screen with the toolbar window sliding, and takes the
 * interaction group's last segment in a narrow window. The window is put back on any outcome.
 */
async function checkBadgeFollows(
  host: NativeBridge,
  state: () => Promise<Speed>,
  artifacts: string,
  evidence: Record<string, unknown>
) {
  const shell = (action: string, row?: string) => host.request('shellPerform', { action, row })
  const overflow = (params: Record<string, unknown> = {}) =>
    host.request('toolbarOverflow', params) as Promise<Speed>
  const fullScreen = (value: boolean) =>
    host.request('previewOverlayTest', { action: 'fullscreen', value })
  const placed = async (name: string, anchor = 'speed') => {
    evidence[`badge-${name}`] = await waitFor(
      async () => {
        const now = await state()
        return !badgeProblem(now, anchor) && now
      },
      `the badge under "${anchor}" (${name})`,
      5000,
      async () => {
        const now = await state()
        return { problem: badgeProblem(now, anchor), ...now }
      }
    )
  }
  const expand = async (want: boolean) => {
    assert.ok(await shell('expand'), 'expand preview')
    await waitFor(expandedIs(host, want), `preview expanded ${want}`)
  }
  const chatWidth = async (width: number) => {
    host.send('layoutWidth', { width })
    await waitFor(
      async () => (await host.request('layoutInspect')).width === width,
      `chat width ${width}`
    )
  }
  const before = await overflow()
  const chat: number = (await host.request('layoutInspect')).width
  let expanded = false
  let full = false
  let moved = false
  try {
    assert.ok(await shell('window-width', '1500'), 'resize to 1500')
    await placed('wide')
    if (!before.sidebarCollapsed) {
      assert.ok(await shell('sidebar-width', '300'), 'sidebar width 300')
      await placed('sidebar')
      assert.ok(
        await shell('sidebar-width', String(Math.round(before.sidebarWidth))),
        'sidebar width restored'
      )
    }
    await chatWidth(520)
    await placed('chat-width')
    await chatWidth(chat)
    await expand(true)
    expanded = true
    await placed('expanded')
    await expand(false)
    expanded = false
    await placed('restored')

    // Narrow: neither the segment nor "…" is in the toolbar.
    assert.ok(await shell('window-width', String(NARROW_WINDOW)), `resize to ${NARROW_WINDOW}`)
    await placed('narrow', 'overlay')
    const narrow = await host.request('shellInspect')
    assert.equal(narrow.moreVisible, false, '"…" leaves a narrow window')
    assert.deepEqual(narrow.interactionSegments, ['select-object', 'device', 'overlay'])
    await capture(host, artifacts, 'preview-speed-narrow')
    assert.ok(await shell('window-width', String(Math.round(before.windowWidth))), 'resize back')
    await placed('widened')

    // Full screen needs a foreground window; the toolbar lives in its own window there.
    if (process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1') {
      await fullScreen(true)
      full = true
      await placed('full-screen')
      const slid = await overflow({ action: 'toolbar-window-move', value: true })
      assert.ok(slid.moved, `the toolbar is in its own window: ${JSON.stringify(slid)}`)
      moved = true
      await placed('toolbar-window-slid')
      await overflow({ action: 'toolbar-window-move', value: false })
      moved = false
      await placed('toolbar-window-back')
      await fullScreen(false)
      full = false
      await placed('windowed')
    } else evidence['badge-full-screen'] = 'skipped: background test (reduced coverage)'
  } finally {
    if (moved) await overflow({ action: 'toolbar-window-move', value: false })
    if (full) await fullScreen(false)
    if (expanded) await shell('expand')
    host.send('layoutWidth', { width: chat })
    await shell('window-width', String(Math.round(before.windowWidth)))
  }
}

/**
 * LKM-206: the preview's slow motion end to end. Each speed change takes a real path:
 * the toolbar menu (`shellPerform preview-speed`), the agent's `preview_speed` tool and
 * the store behind ⌃⇧S. At 0.25× a CSS transition, a CSS keyframe animation, a Web
 * Animation, a requestAnimationFrame loop and a timer each take about 4× as long; Pause
 * holds them, Step advances one frame and 1× is the measured normal timing again.
 */
export async function checkPreviewSpeed(
  host: NativeBridge,
  page: Page,
  fixture: string,
  artifacts: string
) {
  const files = snapshot(fixture).join('\n')
  const evidence: Record<string, unknown> = {}
  const menu = (value: string) =>
    host.request('shellPerform', { action: 'preview-speed', row: value }) as Promise<boolean>
  const state = () => host.request('previewSpeedInspect') as Promise<Speed>

  // The document-start script is in the page world (it answers the control event).
  assert.equal(
    await page(
      `!document.dispatchEvent(new CustomEvent('trezi:speed', { detail: 'rate:1', cancelable: true }))`
    ),
    true,
    'the slow-motion script runs in the page world'
  )
  const idle = await state()
  assert.equal(idle.visible, false, 'no badge at 1×')
  assert.equal(idle.speedChecked, 'Normal Speed (1×)')
  assert.equal(idle.speedProminent, false)
  assert.deepEqual(idle.speedMenu, [
    'Normal Speed (1×)',
    '0.5×',
    '0.25×',
    '0.1×',
    'Paused',
    '',
    'Step Frame'
  ])

  // Frame alignment and a busy machine only ever add time, so the bounds are one-sided wide.
  const normalTiming = (label: string, durations: Durations) => {
    for (const [kind, ms] of Object.entries(durations))
      assert.ok(ms >= MS - 20 && ms <= MS + 250, `${label}: ${kind} took ${ms} ms, not about ${MS}`)
  }
  const normal = (await page(run)) as Durations
  evidence.normal = normal
  normalTiming('1×', normal)

  // 0.25× from the toolbar menu: the badge shows, the item is prominent, each takes ~4×.
  assert.equal(await menu('0.25'), true, 'the toolbar speed menu is enabled')
  await waitFor(async () => (await state()).visible, 'the 0.25× badge', 5000)
  const slowed = await state()
  assert.equal(slowed.label, '0.25×')
  assert.equal(slowed.speedChecked, '0.25×')
  assert.equal(slowed.speedLabel, 'Slow Motion 0.25×')
  assert.equal(slowed.speedProminent, true, 'the slow-motion segment shows the accent glyph')
  evidence.slowedState = slowed
  assert.equal(badgeProblem(slowed, 'speed'), undefined, 'the badge hangs under the segment')
  evidence.capture = await capture(host, artifacts, 'preview-speed')
  const slow = (await page(run)) as Durations
  evidence.slow = slow
  for (const kind of Object.keys(normal) as (keyof Durations)[]) {
    const ratio = slow[kind] / MS
    assert.ok(ratio >= 3.6 && ratio <= 4.8, `0.25×: ${kind} took ${ratio.toFixed(2)}× its ${MS} ms`)
  }
  await checkBadgeFollows(host, state, artifacts, evidence)

  // Pause (agent tool): a running Web Animation and the page clock hold; Step advances one frame.
  await page(`(() => {
    window.__treziSpeedAnimation = document.body.animate([{ opacity: 1 }, { opacity: 0.99 }], 60000);
    return true
  })()`)
  const answer = (await runPreviewAgentTool('preview_speed', { speed: 0 })).content[0]
  const paused = JSON.parse(answer.type === 'text' ? answer.text : '{}')
  assert.equal(paused.label, 'Paused')
  await waitFor(async () => (await state()).label === 'Paused', 'the Paused badge', 5000)
  const clocks = `({ clock: performance.now(), animation: window.__treziSpeedAnimation.currentTime })`
  const held = (await page(clocks)) as { clock: number; animation: number }
  await new Promise((r) => setTimeout(r, 300))
  const still = (await page(clocks)) as { clock: number; animation: number }
  assert.equal(still.clock, held.clock, 'paused: the page clock holds')
  assert.equal(still.animation, held.animation, 'paused: animations hold')
  assert.equal(await menu('step'), true)
  const stepped = await waitFor(
    async () => {
      const value = (await page(clocks)) as { clock: number; animation: number }
      return value.clock !== held.clock && value
    },
    'one stepped frame',
    5000
  )
  evidence.step = { held, stepped }
  assert.ok(Math.abs(stepped.clock - held.clock - 1000 / 60) < 0.01, 'step: one 16.7 ms frame')
  assert.ok(
    Math.abs(stepped.animation - held.animation - 1000 / 60) < 1,
    'step: the animation advances one frame'
  )

  // ⌃⇧S's store: from paused back to 1×, and normal timing is exact again.
  previewSpeed.toggle()
  await waitFor(async () => !(await state()).visible, 'the badge to hide at 1×', 5000)
  await page(`(() => { window.__treziSpeedAnimation?.cancel(); return true })()`)
  const restored = (await page(run)) as Durations
  evidence.restored = restored
  normalTiming('1× again', restored)
  const idleAgain = await state()
  assert.equal(idleAgain.speedChecked, 'Normal Speed (1×)')
  assert.equal(idleAgain.speedProminent, false)
  assert.equal(snapshot(fixture).join('\n'), files, 'project files are unchanged')
  writeFileSync(join(artifacts, 'preview-speed.json'), JSON.stringify(evidence, null, 2))
  console.log(
    `Native preview slow motion: 0.25× ≈ 4× for transition/keyframes/WAAPI/rAF/timer, pause holds, step = one frame, 1× restored (${JSON.stringify({ normal, slow })}).`
  )
}

/** Leave the preview at 1× with no fixture. */
export async function restorePreviewSpeed(page: Page) {
  previewSpeed.set(1)
  await page(
    `(() => { window.__treziSpeedAnimation?.cancel(); document.getElementById('${FIXTURE}')?.remove(); return true })()`
  ).catch(() => {})
}
