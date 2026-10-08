/**
 * Preview slow motion (LKM-206), in the page's own world. The host injects it at document
 * start (`PreviewSpeed.swift`) because the page's libraries (GSAP, Motion, react-spring)
 * capture `requestAnimationFrame`, `performance.now` and `Date.now` when they load. It
 * scales the page's clock and the playback rate of its CSS/Web Animations and media; it
 * never touches project files. Until the first change from 1× every wrapper passes
 * straight through to the native function, so a page nobody slows runs exactly as before.
 * The isolated preview world drives it with `SPEED_EVENT` (`speed-control.ts`).
 */

/** One frame of page time, what Step advances. */
export const FRAME_MS = 1000 / 60
/** The page-world control event; its detail is `rate:<n>` or `step:<frames>`. */
export const SPEED_EVENT = 'trezi:speed'
/** Timer and held-frame ids, far above the browser's own incrementing ids. */
const ID_BASE = 1_000_000_000

/** Page time as a function of real time: continuous across rate changes and exact
 *  (the real time itself) until the first change. */
export class VirtualClock {
  rate = 1
  /** Set by the first change; before it the page sees the native clock. */
  virtual = false
  private real0 = 0
  private page0 = 0
  constructor(private readonly real: () => number) {}
  now(real = this.real()): number {
    return this.virtual ? this.page0 + Math.max(0, real - this.real0) * this.rate : real
  }
  set(rate: number, real = this.real()) {
    if (rate === this.rate) return
    this.page0 = this.now(real)
    this.real0 = real
    this.rate = rate
    this.virtual = true
  }
  /** Advance page time by `ms` (Step while paused). */
  step(ms: number, real = this.real()) {
    this.page0 = this.now(real) + ms
    this.real0 = real
    this.virtual = true
  }
}

type Handler = (...args: unknown[]) => void
interface Timer {
  handler: Handler
  args: unknown[]
  /** Page time it is due at. */
  due: number
  /** Interval period in page ms, null for a timeout. */
  every: number | null
  native: number | null
}
type Win = Window & typeof globalThis

export interface SlowMotion {
  clock: VirtualClock
  set: (rate: number) => void
  step: (frames: number) => void
}

/** Wraps the page's clocks and animations on `win`; `initial` is the session's speed when this document starts. */
export function installSlowMotion(win: Win, initial = 1): SlowMotion {
  const perf = win.performance
  const nativeNow = perf.now.bind(perf)
  const NativeDate = win.Date
  const dateNow = NativeDate.now.bind(NativeDate)
  const raf = win.requestAnimationFrame.bind(win)
  const caf = win.cancelAnimationFrame.bind(win)
  const setT = win.setTimeout.bind(win)
  const clearT = win.clearTimeout.bind(win)
  const clock = new VirtualClock(nativeNow)
  const report = (error: unknown) =>
    setT(() => {
      throw error
    }, 0)

  perf.now = function now() {
    return clock.now()
  }
  NativeDate.now = function now() {
    if (!clock.virtual) return dateNow()
    const real = nativeNow()
    return Math.floor(dateNow() + clock.now(real) - real)
  }

  // requestAnimationFrame: page-time stamps; while paused callbacks wait for Step or resume.
  const held = new Map<number, FrameRequestCallback>()
  const due = new Map<number, FrameRequestCallback>()
  let heldId = ID_BASE
  win.requestAnimationFrame = function requestAnimationFrame(callback: FrameRequestCallback) {
    if (!clock.virtual || typeof callback !== 'function') return raf(callback)
    if (clock.rate > 0) return raf((time) => callback(clock.now(time)))
    held.set(++heldId, callback)
    return heldId
  }
  win.cancelAnimationFrame = function cancelAnimationFrame(id: number) {
    if (!held.delete(id) && !due.delete(id)) caf(id)
  }
  /** One frame for every held callback (Step, or the first frame after resuming). */
  const release = () => {
    if (!held.size) return
    for (const [id, callback] of held) due.set(id, callback)
    held.clear()
    raf((time) => {
      const now = clock.now(time)
      for (const [id, callback] of [...due]) {
        due.delete(id)
        try {
          callback(now)
        } catch (error) {
          report(error)
        }
      }
    })
  }

  // setTimeout / setInterval: delays in page time. Timers created before the first
  // change stay native (they keep real time); a paused clock holds positive delays.
  const timers = new Map<number, Timer>()
  let timerId = ID_BASE
  const schedule = (id: number, timer: Timer) => {
    if (timer.native !== null) clearT(timer.native)
    timer.native = null
    const wait = timer.due - clock.now()
    if (clock.rate === 0 && wait > 0) return
    timer.native = setT(() => fire(id), clock.rate > 0 ? Math.max(0, wait / clock.rate) : 0)
  }
  const fire = (id: number) => {
    const timer = timers.get(id)
    if (!timer) return
    timer.native = null
    if (timer.every === null) timers.delete(id)
    else {
      timer.due = clock.now() + timer.every
      schedule(id, timer)
    }
    timer.handler.apply(win, timer.args)
  }
  const setI = win.setInterval.bind(win)
  const clearI = win.clearInterval.bind(win)
  const start = (repeat: boolean, handler: unknown, delay: unknown, args: unknown[]) => {
    const native = repeat ? setI : setT
    if (!clock.virtual) return native(handler as TimerHandler, delay as number, ...args)
    const ms = Math.max(0, Number(delay) || 0)
    // String handlers are rare: native, with the delay scaled at creation.
    if (typeof handler !== 'function')
      return native(handler as TimerHandler, clock.rate > 0 ? ms / clock.rate : ms, ...args)
    const entry: Timer = {
      handler: handler as Handler,
      args,
      due: clock.now() + ms,
      every: repeat ? Math.max(1, ms) : null,
      native: null
    }
    timers.set(++timerId, entry)
    schedule(timerId, entry)
    return timerId
  }
  const clear = (native: (id?: number) => void) => (id?: number) => {
    const entry = id === undefined ? undefined : timers.get(id)
    if (!entry) return native(id)
    if (entry.native !== null) clearT(entry.native)
    timers.delete(id as number)
  }
  win.setTimeout = function setTimeout(handler: unknown, delay?: unknown, ...args: unknown[]) {
    return start(false, handler, delay, args)
  } as typeof win.setTimeout
  win.setInterval = function setInterval(handler: unknown, delay?: unknown, ...args: unknown[]) {
    return start(true, handler, delay, args)
  } as typeof win.setInterval
  win.clearTimeout = clear(clearT) as typeof win.clearTimeout
  win.clearInterval = clear(clearI) as typeof win.clearInterval

  // CSS transitions, CSS animations and the Web Animations API: playbackRate × speed.
  const doc = win.document
  const timeline = doc.timeline
  const rates = new WeakMap<Animation, { base: number; applied: number }>()
  const apply = (animation: Animation) => {
    // Scroll-driven animations follow the scroll position, not time.
    if (animation.timeline !== timeline) return
    const seen = rates.get(animation)
    const base =
      seen && animation.playbackRate === seen.applied ? seen.base : animation.playbackRate
    const applied = base * clock.rate
    if (animation.playbackRate !== applied) animation.playbackRate = applied
    rates.set(animation, { base, applied })
  }
  const animations = () => (typeof doc.getAnimations === 'function' ? doc.getAnimations() : [])
  const sweep = () => {
    for (const animation of animations()) apply(animation)
  }
  const animate = win.Element.prototype.animate
  if (typeof animate === 'function')
    win.Element.prototype.animate = function (
      this: Element,
      ...args: Parameters<Element['animate']>
    ) {
      const animation = animate.apply(this, args)
      if (clock.rate !== 1) apply(animation)
      return animation
    }
  for (const type of ['animationstart', 'transitionrun', 'transitionstart'])
    win.addEventListener(type, () => clock.rate !== 1 && sweep(), true)

  // Video and audio: playbackRate × speed; paused while the clock is.
  const media = new WeakMap<HTMLMediaElement, { base: number; applied: number; held: boolean }>()
  const applyMedia = (element: HTMLMediaElement) => {
    const seen = media.get(element) ?? {
      base: element.playbackRate,
      applied: element.playbackRate,
      held: false
    }
    if (element.playbackRate !== seen.applied) seen.base = element.playbackRate
    try {
      if (clock.rate === 0) {
        if (!element.paused) {
          element.pause()
          seen.held = true
        }
      } else {
        seen.applied = seen.base * clock.rate
        if (element.playbackRate !== seen.applied) element.playbackRate = seen.applied
        if (seen.held) {
          seen.held = false
          void element.play().catch(() => {})
        }
      }
    } catch {}
    media.set(element, seen)
  }
  const sweepMedia = () => {
    for (const element of doc.querySelectorAll('video, audio'))
      applyMedia(element as HTMLMediaElement)
  }
  win.addEventListener(
    'play',
    (event) => {
      if (clock.rate !== 1 && event.target instanceof win.HTMLMediaElement) applyMedia(event.target)
    },
    true
  )

  // Newly created animations are caught by the events above and by one sweep per frame.
  let looping = false
  const loop = () => {
    looping = clock.rate !== 1
    if (!looping) return
    sweep()
    raf(loop)
  }
  const changed = () => {
    sweep()
    sweepMedia()
    for (const [id, entry] of timers) schedule(id, entry)
    if (clock.rate > 0) release()
    if (clock.rate !== 1 && !looping) {
      looping = true
      raf(loop)
    }
  }
  const set = (rate: number) => {
    if (!(rate >= 0 && rate <= 16) || rate === clock.rate) return
    clock.set(rate)
    changed()
  }
  const step = (frames: number) => {
    const ms = Math.max(1, Math.min(600, Math.round(frames) || 1)) * FRAME_MS
    set(0)
    clock.step(ms)
    for (const animation of animations()) {
      const base = rates.get(animation)?.base
      if (base === undefined || animation.playState !== 'running') continue
      const current = animation.currentTime
      if (typeof current === 'number') animation.currentTime = current + ms * base
    }
    for (const [id, entry] of timers) schedule(id, entry)
    release()
  }
  doc.addEventListener(SPEED_EVENT, (event) => {
    const [command, value] = String((event as CustomEvent).detail ?? '').split(':')
    if (command === 'rate') set(Number(value))
    else if (command === 'step') step(Number(value))
    else return
    event.preventDefault()
  })
  if (initial !== 1) set(initial)
  return { clock, set, step }
}
