import { type NativeContainer, runTool } from './graph'
import { tidyXcode } from './xcode-tidy'

/**
 * Resolved build settings (LKM-275): `xcodebuild -showBuildSettings -json` for the
 * scheme that builds the target, Debug, macOS, with `-derivedDataPath` in Trezi's
 * derived data, so nothing goes to `~/Library/Developer/Xcode/DerivedData` (a bare
 * `-target` query would). Packages are never resolved or updated here
 * (`-disableAutomaticPackageResolution`, `-skipPackageUpdates`). The empty folders
 * xcodebuild creates in the `.xcodeproj` are removed again, and anything else new is
 * reported (`xcode-tidy.ts`).
 * The schemes are tried in order (one named like the target first) until each plan
 * target has its settings.
 */
export interface ResolvedSettings {
  scheme: string
  /** Target name → its resolved settings (string values only). */
  targets: Record<string, Record<string, string>>
  derivedData: string
  errors: string[]
  /** New files or folders xcodebuild left in the project (expected: none). */
  leftovers: string[]
}

export function showSettingsArgs(project: string, scheme: string, derivedData: string): string[] {
  return [
    '-showBuildSettings',
    '-json',
    '-project',
    project,
    '-scheme',
    scheme,
    '-configuration',
    'Debug',
    '-destination',
    'platform=macOS',
    '-derivedDataPath',
    derivedData,
    '-disableAutomaticPackageResolution',
    '-skipPackageUpdates'
  ]
}

export async function resolveXcodeSettings(
  root: string,
  container: NativeContainer,
  targets: string[],
  options: {
    derivedData: string
    env: Record<string, string>
    xcodebuild?: string
    timeoutMs?: number
  }
): Promise<ResolvedSettings> {
  const resolved: ResolvedSettings = {
    scheme: '',
    targets: {},
    derivedData: options.derivedData,
    errors: [],
    leftovers: []
  }
  const selected = targets[targets.length - 1] ?? ''
  const schemes = [
    ...container.schemes.filter((s) => s === selected),
    ...container.schemes.filter((s) => s !== selected)
  ].slice(0, 4)
  if (!schemes.length) {
    resolved.errors.push(
      `${container.path} has no scheme, so xcodebuild cannot resolve its settings.`
    )
    return resolved
  }
  const { leftovers } = await tidyXcode(root, container, async () => {
    for (const scheme of schemes) {
      if (targets.every((t) => resolved.targets[t])) break
      const result = await runTool(
        options.xcodebuild ?? '/usr/bin/xcodebuild',
        showSettingsArgs(container.path, scheme, options.derivedData),
        { cwd: root, timeoutMs: options.timeoutMs ?? 90_000, env: options.env }
      )
      if (result.error) {
        resolved.errors.push(`Scheme ${scheme}: ${result.error}`)
        continue
      }
      let entries: any[]
      try {
        entries = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')))
      } catch {
        resolved.errors.push(`Scheme ${scheme}: xcodebuild -showBuildSettings returned no JSON.`)
        continue
      }
      for (const entry of Array.isArray(entries) ? entries : []) {
        const name = entry?.target ?? entry?.buildSettings?.TARGET_NAME
        if (!name || !targets.includes(name) || resolved.targets[name]) continue
        const settings: Record<string, string> = {}
        for (const [key, value] of Object.entries(entry.buildSettings ?? {}))
          if (typeof value === 'string') settings[key] = value
        resolved.targets[name] = settings
        resolved.scheme ||= scheme
      }
    }
  })
  resolved.leftovers = leftovers
  const missing = targets.filter((t) => !resolved.targets[t])
  if (missing.length)
    resolved.errors.push(
      `No scheme of ${container.path} builds ${missing.join(', ')}; ${missing.length === 1 ? 'its' : 'their'} settings come from the project file.`
    )
  return resolved
}
