/** Bounded, in-process diagnostics for the native 3D Code smoke failure.
 * Only the latest identity and refusal at each boundary are retained. */
export type ThreeDRouteStage =
  | 'host-event'
  | 'preview-ipc'
  | 'inspector'
  | 'editor-request'
  | 'editor-result'
export type ThreeDRouteEntry = {
  count: number
  reason: string
  source?: string
  page?: string
  session?: string
  revision?: number
  selected?: number
  root?: string
}

const stages: Partial<Record<ThreeDRouteStage, ThreeDRouteEntry>> = {}

export function recordThreeDRoute(stage: ThreeDRouteStage, entry: Omit<ThreeDRouteEntry, 'count'>) {
  stages[stage] = { ...entry, count: (stages[stage]?.count ?? 0) + 1 }
}

export function inspectThreeDRoute(): Partial<Record<ThreeDRouteStage, ThreeDRouteEntry>> {
  return structuredClone(stages)
}
