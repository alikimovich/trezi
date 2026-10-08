import { randomUUID } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

/** The only actions the bridge accepts. */
export const TREZI_AGENT_ACTIONS = [
  'workspace_state',
  'prepare_conflict_resolution',
  'git_sync_base',
  'git_merge_continue',
  'git_merge_abort',
  'pr_status',
  'publish_update',
  'publish_merge',
  'land_now',
  'chat_island',
  'open_code',
  'open_preview',
  'reload_preview',
  'restart_dev_server',
  'preview_location',
  'preview_screenshot',
  'preview_inspect',
  'preview_evaluate',
  'preview_console',
  'preview_viewport',
  'project_ui_catalog',
  'compose_project_ui',
  'ask_user'
] as const
export type TreziAgentToolAction = (typeof TREZI_AGENT_ACTIONS)[number]

export interface TreziAgentToolRegistration {
  socketPath: string
  token: string
  dispose: () => void
}

type ToolHandler = (action: TreziAgentToolAction, args?: unknown) => Promise<unknown>

const sessions = new Map<string, ToolHandler>()
let server: Server | null = null
const bridgePath =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\trezi-agent-tools-${process.pid}`
    : join('/tmp', `trezi-agent-tools-${process.pid}.sock`)
let starting: Promise<string> | null = null

const json = (res: import('node:http').ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

const readBody = async (req: import('node:http').IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += part.length
    if (size > 40 * 1024) throw new Error('request-too-large')
    chunks.push(part)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function startServer(): Promise<string> {
  if (server) return bridgePath
  if (starting) return starting
  starting = new Promise<string>((resolve, reject) => {
    if (process.platform !== 'win32') rmSync(bridgePath, { force: true })
    const next = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/invoke') {
        json(res, 404, { ok: false, error: 'not-found' })
        return
      }
      const authorization = req.headers.authorization ?? ''
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      const handler = sessions.get(token)
      if (!handler) {
        json(res, 401, { ok: false, error: 'unauthorized' })
        return
      }
      try {
        const parsed = JSON.parse(await readBody(req)) as { action?: unknown; args?: unknown }
        const action = TREZI_AGENT_ACTIONS.find((name) => name === parsed.action)
        if (!action) {
          json(res, 400, { ok: false, error: 'unknown-action' })
          return
        }
        json(res, 200, { ok: true, result: await handler(action, parsed.args) })
      } catch (error) {
        json(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })
    next.once('error', reject)
    next.listen(bridgePath, () => {
      server = next
      if (process.platform !== 'win32') chmodSync(bridgePath, 0o600)
      // The app/window keeps the real product process alive. In pure unit tests,
      // this bridge should not by itself prevent the runner from exiting.
      next.unref()
      resolve(bridgePath)
    })
  }).finally(() => {
    starting = null
  })
  return starting
}

/**
 * Register one Codex session with the local-socket Trezi control bridge. The
 * bearer token scopes every MCP call to exactly one live chat; the handler owns
 * the authoritative in-process state and routes mutations through Trezi's repo
 * queue rather than letting the MCP subprocess touch hidden worktrees directly.
 */
export async function registerTreziAgentTools(
  handler: ToolHandler
): Promise<TreziAgentToolRegistration> {
  const token = randomUUID()
  sessions.set(token, handler)
  let url: string
  try {
    url = await startServer()
  } catch (error) {
    sessions.delete(token)
    throw error
  }
  let disposed = false
  return {
    socketPath: url,
    token,
    dispose: () => {
      if (disposed) return
      disposed = true
      sessions.delete(token)
    }
  }
}

/** Close the process-wide bridge. Production normally lets process teardown own
 *  this; tests call it so their temporary socket is removed deterministically. */
export async function shutdownTreziAgentTools(): Promise<void> {
  sessions.clear()
  const active = server
  server = null
  if (active) {
    await new Promise<void>((resolve) => active.close(() => resolve()))
  }
  if (process.platform !== 'win32') rmSync(bridgePath, { force: true })
}
