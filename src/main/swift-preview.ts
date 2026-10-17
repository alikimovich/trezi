import { join } from 'node:path'

/** The checkout's Swift component preview driver (LKM-271, `docs/SWIFT-PREVIEWS.md`). */
export const SWIFT_PREVIEW_DRIVER = join(__dirname, '../..', 'src/swift-preview/driver.ts')

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/**
 * The launch command for a detected Swift project: Trezi's own driver on the Bun that
 * runs this backend, in the project root the runtime owner starts it in. Built from
 * these two paths only, never from project files.
 */
export function swiftPreviewCommand(
  bun: string = process.execPath,
  driver: string = SWIFT_PREVIEW_DRIVER
): string {
  return `${quote(bun)} ${quote(driver)}`
}
