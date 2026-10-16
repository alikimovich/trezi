import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  setWorkflowOwner,
  type WorkflowOwner,
  type WorkflowSummary,
  workflowOwner
} from '../main/workflow-owner'
import type { PublishResult } from '../shared/api'
import type { BranchStatus } from '../shared/native-shell'
import type { NativeBridge } from './bridge'
import type { NativeGitController } from './git-controller'
import { checkBranchDot } from './smoke-branch-dot'
import { capture } from './smoke-toolbar'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>

/**
 * LKM-187: Publish shows progress. The workflow owner is stubbed (no Git, no GitHub):
 * it reports the steps the Swift owner reports, and the test advances them. The
 * button turns into a spinner and "Publishing…" at once, follows each step (with the
 * elapsed time after 3 s), offers Cancel only before the pull request, and ends in a
 * toast (success, cancel) or the standard failure sheet. The toast's "View on GitHub"
 * is never pressed, so no browser opens.
 */
export async function checkPublishProgress(
  host: NativeBridge,
  git: NativeGitController,
  artifacts: string
) {
  const root = nativeWorkspace.active?.root
  assert.ok(root, 'Publish progress needs an open project')
  const real = workflowOwner()
  let record: WorkflowSummary | null = null,
    settle: ((result: PublishResult) => void) | null = null,
    cancels = 0
  const step = (name: string, ago = 0) => {
    assert.ok(record, `No publish to move to ${name}`)
    record.step = name
    record.stepSince = new Date(Date.now() - ago).toISOString()
  }
  const finish = (result: PublishResult, state: string) => {
    assert.ok(record && settle, 'No publish to finish')
    record.state = state
    record.result = { ...result }
    delete record.step
    delete record.stepSince
    settle(result)
  }
  const stub: WorkflowOwner = Object.assign(Object.create(real), {
    publish: (target: string) => {
      const now = new Date().toISOString()
      record = {
        id: `smoke-publish-${Date.now()}`,
        kind: 'publish',
        root: target,
        params: {},
        state: 'running',
        steps: [],
        result: null,
        started: now,
        updated: now
      }
      return new Promise<PublishResult>((resolve) => {
        settle = resolve
      })
    },
    workflows: async () => (record ? [record] : []),
    cancel: async () => {
      cancels++
      return true
    }
  })
  const status = git.githubStatus
  const until = (check: (s: State) => boolean, label: string, timeout = 5000) =>
    waitFor(
      async () => {
        const state = await host.request('shellInspect')
        return check(state) && state
      },
      label,
      timeout,
      async () => {
        const s = await host.request('shellInspect')
        return {
          label: s.publishLabel,
          spinning: s.publishSpinning,
          enabled: s.publishEnabled,
          menu: s.publishMenu
        }
      },
      20
    )
  const label = (text: string) => (s: State) => s.publishLabel === text
  const evidence: Record<string, unknown> = {}
  const invoke = git.sheets.invoke
  // The controller's own status poll (activation refresh, publish end) would replace the
  // synthetic branch status with the disposable repo's real one mid-check. While the fixture
  // pins a status, the poll reads that same status back.
  // A real refresh would also clear the synthetic status and reset the toolbar's branch
  // from the disposable repo; the fixture owns the status, so none runs while it does.
  const refresh = git.refresh
  git.refresh = async () => {}
  let pinned: BranchStatus | undefined
  const polled = new WeakSet<object>()
  const setStatus = git.statuses.set
  git.statuses.set = (key, value) => {
    if (key === root && !polled.has(value)) pinned = value
    return setStatus.call(git.statuses, key, value)
  }
  // A poll already in flight when the fixture starts fails against the disposable repo and
  // would clear the status it pinned; no controller path may clear a status the fixture owns.
  const deleteStatus = git.statuses.delete
  git.statuses.delete = (key) =>
    key === root && pinned ? false : deleteStatus.call(git.statuses, key)
  Object.defineProperty(git.sheets, 'invoke', {
    configurable: true,
    value: async (channel: string, ...args: unknown[]) => {
      if (channel === 'github:prepublish') return { warnings: [] }
      if (channel !== 'github:branch-status') return invoke(channel, ...args)
      const result = pinned ? { ...pinned } : await invoke(channel, ...args)
      polled.add(result)
      return result
    }
  })
  setWorkflowOwner(stub)
  git.githubStatus = async () => ({
    connected: true,
    gh: 'ok',
    suggestedName: 'folder-alpha',
    remoteUrl: 'https://github.com/example/folder-alpha.git'
  })
  try {
    // Earlier checks leave refreshes and status polls in flight. Let them settle first: one
    // that finished after the sample below would replace it with the repo's real status.
    const pending = git as unknown as {
      statusFlights: Set<string>
      refreshingStatus: Map<string, number>
    }
    await waitFor(
      () => !pending.statusFlights.has(root) && !pending.refreshingStatus.has(root),
      'Git status polls settled',
      15000
    )
    const priorStatus = git.statuses.get(root)
    const sample = {
      base: 'main',
      ahead: 2,
      behind: 0,
      unpushed: 2,
      upstream: 'origin/trezi/main',
      unpublished: true,
      dirty: false,
      sync: '2 ahead · 0 behind main',
      ci: 'running' as const,
      failing: [] as string[]
    }
    git.statuses.set(root, sample)
    git.render()
    const branchStatus = await until(
      (s) => String(s.branchDisplay).includes('2↑') && s.branchDotState === 'running',
      'Branch sync and running CI'
    )
    assert.ok(
      branchStatus.addressVisible && branchStatus.addressTrailing < branchStatus.rightGroupLeading,
      'Branch status stays inside the toolbar'
    )
    assert.ok(
      branchStatus.branchBusy && branchStatus.branchProgressNative,
      'Running CI uses the native spinner'
    )
    assert.match(branchStatus.branchAccessibilityValue, /^Busy: /)
    for (const width of [1320, 850]) {
      assert.ok(await host.request('shellPerform', { action: 'window-width', row: String(width) }))
      for (const appearance of ['light', 'dark']) {
        assert.ok(
          await host.request('shellPerform', { action: 'window-appearance', row: appearance })
        )
        // The width and appearance actions return before the deferred toolbar layout:
        // wait for the requested width, the running status and two identical spinner frames.
        let previous = ''
        const view = await waitFor(
          async () => {
            const current = await host.request('shellInspect')
            const frame = `${current.windowWidth}|${current.branchProgressFrame}|${current.branchFrameWidth}`
            const settled =
              Math.abs(Number(current.windowWidth) - width) < 1 &&
              current.branchBusy &&
              frame === previous
            previous = frame
            return settled ? current : null
          },
          `Settled running spinner at ${width} in ${appearance}`,
          5000,
          async () => {
            const s = await host.request('shellInspect')
            return {
              windowWidth: s.windowWidth,
              branchBusy: s.branchBusy,
              branchProgressFits: s.branchProgressFits,
              branchProgressFrame: s.branchProgressFrame,
              branchFrameWidth: s.branchFrameWidth,
              branchDisplay: s.branchDisplay
            }
          }
        )
        const geometry = {
          width,
          appearance,
          windowWidth: view.windowWidth,
          branchProgressFrame: view.branchProgressFrame,
          branchFrameWidth: view.branchFrameWidth,
          branchDisplay: view.branchDisplay
        }
        assert.ok(
          view.branchBusy,
          `Spinner active at ${width} in ${appearance}: ${JSON.stringify(geometry)}`
        )
        assert.ok(
          view.branchProgressFits,
          `Spinner fits at ${width} in ${appearance}: ${JSON.stringify(geometry)}`
        )
        assert.equal(view.branchTruncation, 'tail')
        assert.ok(
          view.branchChevronTrailing <= view.branchFrameLeading + view.branchFrameWidth + 0.5
        )
        writeFileSync(
          join(artifacts, `branch-status-${width}-${appearance}.json`),
          JSON.stringify(view, null, 2)
        )
        await capture(host, artifacts, `branch-status-running-${width}-${appearance}`)
      }
    }
    await host.request('shellPerform', { action: 'window-appearance', row: '' })
    await host.request('shellPerform', { action: 'window-width', row: '1320' })
    const statusCase = async (
      name: string,
      patch: Partial<BranchStatus>,
      includes: string[],
      excludes: string[]
    ) => {
      git.statuses.set(root, { ...sample, ...patch })
      git.render()
      const view = await waitFor(async () => {
        const current = await host.request('shellInspect')
        const display = String(current.branchDisplay)
        return includes.every((fragment) => display.includes(fragment)) &&
          excludes.every((fragment) => !display.includes(fragment))
          ? current
          : null
      }, `${name} toolbar status`)
      for (const fragment of includes)
        assert.ok(String(view.branchDisplay).includes(fragment), `${name}: ${fragment}`)
      for (const fragment of excludes)
        assert.ok(!String(view.branchDisplay).includes(fragment), `${name}: no ${fragment}`)
      const state = { ...sample, ...patch }
      const details = (
        view.branchDetails as { title: string; enabled: boolean; action: string }[]
      ).filter((item) => item.title)
      const titles = details.map((item) => item.title).join('\n')
      const content = state.stale
        ? 'Fetched default branch is stale'
        : state.dirty
          ? 'Working tree edited'
          : state.unpublished
            ? 'Content to publish'
            : 'No content to publish'
      assert.ok(titles.includes(content), `${name}: ${content} in details`)
      assert.ok(
        titles.includes(`${state.unpushed} commits ahead of ${state.upstream}`),
        `${name}: upstream count in details`
      )
      assert.ok(
        titles.includes(`History: ${state.ahead} ahead · ${state.behind} behind ${state.base}`),
        `${name}: history in details`
      )
      if (state.pr) assert.ok(titles.includes(`PR #${state.pr.number} ${state.pr.state}`))
      if (state.ci !== 'unknown') assert.ok(titles.includes(`CI ${state.ci}`))
      if (state.deployment) assert.ok(titles.includes(`Deployment ${state.deployment.state}`))
      assert.ok(view.addressTrailing < view.rightGroupLeading, `${name}: status fits toolbar`)
    }
    await statusCase(
      'squash-merged',
      {
        ahead: 42,
        unpushed: 0,
        unpublished: false,
        pr: { number: 126, state: 'merged', url: 'https://github.com/o/r/pull/126' },
        ci: 'passed',
        deployment: {
          state: 'failed',
          revision: 'base-sha',
          url: 'https://github.com/o/r/deployments/1'
        }
      },
      ['✓', '#126', 'Deploy failed'],
      ['42↑', 'Changes']
    )
    for (const width of [1320, 850]) {
      assert.ok(await host.request('shellPerform', { action: 'window-width', row: String(width) }))
      for (const appearance of ['light', 'dark']) {
        assert.ok(
          await host.request('shellPerform', { action: 'window-appearance', row: appearance })
        )
        const view = await host.request('shellInspect')
        assert.ok(view.addressTrailing < view.rightGroupLeading)
        assert.ok(view.branchProgressFits)
        writeFileSync(
          join(artifacts, `branch-status-merged-${width}-${appearance}.json`),
          JSON.stringify(view, null, 2)
        )
        await capture(host, artifacts, `branch-status-merged-${width}-${appearance}`)
      }
    }
    await host.request('shellPerform', { action: 'window-appearance', row: '' })
    await host.request('shellPerform', { action: 'window-width', row: '1320' })
    await statusCase(
      'new-content',
      { ahead: 42, unpushed: 0, unpublished: true, ci: 'running', pr: undefined },
      ['Changes'],
      ['42↑', '#126']
    )
    await statusCase(
      'stale-base',
      { stale: true, ahead: 0, behind: 3, unpushed: 0, unpublished: true },
      ['Refs stale', '3↓'],
      ['Changes']
    )
    await statusCase(
      'behind-only',
      { ahead: 0, behind: 3, unpushed: 0, unpublished: false, dirty: false },
      ['3↓'],
      ['Changes']
    )
    await statusCase(
      'deployment-pending',
      { ci: 'passed', deployment: { state: 'pending', revision: 'base-sha' } },
      ['Deploy pending'],
      ['Deploy failed']
    )
    assert.equal((await host.request('shellInspect')).branchBusy, true)
    await statusCase(
      'unpushed',
      { ahead: 42, unpushed: 2, unpublished: true, ci: 'passed' },
      ['2↑', 'Changes'],
      ['42↑']
    )
    await statusCase(
      'dirty',
      { dirty: true, unpublished: true, unpushed: 0, ci: 'none' },
      ['Edited'],
      ['↑']
    )
    await statusCase(
      'open-pr',
      { pr: { number: 127, state: 'open', url: 'https://github.com/o/r/pull/127' }, ci: 'passed' },
      ['#127'],
      ['#126']
    )
    await statusCase(
      'closed-pr',
      {
        pr: { number: 128, state: 'closed', url: 'https://github.com/o/r/pull/128' },
        ci: 'failed',
        failing: ['build']
      },
      ['#128'],
      ['#127']
    )
    await statusCase(
      'ci-error',
      { ci: 'error', checksUrl: undefined, failing: [] },
      ['Changes'],
      ['#126']
    )
    const ciError = (await host.request('shellInspect')).branchDetails as {
      title: string
      enabled: boolean
    }[]
    assert.ok(ciError.some((row) => row.title === 'CI error' && !row.enabled))
    git.statuses.set(root, sample)
    git.render()
    const dot = await checkBranchDot(host, git, root, sample, artifacts)
    // The Publish label's width can move the whole address block; the dot keeps its
    // frame inside the branch control and its centre line.
    const { local: dotFrame, baseline: dotBaseline } = dot[1320] as {
      local: string
      baseline: number
    }
    git.statuses.set(root, { ...sample, ci: 'passed' })
    git.render()
    await until(
      (s) => s.branchDotState === 'passed' && s.branchDotFilled && !s.branchBusy,
      'Passed CI stops the spinner'
    )
    await capture(host, artifacts, 'branch-status-passed')
    git.statuses.set(root, { ...sample, ci: 'failed', failing: ['build', 'lint'] })
    git.render()
    const failed = await until(
      (s) => String(s.branchAccessibilityValue).includes('●2') && s.branchDotState === 'failed',
      'Failed CI'
    )
    assert.equal(failed.branchBusy, false, 'Failed CI stops the spinner')
    assert.ok(!failed.branchTruncated, 'CI dot and failure count remain visible in toolbar')
    assert.ok(failed.branchTitleWidth <= failed.branchTitleRoom + 0.5, 'Branch title fits control')
    await capture(host, artifacts, 'branch-status-failed')
    pinned = undefined
    if (priorStatus) setStatus.call(git.statuses, root, priorStatus)
    else deleteStatus.call(git.statuses, root)
    git.render()
    await until(label('Publish'), 'Publish is idle')
    // Immediate feedback: the label and spinner before the owner reports anything.
    const clicked = Date.now()
    assert.ok(await host.request('shellPerform', { action: 'publish' }), 'Publish clicks')
    const started = await until(
      (s) =>
        s.publishing &&
        s.publishSpinning &&
        /^(Publishing…|Checking project…|Committing…)$/.test(s.publishLabel),
      'The button shows progress at once'
    )
    evidence.feedbackMs = Date.now() - clicked
    assert.ok(
      (evidence.feedbackMs as number) < 1000,
      `Progress showed ${evidence.feedbackMs} ms after the click`
    )
    assert.equal(started.publishClickable, false, 'A second click cannot publish again')
    assert.equal(
      await host.request('shellPerform', { action: 'publish' }),
      false,
      'Publish is not clickable while it runs'
    )
    await waitFor(() => record, 'the owner was asked to publish')
    step('commit')
    await until(label('Committing…'), 'Committing step')
    step('sync')
    await until(label('Syncing with GitHub…'), 'Syncing step')
    step('push')
    const pushing = await until(label('Pushing…'), 'Pushing step')
    const branchPush = await until(
      (s) => s.branchBusy && String(s.branchDisplay).includes('push'),
      'Branch publish spinner'
    )
    assert.ok(branchPush.branchProgressNative && !/[↗→]/.test(String(branchPush.branchDisplay)))
    assert.match(branchPush.branchAccessibilityValue, /^Busy: /)
    assert.equal(
      branchPush.branchDotLocalFrame,
      dotFrame,
      'A publish step keeps the CI dot in place'
    )
    assert.equal(branchPush.branchDotBaseline, dotBaseline, 'A publish step keeps the dot centred')
    assert.deepEqual(branchPush.branchDotDiameter, [7, 7])
    assert.ok(pushing.publishEnabled, 'The menu opens while the step can be cancelled')
    assert.deepEqual(pushing.publishMenu, ['Pushing…', 'Cancel Publish'])
    evidence.pushing = await capture(host, artifacts, 'publish-progress')
    // A step that has run for more than 3 s shows its elapsed time.
    step('describe', 4200)
    const slow = await until(
      (s) => /^Writing description… [4-9]s$/.test(s.publishLabel),
      'Elapsed time after 3 s'
    )
    evidence.slowLabel = slow.publishLabel
    step('pr')
    const pr = await until(label('Creating pull request…'), 'Creating pull request step')
    assert.ok(pr.publishSpinning && !pr.publishClickable, 'Still publishing, still not clickable')
    assert.deepEqual(pr.publishMenu, ['Creating pull request…'], 'No cancel once the PR is created')
    assert.equal(
      await host.request('shellPerform', { action: 'publish-cancel' }),
      false,
      'Cancel is refused once the PR is being created'
    )
    step('merge')
    await until(label('Merging…'), 'Merging step')
    step('cleanup')
    await until(label('Cleaning up…'), 'Cleaning up step')
    finish(
      { ok: true, branch: 'trezi/smoke', url: 'https://github.com/example/folder-alpha/pull/5' },
      'done'
    )
    const toast = await waitFor(async () => {
      const state = await host.request('toastInspect')
      return state.visible && state.message === 'Published — PR #5 merged' && state
    }, 'Success toast')
    assert.equal(toast.action, 'View on GitHub')
    assert.ok(toast.inWindow && toast.pending, 'The toast is in the window and dismisses itself')
    await new Promise((resolve) => setTimeout(resolve, 300))
    writeFileSync(
      join(artifacts, 'publish-toast.png'),
      Buffer.from(await host.request('captureToast'), 'base64')
    )
    const idle = await until(
      (s) => !s.publishing && s.publishLabel === 'Publish' && !s.publishSpinning,
      'The button returns to normal after success'
    )
    assert.ok(idle.publishClickable && idle.publishMenu.includes('Create PR'))
    assert.equal(idle.branchBusy, false, 'Successful publish stops the subtitle spinner')
    assert.equal(idle.branchDotLocalFrame, dotFrame, 'The CI dot stays put after the spinner stops')
    assert.equal(
      idle.branchDotBaseline,
      dotBaseline,
      'The dot stays centred after the spinner stops'
    )

    // Cancel while pushing: the owner is asked, and the run ends in a short toast.
    assert.ok(await host.request('shellPerform', { action: 'publish' }))
    await waitFor(() => record?.state === 'running' && !record.result, 'second publish')
    step('push')
    await until(label('Pushing…'), 'Pushing before cancel')
    assert.ok(await host.request('shellPerform', { action: 'publish-cancel' }), 'Cancel Publish')
    await until(label('Cancelling…'), 'Cancelling label')
    await waitFor(() => cancels === 1, 'the owner was asked to cancel')
    finish(
      { ok: false, cancelled: true, error: 'Cancelled; nothing further was changed.' },
      'cancelled'
    )
    await waitFor(async () => {
      const state = await host.request('toastInspect')
      return state.visible && state.message === 'Publish cancelled'
    }, 'Cancelled toast')
    await until((s) => !s.publishing && !s.branchBusy, 'Cancel stops the subtitle spinner')

    // Failure: the standard sheet names the step and the conflicting file.
    assert.ok(await host.request('shellPerform', { action: 'publish' }))
    await waitFor(() => record?.state === 'running' && !record.result, 'third publish')
    step('push')
    await until(label('Pushing…'), 'Pushing before the failure')
    finish(
      {
        ok: false,
        error: 'Your changes and the remote changes edit the same lines.',
        conflictFiles: ['index.html'],
        recoveryRefs: ['refs/trezi/recovery/trezi/smoke/1-local'],
        step: 'push'
      },
      'failed'
    )
    const sheet = await waitFor(async () => {
      const state = await host.request('sheetInspect')
      return state.visible && state.title === 'Couldn’t publish' && !state.busy && state
    }, 'Failure sheet')
    assert.ok(sheet.alert && sheet.attached, 'The failure is a sheet on the main window')
    assert.deepEqual(sheet.actions, ['copy', 'cancel', 'retry'])
    assert.equal(sheet.defaultAction, 'retry', 'Return retries')
    assert.equal(sheet.cancelAction, 'cancel', 'Esc closes')
    assert.match(sheet.detail, /Stopped at: Pushing/)
    assert.match(sheet.detail, /index\.html/)
    await new Promise((resolve) => setTimeout(resolve, 300))
    writeFileSync(
      join(artifacts, 'publish-failure.png'),
      Buffer.from(await host.request('captureSheet'), 'base64')
    )
    await until(
      (s) => !s.publishing && !s.branchBusy && s.publishLabel === 'Publish',
      'Failure stops the subtitle spinner'
    )
    await host.request('sheetPerform', { action: 'cancel' })
    await waitFor(async () => !(await host.request('sheetInspect')).visible, 'Failure sheet closed')
    console.log('Native publish progress', JSON.stringify(evidence))
  } finally {
    Object.defineProperty(git.sheets, 'invoke', { configurable: true, value: invoke })
    git.statuses.set = setStatus
    git.statuses.delete = deleteStatus
    git.refresh = refresh
    setWorkflowOwner(real)
    git.githubStatus = status
    // A failed assertion mid-run: end the stubbed publish so the button returns to normal.
    const open = record as WorkflowSummary | null
    if (open?.state === 'running')
      finish({ ok: false, cancelled: true, error: 'Smoke cleanup' }, 'cancelled')
  }
}
