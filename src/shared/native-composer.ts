/** Private native composer events. Delivered directly from AppKit to the Bun chat controller. */
export type NativeComposerAction = { chat: string } & (
  | { action: 'attachment-error'; message: string }
  | { action: 'input'; text: string; caret: number; revision: number }
  | { action: 'key'; key: string }
  | { action: 'send' | 'context' | 'layers' }
  | { action: 'choice'; label: string; value: string }
  | { action: 'suggestion' | 'remove' | 'unreference'; index: number }
  | {
      action: 'files'
      files: { name: string; path: string; type: string; data: string; preview?: string }[]
    }
)
