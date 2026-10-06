import type { Diagnosis, FeedbackInput, FeedbackResult } from '../shared/api'
import type { NativeSheetController } from './sheets-runtime'
export class NativeSupportSheets {
  constructor(
    readonly sheets: NativeSheetController,
    readonly capture: () => Promise<string | null>,
    readonly openExternal: (url: string) => Promise<unknown>
  ) {}
  async feedback() {
    const generation = this.sheets.generation
    const chat = this.sheets.chat.chats.get(this.sheets.chat.active)
    const conversation =
      chat?.messages
        .filter((m) => m.text.trim())
        .map((m) => `${m.role === 'user' ? 'You' : 'Trezi'}: ${m.text.trim()}`)
        .join('\n\n') ?? ''
    const screenshot = await this.capture().catch(() => null)
    if (generation !== this.sheets.generation) return
    this.sheets.present(
      {
        title: 'Send feedback',
        detail:
          'Post feedback as an issue on the Trezi GitHub repository.' +
          (screenshot || conversation
            ? ' Review the attachments below before including them.'
            : ''),
        fields: [
          {
            id: 'body',
            label: 'What happened, or what could be better?',
            kind: 'multiline',
            value: ''
          },
          ...(screenshot
            ? [
                {
                  id: 'preview',
                  label: 'Screenshot preview',
                  kind: 'image' as const,
                  value: screenshot
                },
                {
                  id: 'screenshot',
                  label: 'Include screenshot',
                  kind: 'choice' as const,
                  value: 'yes',
                  choices: [
                    { value: 'yes', label: 'Include' },
                    { value: 'no', label: 'Do not include' }
                  ]
                }
              ]
            : []),
          ...(conversation
            ? [
                {
                  id: 'conversation',
                  label: 'Include current chat',
                  kind: 'choice' as const,
                  value: 'yes',
                  choices: [
                    { value: 'yes', label: 'Include' },
                    { value: 'no', label: 'Do not include' }
                  ]
                },
                {
                  id: 'transcript',
                  label: 'Chat preview',
                  kind: 'readonly' as const,
                  value: conversation
                }
              ]
            : [])
        ],
        actions: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'send', label: 'Post feedback', primary: true }
        ]
      },
      async (action) => {
        if (!action.values.body?.trim()) throw new Error('Write your feedback before posting.')
        const input = {
          body: action.values.body,
          screenshot: action.values.screenshot === 'yes' ? screenshot : null,
          conversation: action.values.conversation === 'yes' ? conversation : null
        }
        const error = await this.submit(input, action.id)
        if (this.sheets.current?.state.id !== action.id) return
        if (error) this.failed(input, error)
      }
    )
  }
  /** Posts the issue; on success closes the sheet and shows the toast, else returns the error. */
  private async submit(input: FeedbackInput, sheet: string): Promise<string | null> {
    const result: FeedbackResult = await this.sheets
      .invoke('feedback:submit', input)
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    if (!result.ok) return result.error || 'Could not send feedback.'
    if (this.sheets.current?.state.id === sheet) this.sheets.close()
    const url = result.url
    this.sheets.toast(
      'Feedback sent',
      url ? { label: 'View on GitHub', run: () => this.openExternal(url) } : undefined
    )
    return null
  }
  /** The standard error sheet: Retry posts the same feedback again, Esc cancels. */
  private failed(input: FeedbackInput, error: string) {
    const details = (message: string) =>
      `Trezi could not post this feedback to GitHub.\nError: ${message}\n\nFeedback:\n${input.body.trim()}`
    this.sheets.present(
      {
        title: 'Couldn’t send feedback',
        detail: error,
        fields: [],
        actions: [
          { id: 'copy', label: 'Copy details', copy: details(error) },
          { id: 'cancel', label: 'Cancel' },
          { id: 'retry', label: 'Retry', primary: true }
        ]
      },
      async (action) => {
        const sheet = this.sheets.current
        if (action.action === 'copy') {
          if (sheet?.state.id === action.id)
            sheet.state.message = 'Details copied to the clipboard.'
          return
        }
        const next = await this.submit(input, action.id)
        if (!next || !sheet || sheet !== this.sheets.current) return
        sheet.state.detail = next
        const copy = sheet.state.actions.find((a) => a.id === 'copy')
        if (copy) copy.copy = details(next)
      }
    )
  }
  diagnose(key: string) {
    const entry = this.sheets.workspace.state.projects.find((p) => p.key === key)
    if (!entry) return
    const status = this.sheets.workspace.state.status
    const error =
      status.kind === 'error' ? status.message : 'The preview is not working as expected.'
    this.sheets.present(
      {
        title: 'Preview problem',
        detail: error,
        fields: [],
        actions: [
          { id: 'cancel', label: 'Close' },
          { id: 'retry', label: 'Restart preview' },
          { id: 'diagnose', label: 'Find a fix…', primary: true }
        ]
      },
      async (action) => {
        if (action.action === 'retry') {
          await this.sheets.workspace.command({ type: 'restart', key })
          if (this.sheets.current?.state.id === action.id) this.sheets.close()
          return
        }
        const diagnosis: Diagnosis | null = await this.sheets.invoke(
          'diagnose:run',
          entry.root,
          error,
          entry.launchSpec?.command ?? ''
        )
        if (this.sheets.current?.state.id !== action.id) return
        if (!diagnosis)
          throw new Error(
            'Could not find a fix. Check your AI provider sign-in or open Activity for error details.'
          )
        this.sheets.present(
          {
            title: 'Suggested fix',
            detail:
              diagnosis.summary +
              (diagnosis.steps.some((s) => s.scope === 'repo')
                ? '\n\nAdd the project steps to a chat draft, then review and send it to make the changes.'
                : ''),
            fields: [
              {
                id: 'steps',
                label: 'Suggested steps',
                kind: 'readonly',
                value: [
                  diagnosis.detail,
                  ...diagnosis.steps.map(
                    (s) =>
                      `${s.scope === 'repo' ? 'Project' : 'Your Mac'}: ${s.text}${s.command ? '\n' + s.command : ''}`
                  )
                ]
                  .filter(Boolean)
                  .join('\n\n')
              }
            ],
            alert: true,
            actions: [
              { id: 'dismiss', label: 'Not now', cancel: true },
              ...(diagnosis.steps.some((s) => s.scope === 'repo')
                ? [{ id: 'apply', label: 'Draft fix in chat', primary: true }]
                : [])
            ]
          },
          async (choice) => {
            if (choice.action === 'apply') {
              if (!this.sheets.workspace.state.projects.includes(entry))
                throw new Error('Reopen this project before preparing its fix.')
              const steps = diagnosis.steps.filter((s) => s.scope === 'repo')
              await this.sheets.chat.command({
                type: 'seed',
                chat: entry.activeSessionKey,
                text:
                  `Fix this so the project runs: ${diagnosis.summary}\n` +
                  steps
                    .map((s) => `- ${s.text}${s.command ? ' (e.g. ' + s.command + ')' : ''}`)
                    .join('\n')
              })
              // A failed open hides the chat; choosing to fix it in chat shows it for this project.
              const workspace = this.sheets.workspace
              if (
                workspace.state.activeKey === entry.key &&
                workspace.state.loadedKey !== entry.key
              ) {
                workspace.state.loadedKey = entry.key
                workspace.changed()
              }
            }
            await this.sheets.invoke(
              'diagnose:record',
              entry.root,
              diagnosis.signature,
              choice.action === 'apply' ? 'applied' : 'dismissed'
            )
            if (this.sheets.current?.state.id === choice.id) this.sheets.close()
          }
        )
      }
    )
  }
}
