/** Private native composer events. Delivered directly from AppKit to the Bun chat controller. */
export type NativeComposerAction = { chat: string } & (
  | { action: 'attachment-error'; message: string }
  /** `sent`: the accepted sends the composer had applied (LKM-304, `Chat.sent`; absent: current). */
  | { action: 'input'; text: string; caret: number; revision: number; sent?: number }
  /** `attempt` (LKM-338): the composer's number for a Return that may send the draft. */
  | { action: 'key'; key: string; attempt?: number }
  /** `stop`: whether the clicked button showed Stop (absent: either). `attempt` (LKM-338):
   *  the composer's increasing number for this Send, echoed in `composer.sending`. */
  | { action: 'send'; stop?: boolean; attempt?: number }
  /** LKM-338: Stop on a send that has not left the composer; the draft stays as it is. */
  | { action: 'cancel-send'; attempt: number }
  | { action: 'context' }
  | { action: 'choice'; label: string; value: string }
  | { action: 'suggestion' | 'remove' | 'unreference'; index: number }
  | {
      action: 'files'
      files: { name: string; path: string; type: string; data: string; preview?: string }[]
    }
)
