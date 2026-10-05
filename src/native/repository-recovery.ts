import { basename } from 'node:path'
import type {
  RecoveryRepository,
  RepositoryOwner,
  RepositoryStatus
} from '../main/repository-owner'
import type { NativeSheetController } from './sheets-runtime'

export interface RecoveryNotice {
  text: string
  kind: 'info' | 'warning' | 'error'
}

const NAMESPACE = 'refs/trezi/recovery/'
const VIEW = 'Activity › Recovery Refs… lists them and can delete them.'
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * The launch report of the repository journal (LKM-134). The service closes every
 * interrupted entry when it opens the journal, so each appears here at one launch
 * only. Work kept at a recovery ref was not lost, so none of this is an error; only a
 * damaged journal (which blocks every repository change) is.
 */
export function recoveryNotices(status: RepositoryStatus): RecoveryNotice[] {
  const notices: RecoveryNotice[] = []
  if (status.journal) notices.push({ text: `Repository journal: ${status.journal}`, kind: 'error' })
  for (const entry of status.recovered ?? []) {
    const head = `An earlier ${entry.kind} in ${entry.root} was interrupted; nothing was replayed.`
    const kept = entry.refs.filter((ref) => !entry.missing.includes(ref))
    if (!entry.refs.length)
      notices.push({
        text: `${head} It had not changed anything that needed a recovery ref.`,
        kind: 'info'
      })
    else if (entry.unreadable)
      notices.push({
        text: `${head} The repository can no longer be read, so its recovery refs (${entry.refs.join(', ')}) could not be checked.`,
        kind: 'warning'
      })
    else if (!entry.missing.length)
      notices.push({
        text: `${head} Its work is kept at ${kept.join(', ')}. ${VIEW}`,
        kind: 'info'
      })
    else
      notices.push({
        text: `${head}${kept.length ? ` Its work is kept at ${kept.join(', ')}.` : ''} ${entry.missing.join(', ')} ${entry.missing.length === 1 ? 'is' : 'are'} not in the repository: deleted since, or never made because the step it guarded had not started.`,
        kind: 'warning'
      })
  }
  if (status.closedEarlier > 0)
    notices.push({
      text: `Closed ${plural(status.closedEarlier, 'interrupted repository operation')} that earlier launches already reported; their recovery refs are kept. ${VIEW}`,
      kind: 'info'
    })
  return notices
}

/**
 * Recovery refs are never deleted automatically (`RecoveryRefs` in the service). This
 * sheet is the explicit action: it lists every kept ref of the open projects and of
 * the journal's repositories, and deletes only the ones the user selects and then
 * confirms, each only while it still points at the commit shown.
 */
export class NativeRecoveryRefs {
  constructor(
    readonly sheets: NativeSheetController,
    readonly repository: Pick<RepositoryOwner, 'recoveryRefs' | 'deleteRecoveryRefs'>,
    readonly roots: () => string[],
    readonly report: (text: string, kind: 'info' | 'error') => void
  ) {}

  async open() {
    const repositories = await this.repository.recoveryRefs([...new Set(this.roots())])
    const items = repositories.flatMap((repository) =>
      repository.refs.map((ref) => ({ root: repository.root, ...ref }))
    )
    this.sheets.present(
      {
        title: 'Recovery Refs',
        detail: items.length
          ? `Trezi keeps work that an interrupted or reconciling operation moved out of a checkout at ${NAMESPACE}… in its repository. They are never deleted automatically. Inspect one with \`git show <ref>\` in that repository; delete the ones whose work you no longer need.`
          : 'No recovery refs are kept in your projects.',
        fields: items.length
          ? [
              {
                id: 'refs',
                label: plural(items.length, 'kept ref'),
                kind: 'multichoice',
                value: '',
                placeholder: 'Filter refs',
                choices: items.map((item, index) => ({
                  value: String(index),
                  label:
                    `${basename(item.root)}  ${item.ref.slice(NAMESPACE.length)}  ${item.date.slice(0, 16).replace('T', ' ')}  ${item.subject}`.trim()
                }))
              }
            ]
          : [],
        actions: [
          { id: 'cancel', label: 'Done' },
          ...(items.length ? [{ id: 'delete', label: 'Delete Selected…', destructive: true }] : [])
        ]
      },
      async (action) => {
        if (action.action !== 'delete') return
        const chosen = (action.values.refs ?? '')
          .split('\n')
          .filter((value) => /^\d+$/.test(value))
          .map(Number)
          .filter((index) => items[index])
          .map((index) => items[index])
        if (!chosen.length) throw new Error('Select the recovery refs to delete.')
        this.confirm(chosen)
      }
    )
  }

  private confirm(chosen: Array<RecoveryRepository['refs'][number] & { root: string }>) {
    this.sheets.present(
      {
        title: `Delete ${plural(chosen.length, 'recovery ref')}?`,
        detail: `Work that only these refs keep becomes unreachable, and Git removes it at its next garbage collection. A ref that changed since it was listed is kept.\n\n${chosen.map((item) => `${item.root}: ${item.ref}`).join('\n')}`,
        fields: [],
        actions: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'delete', label: 'Delete', destructive: true }
        ]
      },
      async (action) => {
        if (action.action !== 'delete') return
        const byRoot = new Map<string, typeof chosen>()
        for (const item of chosen) byRoot.set(item.root, [...(byRoot.get(item.root) ?? []), item])
        let deleted = 0,
          kept = 0
        for (const [root, refs] of byRoot) {
          const result = await this.repository.deleteRecoveryRefs(
            root,
            refs.map(({ ref, sha }) => ({ ref, sha }))
          )
          deleted += result.deleted.length
          kept += result.kept.length
        }
        this.report(
          `Deleted ${plural(deleted, 'recovery ref')}${kept ? `; ${kept} changed since ${kept === 1 ? 'it was' : 'they were'} listed and ${kept === 1 ? 'was' : 'were'} kept` : ''}.`,
          'info'
        )
        if (this.sheets.current?.state.id === action.id) await this.open()
      }
    )
  }
}
