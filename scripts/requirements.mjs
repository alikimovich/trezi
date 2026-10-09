// Trezi's supported platform, in one place (S15). The build stamps MIN_MACOS into both
// bundles (LSMinimumSystemVersion, swiftc -target); the build, the launcher, the CLI and
// install.sh refuse early with one clear message instead of failing inside swiftc or
// dyld. docs/SWIFT-BACKEND-RETIREMENT.md lists the same values; test/distribution.mjs
// keeps them in sync.

/** Oldest macOS the app and its XPC service run on. */
export const MIN_MACOS = '13.3'
/** The SDK the Swift sources compile against (Liquid Glass APIs, availability-guarded). */
export const MIN_SDK = '26.0'
/** package.json#engines.bun */
export const MIN_BUN = '1.3.0'

/** Numeric dotted-version comparison; a missing part counts as 0. */
export function compareVersions(a, b) {
  const left = String(a).trim().split('.').map(Number)
  const right = String(b).trim().split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0)
    if (difference) return Math.sign(difference)
  }
  return 0
}

const valid = version => typeof version === 'string' && /^\d+(\.\d+)*$/.test(version.trim())

/**
 * The problems that stop Trezi on this machine (empty: supported). `sdk` is only
 * needed to build; pass null to check a launch of an existing build.
 */
export function platformProblems({ platform, macos, sdk = null, bun = null }) {
  if (platform !== 'darwin') return [`Trezi requires macOS ${MIN_MACOS} or later.`]
  const problems = []
  if (!valid(macos) || compareVersions(macos, MIN_MACOS) < 0)
    problems.push(`Trezi requires macOS ${MIN_MACOS} or later (this Mac runs ${macos || 'an unknown version'}).`)
  if (sdk !== null && (!valid(sdk) || compareVersions(sdk, MIN_SDK) < 0))
    problems.push(`Building Trezi requires the macOS ${MIN_SDK} SDK or later (found ${sdk || 'none'}). Install the current Xcode command-line tools.`)
  if (bun !== null && (!valid(bun) || compareVersions(bun, MIN_BUN) < 0))
    problems.push(`Trezi requires Bun ${MIN_BUN} or later (found ${bun || 'none'}). Run: bun upgrade`)
  return problems
}

/** This machine's versions (macOS through sw_vers, the SDK through xcrun when asked). */
export function hostVersions({ sdk = false } = {}) {
  const read = command => {
    try {
      const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'ignore' })
      return result.exitCode === 0 ? result.stdout.toString().trim() : null
    } catch {
      return null
    }
  }
  return {
    platform: process.platform,
    macos: process.platform === 'darwin' ? read(['sw_vers', '-productVersion']) : null,
    sdk: sdk ? read(['xcrun', '--sdk', 'macosx', '--show-sdk-version']) : null,
    bun: typeof Bun === 'undefined' ? null : Bun.version
  }
}

/** Throws the first problem, if any. */
export function requireSupportedPlatform(options = {}) {
  const versions = hostVersions(options)
  const problems = platformProblems({ ...versions, sdk: options.sdk ? versions.sdk : null })
  if (problems.length) throw new Error(problems.join('\n'))
  return versions
}

// `bun scripts/requirements.mjs [--build]` (install.sh): print the problems and fail.
if (import.meta.main) {
  try {
    const versions = requireSupportedPlatform({ sdk: process.argv.includes('--build') })
    console.log(`Supported: macOS ${versions.macos}${versions.sdk ? `, SDK ${versions.sdk}` : ''}, Bun ${versions.bun}.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
