import type { ChatIslands, IslandLocation } from '../main/chat-islands'

/**
 * LKM-199: every chat gets its island session once its workspace is ready. A chat
 * restored with a record registers at once; a new chat (LKM-182: listed before its
 * worktree, provider and record exist) waits for its preparation through
 * `agent:chat-record`. The island tool and the first send register a missing one too.
 */
export function islandLocator(
  invoke: (channel: string, ...args: any[]) => Promise<any>,
  turn: (chat: string) => number,
  closed: (chat: string) => boolean
) {
  return async (chat: string): Promise<IslandLocation | null> => {
    const found: { root: string; recordId: string } | null = await invoke('agent:chat-record', chat)
    if (!found?.recordId || closed(chat)) return null
    return { root: found.root, recordId: found.recordId, turn: () => turn(chat) }
  }
}

/** The chat controller's `restoreIslands`: register now, or once the new chat is ready. */
export function islandRestorer(islands: ChatIslands, turn: (chat: string) => number) {
  return (chat: string, root: string, recordId: string) => {
    if (recordId) islands.register(chat, root, recordId, () => turn(chat))
    else void islands.ensure(chat)
  }
}
