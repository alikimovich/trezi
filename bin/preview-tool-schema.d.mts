import type { ZodTypeAny } from 'zod'
type PreviewTool = 'preview_screenshot' | 'preview_inspect' | 'preview_evaluate' | 'preview_console' | 'preview_viewport' | 'preview_speed' | 'preview_interact' | 'preview_verify'
export const previewToolShapes: Record<PreviewTool, Record<string, ZodTypeAny>>
export const previewToolText: Record<PreviewTool, string>
export const runChecksShape: Record<'checks' | 'list' | 'timeoutSeconds', ZodTypeAny>
export const runChecksText: string
