/** Files whose landed changes need more than a page reload/HMR. */
export function environmentChanges(files: string[]): { restart: boolean; install: boolean } {
  const install = files.some((file) =>
    /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?)$/.test(
      file
    )
  )
  const restart =
    install ||
    files.some((file) =>
      /(^|\/)((vite|next|svelte|astro|nuxt)\.config\.[^/]+|\.env(?:\.[^/]+)?|\.npmrc|\.yarnrc(?:\.yml)?)$/.test(
        file
      )
    )
  return { restart, install }
}
