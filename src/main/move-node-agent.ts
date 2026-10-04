import type { MoveNodeRequest, MoveNodeResult } from '../shared/api'
import { projectRelative } from '../shared/project-path'

/**
 * The agent fallback shared by the three movers (`move-node.ts`, `move-node-svelte.ts`,
 * `move-node-html.ts`). Both sources are named relative to `root`, so a worktree chat
 * moves the elements in its own checkout (LKM-155).
 */
export function toAgent(root: string, req: MoveNodeRequest, reason: string): MoveNodeResult {
  const dragged = projectRelative(req.dragged.source, root),
    target = projectRelative(req.target.source, root)
  return {
    applied: false,
    needsAgent: true,
    agentPrompt: `Move the element at ${dragged} to be ${req.position} the element at ${target}. ${reason}`
  }
}
