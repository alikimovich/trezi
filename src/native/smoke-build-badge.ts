import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BuildCheckInput,
  type BuildStamp,
  type BuildStatus,
  deriveBuildStatus,
  type MainComparison
} from '../shared/build-status'
import type { NativeBridge } from './bridge'
import { nativeBuildStatus } from './build-status-controller'
import { preparePreviewInput } from './smoke-input'
import { waitFor } from './smoke-wait'

const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'
const NEXT = '5e6f708192a3b4c5d6e7f8091a2b3c4d1a2b3c4d'
const MAIN = '9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6'
const LONG_BRANCH = 'agent-os/lkm-301-footer-alignment-and-development-build-identity'
const stamp = (over: Partial<BuildStamp> = {}): BuildStamp => ({
  version: '0.1.0',
  build: '1234',
  commit: SHA.slice(0, 7),
  sha: SHA,
  branch: 'main',
  dirty: false,
  tag: 'v0.1.0',
  git: true,
  builtAt: new Date().toISOString(),
  ...over
})
const checked = (comparison: MainComparison | null, online = true): BuildCheckInput => ({
  enabled: true,
  online,
  comparison,
  checkedAt: Date.now()
})
const next = { build: '1235', commit: NEXT.slice(0, 7), sha: NEXT, tag: '' }

/**
 * LKM-301: each badge state, its expected text and dot. Two revisions of one package
 * version, main and other branches, clean and dirty, detached, offline and no Git.
 */
const STATES: { name: string; status: BuildStatus; text: string; tone: string }[] = [
  {
    name: 'on-main',
    status: deriveBuildStatus(stamp(), checked({ main: SHA, contained: true, behind: 0 })),
    text: '0.1.0 (1234, 1a2b3c4)',
    tone: 'green'
  },
  {
    name: 'on-main-next-revision',
    status: deriveBuildStatus(stamp(next), checked({ main: NEXT, contained: true, behind: 0 })),
    text: '0.1.0 (1235, 5e6f708)',
    tone: 'green'
  },
  {
    name: 'behind',
    status: deriveBuildStatus(stamp(), checked({ main: MAIN, contained: true, behind: 3 })),
    text: '0.1.0 (1234, 1a2b3c4) · 3 behind',
    tone: 'yellow'
  },
  {
    name: 'not-on-main',
    status: deriveBuildStatus(stamp({ branch: 'candidate', tag: '' }), checked(null)),
    text: '0.1.0 (1234, 1a2b3c4) · candidate',
    tone: 'orange'
  },
  {
    name: 'local-changes',
    status: deriveBuildStatus(stamp({ dirty: true }), checked(null)),
    text: '0.1.0 (1234, 1a2b3c4) · modified',
    tone: 'blue'
  },
  {
    name: 'local-changes-branch',
    status: deriveBuildStatus(stamp({ ...next, branch: 'candidate', dirty: true }), checked(null)),
    text: '0.1.0 (1235, 5e6f708) · candidate · modified',
    tone: 'blue'
  },
  {
    name: 'detached',
    status: deriveBuildStatus(
      stamp({ branch: '' }),
      checked({ main: MAIN, contained: true, behind: 2 })
    ),
    text: '0.1.0 (1234, 1a2b3c4) · detached · 2 behind',
    tone: 'yellow'
  },
  {
    name: 'unknown',
    status: deriveBuildStatus(stamp(), checked(null, false)),
    text: '0.1.0 (1234, 1a2b3c4) · offline',
    tone: 'gray'
  },
  {
    name: 'no-git',
    status: deriveBuildStatus(
      stamp({ git: false, build: '0', commit: 'unknown', sha: '', branch: '', tag: '' }),
      checked(null)
    ),
    text: '0.1.0 · no Git',
    tone: 'gray'
  }
]

/** `NSStringFromRect` text ("{{x, y}, {w, h}}") as numbers, window coordinates (y up). */
const rect = (text: string) => {
  const [x, y, width, height] = (text.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number)
  return { x, y, width, height, maxX: x + width, maxY: y + height }
}

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Badge = Record<string, any>

/** Dot and text alignment, order, and the badge inside the sidebar without overlap. */
function assertGeometry(name: string, badge: Badge) {
  assert.ok(
    Math.abs(badge.dotCapOffset) <= 0.5,
    `${name}: dot off the text's cap centre by ${badge.dotCapOffset}`
  )
  assert.ok(
    Math.abs(badge.dotCenterOffset) <= 1,
    `${name}: dot off the text's centre by ${badge.dotCenterOffset}`
  )
  const frame = rect(badge.badgeFrame),
    dot = rect(badge.dotFrame),
    identity = rect(badge.identityFrame)
  const sidebar = rect(badge.sidebarFrame)
  assert.ok(dot.width > 0 && dot.maxX <= identity.x + 0.5, `${name}: dot overlaps the text`)
  if (badge.badgeContext) {
    const context = rect(badge.contextFrame)
    assert.ok(
      Math.abs(badge.contextBaseline - badge.identityBaseline) <= 0.5,
      `${name}: baselines differ`
    )
    assert.ok(identity.maxX <= context.x + 0.5, `${name}: identity overlaps context`)
    assert.ok(context.maxX <= frame.maxX + 0.5, `${name}: context leaves the badge`)
  }
  assert.ok(
    frame.x >= sidebar.x && frame.maxX <= sidebar.maxX - 13.5,
    `${name}: badge clipped by the sidebar: ${badge.badgeFrame} in ${badge.sidebarFrame}`
  )
  assert.ok(
    frame.y >= sidebar.y && frame.maxY <= sidebar.maxY,
    `${name}: badge outside the sidebar`
  )
  const activity = rect(badge.activityFrame)
  if (activity.width > 0) assert.ok(frame.maxX <= activity.x, `${name}: badge overlaps Activity`)
}

/** Text, dot, tooltip, accessibility and geometry of one published state. */
async function showState(
  host: NativeBridge,
  name: string,
  status: BuildStatus,
  text: string,
  tone: string
) {
  nativeBuildStatus.current?.publish(status)
  const badge = await waitFor(async () => {
    const value = await host.request('buildBadgeInspect')
    return value.badgeText === text && value
  }, `build badge ${name}`)
  assert.equal(badge.badgeTone, tone, `${name} dot`)
  assert.equal(badge.badgeState, status.state)
  assert.ok(badge.badgeVisible, `${name} badge visible`)
  assert.ok(!badge.badgeText.includes('✓'), `${name}: no unexplained checkmark`)
  assert.equal(badge.badgeAccessibilityRole, 'AXButton')
  assert.equal(badge.badgeAccessibilityLabel, `Build: ${status.spoken}`)
  assert.ok(
    badge.badgeAccessibilityLabel.includes(`Version ${status.version}`),
    `${name} spoken version`
  )
  if (status.build)
    assert.ok(
      badge.badgeAccessibilityLabel.includes(`build ${status.build}`),
      `${name} spoken build`
    )
  for (const line of [
    'Version: 0.1.0',
    `Build: ${status.build || '-'}`,
    `Commit: ${status.commit || '-'}`,
    'Branch:',
    'Tree:',
    'Release tag:',
    'Built:',
    'Checked:'
  ])
    assert.ok(badge.badgeTooltip.includes(line), `${name} tooltip lacks ${line}`)
  assert.ok(badge.aboutCredits.includes('Status: '), 'About Trezi shows the build details')
  if (status.commit)
    assert.ok(badge.badgeMenu.includes(`Copy Commit ${status.commit}`), 'Copy Commit item')
  else
    assert.ok(
      !badge.badgeMenu.some((item: string) => item.startsWith('Copy Commit')),
      `${name}: nothing to copy`
    )
  assertGeometry(name, badge)
  return badge
}

/**
 * LKM-226: the sidebar footer's build badge in every state (text, dot, tooltip and a
 * capture), About Trezi's credits, and the behind badge's click (update steps).
 * LKM-301: dot/text alignment, accessibility, and a narrow sidebar with a long branch.
 */
export async function checkBuildBadge(host: NativeBridge, artifacts: string) {
  const controller = nativeBuildStatus.current
  assert.ok(controller, 'Build status controller')
  const foreground = process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1'
  if (foreground) await preparePreviewInput(host, true)
  const evidence: Record<string, unknown> = {}
  const initialWidth = (await host.request('buildBadgeInspect')).sidebarWidth as number
  try {
    for (const { name, status, text, tone } of STATES) {
      const badge = await showState(host, name, status, text, tone)
      assert.ok(!badge.badgeTruncated, `${name} badge text truncated: ${badge.badgeFrame}`)
      const shot = await host.request('buildBadgeInspect', { capture: 'current' })
      writeFileSync(join(artifacts, `build-badge-${name}.png`), Buffer.from(shot.png, 'base64'))
      evidence[name] = { ...badge, foreground: shot.foreground }
    }
    // The narrowest sidebar and a long branch: the context gives way, nothing clips.
    await host.request('shellPerform', { action: 'sidebar-width', row: '180' })
    const long = deriveBuildStatus(
      stamp({ ...next, branch: LONG_BRANCH, dirty: true }),
      checked(null)
    )
    // The inspected text is the whole string; only its drawing truncates.
    const narrow = await showState(
      host,
      'narrow',
      long,
      `0.1.0 (1235, 5e6f708) · ${LONG_BRANCH} · modified`,
      'blue'
    )
    assert.ok(Math.abs(narrow.sidebarWidth - 180) <= 1, `narrow sidebar: ${narrow.sidebarWidth}`)
    assert.ok(narrow.contextTruncated, 'the long branch truncates')
    assert.ok(!narrow.identityTruncated, 'version, build and commit stay whole')
    const narrowShot = await host.request('buildBadgeInspect', { capture: 'current' })
    writeFileSync(join(artifacts, 'build-badge-narrow.png'), Buffer.from(narrowShot.png, 'base64'))
    evidence.narrow = { ...narrow, foreground: narrowShot.foreground }
    await host.request('shellPerform', {
      action: 'sidebar-width',
      row: String(Math.round(Math.min(340, Math.max(180, initialWidth))))
    })
    // A dark-appearance capture of the behind badge (yellow on the dark sidebar).
    const behind = STATES[2]
    await showState(host, 'behind-dark', behind.status, behind.text, behind.tone)
    const dark = await host.request('buildBadgeInspect', { capture: 'dark' })
    writeFileSync(join(artifacts, 'build-badge-behind-dark.png'), Buffer.from(dark.png, 'base64'))
    // Clicking the behind badge opens the details with the update steps.
    await host.request('buildBadgeInspect', { perform: true })
    const sheet = await waitFor(async () => {
      const value = await host.request('sheetInspect')
      return value.visible && value.title === 'A newer Trezi is on main' && value
    }, 'build details sheet')
    assert.ok(
      sheet.detail.includes('git pull') && sheet.detail.includes('bun run build'),
      'update steps'
    )
    assert.ok(sheet.detail.includes('Behind main by 3 commits'), sheet.detail)
    for (const action of ['cancel', 'copy-commit', 'check', 'update'])
      assert.ok(sheet.actions.includes(action), `details sheet lacks ${action}`)
    writeFileSync(
      join(artifacts, 'build-badge-details.png'),
      Buffer.from(await host.request('captureSheet'), 'base64')
    )
    evidence.details = { title: sheet.title, detail: sheet.detail, actions: sheet.actions }
    await host.request('sheetPerform', { action: 'cancel' })
    await waitFor(async () => !(await host.request('sheetInspect')).visible, 'details sheet closed')
    writeFileSync(join(artifacts, 'build-badge.json'), JSON.stringify(evidence, null, 2))
  } finally {
    await host
      .request('shellPerform', {
        action: 'sidebar-width',
        row: String(Math.round(Math.min(340, Math.max(180, initialWidth))))
      })
      .catch(() => undefined)
    await restoreBuildBadge()
  }
}

/** Back to this build's own state (the test profile never asks GitHub). */
export async function restoreBuildBadge() {
  await nativeBuildStatus.current?.check()
}
