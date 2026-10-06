import type { ProjectMemory, ProjectMemoryUpdate } from '../main/project-memory'
import { memoryChangeNote } from '../main/project-memory-format'
import type { NativeSheetController } from './sheets-runtime'

/**
 * The non-blocking note after an automatic project-memory update or cleanup
 * (LKM-177): "Project memory updated: +1 rule" with View (the memory editor) and
 * Undo (restore the memory as it was, only if nothing changed it since).
 */
export function showProjectMemoryNote(
  sheets: Pick<NativeSheetController, 'toast'>,
  update: ProjectMemoryUpdate,
  deps: {
    view: (root: string) => void
    undo: (update: ProjectMemoryUpdate) => Promise<ProjectMemory | null>
  }
): string {
  const message = memoryChangeNote(update.before.content, update.after.content)
  sheets.toast(
    message,
    [
      { label: 'View', run: async () => deps.view(update.root) },
      {
        label: 'Undo',
        run: async () => {
          let undone: ProjectMemory | null = null
          try {
            undone = await deps.undo(update)
          } catch {
            undone = null
          }
          sheets.toast(
            undone
              ? 'Project memory change undone'
              : 'Project memory changed since, so nothing was undone'
          )
        }
      }
    ],
    8
  )
  return message
}
