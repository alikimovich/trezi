/**
 * The model a session actually runs, as the chat shows it (LKM-164). The picker sends
 * aliases (`opus`, `sonnet`, `default`) that the bundled CLI resolves; the session's
 * init message reports the result (`claude-opus-5-5`), and the user should see that
 * ("Opus 5.5"), not guess it from the alias.
 */

/** "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5",
 *  "claude-fable-5-1[1m]" → "Fable 5.1 (1M)". Any other id is returned as given. */
export function resolvedModelLabel(id: string): string {
  const trimmed = id.trim()
  const match = /^claude-([a-z0-9.-]+?)(?:-\d{8})?(\[1m\])?$/i.exec(trimmed)
  if (!match) return trimmed
  const parts = match[1].split('-')
  const family = parts.filter((p) => /^[a-z]+$/i.test(p))
  const version = parts.filter((p) => /^\d+(\.\d+)?$/.test(p))
  if (family.length !== 1 || !version.length || family.length + version.length !== parts.length)
    return trimmed
  const name = family[0].charAt(0).toUpperCase() + family[0].slice(1).toLowerCase()
  return `${name} ${version.join('.')}${match[2] ? ' (1M)' : ''}`
}

/**
 * The model picker's label for the selected choice once the session has said what it
 * runs: the resolved name when the choice was its alias ("Opus" → "Opus 5.5"), both
 * otherwise ("Default · Opus 5.5"), and the choice alone when it already names it.
 */
export function pickerLabel(choice: string, resolved?: string): string {
  if (!resolved) return choice
  const label = resolvedModelLabel(resolved)
  const a = choice.trim().toLowerCase()
  const b = label.toLowerCase()
  if (!a || b.startsWith(`${a} `) || b === a) return label
  if (a.includes(b)) return choice
  return `${choice} · ${label}`
}
