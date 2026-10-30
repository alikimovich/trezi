/**
 * The open (not closed/archived) chats nested under the selected project's sidebar row,
 * newest first. Recency is the order chats were opened in the project (`sessionKeys`, where a
 * new or resumed chat is appended), not the time of the last message: a streamed answer never
 * reorders the list, only opening or closing a chat does. Every open chat is listed, as the
 * retired Electron rail did: archiving (Close chat) keeps the list short, and closed chats move
 * to the row's History section. Pure.
 */
export function recentChats(sessionKeys: readonly string[]): string[] {
  return [...new Set(sessionKeys)].reverse()
}

/** A history row's age, as the retired Electron rail showed it ("now", "5m", "3h", "2d", "4mo", "1y"). Pure. */
export function shortAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.round(d / 365)}y`
}
