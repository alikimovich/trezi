import type { PreviewOverlayState } from '../shared/preview-overlay'

/**
 * The preview's rulers, guides and layout grids as the agent sees them (LKM-205):
 * `workspace_state` reports them read-only. Only the user changes them, in the native
 * overlay; the native backend supplies the source from the stored preference.
 */
export type AgentPreviewOverlay = PreviewOverlayState & { viewport: string }

let read: (root: string) => AgentPreviewOverlay | null = () => null
export function setPreviewOverlaySource(
  source: (root: string) => AgentPreviewOverlay | null
): void {
  read = source
}
export function agentPreviewOverlay(root: string): Record<string, unknown> | null {
  const state = read(root)
  if (!state) return null
  return {
    ...state,
    readOnly: true,
    note: 'Rulers, guides and layout grids the user set over the preview, in page CSS px. Only the user can change them.'
  }
}
