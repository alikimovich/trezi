/** Replaced by `scripts/build-native.mjs` (esbuild `define`) with `versionLabel` of the build. */
declare const TREZI_VERSION: string | undefined

/** "Trezi 0.1.0 (build N, <short sha>)", as stamped into this build; the same text `trezi --version` prints. */
export const appVersion = (): string =>
  typeof TREZI_VERSION === 'string' ? TREZI_VERSION : 'Trezi (unbuilt development source)'
