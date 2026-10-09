import { SPEED_EVENT } from './slow-motion'

/** LKM-206: hands a speed change or a frame step to the page-world clock (`slow-motion.ts`)
 *  as a string event detail, the only kind that crosses content worlds. */
export function sendPageSpeed(change: unknown) {
  const { speed, step } = (change ?? {}) as { speed?: unknown; step?: unknown }
  const detail =
    typeof step === 'number' && Number.isInteger(step) && step > 0
      ? `step:${step}`
      : typeof speed === 'number' && speed >= 0 && speed <= 1
        ? `rate:${speed}`
        : null
  if (detail) document.dispatchEvent(new CustomEvent(SPEED_EVENT, { detail }))
}
