import { execFile } from 'child_process'
import { promisify } from 'util'
import { enclosingRepoRoot, ensureBranch } from './git'
import { defaultBase } from './publish-scope'

/**
 * Publication's one Bun step: before the workflow owner (S13, `WorkflowPublish.swift`)
 * publishes, a checkout still on its base branch moves onto a work branch through the
 * repository owner. The PR description helper stays in Bun too (`generatePublishDescription`).
 */

const execFileP = promisify(execFile)

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd: root, maxBuffer: 10 * 1024 * 1024 })
  return stdout.trim()
}

/**
 * A checkout still on its base branch is moved onto `trezi/<base>` before publishing
 * (`checkout -b` carries uncommitted work along). Answers the branch to publish, or
 * the refusal to show. Runs before any publish effect.
 */
export async function healPublishBranch(
  root: string
): Promise<{ branch: string } | { error: string } | null> {
  let branch: string
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree'])
    branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    return null
  }
  const base = await defaultBase(root)
  if (branch !== base) return null
  // The open-time `git:ensure` should have moved the checkout onto a trezi/* work
  // branch, but a project can still land here (ensure failed at open, the user
  // switched back, or a previous publish's recovery stranded them). `ensureBranch`
  // still refuses non-root checkouts, which stays a hard error naming the situation.
  const healed = await ensureBranch(root)
  if (!healed.isRepo) {
    const enclosing = await enclosingRepoRoot(root)
    return {
      error:
        enclosing === null
          ? `This folder isn't a git repository, so there's nothing to publish from. Run \`git init\` in ${root} (and make a first commit), then try again.`
          : `Can't publish: this folder is inside the repository at ${enclosing}, but isn't its top level, so Trezi won't switch that whole repo onto a work branch. Either open ${enclosing} as the project and publish from there, or make this folder its own repository with \`git init\` in ${root}.`
    }
  }
  if (!healed.branch || healed.branch === base || healed.error) {
    return {
      error: `You're on ${base} and Trezi couldn't create a work branch${healed.error ? `: ${healed.error}` : '.'}`
    }
  }
  return { branch: healed.branch }
}
