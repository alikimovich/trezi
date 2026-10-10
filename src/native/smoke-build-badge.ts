import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BuildCheckInput,
  type BuildStamp,
  deriveBuildStatus,
  type MainComparison
} from '../shared/build-status'
import type { NativeBridge } from './bridge'
import { nativeBuildStatus } from './build-status-controller'
import { preparePreviewInput } from './smoke-input'
import { waitFor } from './smoke-wait'

const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'
const MAIN = '9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6'
const stamp = (over: Partial<BuildStamp> = {}): BuildStamp => ({
  version: '0.1.0',
  build: '1234',
  commit: SHA.slice(0, 7),
  sha: SHA,
  branch: 'main',
  dirty: false,
  tag: 'v0.1.0',
  ...over
})
const checked = (comparison: MainComparison | null, online = true): BuildCheckInput => ({
  enabled: true,
  online,
  comparison,
  checkedAt: Date.now()
})

/** Each badge state, its expected text and dot. */
const STATES = [
  {
    name: 'on-main',
    status: deriveBuildStatus(stamp(), checked({ main: SHA, contained: true, behind: 0 })),
    text: '0.1.0 · main ✓',
    tone: 'green'
  },
  {
    name: 'behind',
    status: deriveBuildStatus(stamp(), checked({ main: MAIN, contained: true, behind: 3 })),
    text: '0.1.0 · 3 behind',
    tone: 'yellow'
  },
  {
    name: 'not-on-main',
    status: deriveBuildStatus(stamp({ branch: 'candidate', tag: '' }), checked(null)),
    text: 'candidate · not on main',
    tone: 'orange'
  },
  {
    name: 'local-changes',
    status: deriveBuildStatus(stamp({ dirty: true }), checked(null)),
    text: '0.1.0 · local changes',
    tone: 'blue'
  },
  {
    name: 'unknown',
    status: deriveBuildStatus(stamp(), checked(null, false)),
    text: '0.1.0 · offline',
    tone: 'gray'
  }
]

/**
 * LKM-226: the sidebar footer's build badge in every state (text, dot, tooltip and a
 * capture), About Trezi's credits, and the behind badge's click (update steps).
 */
export async function checkBuildBadge(host: NativeBridge, artifacts: string) {
  const controller = nativeBuildStatus.current
  assert.ok(controller, 'Build status controller')
  const foreground = process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1'
  if (foreground) await preparePreviewInput(host, true)
  const evidence: Record<string, unknown> = {}
  try {
    for (const { name, status, text, tone } of STATES) {
      controller.publish(status)
      const badge = await waitFor(async () => {
        const value = await host.request('buildBadgeInspect')
        return value.badgeText === text && value
      }, `build badge ${name}`)
      assert.equal(badge.badgeTone, tone, `${name} dot`)
      assert.equal(badge.badgeState, status.state)
      assert.ok(badge.badgeVisible, `${name} badge visible`)
      assert.ok(!badge.badgeTruncated, `${name} badge text truncated: ${badge.badgeFrame}`)
      for (const line of [
        'Version: 0.1.0',
        'Build: 1234',
        `Commit: ${SHA.slice(0, 7)}`,
        'Branch:',
        'Release tag:',
        'Checked:'
      ])
        assert.ok(badge.badgeTooltip.includes(line), `${name} tooltip lacks ${line}`)
      assert.ok(badge.aboutCredits.includes('Status: '), 'About Trezi shows the build details')
      assert.ok(badge.badgeMenu.includes(`Copy Commit ${SHA.slice(0, 7)}`), 'Copy Commit item')
      const shot = await host.request('buildBadgeInspect', { capture: 'current' })
      writeFileSync(join(artifacts, `build-badge-${name}.png`), Buffer.from(shot.png, 'base64'))
      evidence[name] = { ...badge, foreground: shot.foreground }
    }
    // A dark-appearance capture of the behind badge (yellow on the dark sidebar).
    controller.publish(STATES[1].status)
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
    await restoreBuildBadge()
  }
}

/** Back to this build's own state (the test profile never asks GitHub). */
export async function restoreBuildBadge() {
  await nativeBuildStatus.current?.check()
}
