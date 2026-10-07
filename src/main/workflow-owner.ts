import type {
  Diagnosis,
  FeedbackResult,
  GithubConnectOptions,
  GithubConnectResult,
  GitRemoteAction,
  GitRemoteResult,
  GitRemoteStatus,
  PublishResult,
  UpdateStatus
} from '../shared/api'
import type { PublishMessage } from '../shared/publish-message'
import type { InstallInput, InstallResult } from './skills-install'

/**
 * The workflow owner seam (S13). Under the Swift launch the service's workflow owner
 * performs Trezi's side-effecting workflows outside a chat turn and keeps a durable
 * record of each step (intent before the effect, receipt after):
 * - publication: Publish (merge or PR only), the notes handoff PR, a saved run's PR;
 * - remote Git actions: Connect to GitHub, fetch, pull, switch to a remote branch;
 * - project setup: the `.trezi/` instrumentation helpers, their removal, new projects;
 * - Trezi's own update (pull, install, build) and the diagnosis memory;
 * - the in-app feedback issue (`gh issue create`) and curated skill-pack installs.
 * A reply lost after a remote effect, a crash or a retry therefore never repeats a PR,
 * a merge or an update: the owner answers from its receipt, or reconciles an uncertain
 * step from what GitHub and Git hold. Bun keeps the helpers that only propose bounded
 * results (PR descriptions, framework detection and helper sources, starter files,
 * diagnoses) and the sheets that collect the user's explicit intent. There is no other
 * owner: LKM-111 removed the TS twin, so without the service a workflow fails.
 */

/** Bun's description helper: a PR title and body for the pushed range. */
export type Describe = (base: string, head: string) => Promise<PublishMessage>

export interface HelperFile {
  path: string
  content: string
}
export type HelperWrite =
  | { ok: true; written: boolean; helpers: Array<{ path: string; sha256: string }> }
  | { ok: false; error: string }
export interface CreatedProject {
  ok: boolean
  root?: string
  error?: string
  warning?: string
}
export interface WorkflowStepSummary {
  name: string
  state: string
  receipt: Record<string, unknown>
  message?: string
  at: string
}
export interface WorkflowSummary {
  id: string
  kind: string
  root: string
  params: Record<string, unknown>
  /** running · describe · done · failed · cancelled · interrupted · superseded · dismissed */
  state: string
  steps: WorkflowStepSummary[]
  result: { workflow: string; stage: string; result?: unknown } | Record<string, unknown> | null
  started: string
  updated: string
  /** The last lines of a running step's output. */
  progress?: string
  /** An open publish's current step and since when (ISO), LKM-187. */
  step?: string
  stepSince?: string
}
export type WorkflowKind =
  | 'publish'
  | 'handoff'
  | 'branchPr'
  | 'connect'
  | 'remoteUpdate'
  | 'setup'
  | 'uninstall'
  | 'createProject'
  | 'update'
  | 'feedback'
  | 'skills'

export class WorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface WorkflowOwner {
  readonly kind: 'swift'
  publish(root: string, mode: 'merge' | 'pr', describe: Describe): Promise<PublishResult>
  handoff(root: string, title: string, notes: number, describe: Describe): Promise<PublishResult>
  branchPr(
    root: string,
    branch: string,
    describe: Describe
  ): Promise<{ ok: boolean; prUrl?: string; error?: string }>
  connect(root: string, options: GithubConnectOptions): Promise<GithubConnectResult>
  remoteStatus(root: string, fetch: boolean): Promise<GitRemoteStatus>
  remoteUpdate(root: string, action: GitRemoteAction, busy: boolean): Promise<GitRemoteResult>
  /** Writes each proposed helper only if it is absent. */
  writeHelpers(root: string, files: HelperFile[]): Promise<HelperWrite>
  removeHelpers(root: string): Promise<{ ok: boolean; files?: string[]; error?: string }>
  /** Starter files (relative path → content) and the package manager to install with. */
  createProject(
    root: string,
    files: Record<string, string>,
    install: 'bun' | 'npm' | null
  ): Promise<CreatedProject>
  /** Whether Trezi's own checkout trails its upstream (fetches; `idle` on any soft failure). */
  updateCheck(root: string): Promise<UpdateStatus>
  /** Trezi's own update: pull (fast-forward), install, build. Restart stays the caller's. */
  update(root: string, progress?: (text: string) => void): Promise<{ ok: boolean; error?: string }>
  /** Files the in-app feedback issue on Trezi's own repository (`root` is its checkout). */
  feedback(root: string, title: string, body: string): Promise<FeedbackResult>
  /** Installs a curated skill pack (`npx skills add`); never throws for an install failure. */
  installSkills(input: InstallInput): Promise<InstallResult>
  recallDiagnosis(root: string, signature: string): Promise<Diagnosis | null>
  rememberDiagnosis(root: string, diagnosis: Diagnosis): Promise<void>
  diagnosisStatus(root: string, signature: string, status: 'applied' | 'dismissed'): Promise<void>
  /** Stops the open workflow of `kind` on `root` before its next step. */
  cancel(kind: WorkflowKind, root: string): Promise<boolean>
  workflows(): Promise<WorkflowSummary[]>
  dismiss(id: string): Promise<void>
}

let owner: WorkflowOwner | null = null

/** Installed once by the native entry point when the Swift service is supervising Bun. */
export function setWorkflowOwner(next: WorkflowOwner | null): void {
  owner = next
}

/** The installed Swift owner; without the service there is none, and nothing runs. */
export function workflowOwner(): WorkflowOwner {
  if (!owner) throw new Error('Trezi’s service is not running, so the workflow cannot run.')
  return owner
}
