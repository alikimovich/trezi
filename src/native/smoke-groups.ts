/** Named groups of the native smoke, selected with `--only=group,group`
 *  (`bun run dev:native --test --only=core,chat`). Selection only filters which of
 *  smoke-core's named checks run (smoke-runner still collects every failure the
 *  same way); the shared prelude always runs because every group builds on it.
 *  No flag runs every group. Pure. */
export const NATIVE_SMOKE_GROUPS = [
  'core',
  'islands',
  'shadow-light',
  'sidebar',
  'settings',
  'chat',
  'composer'
] as const
export type NativeSmokeGroup = (typeof NATIVE_SMOKE_GROUPS)[number]

const known = (name: string): name is NativeSmokeGroup =>
  (NATIVE_SMOKE_GROUPS as readonly string[]).includes(name)

/** The groups named by argv's `--only=` flag, or every group when it is absent.
 *  Throws a message naming the valid groups for an unknown or empty selection. */
export function parseSmokeGroups(argv: readonly string[]): Set<NativeSmokeGroup> {
  const flags = argv.filter((arg) => arg === '--only' || arg.startsWith('--only='))
  if (!flags.length) return new Set(NATIVE_SMOKE_GROUPS)
  const list = NATIVE_SMOKE_GROUPS.join(', ')
  if (flags.length > 1)
    throw new Error(`--only may be given once; combine groups with commas. Known groups: ${list}`)
  const names = flags[0]
    .slice('--only='.length)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (!names.length)
    throw new Error(`--only needs at least one group, e.g. --only=core,chat. Known groups: ${list}`)
  const unknown = names.filter((name) => !known(name))
  if (unknown.length)
    throw new Error(
      `Unknown native smoke group${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Known groups: ${list}`
    )
  // The live turn edits the heading text that the core group's text edit writes.
  if (argv.includes('--live') && !names.includes('core'))
    throw new Error('--live needs the core group in --only')
  return new Set(names as NativeSmokeGroup[])
}

/** Checks that run for every selection: the setup the groups build on, and the
 *  closing capture plus one-WebKit-view isolation check. */
export const SMOKE_PRELUDE = ['startup', 'open-project', 'chat-ready', 'final-shell'] as const

/** The group(s) each smoke-core check belongs to; a check runs when any of them is selected. */
export const SMOKE_CHECK_GROUPS: Readonly<Record<string, readonly NativeSmokeGroup[]>> = {
  'mobile-viewport': ['core'],
  'source-stamps': ['core'],
  'shell-layout': ['core'],
  'toolbar-address': ['core'],
  'selection-input': ['core'],
  inspector: ['core'],
  'layers-island': ['core'],
  'movable-islands': ['core'],
  'preview-overlay': ['core'],
  'text-edit': ['core'],
  'source-editor': ['core'],
  'source-syntax': ['core'],
  'source-wrap': ['core'],
  'preview-inspector': ['core'],
  'agent-preview': ['core'],
  'preview-timing': ['core'],
  'preview-speed': ['core'],
  'toolbar-more': ['core'],
  'states-workbench': ['core'],
  'publish-progress': ['core'],
  'live-provider': ['core'],
  // One fixture scope covers both; smoke-islands reads the selection to run either part.
  'chat-islands': ['islands', 'shadow-light'],
  'island-new-chat': ['islands'],
  'project-switching': ['sidebar'],
  'chat-gate': ['sidebar'],
  sheets: ['settings'],
  dreamer: ['settings'],
  'security-session': ['settings'],
  'native-chat': ['chat'],
  'sent-attachments': ['chat'],
  'comment-rows': ['chat'],
  'landing-check': ['chat'],
  'agent-question': ['chat'],
  'chat-text': ['chat'],
  composer: ['composer'],
  'chat-drafts': ['composer'],
  'visible-composer': ['composer']
}

/** Only the checks the selection names, plus the prelude, in their original order.
 *  A check with no group and not in the prelude is a bug: new checks must be classified.
 *  A filtered run says so up front: its final PASS line is not full-suite acceptance. */
export function selectSmokeChecks<T extends { name: string }>(
  checks: T[],
  groups: ReadonlySet<NativeSmokeGroup>,
  log: (line: string) => void = console.log
): T[] {
  const prelude: readonly string[] = SMOKE_PRELUDE
  for (const { name } of checks)
    if (!prelude.includes(name) && !SMOKE_CHECK_GROUPS[name])
      throw new Error(`Native smoke check ${name} has no group in smoke-groups.ts`)
  const picked = checks.filter(
    ({ name }) =>
      prelude.includes(name) || SMOKE_CHECK_GROUPS[name].some((group) => groups.has(group))
  )
  if (picked.length < checks.length)
    log(
      `NATIVE SMOKE FILTERED (--only=${[...groups].join(',')}): running ${picked.length} of ${checks.length} checks; the other groups did not run, so a pass below is not full-suite acceptance.`
    )
  return picked
}
