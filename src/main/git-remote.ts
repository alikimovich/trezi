import type { GitRemoteAction } from '../shared/api'
import type { RpcHandlerRegistry } from './rpc-router'
import { workflowOwner } from './workflow-owner'

/**
 * Remote Git actions (fetch, pull, switch to a remote branch). The service's workflow
 * owner runs them in the repository lane and journals each step (S13,
 * `WorkflowRemote.swift`); this only routes the sheet's requests.
 */
export function registerGitRemoteIpc(
  router: RpcHandlerRegistry,
  busy: (root: string) => boolean
): void {
  // `busy` is Bun's view of the project's running agents when the request is made.
  router.handle('git:remote-status', (_event, root: string, fetch?: boolean) =>
    workflowOwner().remoteStatus(root, fetch ?? false)
  )
  router.handle('git:remote-update', (_event, root: string, action: GitRemoteAction) =>
    workflowOwner().remoteUpdate(root, action, busy(root))
  )
}
