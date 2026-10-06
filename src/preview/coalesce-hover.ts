/** Keep the newest pointer target and run its layout work once per display frame. */
export function coalesceHover<T>(
  draw: (target: T) => void,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame
): { move: (target: T) => void; clear: () => void } {
  let frame = 0
  let latest: T | undefined
  return {
    move(target) {
      latest = target
      if (frame) return
      frame = schedule(() => {
        frame = 0
        const target = latest
        latest = undefined
        if (target !== undefined) draw(target)
      })
    },
    clear() {
      if (frame) cancel(frame)
      frame = 0
      latest = undefined
    }
  }
}
