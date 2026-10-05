import type { SessionRecord } from '../shared/api'
import type { NativeSheetController } from './sheets-runtime'
export class NativeReviewController {
  constructor(
    readonly sheets: NativeSheetController,
    readonly openExternal: (url: string) => Promise<unknown>
  ) {}
  async open(id: string) {
    const generation = this.sheets.generation
    const record: SessionRecord | null = await this.sheets.invoke('sessions:get', id)
    if (!record || generation !== this.sheets.generation) return
    this.show(record)
  }
  private show(record: SessionRecord) {
    const comment = record.kind === 'comment' && !!record.branch
    this.sheets.present(
      {
        title: record.title || 'Saved chat',
        detail: [record.projectName, record.branch, new Date(record.startedAt).toLocaleString()]
          .filter(Boolean)
          .join(' · '),
        fields: [
          ...(record.filesTouched.length
            ? [
                {
                  id: 'files',
                  label: 'Files changed',
                  kind: 'readonly' as const,
                  value: record.filesTouched.join('\n')
                }
              ]
            : []),
          {
            id: 'transcript',
            label: 'Chat history',
            kind: 'readonly',
            value:
              record.transcript
                .map(
                  (t) =>
                    `${t.role === 'user' ? 'You' : t.role === 'assistant' ? 'Trezi' : t.role}\n${t.text}`
                )
                .join('\n\n') || 'No messages were saved for this chat.'
          }
        ],
        actions: [
          { id: 'cancel', label: 'Close' },
          { id: 'rename', label: 'Rename…' },
          ...(!comment ? [{ id: 'remove-record', label: 'Delete history…' }] : []),
          ...(record.prUrl ? [{ id: 'view-pr', label: 'View PR' }] : []),
          ...(comment
            ? [
                { id: 'apply', label: 'Apply' },
                ...(!record.prUrl ? [{ id: 'pr', label: 'Create PR' }] : []),
                { id: 'discard', label: 'Discard…' }
              ]
            : []),
          ...(record.sdkSessionId ? [{ id: 'resume', label: 'Continue chat', primary: true }] : [])
        ]
      },
      async (action) => {
        const current = () => this.sheets.current?.state.id === action.id
        const title =
          record.transcript.find((t) => t.role === 'user')?.text.slice(0, 70) ||
          'Trezi comment edit'
        if (action.action === 'rename') {
          const project = this.sheets.workspace.state.projects.find(
            (p) => p.root === record.projectRoot
          )
          if (project) this.sheets.renameChat('history:' + record.id, project.key)
          return
        }
        if (action.action === 'view-pr' && record.prUrl) {
          await this.openExternal(record.prUrl)
          return
        }
        if (action.action === 'remove-record') {
          this.sheets.present(
            {
              title: 'Delete this chat from history?',
              detail:
                'This removes the saved messages from history. It does not change your project files.',
              fields: [],
              actions: [
                { id: 'back', label: 'Back' },
                { id: 'delete', label: 'Delete chat', primary: true, destructive: true }
              ]
            },
            async (confirmation) => {
              if (confirmation.action === 'back') {
                this.show(record)
                return
              }
              await this.sheets.invoke('sessions:remove', record.id)
              const project = this.sheets.workspace.state.projects.find(
                (p) => p.root === record.projectRoot
              )
              if (project) {
                this.sheets.workspace.state.history[project.key] = await this.sheets.invoke(
                  'sessions:list',
                  record.projectRoot
                )
                this.sheets.workspace.changed()
              }
              if (this.sheets.current?.state.id === confirmation.id) this.sheets.close()
            }
          )
          return
        }
        if (action.action === 'discard') {
          this.sheets.present(
            {
              title: 'Discard this saved work?',
              detail:
                'Delete the saved branch and chat history. Any changes already applied to your project will stay.',
              fields: [],
              actions: [
                { id: 'back', label: 'Back' },
                { id: 'discard', label: 'Discard', primary: true, destructive: true }
              ]
            },
            async (confirmation) => {
              if (confirmation.action === 'back') {
                this.show(record)
                return
              }
              const result = await this.sheets.invoke(
                'agent:spawn-discard',
                record.projectRoot,
                record.branch
              )
              if (!result.ok) throw new Error(result.error || 'Could not discard this saved work.')
              await this.sheets.invoke('sessions:remove', record.id)
              const project = this.sheets.workspace.state.projects.find(
                (p) => p.root === record.projectRoot
              )
              if (project) {
                this.sheets.workspace.state.history[project.key] = await this.sheets.invoke(
                  'sessions:list',
                  record.projectRoot
                )
                this.sheets.workspace.changed()
              }
              if (this.sheets.current?.state.id === confirmation.id) this.sheets.close()
            }
          )
          return
        }
        if (action.action === 'resume') {
          const project = this.sheets.workspace.state.projects.find(
            (p) => p.root === record.projectRoot
          )
          if (!project) throw new Error('Open this project before resuming its chat.')
          await this.sheets.workspace.command({
            type: 'resume',
            key: project.key,
            record: record.id
          })
          if (current()) this.sheets.close()
          return
        }
        const result =
          action.action === 'apply'
            ? await this.sheets.invoke('agent:spawn-apply', record.projectRoot, record.branch)
            : await this.sheets.invoke(
                'agent:spawn-pr',
                record.projectRoot,
                record.branch,
                title,
                record.id
              )
        if (!result.ok) throw new Error(result.error || 'The operation failed.')
        if (!current()) return
        if (result.prUrl) {
          record.prUrl = result.prUrl
          this.show(record)
        } else
          this.sheets.current!.state.message = 'Applied to your project. The preview will refresh.'
      }
    )
  }
}
