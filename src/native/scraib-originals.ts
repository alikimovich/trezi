import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LKM-277: where the Scraib acceptance checks find the originals they copy. Both are only
 * read (hashed before and after); every build and edit happens on a disposable copy.
 * `TREZI_SCRAIB_XCODE` / `TREZI_SCRAIB_OPEN` point elsewhere. Pure apart from `existsSync`.
 */
export const SCRAIB_XCODE = process.env.TREZI_SCRAIB_XCODE || '/Users/panda/dev/scraib-xcode'
export const SCRAIB_OPEN = process.env.TREZI_SCRAIB_OPEN || '/Users/panda/dev/Scraib-open'

export const hasScraibXcode = () => existsSync(join(SCRAIB_XCODE, 'scraib.xcodeproj'))
export const hasScraibOpen = () => existsSync(join(SCRAIB_OPEN, 'Scraib.xcodeproj'))

/**
 * Extra launcher time the core group needs when the Scraib checks run on this machine:
 * full-target builds of a 40-file app (first build, edit, error, fix) and Scraib-open's
 * package dependencies. Nothing extra where the originals are absent (the checks say so
 * and do nothing).
 */
export function scraibAcceptanceBudgetMs(): number {
  return (hasScraibXcode() ? 360_000 : 0) + (hasScraibOpen() ? 300_000 : 0)
}
