import type { Annotation } from './api'

/** Escape backticks so a note can't break out of an inline-code span. */
const code = (s: string): string => `\`${s.replace(/`/g, 'ˋ')}\``

/**
 * Render the handoff PR body from the notes + changed files. Pure (no electron /
 * fs), so it's unit-testable on its own. Note text is single-lined and the
 * changed-file list is capped so a huge working tree can't bloat the body.
 */
export function buildPrBody(annotations: Annotation[], changedFiles: string[]): string {
  const lines: string[] = ['## Design handoff', '', '_Prepared in Trezi._', '']
  if (changedFiles.length) {
    lines.push(`### Changed files (${changedFiles.length})`, '')
    for (const f of changedFiles.slice(0, 50)) lines.push(`- ${code(f)}`)
    if (changedFiles.length > 50) lines.push(`- …and ${changedFiles.length - 50} more`)
    lines.push('')
  }
  if (annotations.length) {
    lines.push(`### Notes (${annotations.length})`, '')
    for (const a of annotations) {
      const where = a.source ?? a.selector
      lines.push(`- [ ] **${a.tag}** ${code(where)} — ${a.text.replace(/\r?\n/g, ' ')}`)
    }
    lines.push('')
  } else {
    lines.push('_No annotations._', '')
  }
  return lines.join('\n')
}
