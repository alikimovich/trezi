import type { RepositoryOwner } from '../main/repository-owner'
import type { NativeSheetController } from './sheets-runtime'

/** `root\nbranch\ntip` of each notice the user ignored; a branch that moves asks again. */
export const IGNORED_KEY = 'trezi:stranded-landings-ignored'
const KEEP = 50

export interface StrandedLandingsDeps {
  sheets: Pick<NativeSheetController, 'toast'>
  owner: () => Pick<RepositoryOwner, 'strandedLandings' | 'restoreLandings'>
  preferences: {
    get(key: string): string | null
    set(key: string, value: string | null): Promise<void>
  }
  log: (text: string, kind: string) => void
  /** After a merge: refresh the branch label and the preview environment. */
  restored: (root: string, files: string[]) => Promise<void>
}

export function strandedMessage(count: number, branch: string, current: string): string {
  return `${count} earlier chat ${count === 1 ? 'change is' : 'changes are'} on branch ${branch}, not on ${current}`
}

/**
 * LKM-185: once per project per launch, landed chat commits that only another local
 * branch holds (an older publish moved the live checkout off them) get one notice
 * with "Bring them back" (a merge, with the normal conflict flow) and "Ignore".
 * Answers the message shown, or null.
 */
export function strandedLandingsNotice(deps: StrandedLandingsDeps) {
  const checked = new Set<string>()
  const ignored = (): string[] => {
    try {
      const value = JSON.parse(deps.preferences.get(IGNORED_KEY) ?? '[]')
      return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
    } catch {
      return []
    }
  }
  return async (root: string | undefined): Promise<string | null> => {
    if (!root || checked.has(root)) return null
    checked.add(root)
    const found = await deps.owner().strandedLandings(root)
    const key = (branch: string, tip: string) => `${root}\n${branch}\n${tip}`
    const skip = new Set(ignored())
    const first = found.branches.find((item) => !skip.has(key(item.branch, item.tip)))
    if (!first || !found.current) return null
    const current = found.current
    const message = strandedMessage(first.count, first.branch, current)
    deps.sheets.toast(
      message,
      [
        {
          label: 'Bring them back',
          run: async () => {
            try {
              const result = await deps.owner().restoreLandings(root, first.branch, first.tip)
              if (result.merged) {
                deps.log(
                  `Brought back earlier chat changes from ${first.branch} into ${current}`,
                  'success'
                )
              } else {
                deps.log(
                  `Bringing back ${first.branch} paused because it overlaps ${current} in ${result.conflictFiles.length} ${result.conflictFiles.length === 1 ? 'file' : 'files'}:\n${result.conflictFiles.join('\n')}\nResolve and stage each file, then commit the merge.\nRecovery refs: ${result.recoveryRefs.join(', ')}`,
                  'warning'
                )
              }
              await deps.restored(root, result.files)
            } catch (error) {
              deps.log(String(error), 'error')
            }
          }
        },
        {
          label: 'Ignore',
          run: async () => {
            const entry = key(first.branch, first.tip)
            const next = [...ignored().filter((item) => item !== entry), entry]
            await deps.preferences.set(IGNORED_KEY, JSON.stringify(next.slice(-KEEP)))
          }
        }
      ],
      30
    )
    return message
  }
}
