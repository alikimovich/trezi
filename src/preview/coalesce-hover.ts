/** Draw the first target now; keep only the newest subsequent target per frame. */
export function coalesceHover<T>(
  draw: (target: T) => void,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame
): { move: (target: T) => void; clear: () => void } {
  let frame = 0
  let latest: T | undefined
  let painted: T | undefined
  const flush = () => {
    frame = 0
    const target = latest
    latest = undefined
    if (target === undefined || target === painted) {
      painted = undefined
      return
    }
    painted = target
    draw(target)
    frame = schedule(flush)
  }
  return {
    move(target) {
      if (frame) {
        latest = target
        return
      }
      painted = target
      draw(target)
      frame = schedule(flush)
    },
    clear() {
      if (frame) cancel(frame)
      frame = 0
      latest = undefined
      painted = undefined
    }
  }
}
