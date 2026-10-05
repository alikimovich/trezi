/** Canonical stamps win; existing project instrumentation remains readable. */
export function sourceStamp(element: Element, component = false): string | null {
  const suffix = component ? 'component-source' : 'source'
  return (
    element.getAttribute(`data-trezi-${suffix}`) ?? element.getAttribute(`data-praxis-${suffix}`)
  )
}
export function sourceSelector(value?: string): string {
  const match = value === undefined ? '' : `="${CSS.escape(value)}"`
  return `:is([data-trezi-source${match}],[data-praxis-source${match}]:not([data-trezi-source]))`
}
