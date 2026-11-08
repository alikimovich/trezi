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
  'composer',
  'agent-browser',
  'selection',
  'changes',
  'inspector'
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
  if (argv.includes(DREAMER_ACCEPTANCE_FLAG) && !names.includes('settings'))
    throw new Error(`${DREAMER_ACCEPTANCE_FLAG} needs the settings group in --only`)
  if (argv.includes(MARKUP_ACCEPTANCE_FLAG) && !names.includes('core'))
    throw new Error(`${MARKUP_ACCEPTANCE_FLAG} needs the core group in --only`)
  if (argv.includes(ANNOTATION_COMPOSITE_FLAG) && !names.includes('core'))
    throw new Error(`${ANNOTATION_COMPOSITE_FLAG} needs the core group in --only`)
  if (argv.includes(SOURCE_POPOUT_ACCEPTANCE_FLAG) && !names.includes('core'))
    throw new Error(`${SOURCE_POPOUT_ACCEPTANCE_FLAG} needs the core group in --only`)
  if (argv.includes(CHAT_RECOVERY_ACCEPTANCE_FLAG) && !names.includes('chat'))
    throw new Error(`${CHAT_RECOVERY_ACCEPTANCE_FLAG} needs the chat group in --only`)
  return new Set(names as NativeSmokeGroup[])
}

/** Full-suite foreground captures can outlast the focused run's launcher watchdog.
 *  Passing full runs on a loaded host took 381–404 s (LKM-267), so the full suite gets
 *  600 s. Each smoke check keeps its own timeout and assertions. `coreExtraMs` is added
 *  when the core group runs (LKM-277: the Scraib acceptance builds, `scraib-originals.ts`). */
export function smokeLauncherTimeoutMs(
  groups: ReadonlySet<NativeSmokeGroup>,
  coreExtraMs = 0
): number {
  const base = NATIVE_SMOKE_GROUPS.every((group) => groups.has(group)) ? 600_000 : 300_000
  return base + (groups.has('core') ? coreExtraMs : 0)
}

/** Checks that run for every selection: the setup the groups build on, and the
 *  closing capture plus one-WebKit-view isolation check. */
export const SMOKE_PRELUDE = ['startup', 'open-project', 'chat-ready', 'final-shell'] as const

/** The group(s) each smoke-core check belongs to; a check runs when any of them is selected. */
export const SMOKE_CHECK_GROUPS: Readonly<Record<string, readonly NativeSmokeGroup[]>> = {
  'mobile-viewport': ['core'],
  'source-stamps': ['core'],
  'shell-layout': ['core'],
  'toolbar-address': ['core', 'shadow-light'],
  'toggle-ui': ['core'],
  'toolbar-actions': ['core', 'shadow-light'],
  'device-frame': ['core'],
  'selection-input': ['core', 'selection'],
  inspector: ['core', 'inspector'],
  'inspector-custom': ['core'],
  'select-off': ['core'],
  'layers-island': ['core'],
  'movable-islands': ['core'],
  'preview-overlay': ['core'],
  'preview-markup': ['core'],
  'annotation-composite-send-native': ['core'],
  'text-edit': ['core', 'selection'],
  'editor-freshness': ['core'],
  'source-editor': ['core'],
  'source-popout': ['core'],
  'source-syntax': ['core'],
  'source-wrap': ['core'],
  'changes-panel': ['changes'],
  'preview-inspector': ['core'],
  'agent-preview': ['core'],
  'agent-interact': ['core'],
  'agent-runtime': ['core'],
  'agent-navigation': ['core', 'agent-browser'],
  'agent-verify': ['core'],
  'managed-agent-browser': ['core'],
  'agent-integration': ['core'],
  'preview-timing': ['core'],
  'preview-speed': ['core'],
  'preview-history': ['core'],
  'toolbar-more': ['core'],
  'three-d': ['core'],
  'publish-progress': ['core', 'shadow-light'],
  'swift-preview': ['core'],
  'swift-graph': ['core'],
  'swift-build': ['core'],
  'swift-macros': ['core'],
  'scraib-xcode': ['core'],
  'scraib-open': ['core'],
  'git-updates': ['core'],
  'live-provider': ['core'],
  // One fixture scope covers both; smoke-islands reads the selection to run either part.
  'chat-islands': ['islands'],
  'island-new-chat': ['islands'],
  'project-switching': ['sidebar'],
  'chat-gate': ['sidebar'],
  'build-badge': ['sidebar'],
  sheets: ['settings'],
  dreamer: ['settings'],
  // LKM-447: opt-in, pushed only with --dreamer-acceptance (selectDreamerAcceptance).
  'dreamer-export-primary': ['settings'],
  'markup-toggle-overlay-native': ['core'],
  // LKM-456: opt-in, pushed only with --source-popout-acceptance (selectSourcePopoutAcceptance).
  'fullscreen-popout-close-native': ['core'],
  'skills-settings': ['settings'],
  'browser-setup': ['settings'],
  'security-session': ['settings'],
  'native-chat': ['chat'],
  // LKM-453: opt-in, pushed only with --chat-recovery-acceptance (selectChatRecoveryAcceptance).
  'chat-recovery-flow-native': ['chat'],
  'sidebar-status': ['sidebar', 'chat'],
  'sidebar-chats': ['sidebar', 'chat'],
  'sent-attachments': ['chat'],
  'comment-rows': ['chat'],
  'incident-row': ['chat'],
  'landing-check': ['chat'],
  'agent-question': ['chat'],
  'chat-text': ['chat'],
  'chat-reply': ['chat', 'composer'],
  'chat-ui': ['chat'],
  'code-link-click': ['chat'],
  'parallel-stream': ['chat', 'sidebar'],
  'mixed-origin-compatible': ['chat'],
  'mixed-origin-incompatible': ['chat'],
  'quit-alert': ['chat'],
  composer: ['composer'],
  'chat-drafts': ['composer'],
  'visible-composer': ['composer'],
  'composer-send': ['composer', 'chat'],
  'start-composer': ['composer']
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

/** LKM-447: the opt-in Dreamer acceptance (`bun run acceptance:dreamer`, docs/DREAMER.md). */
export const DREAMER_ACCEPTANCE_FLAG = '--dreamer-acceptance'
export const DREAMER_ACCEPTANCE_CHECK = 'dreamer-export-primary'
export const MARKUP_ACCEPTANCE_FLAG = '--markup-acceptance'
export const MARKUP_ACCEPTANCE_CHECK = 'markup-toggle-overlay-native'
export const ANNOTATION_COMPOSITE_FLAG = '--annotation-composite-acceptance'
export const ANNOTATION_COMPOSITE_CHECK = 'annotation-composite-send-native'

/** LKM-543: only the disposable project prelude and the annotation/Send fixture. */
export function selectAnnotationComposite<T extends { name: string }>(
  checks: T[],
  argv: readonly string[]
): T[] {
  if (!argv.includes(ANNOTATION_COMPOSITE_FLAG)) return checks
  if (
    argv.includes('--live') ||
    argv.some((arg) => arg !== ANNOTATION_COMPOSITE_FLAG && /^--[\w-]+-acceptance$/.test(arg))
  )
    throw new Error(`${ANNOTATION_COMPOSITE_FLAG} cannot run with --live or another acceptance`)
  const picked = checks.filter(
    ({ name }) =>
      (SMOKE_PRELUDE as readonly string[]).includes(name) || name === ANNOTATION_COMPOSITE_CHECK
  )
  if (!picked.some(({ name }) => name === ANNOTATION_COMPOSITE_CHECK))
    throw new Error(`${ANNOTATION_COMPOSITE_FLAG}: ${ANNOTATION_COMPOSITE_CHECK} was not selected`)
  return picked
}

/** With the flag, only the prelude and the Dreamer acceptance run (the flag's check must be
 *  among `checks`); without it the selection is unchanged. */
export function selectDreamerAcceptance<T extends { name: string }>(
  checks: T[],
  argv: readonly string[],
  log: (line: string) => void = console.log
): T[] {
  if (!argv.includes(DREAMER_ACCEPTANCE_FLAG)) return checks
  if (argv.includes('--live')) throw new Error(`${DREAMER_ACCEPTANCE_FLAG} cannot run with --live`)
  const prelude: readonly string[] = SMOKE_PRELUDE
  const picked = checks.filter(
    ({ name }) => prelude.includes(name) || name === DREAMER_ACCEPTANCE_CHECK
  )
  if (!picked.some(({ name }) => name === DREAMER_ACCEPTANCE_CHECK))
    throw new Error(
      `${DREAMER_ACCEPTANCE_FLAG}: the ${DREAMER_ACCEPTANCE_CHECK} check was not selected`
    )
  log(
    `DREAMER ACCEPTANCE (${DREAMER_ACCEPTANCE_FLAG}): running ${picked.map((c) => c.name).join(', ')}; not full-suite acceptance.`
  )
  return picked
}

/** One opt-in foreground check plus the existing disposable-project prelude. */
export function selectMarkupAcceptance<T extends { name: string }>(
  checks: T[],
  argv: readonly string[]
): T[] {
  if (!argv.includes(MARKUP_ACCEPTANCE_FLAG)) return checks
  if (
    argv.includes('--live') ||
    argv.includes(DREAMER_ACCEPTANCE_FLAG) ||
    argv.includes(SOURCE_POPOUT_ACCEPTANCE_FLAG)
  )
    throw new Error(
      `${MARKUP_ACCEPTANCE_FLAG} cannot run with --live, ${DREAMER_ACCEPTANCE_FLAG} or ${SOURCE_POPOUT_ACCEPTANCE_FLAG}`
    )
  const picked = checks.filter(
    ({ name }) =>
      (SMOKE_PRELUDE as readonly string[]).includes(name) || name === MARKUP_ACCEPTANCE_CHECK
  )
  if (!picked.some(({ name }) => name === MARKUP_ACCEPTANCE_CHECK))
    throw new Error(`${MARKUP_ACCEPTANCE_FLAG}: ${MARKUP_ACCEPTANCE_CHECK} was not selected`)
  return picked
}

/** LKM-456: the opt-in LKM-444 full-screen pop-out close acceptance with posted pointer and
 *  keyboard input (`bun run acceptance:source-popout`, docs/TESTING.md). */
export const SOURCE_POPOUT_ACCEPTANCE_FLAG = '--source-popout-acceptance'
export const SOURCE_POPOUT_ACCEPTANCE_CHECK = 'fullscreen-popout-close-native'

/** With the flag, only the prelude and the pop-out acceptance run; without it the selection
 *  is unchanged. It runs alone: not with --live or the Dreamer acceptance. */
export function selectSourcePopoutAcceptance<T extends { name: string }>(
  checks: T[],
  argv: readonly string[],
  log: (line: string) => void = console.log
): T[] {
  const flag = SOURCE_POPOUT_ACCEPTANCE_FLAG,
    check = SOURCE_POPOUT_ACCEPTANCE_CHECK
  if (!argv.includes(flag)) return checks
  if (argv.includes('--live')) throw new Error(`${flag} cannot run with --live`)
  if (argv.includes(DREAMER_ACCEPTANCE_FLAG))
    throw new Error(`${flag} cannot run with ${DREAMER_ACCEPTANCE_FLAG}`)
  if (argv.includes(MARKUP_ACCEPTANCE_FLAG))
    throw new Error(`${flag} cannot run with ${MARKUP_ACCEPTANCE_FLAG}`)
  const prelude: readonly string[] = SMOKE_PRELUDE
  const picked = checks.filter(({ name }) => prelude.includes(name) || name === check)
  if (!picked.some(({ name }) => name === check))
    throw new Error(`${flag}: the ${check} check was not selected`)
  log(
    `SOURCE POP-OUT ACCEPTANCE (${flag}): running ${picked.map((c) => c.name).join(', ')}; not full-suite acceptance.`
  )
  return picked
}

/** LKM-453: the opt-in chat recovery acceptance (`bun run acceptance:chat-recovery`,
 *  docs/TESTING.md "Chat recovery acceptance"). */
export const CHAT_RECOVERY_ACCEPTANCE_FLAG = '--chat-recovery-acceptance'
export const CHAT_RECOVERY_ACCEPTANCE_CHECK = 'chat-recovery-flow-native'

/** With the flag, only the prelude and the chat recovery acceptance run (the check must be
 *  among `checks`); without it the selection is unchanged. It runs alone: not with --live
 *  or any other `--*-acceptance` flag. */
export function selectChatRecoveryAcceptance<T extends { name: string }>(
  checks: T[],
  argv: readonly string[],
  log: (line: string) => void = console.log
): T[] {
  const flag = CHAT_RECOVERY_ACCEPTANCE_FLAG,
    check = CHAT_RECOVERY_ACCEPTANCE_CHECK
  if (!argv.includes(flag)) return checks
  if (argv.includes('--live')) throw new Error(`${flag} cannot run with --live`)
  const other = argv.find((arg) => arg !== flag && /^--[\w-]+-acceptance$/.test(arg))
  if (other) throw new Error(`${flag} cannot run with ${other}`)
  const prelude: readonly string[] = SMOKE_PRELUDE
  const picked = checks.filter(({ name }) => prelude.includes(name) || name === check)
  if (!picked.some(({ name }) => name === check))
    throw new Error(`${flag}: the ${check} check was not selected`)
  log(
    `CHAT RECOVERY ACCEPTANCE (${flag}): running ${picked.map((c) => c.name).join(', ')}; not full-suite acceptance.`
  )
  return picked
}
