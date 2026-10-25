import type {
  Diagnosis,
  FeedbackAccount,
  FeedbackInput,
  FeedbackResult,
  FeedbackScreenshot
} from '../shared/api'
import type { NativeSheetController } from './sheets-runtime'
/** What the diagnostics consent covers (gathered by src/main/feedback-diagnostics.ts). */
export const DIAGNOSTICS_CONSENT =
  'The last 30 minutes of Trezi’s logs (Help → Show Logs in Finder), the system log from the last hour, this chat’s landing state, the git status of its worktree, and a 3-second sample of the app if it is busy. Secrets are removed and your home folder is shortened to ~.'
/** LKM-336: where feedback goes, said on the sheet. */
export const FEEDBACK_PRIVACY =
  'Your feedback goes privately to the Trezi developer. It is not posted on a public page.'
export const INVITE_PROMPT = 'Enter the invite code from your Trezi beta invite.'
type Failure = Extract<FeedbackResult, { ok: false }>
export class NativeSupportSheets {
  constructor(
    readonly sheets: NativeSheetController,
    readonly capture: () => Promise<FeedbackScreenshot | null>
  ) {}
  async feedback() {
    const generation = this.sheets.generation
    // Captured before any sheet is up, so the screenshot shows the window as the user saw it.
    const [screenshot, account] = await Promise.all([
      this.capture().catch(() => null),
      this.sheets
        .invoke('feedback:account')
        .catch((): FeedbackAccount => ({ hasCode: false })) as Promise<FeedbackAccount>
    ])
    if (generation !== this.sheets.generation) return
    const valid = account.hasCode && !account.invalid
    if (!valid)
      return this.inviteCode(account.hasCode ? account.error : undefined, (name) =>
        this.compose(screenshot, name)
      )
    this.compose(screenshot, account.name)
  }
  /** Asks for the invite code once; the code is checked and saved before `then` runs. */
  private inviteCode(
    message: string | undefined,
    then: (name: string | null, sheet: string) => void | Promise<void>
  ) {
    this.sheets.present(
      {
        title: 'Enter your invite code',
        detail: `${INVITE_PROMPT} Trezi keeps it encrypted with your Keychain and sends it only to the Trezi feedback service. You can change or remove it in Settings → General.`,
        fields: [
          {
            id: 'code',
            label: 'Invite code',
            kind: 'secure',
            value: '',
            placeholder: 'Paste invite code'
          }
        ],
        message,
        actions: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'continue', label: 'Continue', primary: true }
        ]
      },
      async (action) => {
        const code = action.values.code?.trim() ?? ''
        if (!code) throw new Error(INVITE_PROMPT)
        const result = await this.sheets.invoke('feedback:code', code)
        if (!result?.ok) throw new Error(result?.error ?? 'Could not save the invite code.')
        if (this.sheets.current?.state.id !== action.id) return
        await then(result.name ?? null, action.id)
      }
    )
  }
  private compose(screenshot: FeedbackScreenshot | null, name: string | null) {
    const chat = this.sheets.chat.chats.get(this.sheets.chat.active)
    const conversation =
      chat?.messages
        .filter((m) => m.text.trim())
        .map((m) => `${m.role === 'user' ? 'You' : 'Trezi'}: ${m.text.trim()}`)
        .join('\n\n') ?? ''
    this.sheets.present(
      {
        title: 'Send feedback',
        detail:
          (name ? `Sending as ${name}. ` : '') +
          FEEDBACK_PRIVACY +
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
                  value: screenshot.preview
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
            : []),
          // LKM-165: diagnostics are attached only with this explicit consent.
          {
            id: 'diagnostics',
            label: 'Include diagnostics',
            kind: 'choice',
            value: 'no',
            choices: [
              { value: 'yes', label: 'Include' },
              { value: 'no', label: 'Do not include' }
            ]
          },
          {
            id: 'diagnostics-detail',
            label: 'Diagnostics',
            kind: 'readonly',
            value: DIAGNOSTICS_CONSENT
          }
        ],
        actions: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'send', label: 'Send feedback', primary: true }
        ]
      },
      async (action) => {
        if (!action.values.body?.trim()) throw new Error('Write your feedback before sending.')
        const input: FeedbackInput = {
          body: action.values.body,
          screenshot:
            action.values.screenshot === 'yes' && screenshot
              ? { contentType: screenshot.contentType, data: screenshot.data }
              : null,
          conversation: action.values.conversation === 'yes' ? conversation : null,
          diagnostics: action.values.diagnostics === 'yes',
          chat:
            action.values.diagnostics === 'yes' && chat
              ? { key: this.sheets.chat.active, root: chat.root }
              : null
        }
        const failure = await this.submit(input, action.id)
        if (this.sheets.current?.state.id !== action.id) return
        if (failure) this.failed(input, failure)
      }
    )
  }
  /** Sends the report; on success closes the sheet and shows the toast, else returns the failure. */
  private async submit(input: FeedbackInput, sheet: string): Promise<Failure | null> {
    const result: FeedbackResult = await this.sheets
      .invoke('feedback:submit', input)
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retry: true
      }))
    if (!result.ok) return { ...result, error: result.error || 'Could not send feedback.' }
    if (this.sheets.current?.state.id === sheet) this.sheets.close()
    this.sheets.toast(
      `Feedback sent (${result.issue}).${result.warning ? ` ${result.warning}` : ''}`
    )
    return null
  }
  /**
   * The standard error sheet. Retry sends the same report again when that can help (no
   * network, a server error, a rate limit); a refused invite code offers a new one.
   */
  private failed(input: FeedbackInput, failure: Failure) {
    const details = (message: string) =>
      `Trezi could not send this feedback.\nError: ${message}\n\nFeedback:\n${input.body.trim()}`
    const primary = failure.code
      ? [{ id: 'code', label: 'Enter invite code…', primary: true }]
      : failure.retry
        ? [{ id: 'retry', label: 'Retry', primary: true }]
        : []
    this.sheets.present(
      {
        title: 'Couldn’t send feedback',
        detail: failure.error,
        fields: [],
        actions: [
          { id: 'copy', label: 'Copy details', copy: details(failure.error) },
          { id: 'cancel', label: primary.length ? 'Cancel' : 'Close' },
          ...primary
        ]
      },
      async (action) => {
        const sheet = this.sheets.current
        if (action.action === 'copy') {
          if (sheet?.state.id === action.id)
            sheet.state.message = 'Details copied to the clipboard.'
          return
        }
        // The new code's sheet stays busy while the same report is sent again.
        if (action.action === 'code')
          return this.inviteCode(undefined, async (_name, id) => {
            const again = await this.submit(input, id)
            if (again && this.sheets.current?.state.id === id) this.failed(input, again)
          })
        const next = await this.submit(input, action.id)
        if (!next || !sheet || sheet !== this.sheets.current) return
        if (next.code || !next.retry) return this.failed(input, next)
        sheet.state.detail = next.error
        const copy = sheet.state.actions.find((a) => a.id === 'copy')
        if (copy) copy.copy = details(next.error)
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
