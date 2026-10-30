/** How many of the selected project's chats the sidebar nests under its row (LKM-378). */
export const RECENT_CHAT_LIMIT = 5

/**
 * The open (not closed/archived) chats nested under the selected project's sidebar row,
 * newest first. Recency is the order chats were opened in the project (`sessionKeys`, where a
 * new or resumed chat is appended), not the time of the last message: a streamed answer never
 * reorders the list, only opening or closing a chat does. The active chat always keeps a slot
 * (in place of the oldest shown one) so the highlighted row is visible. `more` asks for the
 * "View all chats" entry. Pure.
 */
export function recentChats(
  sessionKeys: readonly string[],
  active: string | null,
  limit = RECENT_CHAT_LIMIT
): { keys: string[]; more: boolean } {
  const order = [...new Set(sessionKeys)].reverse()
  let keys = order.slice(0, limit)
  if (active && order.includes(active) && !keys.includes(active))
    keys = [...keys.slice(0, limit - 1), active]
  return { keys, more: order.length > limit }
}
