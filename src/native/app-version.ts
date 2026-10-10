import { type BuildStamp, parseBuildStamp } from '../shared/build-status'

/** Replaced by `scripts/build-native.mjs` (esbuild `define`) with `versionLabel` of the build. */
declare const TREZI_VERSION: string | undefined
/** LKM-226: the build's `buildInfo` (scripts/version.mjs) as JSON text, defined the same way. */
declare const TREZI_BUILD: string | undefined

/** "Trezi 0.1.0 (build N, <short sha>)", as stamped into this build; the same text `trezi --version` prints. */
export const appVersion = (): string =>
  typeof TREZI_VERSION === 'string' ? TREZI_VERSION : 'Trezi (unbuilt development source)'

/** Version, build, sha, branch, dirty flag and release tag of this build; null when unbuilt. */
export const buildStamp = (): BuildStamp | null =>
  typeof TREZI_BUILD === 'string' ? parseBuildStamp(TREZI_BUILD) : null
