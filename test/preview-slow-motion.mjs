/**
 * LKM-206 unit checks, no desktop: the virtual clock, the page-world wrappers on a fake
 * window (exact passthrough at 1×, scaled clocks, timers and frames, Pause and Step,
 * animation and media rates), the session speed store and the `preview_speed` tool.
 * The WebKit behavior itself is covered by the native `preview-speed` smoke check.
 *
 * Run with: bun test/preview-slow-motion.mjs
 */
import assert from 'node:assert/strict'
import { runPreviewAgentTool } from '../src/main/preview-agent-tools.ts'
import { PreviewSpeed, parseSpeed, previewSpeed, speedLabel } from '../src/main/preview-speed.ts'
import {
  FRAME_MS,
  installSlowMotion,
  SPEED_EVENT,
  VirtualClock
} from '../src/preview/slow-motion.ts'

const close = (actual, expected, message, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} ≠ ${expected}`)

// --- VirtualClock ----------------------------------------------------------------------
{
  let real = 1000
  const clock = new VirtualClock(() => real)
  assert.equal(clock.now(), 1000, 'exact real time before any change')
  clock.set(1)
  assert.equal(clock.virtual, false, 'setting 1× first changes nothing')
  clock.set(0.25)
  real += 400
  close(clock.now(), 1100, '0.25×: 400 real ms are 100 page ms')
  clock.set(0)
  real += 1000
  close(clock.now(), 1100, 'paused: page time holds')
  clock.step(FRAME_MS)
  close(clock.now(), 1100 + FRAME_MS, 'step advances one frame')
  clock.set(1)
  real += 250
  close(clock.now(), 1100 + FRAME_MS + 250, '1× again: durations are exact')
}

// --- page world on a fake window ---------------------------------------------------------
function fakeWindow() {
  let real = 5000
  const tasks = []
  let taskId = 0
  let frames = []
  let frameId = 0
  const listeners = new Map()
  const on = (map) => (type, fn) => map.set(type, [...(map.get(type) ?? []), fn])
  const docListeners = new Map()
  const animations = []
  class Media {
    playbackRate = 1
    paused = false
    pause() {
      this.paused = true
    }
    play() {
      this.paused = false
      return Promise.resolve()
    }
  }
  const media = [new Media()]
  const timeline = {}
  class Animation {
    playbackRate = 1
    playState = 'running'
    currentTime = 0
    timeline = timeline
  }
  const win = {
    performance: { now: () => real },
    Date: { now: () => 1_700_000_000_000 + real },
    requestAnimationFrame: (fn) => {
      frames.push([++frameId, fn])
      return frameId
    },
    cancelAnimationFrame: (id) => {
      frames = frames.filter(([f]) => f !== id)
    },
    setTimeout: (fn, ms = 0, ...args) => {
      tasks.push({ id: ++taskId, at: real + Math.max(0, ms), fn, args, every: null })
      return taskId
    },
    setInterval: (fn, ms = 0, ...args) => {
      tasks.push({ id: ++taskId, at: real + ms, fn, args, every: Math.max(1, ms) })
      return taskId
    },
    clearTimeout: (id) => tasks.splice(tasks.findIndex((t) => t.id === id) >>> 0, 1),
    clearInterval: (id) => tasks.splice(tasks.findIndex((t) => t.id === id) >>> 0, 1),
    addEventListener: on(listeners),
    Element: {
      prototype: {
        animate: () => {
          const animation = new Animation()
          animations.push(animation)
          return animation
        }
      }
    },
    HTMLMediaElement: Media,
    document: {
      timeline,
      getAnimations: () => animations,
      querySelectorAll: () => media,
      addEventListener: on(docListeners)
    }
  }
  /** Advance real time, running due timers in order and frames every 16.67 ms. */
  const advance = (ms) => {
    const end = real + ms
    for (;;) {
      const next = tasks.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
      const frameAt = Math.floor(real / FRAME_MS + 1) * FRAME_MS
      if (frames.length && frameAt <= end && (!next || frameAt <= next.at)) {
        real = frameAt
        const run = frames
        frames = []
        for (const [, fn] of run) fn(real)
        continue
      }
      if (!next) break
      real = Math.max(real, next.at)
      if (next.every === null) tasks.splice(tasks.indexOf(next), 1)
      else next.at += next.every
      next.fn(...next.args)
    }
    real = end
  }
  const send = (detail) => {
    let prevented = false
    for (const fn of docListeners.get(SPEED_EVENT) ?? [])
      fn({ detail, preventDefault: () => (prevented = true) })
    return prevented
  }
  return {
    win,
    advance,
    send,
    animations,
    media,
    Animation,
    real: () => real,
    fire: (type) => {
      for (const fn of listeners.get(type) ?? []) fn({ target: media[0] })
    }
  }
}

{
  const page = fakeWindow()
  const { win } = page
  const nativeRaf = win.requestAnimationFrame
  const motion = installSlowMotion(win)
  // 1×: every wrapper hands straight to the native function.
  assert.equal(win.performance.now(), page.real(), '1×: performance.now is real time')
  assert.equal(win.Date.now(), 1_700_000_000_000 + page.real(), '1×: Date.now is real time')
  const early = []
  win.setTimeout(() => early.push(win.performance.now()), 100)
  const id = win.requestAnimationFrame(() => {})
  assert.ok(id < 1e9, '1×: frames have native ids')
  page.advance(100)
  assert.equal(early.length, 1, '1×: a 100 ms timeout fires after 100 real ms')
  assert.equal(nativeRaf !== win.requestAnimationFrame, true)

  // 0.25×: every clock runs at a quarter speed.
  assert.equal(page.send('rate:0.25'), true, 'the speed event is handled')
  const t0 = win.performance.now()
  const d0 = win.Date.now()
  page.advance(400)
  close(win.performance.now() - t0, 100, '0.25×: performance.now')
  close(win.Date.now() - d0, 100, '0.25×: Date.now', 1)
  let fired = null
  const start = page.real()
  win.setTimeout(() => (fired = page.real() - start), 50)
  page.advance(199)
  assert.equal(fired, null, '0.25×: a 50 ms timeout has not fired after 199 real ms')
  page.advance(2)
  close(fired, 200, '0.25×: a 50 ms timeout fires after 200 real ms', 0.001)
  const stamps = []
  const tick = (t) => {
    stamps.push(t)
    if (stamps.length < 3) win.requestAnimationFrame(tick)
  }
  win.requestAnimationFrame(tick)
  page.advance(100)
  close(stamps[1] - stamps[0], FRAME_MS / 4, '0.25×: frame stamps advance a quarter frame')

  // Animations and media follow the speed; a page-set rate is kept as the base.
  const css = new page.Animation()
  css.playbackRate = 2
  page.animations.push(css)
  page.fire('animationstart')
  assert.equal(css.playbackRate, 0.5, 'a new CSS animation runs at its own rate × 0.25')
  const waapi = win.Element.prototype.animate()
  assert.equal(waapi.playbackRate, 0.25, 'Element.animate is slowed at creation')
  const scroll = new page.Animation()
  scroll.timeline = {}
  page.animations.push(scroll)
  page.advance(20)
  assert.equal(scroll.playbackRate, 1, 'scroll-driven animations keep their rate')
  assert.equal(page.media[0].playbackRate, 0.25, 'media plays at 0.25×')

  // Pause holds frames, timers and animations; Step advances one frame.
  page.send('rate:0')
  assert.equal(css.playbackRate, 0, 'paused: animations hold')
  assert.equal(page.media[0].paused, true, 'paused: media pauses')
  const pausedAt = win.performance.now()
  let ran = 0
  win.requestAnimationFrame(() => ran++)
  let timeout = 0
  win.setTimeout(() => timeout++, 10)
  page.advance(500)
  assert.equal(win.performance.now(), pausedAt, 'paused: page time holds')
  assert.equal(ran, 0, 'paused: frame callbacks wait')
  assert.equal(timeout, 0, 'paused: timers wait')
  css.currentTime = 100
  page.send('step:1')
  page.advance(FRAME_MS)
  close(win.performance.now() - pausedAt, FRAME_MS, 'step: one frame of page time')
  assert.equal(ran, 1, 'step: held frame callbacks run once')
  assert.equal(timeout, 1, 'step: a timer due within the frame fires')
  close(css.currentTime, 100 + FRAME_MS * 2, 'step: animations advance one frame at their own rate')
  page.send('step:2')
  page.advance(FRAME_MS)
  close(win.performance.now() - pausedAt, 3 * FRAME_MS, 'step:2 advances two frames')

  // Back to 1×: rates restored, durations exact again.
  page.send('rate:1')
  assert.equal(css.playbackRate, 2, '1×: the page rate is back')
  assert.equal(waapi.playbackRate, 1)
  assert.equal(page.media[0].playbackRate, 1)
  assert.equal(page.media[0].paused, false, '1×: media held by the pause plays again')
  const back = win.performance.now()
  let exact = null
  const at = page.real()
  win.setTimeout(() => (exact = page.real() - at), 30)
  page.advance(100)
  close(win.performance.now() - back, 100, '1×: performance.now runs at real speed')
  close(exact, 30, '1×: timeouts take their real duration', 0.001)
  assert.equal(page.send('bogus'), false, 'unknown details are ignored')
  assert.equal(motion.clock.rate, 1)
}

{
  // A document that starts slowed (the speed baked into the document-start script).
  const page = fakeWindow()
  const motion = installSlowMotion(page.win, 0.5)
  assert.equal(motion.clock.rate, 0.5, 'the initial speed applies at document start')
  const t0 = page.win.performance.now()
  page.advance(100)
  close(page.win.performance.now() - t0, 50, 'initial 0.5×')
}

// --- session store ---------------------------------------------------------------------
{
  assert.equal(parseSpeed(0.25), 0.25)
  assert.equal(parseSpeed('0.5x'), 0.5)
  assert.equal(parseSpeed('0.1×'), 0.1)
  assert.equal(parseSpeed('Paused'), 0)
  assert.equal(parseSpeed(0.3), null, 'only offered speeds')
  assert.equal(parseSpeed('fast'), null)
  assert.equal(speedLabel(0), 'Paused')
  assert.equal(speedLabel(0.25), '0.25×')
  const store = new PreviewSpeed()
  const changes = []
  store.on((change) => changes.push(change))
  store.scope('a')
  assert.deepEqual(changes, [], 'opening the first project at 1× sends nothing')
  store.toggle()
  assert.equal(store.speed, 0.25, '⌃⇧S defaults to 0.25×')
  store.set(0.1)
  store.toggle()
  assert.equal(store.speed, 1)
  store.toggle()
  assert.equal(store.speed, 0.1, '⌃⇧S returns to the last slow speed')
  assert.equal(store.set(0.3), false, 'unknown speeds are refused')
  assert.equal(store.step(3), 3)
  assert.equal(store.speed, 0, 'step pauses')
  assert.equal(store.step(10_000), 600, 'steps are bounded')
  store.scope('a')
  assert.equal(store.speed, 0, 'the same project keeps its speed')
  store.scope('b')
  assert.equal(store.speed, 1, 'another project starts at 1×')
  store.toggle()
  assert.equal(store.speed, 0.25, 'and with the default slow speed')
  assert.deepEqual(changes.slice(0, 3), [{ speed: 0.25 }, { speed: 0.1 }, { speed: 1 }])
  assert.deepEqual(changes.slice(4, 6), [{ speed: 0 }, { step: 3 }])
}

// --- preview_speed tool ---------------------------------------------------------------
{
  const calls = []
  const host = {
    evaluate: async (code, world) => {
      calls.push(world)
      return true
    },
    captureRect: async () => null,
    setViewport: async () => ({ width: null, zoom: 1 })
  }
  const sent = []
  const off = previewSpeed.on((change) => sent.push(change))
  const text = async (args) =>
    JSON.parse((await runPreviewAgentTool('preview_speed', args, host)).content[0].text)
  assert.deepEqual(await text({}), {
    speed: 1,
    label: '1×',
    next: 'The preview runs at normal speed.'
  })
  const slow = await text({ speed: 0.25 })
  assert.equal(slow.speed, 0.25)
  assert.match(slow.next, /speed: 1/)
  const stepped = await text({ step: 2 })
  assert.equal(stepped.speed, 0)
  assert.equal(stepped.stepped, 2)
  close(stepped.pageMs, 33.3, 'two frames of page time', 0.05)
  assert.match((await text({ speed: 0.3 })).error, /Unknown speed/)
  assert.match((await text({ step: 0 })).error, /1 to 600/)
  assert.equal((await text({ speed: 'paused' })).label, 'Paused')
  assert.equal((await text({ speed: 1 })).speed, 1)
  assert.deepEqual(sent, [{ speed: 0.25 }, { speed: 0 }, { step: 2 }, { speed: 1 }])
  assert.ok(
    calls.every((world) => world === 'preview'),
    'waits in the preview world'
  )
  off()
}

console.log(
  'PREVIEW-SLOW-MOTION OK — exact 1× passthrough, scaled clocks/timers/frames, pause and step, animation/media rates, session store, preview_speed tool'
)
