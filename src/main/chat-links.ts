import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseChatLink } from '../shared/code-link'
import type { SourceRange } from '../shared/native-editor'
import { codeTarget } from './code-tools'

/**
 * LKM-657: where a link clicked in chat goes. Web links stay with AppKit (the browser);
 * everything else is parsed once (`parseChatLink`) and routed here:
 *
 * - a text file inside the chat's project opens in Trezi's editor (LKM-364's checks);
 * - an image, PDF or movie inside the project opens in Quick Look, a folder in Finder;
 * - a path outside the project, a missing file, a likely secret or a file the editor
 *   cannot show becomes a `notice`: the chat says where the link points and offers
 *   Reveal in Finder / Copy Path, which only the owner's click performs.
 *
 * Content is shown only for files whose canonical path (symlinks resolved) stays inside
 * the canonical project root. Nothing outside it is read or even `stat`ed (an automount
 * path would mount on a stat), nothing is executed, and no link is handed to `open`.
 */
export type ChatLinkRoute =
  | { type: 'code'; root: string; source: string; range?: SourceRange }
  | { type: 'quick-look'; path: string }
  | { type: 'reveal'; path: string }
  | { type: 'notice'; detail: string; path: string; reveal: boolean }
  | { error: string }

/** Quick Look shows these natively, without running page scripts. */
export const QUICK_LOOK_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
  '.bmp',
  '.avif',
  '.pdf',
  '.mov',
  '.mp4',
  '.m4v'
])

/** Credentials and keys are never shown just because a chat linked them. */
const SECRET =
  /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.\w+)?|[^/]*\.(pem|key|p12|pfx|keychain|keychain-db|kdbx|mobileprovision))$|(^|\/)\.(ssh|gnupg|aws)\//i

/** Automounted or network locations: Finder would mount or reach the network to reveal. */
const REMOTE = /^\/(net|Network|Volumes|home|afs)(\/|$)/

const inside = (base: string, path: string) => {
  const rel = relative(base, path)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const notice = (detail: string, path: string, reveal = true): ChatLinkRoute => ({
  type: 'notice',
  detail,
  path,
  reveal: reveal && !REMOTE.test(path)
})

export async function chatLinkRoute(root: string, href: unknown): Promise<ChatLinkRoute> {
  const link = parseChatLink(href)
  if (link.kind === 'refused') return { error: link.error }
  if (link.kind === 'web') return { error: 'Web links open in your browser.' }
  if (!root) return { error: 'Open a project to show its code.' }
  let base: string
  try {
    base = await realpath(root)
  } catch {
    return { error: 'The project folder is not available.' }
  }
  // Lexical first: `resolve` normalizes `..` (decoded `%2e%2e`/`%2F` included).
  let path: string
  if (link.kind === 'project') {
    path = resolve(base, link.file)
    if (!inside(base, path)) return { error: 'The file must be inside the project.' }
  } else {
    const expanded =
      link.path === '~' || link.path.startsWith('~/')
        ? `${homedir()}${link.path.slice(1)}`
        : link.path
    path = resolve(expanded)
    if (
      path !== base &&
      !inside(base, path) &&
      path !== resolve(root) &&
      !inside(resolve(root), path)
    )
      return notice(
        `This link points outside this project, so Trezi does not open it: ${path}`,
        path
      )
  }
  let real: string
  try {
    real = await realpath(path)
  } catch {
    return notice(`The linked file does not exist: ${path}`, path, false)
  }
  if (!inside(base, real) && real !== base)
    return { error: 'The link leaves the project through a symbolic link.' }
  const file = relative(base, real).split(sep).join('/')
  if (real === base) return { type: 'reveal', path: real }
  if (SECRET.test(file))
    return notice(
      `${basename(real)} may hold credentials, so Trezi does not show it: ${real}`,
      real
    )
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(real)
  } catch {
    return notice(`The linked file is not readable: ${real}`, real, false)
  }
  if (info.isDirectory()) return { type: 'reveal', path: real }
  if (!info.isFile()) return notice(`${basename(real)} is not a regular file: ${real}`, real)
  if (QUICK_LOOK_EXTENSIONS.has(extname(real).toLowerCase()))
    return { type: 'quick-look', path: real }
  const code = await codeTarget(root, file, link.lines)
  if ('error' in code)
    return notice(
      `${basename(real)} cannot be shown in Trezi’s editor (${code.error}): ${real}`,
      real
    )
  return { type: 'code', ...code }
}
