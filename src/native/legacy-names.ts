import type { LegacyNamesPlan, LegacyNamesResult } from '../main/editing-owner'
import type { NativeSheetController } from './sheets-runtime'

/**
 * The confirmation half of the one-time rename to Trezi names (LKM-132). A clean
 * project migrates on detection without asking; a project with uncommitted changes is
 * never rewritten silently: on activation it gets this sheet, once per project per
 * launch. Old names keep working either way, so "Not now" loses nothing.
 */
export class NativeLegacyNames {
  private readonly asked = new Set<string>()
  constructor(
    readonly sheets: NativeSheetController,
    readonly invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>,
    readonly report: (message: string, level: 'error' | 'success') => void
  ) {}

  async check(key: string, root: string) {
    if (this.asked.has(root) || this.sheets.current) return
    const plan = await this.invoke<LegacyNamesPlan>('project:legacy-names', root)
    if (!plan.legacy || plan.clean || this.asked.has(root) || this.sheets.current) return
    this.asked.add(root)
    const files = [...plan.helpers, ...plan.files]
    this.sheets.present(
      {
        title: 'Update setup files?',
        alert: true,
        detail: `${root}\n\nThis project has setup files from an earlier Trezi version. They still work. Updating renames them to the current names. The project has uncommitted changes, so Trezi asks first; nothing is committed.`,
        fields: [
          {
            id: 'files',
            label: 'Files to update',
            kind: 'readonly',
            value:
              files.slice(0, 40).join('\n') +
              (files.length > 40 ? `\n…and ${files.length - 40} more` : '')
          }
        ],
        actions: [
          { id: 'cancel', label: 'Not now' },
          { id: 'update', label: 'Update files', primary: true }
        ]
      },
      async (action) => {
        if (action.action !== 'update') return
        if (this.sheets.workspace.state.activeKey !== key)
          throw new Error('The active project changed. Nothing was updated.')
        const result = await this.invoke<LegacyNamesResult>('project:migrate-names', root)
        if (this.sheets.current?.state.id === action.id) this.sheets.close()
        if (!result.migrated) return
        this.report(
          `Updated ${result.files.length} file${result.files.length === 1 ? '' : 's'} to current Trezi names.${result.kept.length ? ` Earlier helpers that differed are kept in .trezi/legacy/.` : ''}`,
          'success'
        )
        await this.sheets.workspace.command({ type: 'restart', key })
      }
    )
  }
}
