/**
 * LKM-196: what the preview's main frame actually did. The native host reports each
 * main-frame navigation (start, HTTP response, finished, failed, cancelled); this keeps
 * the latest so `open_preview` can wait for the real result instead of answering
 * "requested", and so the preview shows a loading pill while it navigates and an error
 * pill when the page answered with an HTTP error (a 500 often renders blank white).
 * A navigation that cannot reach the server is the preview's error page instead
 * (`load-error` → the workspace status, with Restart).
 */
export type PreviewLoadEvent =
  | { type: 'start'; url: string }
  | { type: 'response'; url: string; status: number }
  | { type: 'loaded'; url: string }
  | { type: 'failed'; url: string; message: string }
  | { type: 'cancelled'; url: string }

export interface PreviewLoadOutcome {
  outcome: 'loaded' | 'failed'
  finalUrl: string
  /** The main frame's HTTP status, when WebKit reported a response. */
  status: number | null
  error?: string
}

export type PreviewLoadBanner =
  | { kind: 'loading'; path: string }
  | { kind: 'error'; path: string; status: number; message: string }

/** How the native side handled one `preview:open` request. */
export type PreviewDispatch = 'loading' | 'deferred' | 'no-server' | 'elsewhere' | 'dropped'

/** A quick navigation never flashes the loading pill. */
export const LOADING_DELAY_MS = 350

export const pathOf = (url: string): string => {
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search + parsed.hash
  } catch {
    return url
  }
}
const sameTarget = (a: string, b: string): boolean => {
  try {
    const x = new URL(a)
    const y = new URL(b)
    x.hash = ''
    y.hash = ''
    return x.href === y.href
  } catch {
    return a === b
  }
}

interface LoadWaiter {
  target: string
  armed: boolean
  resolve: (outcome: PreviewLoadOutcome | null) => void
}

export class PreviewLoads {
  banner: PreviewLoadBanner | null = null
  /** Called whenever `banner` changes. */
  onChange: () => void = () => {}
  private status: number | null = null
  private url = ''
  private loading = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private ids = 0
  private readonly loads = new Set<LoadWaiter>()
  private readonly dispatches = new Map<number, (outcome: PreviewDispatch | null) => void>()

  constructor(readonly loadingDelay = LOADING_DELAY_MS) {}

  record(event: PreviewLoadEvent): void {
    if (event.type === 'start') {
      this.clearTimer()
      this.status = null
      this.url = event.url
      this.loading = true
      for (const waiter of this.loads) if (sameTarget(waiter.target, event.url)) waiter.armed = true
      if (this.banner?.kind === 'error') this.show(null)
      this.timer = setTimeout(() => {
        this.timer = undefined
        if (this.loading) this.show({ kind: 'loading', path: pathOf(this.url) })
      }, this.loadingDelay)
      this.timer.unref?.()
      return
    }
    if (event.type === 'response') {
      this.status = event.status
      this.url = event.url || this.url
      return
    }
    this.clearTimer()
    this.loading = false
    if (event.type === 'cancelled') {
      if (this.banner?.kind === 'loading') this.show(null)
      return
    }
    const finalUrl = event.url || this.url
    if (event.type === 'loaded') {
      const status = this.status
      this.show(
        status !== null && status >= 400
          ? {
              kind: 'error',
              path: pathOf(finalUrl),
              status,
              message: `The dev server answered HTTP ${status}.`
            }
          : null
      )
      this.settle({ outcome: 'loaded', finalUrl, status })
    } else {
      this.show(null)
      this.settle({ outcome: 'failed', finalUrl, status: this.status, error: event.message })
    }
  }

  /** The next navigation of `target` to finish or fail, or null after `timeoutMs`. */
  nextLoad(
    target: string,
    timeoutMs: number
  ): { done: Promise<PreviewLoadOutcome | null>; cancel: () => void } {
    let waiter!: LoadWaiter
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = new Promise<PreviewLoadOutcome | null>((resolve) => {
      waiter = {
        target,
        armed: false,
        resolve: (outcome) => {
          clearTimeout(timer)
          this.loads.delete(waiter)
          resolve(outcome)
        }
      }
      this.loads.add(waiter)
      timer = setTimeout(() => waiter.resolve(null), Math.max(0, timeoutMs))
      timer.unref?.()
    })
    return { done, cancel: () => waiter.resolve(null) }
  }

  /** A request id for `preview:open`, and how the native side handled it (null on timeout). */
  request(timeoutMs: number): { id: number; dispatched: Promise<PreviewDispatch | null> } {
    const id = ++this.ids
    const dispatched = new Promise<PreviewDispatch | null>((resolve) => {
      const timer = setTimeout(() => finish(null), timeoutMs)
      timer.unref?.()
      const finish = (outcome: PreviewDispatch | null) => {
        clearTimeout(timer)
        this.dispatches.delete(id)
        resolve(outcome)
      }
      this.dispatches.set(id, finish)
    })
    return { id, dispatched }
  }

  dispatched(id: number | undefined, outcome: PreviewDispatch): void {
    if (id !== undefined) this.dispatches.get(id)?.(outcome)
  }

  /** The user dismissed the error pill. */
  dismiss(): void {
    if (this.banner?.kind === 'error') this.show(null)
  }

  /** The project or its server changed: nothing shown belongs to the new page. */
  reset(): void {
    this.clearTimer()
    this.loading = false
    this.status = null
    this.show(null)
  }

  private settle(outcome: PreviewLoadOutcome): void {
    for (const waiter of [...this.loads]) if (waiter.armed) waiter.resolve(outcome)
  }
  private clearTimer(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }
  private show(next: PreviewLoadBanner | null): void {
    if (JSON.stringify(next) === JSON.stringify(this.banner)) return
    this.banner = next
    this.onChange()
  }
}

/** The one preview's navigation state (there is one project preview WebView). */
export const previewLoads = new PreviewLoads()
