import type { ThreeDAction } from './api'

/** Scene revisions protect node-index actions. Camera and close remain usable during HMR. */
export function threeDActionAllowed(
  raw: unknown,
  session: string,
  revision: number,
  layers: number
): raw is ThreeDAction {
  if (!raw || typeof raw !== 'object') return false
  const value = raw as { session?: unknown; revision?: unknown; action?: unknown; value?: unknown }
  if (
    value.session !== session ||
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 0
  )
    return false
  switch (value.action) {
    case 'close':
    case 'front':
    case 'reset':
      return true
    case 'code':
      return value.revision === revision
    case 'separation':
      return (
        Number.isInteger(value.value) &&
        (value.value as number) >= 0 &&
        (value.value as number) <= 100
      )
    case 'layer':
      return (
        value.revision === revision &&
        Number.isInteger(value.value) &&
        (value.value as number) >= 0 &&
        (value.value as number) < layers
      )
    default:
      return false
  }
}
