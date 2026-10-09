import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/** Keep the physical profile in place: Git administrative paths and saved absolute
 * worktree references remain valid. Atomic alias creation has no partial-copy state.
 * Both app versions then acquire the same profile lock in the same physical directory.
 * This module only resolves and checks; the aliases are made by the service
 * (`src/service/ProfilePaths.swift`) before Bun starts. LKM-111 removed the Bun
 * twin that made them without one, so an unmigrated store is refused, not changed.
 */
const unmigrated = () =>
  new Error(
    'The Trezi service did not migrate this profile; quit and reopen Trezi. No data was changed.'
  )

export function nativeProfilePath(support: string): string {
  const current = join(support, 'Trezi Native')
  const legacy = join(support, 'Praxis Native')
  const present = (path: string) => {
    try {
      lstatSync(path)
      return true
    } catch (e: any) {
      if (e.code === 'ENOENT') return false
      throw e
    }
  }
  if (present(current)) {
    if (!existsSync(current))
      throw new Error('Trezi profile alias is broken; restore its original target before starting.')
    if (present(legacy) && realpathSync(current) !== realpathSync(legacy)) {
      throw new Error(
        'Separate Trezi Native and Praxis Native profiles exist. Select one explicitly with TREZI_USER_DATA; neither profile was changed.'
      )
    }
    return current
  }
  if (present(legacy)) {
    if (!lstatSync(legacy).isDirectory())
      throw new Error('Legacy native profile must be a real directory.')
    throw unmigrated()
  }
  return current
}

/** Session files and worktrees stay physically in place, including older dsgn data. */
export function nativeSessionPath(profile: string): string {
  const current = join(profile, 'trezi')
  const candidates = ['praxis', 'dsgn'].map((name) => join(profile, name)).filter(existsSync)
  if (existsSync(current)) {
    if (candidates.some((path) => realpathSync(path) !== realpathSync(current)))
      throw new Error(
        'Separate Trezi and legacy session stores exist; reconcile them before opening chats. No data was changed.'
      )
    return current
  }
  if (candidates.length > 1 && realpathSync(candidates[0]) !== realpathSync(candidates[1]))
    throw new Error(
      'Both Praxis and dsgn session stores exist; reconcile them before opening chats. No data was changed.'
    )
  if (candidates.length) {
    if (!lstatSync(candidates[0]).isDirectory())
      throw new Error('Legacy session store must be a real directory.')
    throw unmigrated()
  }
  return current
}
