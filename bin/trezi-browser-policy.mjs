import { basename, resolve } from 'node:path'

/**
 * LKM-269: shared Claude/Codex shell-command policy for Vercel agent-browser. The only
 * allowed route is Trezi's managed wrapper (`bin/managed/agent-browser`), reached through
 * `"$TREZI_AGENT_BROWSER"` or its absolute path. A login shell can rebuild PATH, so a
 * bare `agent-browser` is not trusted to resolve to it. Hooks run before any permission
 * bypass; the wrapper itself still refuses unsafe flags, so this is a second layer.
 */
const FORBIDDEN_FLAGS = new Set([
  '--headed', '--executable-path', '--profile', '--config', '--auto-connect', '--cdp',
  '--provider', '-p', '--engine', '--args', '--extension', '--session-name', '--state',
  '--', '--all'
])
// Commands that only look at a path or a name never launch a browser.
const INSPECTORS = new Set([
  'which', 'type', 'whereis', 'hash', 'ls', 'stat', 'file', 'echo', 'printf',
  'readlink', 'realpath', 'test', '[', 'grep', 'rg'
])
// Commands that run their arguments as a program.
const LAUNCHERS = new Set([
  'command', 'builtin', 'env', 'sudo', 'nohup', 'time', 'xargs', 'exec', 'bash', 'sh', 'zsh', 'timeout', 'nice',
  'npx', 'bunx', 'pnpm', 'yarn', 'npm', 'bun', 'node'
])

const unquote = (word) => word.replace(/^[({'"]+|[)}'"]+$/g, '')
const isManagedVariable = (word) => /^\$\{?TREZI_AGENT_BROWSER\}?$/.test(word)

const wrapperAdvice = (wrapper) =>
  `Run Trezi's managed Vercel agent-browser by its absolute path: "$TREZI_AGENT_BROWSER" <command> --session trezi-<task-id>` +
  (wrapper ? ` (${wrapper}).` : '.') +
  ' Never call a global agent-browser, and do not substitute WebKit, preview_evaluate or a headed/system Chrome.'

/**
 * A refusal message for a shell `command` that would reach agent-browser outside Trezi's
 * managed wrapper (or that passes a flag the wrapper forbids), else `null`.
 * `wrapper` is the verified absolute wrapper path, or `undefined` when this install has none.
 */
export function browserCommandRefusal(command, wrapper, cwd = '') {
  if (typeof command !== 'string' || !/agent-browser|TREZI_AGENT_BROWSER/.test(command)) return null
  if (/(?:^|[\s;&|(])(?:export\s+|declare\s+(?:-x\s+)?|typeset\s+)?TREZI_AGENT_BROWSER=/.test(command))
    return `The managed agent-browser route is app-owned and cannot be reassigned. ${wrapperAdvice(wrapper)}`
  for (const segment of command.split(/&&|\|\||[;&|\n]/)) {
    const words = segment.trim().split(/\s+/).map(unquote).filter(Boolean)
    let at = 0
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '')) at++
    const assignments = words.slice(0, at)
    let [first = '', ...rest] = words.slice(at)
    // Unwrap bounded POSIX command prefixes. -p changes command lookup, while
    // -v/-V only inspect it; neither nested prefixes nor options may hide execution.
    let inspecting = false
    for (let depth = 0; first === 'command' && depth < 32; depth++) {
      while (rest[0]?.startsWith('-') && rest[0] !== '--') {
        const option = rest.shift()
        if (!/^-[pvV]+$/.test(option))
          return `Unsupported command prefix for managed browser verification. ${wrapperAdvice(wrapper)}`
        if (/[vV]/.test(option)) inspecting = true
      }
      if (rest[0] === '--') rest.shift()
      if (inspecting) break
      first = rest.shift() ?? ''
    }
    const involved = [first, ...rest].some(
      (word) => word === 'agent-browser' || basename(word) === 'agent-browser' || isManagedVariable(word)
    )
    if (!involved) continue
    if (INSPECTORS.has(first) || (first === 'command' && inspecting)) continue
    if (!wrapper)
      return "Trezi's managed agent-browser wrapper (bin/managed/agent-browser) is missing or not executable in this install. That is a Trezi install problem, not a browser or CLI dependency. Do not use a global agent-browser."
    if (assignments.some((word) => /^(?:TREZI_AGENT_BROWSER|PATH)=/.test(word)))
      return `PATH and the managed route cannot be overridden for agent-browser. ${wrapperAdvice(wrapper)}`
    const bare = first === 'agent-browser' || (LAUNCHERS.has(first) && rest.includes('agent-browser'))
    if (bare)
      return `A bare agent-browser can resolve to a global CLI (login shells rebuild PATH). ${wrapperAdvice(wrapper)}`
    for (const word of [first, ...rest]) {
      if (word.includes('/') && basename(word) === 'agent-browser' && resolve(cwd || '/', word) !== wrapper)
        return `${word} is not Trezi's managed wrapper. ${wrapperAdvice(wrapper)}`
    }
    for (const word of rest) {
      if (FORBIDDEN_FLAGS.has(word.split('=')[0]))
        return `${word.split('=')[0]} is unavailable in Trezi's managed browser (isolated, headless, private profile only).`
      if (/(?:Google Chrome|Chromium|Chrome)\.app/.test(word))
        return "A system Chrome is not allowed for managed verification; Trezi's wrapper pins a private headless shell."
    }
  }
  return null
}
