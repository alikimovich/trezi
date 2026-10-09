import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type PathContext, shortPaths } from '../shared/display-path'

/** The profile folder names, current first, then earlier builds' (renamed and Electron-era). */
export const PROFILE_NAMES = ['Trezi Native', 'Praxis Native', 'Trezi', 'Praxis', 'dsgn']

let profile: string | undefined
let profiles: string[] | undefined
const projects = new Set<string>()

/** The running profile (`app.getPath('userData')`); set once at startup. */
export function setDisplayProfile(path: string) {
  profile = path
  profiles = undefined
}

/** Profile roots as the user may see them: the profile, its physical target and the
 *  profiles beside it under every name Trezi has used. */
function profileRoots(): string[] {
  if (profiles) return profiles
  const found = new Set<string>()
  const add = (path: string) => {
    found.add(path)
    try {
      found.add(realpathSync(path))
    } catch {}
  }
  if (profile) add(profile)
  for (const support of new Set([
    profile && dirname(profile),
    join(homedir(), 'Library/Application Support')
  ]))
    if (support) for (const name of PROFILE_NAMES) add(join(support, name))
  profiles = [...found]
  return profiles
}

/** A project the user has open, so its paths show relative to it. */
export function rememberProject(root: string) {
  if (!root?.startsWith('/') || projects.has(root)) return
  projects.add(root)
  try {
    projects.add(realpathSync(root))
  } catch {}
}

export function displayContext(extra: string[] = []): PathContext {
  for (const root of extra) rememberProject(root)
  return { projects: [...projects], profiles: profileRoots() }
}

/** The collapsed form of `text` for a UI surface; callers keep `text` for Copy and tooltips. */
export const displayText = (text: string, extra: string[] = []) =>
  shortPaths(text, displayContext(extra))
