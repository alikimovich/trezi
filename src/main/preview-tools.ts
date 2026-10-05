import { type PreviewOpenRequest, previewPath } from '../shared/preview-navigation'

export function openAgentPreview(
  root: string,
  key: string,
  raw: unknown,
  notify: (channel: string, payload: unknown) => void,
  background = false
): unknown {
  if (background) return { error: 'Background edits cannot navigate the user preview.' }
  const path = previewPath((raw as { path?: unknown })?.path)
  if (!path)
    return {
      error: 'Provide a project-root path starting with /, including optional query and hash.'
    }
  const request: PreviewOpenRequest = { root, key, path }
  notify('preview:open', request)
  return {
    requested: true,
    path,
    message:
      'Requested navigation in the active chat/project preview after this turn lands and the web preview is running. This does not confirm the page has loaded.'
  }
}
