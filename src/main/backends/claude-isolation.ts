import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Settings → General "Allow my Claude Code plugins in Trezi chats" (LKM-138). Off by default. */
export const CLAUDE_USER_PLUGINS_KEY = 'trezi:claude-user-plugins:v1'

let read: () => string | null | undefined = () => null
/** Main reads the preference whenever a Claude helper session opens and passes it in its options. */
export function setClaudeUserPluginsSource(source: () => string | null | undefined): void {
  read = source
}
export const claudeUserPluginsAllowed = (): boolean => read() === 'true'

const isTable = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const keysOf = (file: string, field: string): string[] => {
  try {
    const value = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)[field]
    return isTable(value) ? Object.keys(value) : []
  } catch {
    return []
  }
}

/**
 * Plugin ids the user installed or enabled (`$CLAUDE_CONFIG_DIR`, default `~/.claude`,
 * plus the repo's own settings files, which can only enable plugins the user installed).
 * Read per session so a plugin installed mid-chat is still excluded from the next one.
 */
export function personalClaudePlugins(
  root: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const home = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return [
    ...new Set([
      ...keysOf(join(home, 'plugins', 'installed_plugins.json'), 'plugins'),
      ...keysOf(join(home, 'settings.json'), 'enabledPlugins'),
      ...keysOf(join(root, '.claude', 'settings.json'), 'enabledPlugins'),
      ...keysOf(join(root, '.claude', 'settings.local.json'), 'enabledPlugins')
    ])
  ].sort()
}

/**
 * Claude SDK options that keep a Trezi chat to Trezi's own tools: only the MCP servers
 * Trezi passes (`--strict-mcp-config` drops `~/.claude.json`, plugin and `.mcp.json`
 * servers) and every personal plugin disabled by flag settings, which outrank user,
 * project and local settings. CLAUDE.md files, skills and the bundled Trezi plugin
 * still load. With the setting on, nothing changes.
 */
export function claudeIsolationOptions(
  root: string,
  allowUserPlugins: boolean,
  env: NodeJS.ProcessEnv = process.env
): { strictMcpConfig?: boolean; settings?: { enabledPlugins: Record<string, boolean> } } {
  if (allowUserPlugins) return {}
  const plugins = personalClaudePlugins(root, env)
  return {
    strictMcpConfig: true,
    ...(plugins.length
      ? { settings: { enabledPlugins: Object.fromEntries(plugins.map((id) => [id, false])) } }
      : {})
  }
}
