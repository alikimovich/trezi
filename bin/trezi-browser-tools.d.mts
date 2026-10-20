type Env = Record<string, string | undefined>
type Arch = string

export const CLI_VERSION: string
export const CLI_SERIES: string
export const PLAYWRIGHT_VERSION: string
export const PLAYWRIGHT_NODE_MAJOR: number
export const BROWSER_TOOL_LINKS: {
  agentBrowser: string
  playwrightBrowsers: string
  playwrightRegistry: string
  npx: string
  node: string
  homebrew: string
}
export const BROWSER_TOOL_COMMANDS: { cli: string; shell: string }

export type ToolSource = 'test' | 'trezi' | 'path' | 'playwright'
export interface FoundCli {
  path: string
  source: ToolSource
}
export interface FoundShell {
  path: string
  source: ToolSource
  revision?: number
}
export interface Prerequisites {
  node?: { path: string; version?: string; major: number }
  npm?: string
  npx?: string
  brew?: string
}
export interface BrowserToolsDetection {
  tools: string
  platform: { ok: boolean; reason?: string }
  cli?: FoundCli & { version?: string; tested: boolean }
  shell?: FoundShell & { version?: string }
  prerequisites: Prerequisites
}

export function browserToolsDirectory(env?: Env, home?: string): string
export function ownedCliPath(tools: string, arch?: Arch): string
export function findCli(options?: { env?: Env; home?: string; skip?: string[]; arch?: Arch }): FoundCli | undefined
export function findShell(options?: { env?: Env; home?: string; arch?: Arch }): FoundShell | undefined
export function toolVersionAsync(path: string, env?: Env, timeout?: number): Promise<string | undefined>
export function cliVersionNumber(text: string | undefined): string | undefined
export function shellVersionNumber(text: string | undefined): string | undefined
export function testedCli(version: string | undefined): boolean
export function findTool(name: string, env?: Env): string | undefined
export function platformSupport(platform?: string, arch?: Arch): { ok: boolean; reason?: string }
export function detectBrowserTools(options?: {
  env?: Env
  home?: string
  skip?: string[]
  platform?: string
  arch?: Arch
  /** Each `--version` probe is killed (whole process group, SIGKILL) after this many ms. */
  probeTimeout?: number
}): Promise<BrowserToolsDetection>
