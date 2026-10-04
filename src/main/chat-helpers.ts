import { onChain, recreateWorkspace, states } from './chat-state'
import { editingOwner } from './editing-owner'

/**
 * Copy the live setup helpers into a chat's checkout now, parked or not (LKM-153).
 * Connect to Trezi runs its agent there and agents may not write `.trezi/`, so Trezi
 * puts them in place itself. Answers the checkout, or null for a chat of another
 * project or one that runs in the live tree.
 */
export async function syncChatHelpers(sessionKey: string, liveRoot: string): Promise<string | null> {
  const st = states.get(sessionKey)
  if (!st || st.liveRoot !== liveRoot) return null
  st.lastUsed = Date.now()
  return onChain(st, async () => {
    await recreateWorkspace(st)
    await editingOwner().syncSetupHelpers(st.liveRoot, st.wt.path)
    return st.wt.path
  })
}
