/**
 * A path or stamp source relative to the project root (LKM-151, LKM-155): an absolute
 * path into the live checkout would send a worktree chat's edits straight to the live
 * tree, so every agent prompt that names a source goes through this.
 *
 * Keeps a `:line[:col]` suffix. Trailing separators on `root` are ignored; a Windows-style
 * root (drive letter or `\`) compares case-insensitively with `\` read as `/` and yields a
 * `/`-separated remainder. A path outside `root` comes back unchanged, unless `served`:
 * a file as a dev server printed it (`./src/…`, root-relative `/src/…`) also loses its
 * leading `./` or `/`.
 */
export function projectRelative(
  path: string,
  root?: string | null,
  { served = false } = {}
): string {
  const relative = withoutRoot(path, root)
  return served ? relative.replace(/^\.\//, '').replace(/^\/+/, '') : relative
}

function withoutRoot(path: string, root?: string | null): string {
  if (!root) return path
  const windows = /^[A-Za-z]:|\\/.test(root)
  const slashes = (value: string): string => (windows ? value.replace(/\\/g, '/') : value)
  const base = `${slashes(root).replace(/\/+$/, '')}/`
  const candidate = slashes(path)
  const inside = windows
    ? candidate.toLowerCase().startsWith(base.toLowerCase())
    : candidate.startsWith(base)
  return inside ? candidate.slice(base.length) : path
}
