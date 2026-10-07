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
import type { NativeBridge } from './bridge'
import type { NativeGitController } from './git-controller'
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
  setWorkflowOwner(stub)
  git.githubStatus = async () => ({
    connected: true,
    gh: 'ok',
    suggestedName: 'folder-alpha',
    remoteUrl: 'https://github.com/example/folder-alpha.git'
  })
  try {
    await until(label('Publish'), 'Publish is idle')
    // Immediate feedback: the label and spinner before the owner reports anything.
    const clicked = Date.now()
    assert.ok(await host.request('shellPerform', { action: 'publish' }), 'Publish clicks')
    const started = await until(
      (s) =>
        s.publishing && s.publishSpinning && /^(Publishing…|Committing…)$/.test(s.publishLabel),
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
    await until((s) => !s.publishing, 'The button returns to normal after cancel')

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
    await until((s) => !s.publishing && s.publishLabel === 'Publish', 'Idle after the failure')
    await host.request('sheetPerform', { action: 'cancel' })
    await waitFor(async () => !(await host.request('sheetInspect')).visible, 'Failure sheet closed')
    console.log('Native publish progress', JSON.stringify(evidence))
  } finally {
    setWorkflowOwner(real)
    git.githubStatus = status
    // A failed assertion mid-run: end the stubbed publish so the button returns to normal.
    const open = record as WorkflowSummary | null
    if (open?.state === 'running')
      finish({ ok: false, cancelled: true, error: 'Smoke cleanup' }, 'cancelled')
  }
}
