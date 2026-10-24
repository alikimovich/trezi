/** Private native composer events. Delivered directly from AppKit to the Bun chat controller. */
export type NativeComposerAction = { chat: string } & (
  | { action: 'attachment-error'; message: string }
  /** `sent`: the accepted sends the composer had applied (LKM-304, `Chat.sent`; absent: current). */
  | { action: 'input'; text: string; caret: number; revision: number; sent?: number }
  | { action: 'key'; key: string }
  /** `stop`: whether the clicked button showed Stop (absent: either). */
  | { action: 'send'; stop?: boolean }
  | { action: 'context' }
  | { action: 'choice'; label: string; value: string }
  | { action: 'suggestion' | 'remove' | 'unreference'; index: number }
  | {
      action: 'files'
      files: { name: string; path: string; type: string; data: string; preview?: string }[]
    }
)
