import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodexOptions } from '@openai/codex-sdk'
import type { TreziAgentToolRegistration } from '../trezi-agent-tools'

type CodexConfig = NonNullable<CodexOptions['config']>
const isTable = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * MCP server names declared in the user's own Codex config (`$CODEX_HOME/config.toml`,
 * default `~/.codex`). Read per turn so a server added or removed mid-chat is handled.
 */
export function personalMcpServers(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.CODEX_HOME || join(homedir(), '.codex')
  try {
    const { TOML } = (globalThis as unknown as { Bun: { TOML: { parse(text: string): unknown } } })
      .Bun
    const parsed = TOML.parse(readFileSync(join(home, 'config.toml'), 'utf8'))
    const servers = isTable(parsed) ? parsed.mcp_servers : null
    return isTable(servers) ? Object.keys(servers).filter((name) => isTable(servers[name])) : []
  } catch {
    // No config, or one the CLI will refuse to load too: nothing of it can run.
    return []
  }
}

/**
 * Codex features that bring MCP servers from outside `mcp_servers` (LKM-126): an
 * installed plugin (`[plugins."vercel@openai-curated"]`) starts the servers in its own
 * `.mcp.json`, e.g. `https://mcp.vercel.com`, and `apps` starts the ChatGPT account's
 * connectors. Both are the user's, so a Trezi session turns them off.
 */
const personalFeatures = { plugins: false, apps: false }

/**
 * `config` with every personal MCP server switched off, so a Trezi session runs only
 * the servers Trezi passes. The CLI merges `--config` tables into the user's config
 * (replacing `mcp_servers` whole is not possible), and `enabled=false` on a name the
 * user never declared fails config load ("invalid transport"), so only declared names
 * are disabled. Plugin and app servers are not declared there; their features are off.
 */
export function isolatedCodexConfig(
  config: CodexConfig = {},
  env: NodeJS.ProcessEnv = process.env
): CodexConfig {
  const ours = isTable(config.mcp_servers) ? (config.mcp_servers as CodexConfig) : {}
  const mcp_servers: CodexConfig = {}
  for (const name of personalMcpServers(env)) {
    if (!(name in ours)) mcp_servers[name] = { enabled: false }
  }
  Object.assign(mcp_servers, ours)
  const features = { ...(isTable(config.features) ? config.features : {}), ...personalFeatures }
  return { ...config, features, ...(Object.keys(mcp_servers).length ? { mcp_servers } : {}) }
}

const requiredTools = [
  'chat_island',
  'preview_location',
  'preview_screenshot',
  'preview_inspect',
  'preview_evaluate',
  'preview_console',
  'preview_viewport',
  'preview_speed',
  'workspace_state',
  'prepare_conflict_resolution',
  'git_sync_base',
  'git_merge_continue',
  'git_merge_abort',
  'pr_status',
  'publish_update',
  'publish_merge',
  'land_now',
  'project_ui_catalog',
  'compose_project_ui',
  'open_preview',
  'reload_preview',
  'restart_dev_server',
  'open_code',
  'ask_user',
  'chat_ui'
]

/** LKM-203: `land_now`, `publish_update` and `publish_merge` wait for the real result
 * (landing up to 60 s, workflow polling up to 180 s from the call). Codex's default tool
 * timeout is 60 s, which would report an error while the push or merge carries on. */
export const SYNC_TOOL_TIMEOUT_SEC = 300

export function treziMcpConfig(appRoot: string, registration: TreziAgentToolRegistration) {
  return {
    mcp_servers: {
      trezi: {
        command: process.execPath,
        args: [join(appRoot, 'bin/trezi-agent-mcp.mjs')],
        cwd: appRoot,
        enabled: true,
        // A missing bridge must fail the turn, including subsequent CLI resumes.
        required: true,
        startup_timeout_sec: 15,
        tool_timeout_sec: SYNC_TOOL_TIMEOUT_SEC,
        // Every Trezi tool is pre-approved: sessions run with approvals disabled, so an
        // unapproved one is refused outright (LKM-165: `workspace_state` was).
        tools: Object.fromEntries(
          requiredTools.map((name) => [name, { approval_mode: 'approve' }])
        ),
        env: {
          TREZI_AGENT_TOOL_SOCKET: registration.socketPath,
          TREZI_AGENT_TOOL_TOKEN: registration.token
        }
      }
    }
  }
}

/** Codex's PreToolUse hook enforces the selected Git mode before shell execution. */
export function gitAccessHook(
  appRoot: string,
  access: 'managed' | 'full',
  liveRoot: string,
  workRoot = ''
) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  return {
    features: { hooks: true },
    hooks: {
      PreToolUse: [
        {
          matcher: '^Bash$',
          hooks: [
            {
              type: 'command',
              command: `${quote(process.execPath)} ${quote(join(appRoot, 'bin/trezi-git-guard.mjs'))} ${quote(access)} ${quote(liveRoot)} ${quote(workRoot)}`
            }
          ]
        }
      ]
    }
  }
}

/** Check the actual helper and authenticated socket without making a model call. */
export async function verifyTreziMcp(config: ReturnType<typeof treziMcpConfig>): Promise<void> {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js')
  ])
  const server = config.mcp_servers.trezi
  const client = new Client({ name: 'trezi-startup', version: '1' })
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: server.env,
    stderr: 'ignore'
  })
  const options = { timeout: server.startup_timeout_sec * 1000 }
  try {
    await client.connect(transport, options)
    const { tools } = await client.listTools({}, options)
    const names = new Set(tools.map((tool) => tool.name))
    const missing = requiredTools.filter((name) => !names.has(name))
    if (missing.length) throw new Error(`Missing tools: ${missing.join(', ')}`)
    const result = await client.callTool(
      { name: 'workspace_state', arguments: {} },
      undefined,
      options
    )
    if (result.isError) throw new Error('The session tool bridge rejected its connection.')
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error))
      .split(server.env.TREZI_AGENT_TOOL_TOKEN)
      .join('[redacted]')
    throw new Error(`Trezi tools could not connect: ${detail}. Restart Trezi and retry the chat.`)
  } finally {
    await client.close().catch(() => {})
  }
}
