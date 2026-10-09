import { access, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DetectedProject, Framework, PreviewKind } from '../shared/api'
import { projectPackageManager } from './project-dependencies'

/**
 * Project runtime detection and launch commands: the reference the Swift owner
 * (`src/service/RuntimeDetect.swift`, S06) mirrors byte for byte, checked by
 * `test/runtime-owner.mjs`. Pure: file reads only.
 */

/** Find the entry HTML to serve for the directory root: index.html, else the first *.html. */
export async function findStaticEntry(root: string): Promise<string | null> {
  try {
    const names = await readdir(root)
    if (names.includes('index.html')) return 'index.html'
    if (names.includes('index.htm')) return 'index.htm'
    const html = names.filter((n) => /\.html?$/i.test(n)).sort()
    return html[0] ?? null
  } catch {
    return null
  }
}

// The preview always runs on a free port we pick (from this base) bound to IPv4
// loopback — so it never collides with the framework default (5173/3000), never
// hits the IPv4/IPv6 localhost mismatch, and never attaches to a stale server.
// 7777, not 6666: the IRC ports (6665-6669) are on the browser/fetch
// blocked-ports list, so a preview on 6666 can't be loaded or probed.
export const PREVIEW_PORT_BASE = 7777
export const PREVIEW_HOST = '127.0.0.1'

/** Append the framework's port/host flags so the dev server binds where we want. */
export function withPort(command: string, framework: Framework | undefined, port: number): string {
  switch (framework) {
    case 'vite':
    case 'sveltekit':
      return `${command} -- --port ${port} --host ${PREVIEW_HOST}`
    case 'next': {
      // npm consumes script flags unless separated; bun/pnpm forward them and
      // an extra '--' makes Next interpret --port as a project directory.
      const separator =
        /^npm\s+(?:run|run-script)\b/.test(command.trim()) && !/\s--(?:\s|$)/.test(command)
          ? ' --'
          : ''
      return `${command}${separator} --port ${port} -H ${PREVIEW_HOST}`
    }
    default:
      // CRA + unknown/custom commands read PORT/HOST from the env we set instead.
      return command
  }
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false
  )

function detectFramework(deps: Record<string, string>): Framework {
  // React Native targets are checked first: an Expo repo also lists `react-native`,
  // and either one means "preview in a simulator", not a web dev server.
  if (deps.expo) return 'expo'
  if (deps['react-native']) return 'react-native'
  if (deps.next) return 'next'
  if (deps['@sveltejs/kit']) return 'sveltekit'
  if (deps['react-scripts']) return 'cra'
  if (deps.vite) return 'vite'
  return 'unknown'
}

/** RN/Expo projects preview in the iOS Simulator; everything else is a web URL. */
function previewKindFor(framework: Framework): PreviewKind {
  return framework === 'expo' || framework === 'react-native' ? 'simulator' : 'web'
}

/** A plain HTML/JS folder we'll serve with the built-in static server. */
function staticProject(root: string, name?: string): DetectedProject {
  return {
    root,
    name: name ?? basename(root),
    framework: 'static',
    packageManager: 'npm', // unused — static sites are served in-process
    scriptName: '',
    devCommand: '', // no command to spawn; start() routes 'static' to the static server
    previewKind: 'web'
  }
}

/**
 * Given a project folder, detect the framework + package manager and the dev
 * command. A custom-command escape hatch lets the user override the detected
 * command (monorepos, odd setups).
 */
export async function detectProject(root: string): Promise<DetectedProject> {
  const pkgPath = join(root, 'package.json')
  if (!(await exists(pkgPath))) {
    // No package.json — a vanilla HTML/CSS/JS site if there's an HTML entry to
    // serve; otherwise there's nothing we know how to launch, so ask for a command.
    if (await findStaticEntry(root)) return staticProject(root)
    const entries = await readdir(root)
    if (
      entries.every((entry) =>
        ['.git', '.gitignore', '.DS_Store', '.trezi', '.praxis'].includes(entry)
      )
    ) {
      return { ...staticProject(root), framework: 'unknown', setupRequired: true }
    }
    throw new Error(
      'No package.json or index.html found in that folder. Enter a command to launch this project.'
    )
  }
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  const scripts: Record<string, string> = pkg.scripts ?? {}
  const packageManager = await projectPackageManager(root)
  const framework = detectFramework({ ...pkg.dependencies, ...pkg.devDependencies })
  const previewKind = previewKindFor(framework)

  const scriptName = scripts.dev ? 'dev' : scripts.start ? 'start' : ''
  if (!scriptName && previewKind === 'web') {
    // A package.json with no dev/start script: if the framework is unrecognized
    // and it ships an HTML entry, treat it as a vanilla static site (many bundler-
    // less repos carry a package.json with no scripts). A recognized framework
    // (vite/next/…) with no dev script has a build-template index.html that won't
    // serve raw, so ask for a launch command instead.
    if (framework === 'unknown' && (await findStaticEntry(root)))
      return staticProject(root, pkg.name)
    throw new Error(
      'No "dev" or "start" script in package.json. Enter a command to launch this project.'
    )
  }
  // RN/Expo: prefer the repo's start script (usually `expo start`), but fall back
  // to `expo start` directly so a repo without one still launches the simulator.
  const devCommand =
    scriptName !== ''
      ? `${packageManager} run ${scriptName}`
      : `${packageManager === 'npm' ? 'npx' : packageManager} expo start`

  return {
    root,
    name: pkg.name ?? basename(root),
    framework,
    packageManager,
    scriptName,
    devCommand,
    previewKind
  }
}

const CONFLICT_RE =
  /port \d+ is in use|unable to acquire lock|another instance|EADDRINUSE|address already in use/i

export function interpretFailure(code: number | null, tail: string): string {
  if (CONFLICT_RE.test(tail)) {
    return (
      'A dev server is already running for this project. Trezi manages the dev server itself — ' +
      'stop your other instance (e.g. the `dev` running in your terminal) and try again.'
    )
  }
  return `Dev server exited (code ${code}) before printing a URL.\n${tail.slice(-600)}`
}
