import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BranchStatus } from '../shared/native-shell'
import type { NativeBridge } from './bridge'
import type { NativeGitController } from './git-controller'
import { capture } from './smoke-toolbar'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>

const states = ['none', 'unknown', 'running', 'passed', 'failed'] as const

/**
 * LKM-245: the subtitle's CI dot is one drawn circle in a fixed slot. Every ordered
 * transition between CI states, into and out of the running spinner, keeps its window
 * frame, diameter and centre line; passed and failed fill it, the others stroke it.
 * Foreground captures at normal and narrow widths in light and dark mode follow.
 */
export async function checkBranchDot(
  host: NativeBridge,
  git: NativeGitController,
  root: string,
  sample: BranchStatus,
  artifacts: string
) {
  const show = async (ci: (typeof states)[number]) => {
    git.statuses.set(root, { ...sample, ci, failing: ci === 'failed' ? ['build', 'lint'] : [] })
    git.render()
    const state: State = await waitFor(
      async () => {
        const s = await host.request('shellInspect')
        return s.branchDotState === ci && s.branchBusy === (ci === 'running') && s
      },
      `CI dot ${ci}`,
      5000,
      undefined,
      20
    )
    assert.ok(state.branchDotVisible && state.branchDotFits, `The ${ci} dot is in its slot`)
    assert.equal(state.branchDotFilled, ci === 'passed' || ci === 'failed', `${ci} fill`)
    return state
  }
  const geometry = (s: State) => ({
    frame: s.branchDotFrame,
    local: s.branchDotLocalFrame,
    diameter: s.branchDotDiameter,
    baseline: s.branchDotBaseline,
    slot: s.branchDotSlot
  })
  const evidence: Record<string, unknown> = {}
  for (const width of [1320, 850]) {
    assert.ok(await host.request('shellPerform', { action: 'window-width', row: String(width) }))
    let reference: ReturnType<typeof geometry> | undefined
    for (const from of states)
      for (const to of states) {
        if (from === to) continue
        for (const ci of [from, to]) {
          const now = geometry(await show(ci))
          reference ??= now
          assert.deepEqual(now, reference, `CI dot ${from} → ${to} at ${width}`)
        }
      }
    assert.ok(reference)
    assert.deepEqual(reference.diameter, [7, 7], 'The dot keeps its 7 pt diameter')
    evidence[width] = reference
    for (const appearance of ['light', 'dark']) {
      assert.ok(
        await host.request('shellPerform', { action: 'window-appearance', row: appearance })
      )
      for (const ci of ['passed', 'none'] as const) {
        assert.deepEqual(geometry(await show(ci)), reference, `${ci} at ${width} in ${appearance}`)
        await capture(host, artifacts, `branch-dot-${ci}-${width}-${appearance}`)
      }
    }
    await host.request('shellPerform', { action: 'window-appearance', row: '' })
  }
  await host.request('shellPerform', { action: 'window-width', row: '1320' })
  writeFileSync(join(artifacts, 'branch-dot.json'), JSON.stringify(evidence, null, 2))
  return evidence
}
