import { join } from 'node:path'
import {
  selectToolchain,
  type ToolchainOptions,
  type ToolchainSelection,
  toolchainStamp
} from './toolchain'

/**
 * One project's toolchain selection (LKM-274, `toolchain.ts`), selected again only when
 * what it depends on changed (the setting, `DEVELOPER_DIR`, an installed Xcode) or when
 * forced (a requested rebuild, which also rereads `xcode-select -p`).
 */
export class ToolchainPicker {
  current: ToolchainSelection | null = null
  private selecting: Promise<ToolchainSelection> | null = null
  private stamp = ''

  constructor(
    private readonly options: {
      /** A project's cache folder; the probe cache and its work folder go beside it. */
      cacheDir: string
      log: (line: string) => void
      /** Discovery and probe options (tests point them at scripted toolchains). */
      toolchain?: Partial<ToolchainOptions>
    }
  ) {}

  pick(override: ToolchainOptions['override'], force = false): Promise<ToolchainSelection> {
    const options: ToolchainOptions = {
      cacheFile: join(this.options.cacheDir, '..', 'toolchains.json'),
      workDir: join(this.options.cacheDir, '..', 'toolchain-probe'),
      override,
      ...this.options.toolchain
    }
    const stamp = toolchainStamp(options)
    if (this.selecting && !force && stamp === this.stamp) return this.selecting
    const selecting = selectToolchain(options).then((selection) => {
      if (this.selecting !== selecting) return selection
      const previous = this.current
      this.current = selection
      if (previous?.key !== selection.key || previous?.message !== selection.message)
        this.options.log(
          `Swift previews: toolchain ${selection.toolchain?.developerDir ?? 'none'} (${selection.reason}) ${selection.message}`
        )
      return selection
    })
    this.selecting = selecting
    this.stamp = stamp
    return selecting
  }
}
