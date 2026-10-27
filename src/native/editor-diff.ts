import { projectFile } from '../main/code-sources'
import { codeTarget } from '../main/code-tools'
import type { NativeEditorAction } from '../shared/native-editor'
import type { EditorSession, NativeEditorController } from './editor-controller'

/**
 * The editor sidebar's read-only Changes list (LKM-364). Each project's session keeps
 * its own diff, so nothing carries over between projects; a read that finishes after a
 * newer one (or after a project switch re-read) is dropped. Opening a listed file goes
 * through the same project-file check and `open` with a range as `open_code`, so a
 * draft is kept and nothing is written.
 */
export async function refreshDiff(controller: NativeEditorController, session: EditorSession) {
  const generation = ++session.diffGeneration
  session.state.diffBusy = true
  controller.publish(session)
  try {
    const diff = await controller.diffs(session.state.root)
    if (generation === session.diffGeneration) session.state.diff = diff
  } catch (error) {
    if (generation === session.diffGeneration)
      session.state.diff = {
        root: session.state.root,
        git: true,
        branch: '',
        head: '',
        detached: false,
        base: null,
        sections: [],
        message: `Could not read the changes: ${String(error)}`
      }
  } finally {
    if (generation === session.diffGeneration) {
      session.state.diffBusy = false
      controller.publish(session)
    }
  }
}

/** A click on a listed file (its first hunk) or one of its hunks. */
export async function openDiff(
  controller: NativeEditorController,
  session: EditorSession,
  action: NativeEditorAction
) {
  const root = session.state.root
  const refuse = (error: string) => {
    session.state.error = error
    controller.publish(session)
  }
  const file = session.state.diff?.sections
    .find((section) => section.kind === action.section)
    ?.files.find((listed) => listed.path === action.source)
  if (!file) return refuse('That file is no longer in the Changes list. Refresh it.')
  if (file.status === 'deleted')
    return refuse(`${file.path} was deleted, so there is no file to open.`)
  if (file.binary) {
    const located = await projectFile(root, file.path)
    if (!located) return refuse('Not opened in the editor: the file must be inside the project.')
    return controller.open(root, `${located.file}:1`)
  }
  const hunk = file.hunks[action.hunk ?? 0]
  const start = Math.max(1, hunk?.newStart ?? 1)
  const lines = hunk
    ? { startLine: start, endLine: start + Math.max(1, hunk.newCount) - 1 }
    : undefined
  const target = await codeTarget(root, file.path, lines)
  if ('error' in target) return refuse(`Not opened in the editor: ${target.error}`)
  await controller.open(root, target.source, undefined, false, target.range)
}
