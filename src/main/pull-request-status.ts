import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface PullRequestStatus {
  number?: number
  url?: string
  mergeable?: string
  baseRefName?: string
  headRefName?: string
  statusCheckRollup?: unknown[]
  conflictingFiles: string[]
  error?: string
}

/** Read GitHub's mergeability and identify local conflict paths without changing either checkout. */
export async function pullRequestStatus(
  liveRoot: string,
  workRoot = liveRoot,
  number?: number
): Promise<PullRequestStatus> {
  try {
    const { stdout } = await exec(
      'gh',
      [
        'pr',
        'view',
        ...(number ? [String(number)] : []),
        '--json',
        'number,url,mergeable,baseRefName,headRefName,statusCheckRollup'
      ],
      { cwd: liveRoot, timeout: 30_000 }
    )
    const status = JSON.parse(stdout) as PullRequestStatus
    const base = status.baseRefName
    let conflictingFiles: string[] = []
    if (typeof base === 'string' && /^[A-Za-z0-9._/-]+$/.test(base)) {
      try {
        await exec('git', ['merge-tree', '--write-tree', `refs/remotes/origin/${base}`, 'HEAD'], {
          cwd: workRoot,
          timeout: 15_000
        })
      } catch (error) {
        const output = (error as { stdout?: string }).stdout ?? ''
        conflictingFiles = [...output.matchAll(/^CONFLICT .* in (.+)$/gm)].map((match) => match[1])
      }
    }
    return { ...status, conflictingFiles: [...new Set(conflictingFiles)] }
  } catch (error) {
    return {
      conflictingFiles: [],
      error: `Could not read the existing pull request: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
