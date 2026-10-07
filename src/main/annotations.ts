import { ipcMain } from '../native/platform'
import type { AnnotationInput, PublishResult } from '../shared/api'
import { publishProgress } from '../shared/publish-progress'
import { createAnnotationStore } from './annotation-store'
import { generatePublishDescription } from './publish-description'
import { workflowOwner } from './workflow-owner'

/**
 * Engineer handoff (v3): "Publish" turns the trezi-related working changes + the
 * reviewer notes into a branch and a PR. The notes themselves (`.trezi/annotations.json`)
 * are stored by `annotation-store.ts`; publication only reads them. The publish
 * workflows run in the workflow owner (S13, `workflow-owner.ts`); the legacy code is
 * `publish.ts`. PR descriptions are this module's helper (`generatePublishDescription`).
 */

const annotations = createAnnotationStore()

async function guarded(task: () => Promise<PublishResult>): Promise<PublishResult> {
  try {
    return await task()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerAnnotationsIpc(): void {
  ipcMain.handle('annotations:list', (_e, root: string) => annotations.list(root))
  ipcMain.handle('annotations:add', (_e, root: string, input: AnnotationInput) =>
    annotations.add(root, input)
  )
  ipcMain.handle('annotations:remove', (_e, root: string, id: string) =>
    annotations.remove(root, id)
  )
  ipcMain.handle('publish:to-pr', (_e, root: string, opts: { title: string }) =>
    guarded(async () => {
      // A damaged notes file stops publication before any Git mutation.
      const notes = await annotations.list(root)
      return workflowOwner().handoff(root, opts.title, notes.length, (base, head) =>
        generatePublishDescription(root, base, head)
      )
    })
  )
  ipcMain.handle('publish:ship', (_e, root: string, _summary?: string[], mode?: 'merge' | 'pr') =>
    guarded(() =>
      workflowOwner().publish(root, mode ?? 'merge', (base, head) =>
        generatePublishDescription(root, base, head)
      )
    )
  )
  // LKM-187: the toolbar follows the newest publish on a root and can stop it.
  ipcMain.handle('publish:progress', async (_e, root: string) =>
    publishProgress(await workflowOwner().workflows(), root)
  )
  ipcMain.handle('publish:cancel', (_e, root: string) => workflowOwner().cancel('publish', root))
}
