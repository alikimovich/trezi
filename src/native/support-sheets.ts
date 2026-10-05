import type { Diagnosis } from '../shared/api'
import type { NativeSheetController } from './sheets-runtime'
/** What the diagnostics consent covers (gathered by src/main/feedback-diagnostics.ts). */
export const DIAGNOSTICS_CONSENT =
  'App, service and helper logs from the last hour, this chat’s landing state, the git status of its worktree, and a 3-second sample of the app if it is busy. Secrets are removed and your home folder is shortened to ~.'
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
          { id: 'send', label: 'Post feedback', primary: true }
        ]
      },
      async (action) => {
        if (!action.values.body?.trim()) throw new Error('Write your feedback before posting.')
        const result = await this.sheets.invoke('feedback:submit', {
          body: action.values.body,
          screenshot: action.values.screenshot === 'yes' ? screenshot : null,
          conversation: action.values.conversation === 'yes' ? conversation : null,
          diagnostics: action.values.diagnostics === 'yes',
          chat:
            action.values.diagnostics === 'yes' && chat
              ? { key: this.sheets.chat.active, root: chat.root }
              : null
        })
        if (!result.ok) throw new Error(result.error ?? 'Could not send feedback.')
        if (this.sheets.current?.state.id !== action.id) return
        this.sheets.present(
          {
            title: 'Feedback sent',
            detail: 'Your issue is now on GitHub.',
            fields: [],
            actions: [
              { id: 'cancel', label: 'Close' },
              ...(result.url ? [{ id: 'view', label: 'View issue' }] : [])
            ]
          },
          async () => {
            if (result.url) await this.openExternal(result.url)
          }
        )
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
            actions: [
              { id: 'dismiss', label: 'Not now' },
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
