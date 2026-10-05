/**
 * "Connect to GitHub" — the first-publish bridge (see docs/PROGRESS.md). A
 * freshly scaffolded project is a local-only repo with no `origin`; Publish
 * assumes a remote already exists. Connect is a distinct, explicit step that creates
 * the GitHub repo, wires `origin` and pushes the built work, so the repo's default
 * branch reflects what the user made (Option B). The service's workflow owner performs
 * and journals it (S13); this module only reads the project's GitHub link and `gh`
 * readiness for the sheet. Any failure degrades to a describable state, never a throw.
 */
import { execFile } from 'child_process'
import { basename } from 'path'
import { promisify } from 'util'
import { ipcMain } from '../native/platform'
import type { GithubConnectOptions, GithubStatus } from '../shared/api'
import { sanitizeRepoName } from '../shared/github'
import { workflowOwner } from './workflow-owner'

const execFileP = promisify(execFile)

const git = (root: string, args: string[], timeout = 10000): Promise<{ stdout: string }> =>
  execFileP('git', args, { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024 }) as Promise<{
    stdout: string
  }>

const gh = (root: string, args: string[], timeout = 30000): Promise<{ stdout: string }> =>
  execFileP('gh', args, { cwd: root, timeout, maxBuffer: 10 * 1024 * 1024 }) as Promise<{
    stdout: string
  }>

/** trimmed stdout, or '' on any failure. */
const tryOut = async (p: Promise<{ stdout: string }>): Promise<string> => {
  try {
    return (await p).stdout.trim()
  } catch {
    return ''
  }
}

/**
 * Report the project's GitHub link + gh readiness, and prefill the connect
 * sheet. Never throws — a non-repo / missing gh degrades to a describable state.
 */
export async function githubStatus(root: string): Promise<GithubStatus> {
  const suggestedName = sanitizeRepoName(basename(root) || 'my-app')

  const remoteUrl = await tryOut(git(root, ['remote', 'get-url', 'origin']))
  if (remoteUrl) {
    return { connected: true, remoteUrl, gh: 'ok', suggestedName }
  }

  // No remote yet — probe gh so the sheet can guide install/login before the user
  // fills anything in.
  try {
    await execFileP('gh', ['--version'], { timeout: 8000 })
  } catch {
    return { connected: false, gh: 'missing', suggestedName }
  }
  try {
    await execFileP('gh', ['auth', 'status'], { timeout: 8000 })
  } catch {
    return { connected: false, gh: 'unauthed', suggestedName }
  }

  const login = await tryOut(gh(root, ['api', 'user', '-q', '.login'], 8000))
  const orgsRaw = await tryOut(gh(root, ['api', 'user/orgs', '-q', '.[].login'], 8000))
  const orgs = orgsRaw ? orgsRaw.split('\n').filter(Boolean) : []
  return {
    connected: false,
    gh: 'ok',
    suggestedName,
    ...(login ? { login } : {}),
    ...(orgs.length ? { orgs } : {})
  }
}

export function registerGithubIpc(): void {
  ipcMain.handle('github:status', (_e, root: string) => githubStatus(root))
  // Creating the repository is a remote effect: the workflow owner journals it (S13).
  ipcMain.handle('github:connect', (_e, root: string, opts: GithubConnectOptions) =>
    workflowOwner().connect(root, { ...opts, name: sanitizeRepoName(opts.name) })
  )
}
