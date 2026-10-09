/** What a dev-server output line is about; its text is never logged. */
export function outputKind(line: string): 'ready' | 'error' | 'warning' | 'output' {
  return /\b(?:ready|listening)\b/i.test(line)
    ? 'ready'
    : /\b(?:error|failed)\b/i.test(line)
      ? 'error'
      : /\bwarn(?:ing)?\b/i.test(line)
        ? 'warning'
        : 'output'
}

export interface OutputFields {
  kind: ReturnType<typeof outputKind>
  chars: number
  /** Identical lines (same kind and size) before this one that were not logged. */
  skipped?: number
}

/**
 * The product-log entry for each dev-server output line, or null for a repeat. A server
 * that prints the same status every few seconds filled the feedback log with identical
 * "Dev server output" lines (LKM-199): a line of the same kind and size as the one before
 * is dropped, and the next different line says how many were.
 */
export function outputLogger() {
  let last = ''
  let skipped = 0
  return (line: string): OutputFields | null => {
    if (!line.trim()) return null
    const kind = outputKind(line)
    const key = `${kind}:${line.length}`
    if (key === last) {
      skipped++
      return null
    }
    const fields: OutputFields = { kind, chars: line.length, ...(skipped ? { skipped } : {}) }
    last = key
    skipped = 0
    return fields
  }
}
