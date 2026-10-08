import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { healPublishBranch } from '../main/publish'
import { findPack } from '../main/skill-packs'
import { type Describe, WorkflowError, type WorkflowOwner } from '../main/workflow-owner'
import type { PublishMessage } from '../shared/publish-message'
import type { ServiceFailure } from '../shared/service-contract/types'

type Result = { kind: 'succeeded'; payload: any } | { kind: 'failed'; payload: ServiceFailure }
interface ServiceMessage {
  service?: string
  id?: number
  reply?: { result: Result }
}
/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface WorkflowLink {
  sendService(frame: object): void
  on(event: 'service-reply', listener: (message: ServiceMessage) => void): unknown
}

export interface WorkflowClientOptions {
  /** How long one attempt waits before the same operation is asked again. */
  timeout?: number
  /** Attempts after the first when a reply does not arrive (same operation ID). */
  retries?: number
  /** Repository leases the calling async chain holds. */
  leases?: () => string[]
  /** How often a running update's progress is read. */
  progressInterval?: number
  /** Arms one reply deadline and returns its cancel; a wall-clock timer by default.
   *  Tests pass a manual clock so a deadline expires on an event, not after a wait. */
  deadline?: (expire: () => void, ms: number) => () => void
}

const wallClock = (expire: () => void, ms: number) => {
  const timer = setTimeout(expire, ms)
  return () => clearTimeout(timer)
}

/**
 * Bun's client for the Swift workflow owner (S13). Every workflow request carries an
 * operation ID; when a reply does not arrive in time the SAME operation is asked again,
 * so the owner answers from its receipt (or joins the run still under way) instead of
 * repeating a push, a PR, a merge or an update. A publication is two requests around
 * the description helper, which only proposes a title and body. A failure rejects with
 * the owner's code; Bun never performs the workflow itself.
 */
export function serviceWorkflows(
  link: WorkflowLink,
  options: WorkflowClientOptions = {}
): WorkflowOwner {
  const connection = randomUUID()
  const timeout = options.timeout ?? 15 * 60_000
  const retries = options.retries ?? 2
  const deadline = options.deadline ?? wallClock
  const pending = new Map<number, (value: Result) => void>()
  let sequence = 0

  link.on('service-reply', (message) => {
    if (message.service !== 'workflow' || !message.reply) return
    const resolve = pending.get(message.id ?? -1)
    if (resolve) resolve(message.reply.result)
  })

  const call = (
    method: string,
    body: Record<string, unknown>,
    mode: 'read' | 'mutation' = 'mutation',
    attempts = retries
  ): Promise<any> => {
    const operationID = randomUUID()
    const ids: number[] = []
    return new Promise<Result>((resolve, reject) => {
      let disarm = () => {}
      const settle = (value: Result) => {
        disarm()
        for (const id of ids) pending.delete(id)
        resolve(value)
      }
      const attempt = (left: number) => {
        const id = ++sequence
        ids.push(id)
        pending.set(id, settle)
        link.sendService({
          service: 'workflow',
          id,
          request: {
            connection,
            requestID: randomUUID(),
            operationID,
            scope: {},
            mode,
            service: 'workflow',
            method,
            body
          }
        })
        disarm = deadline(() => {
          if (left > 0) return attempt(left - 1)
          for (const stale of ids) pending.delete(stale)
          reject(
            new WorkflowError(
              'deadlineExceeded',
              `The Trezi service did not answer the ${method} request in time; asking again resumes it.`
            )
          )
        }, timeout)
      }
      attempt(mode === 'read' ? 0 : attempts)
    }).then((result) => {
      if (result.kind === 'succeeded') return result.payload
      throw new WorkflowError(result.payload.code, result.payload.message)
    })
  }
  const leases = () => {
    const held = options.leases?.() ?? []
    return held.length ? { leases: held } : {}
  }
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  /** Phase two: describe the pushed range, then let the owner finish. */
  const finish = async (reply: any, describe: Describe): Promise<any> => {
    if (reply.stage === 'done') return reply.result
    let described: PublishMessage
    try {
      described = await describe(reply.base, reply.head)
    } catch (error) {
      return (
        await call('describe', {
          workflow: reply.workflow,
          error: message(error) || 'The description could not be generated.',
          ...leases()
        })
      ).result
    }
    return (
      await call('describe', {
        workflow: reply.workflow,
        title: described.title,
        body: described.body,
        ...leases()
      })
    ).result
  }

  return {
    kind: 'swift',
    async publish(root, mode, describe) {
      const healed = await healPublishBranch(root)
      if (healed && 'error' in healed) return { ok: false, error: healed.error }
      return finish(await call('publish', { root, mode, intent: 'publish', ...leases() }), describe)
    },
    async handoff(root, title, notes, describe) {
      return finish(
        await call('handoff', {
          root,
          title: title || 'trezi: design handoff',
          notes,
          intent: 'publish',
          ...leases()
        }),
        describe
      )
    },
    async branchPr(root, branch, describe) {
      return finish(
        await call('branchPr', { root, branch, intent: 'publish', ...leases() }),
        describe
      )
    },
    async connect(root, options) {
      const reply = await call('connect', {
        root,
        name: options.name,
        owner: options.owner?.trim() ?? '',
        private: !!options.private,
        intent: 'connect',
        ...leases()
      })
      return reply.result
    },
    remoteStatus: (root, fetch) => call('remoteStatus', { root, fetch, ...leases() }),
    async remoteUpdate(root, action, busy) {
      const reply = await call('remoteUpdate', {
        root,
        action: action.action,
        ref: action.ref,
        expectedBranch: action.expectedBranch ?? null,
        busy,
        intent: 'update',
        ...leases()
      })
      return reply.result
    },
    async writeHelpers(root, files) {
      return (
        await call('setup', {
          root,
          files: files.map(({ path, content }) => ({ path, content })),
          intent: 'setup',
          ...leases()
        })
      ).result
    },
    async removeHelpers(root) {
      return (await call('uninstall', { root, intent: 'uninstall', ...leases() })).result
    },
    async createProject(root, files, install) {
      return (await call('createProject', { root, files, install, intent: 'create' })).result
    },
    updateCheck: (root) => call('updateCheck', { root, ...leases() }),
    async update(root, progress) {
      let polling = true
      const poll = async () => {
        while (polling) {
          await new Promise((resolve) => setTimeout(resolve, options.progressInterval ?? 500))
          if (!polling) return
          const running = (await call('workflows', {}, 'read').catch(() => [])).find(
            (w: any) => w.kind === 'update' && w.root === root && w.state === 'running'
          )
          if (running?.progress && polling) progress?.(running.progress)
        }
      }
      const watcher = progress ? poll() : Promise.resolve()
      try {
        const result = (await call('update', { root, intent: 'update' })).result
        return result.ok ? { ok: true } : { ok: false, error: result.error }
      } finally {
        polling = false
        await watcher
      }
    },
    async feedback(root, title, body) {
      return (await call('feedback', { root, title, body, intent: 'feedback', ...leases() })).result
    },
    async installSkills(input) {
      const pack = findPack(input.packId)
      const targetDir =
        input.scope === 'user'
          ? join(homedir(), '.claude', 'skills')
          : join(input.liveRoot, '.claude', 'skills')
      // The catalog is Bun's; the owner accepts only a GitHub owner/name and plain skill names.
      if (!pack) {
        return {
          ok: false,
          packId: input.packId,
          scope: input.scope,
          targetDir,
          installed: [],
          message: `Refusing to install '${input.packId}': not in the curated skill-pack allowlist.`
        }
      }
      return (
        await call('skills', {
          root: input.liveRoot,
          packId: pack.id,
          scope: input.scope,
          repo: pack.repo,
          skills: pack.skills ?? [],
          title: pack.title,
          intent: 'skills',
          ...leases()
        })
      ).result
    },
    recallDiagnosis: (root, signature) => call('diagnosis', { root, signature }, 'read'),
    async rememberDiagnosis(root, diagnosis) {
      await call('remember', { root, diagnosis: JSON.parse(JSON.stringify(diagnosis)) })
    },
    async diagnosisStatus(root, signature, status) {
      await call('diagnosisStatus', { root, signature, status })
    },
    cancel: async (kind, root) => (await call('cancel', { kind, root }, 'mutation', 0)).cancelled,
    workflows: () => call('workflows', {}, 'read'),
    async dismiss(id) {
      await call('dismiss', { workflow: id, intent: 'dismiss' })
    }
  }
}
