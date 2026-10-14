import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import type { NativeGitController } from './git-controller'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

/** Native presentation and action wiring; the owner integration fixture exercises Git. */
export async function checkGitUpdates(
  host: NativeBridge,
  git: NativeGitController,
  artifacts: string
) {
  const key = nativeWorkspace.active?.key
  assert.ok(key, 'Git updates needs an open disposable project')
  const originalInvoke = git.sheets.invoke
  const originalRefresh = git.refresh
  const originalEnvironment = nativeWorkspace.refreshEnvironment
  let changes = [
    {
      path: 'app.ts',
      state: ' M',
      eligible: true,
      preview: 'diff --git a/app.ts b/app.ts\n+new work'
    },
    {
      path: 'new.ts',
      state: '??',
      eligible: true,
      preview: 'diff --git a/new.ts b/new.ts\n+new file'
    }
  ]
  let commits = 0
  const status = () => ({
    current: 'trezi/main',
    remotes: ['origin'],
    upstream: 'refs/remotes/origin/main',
    localBranches: ['trezi/main'],
    branches: [
      { ref: 'refs/remotes/origin/main', remote: 'origin', branch: 'main', label: 'origin/main' }
    ],
    changes,
    changeToken: 'reviewed-tree'
  })
  Object.defineProperty(git.sheets, 'invoke', {
    configurable: true,
    value: async (channel: string, ...args: unknown[]) => {
      if (channel === 'git:remote-status') return status()
      if (channel === 'git:remote-update') {
        const action = args[1] as {
          action: string
          ref: string
          commit?: { message: string; changeToken: string }
        }
        assert.equal(action.action, 'pull')
        assert.equal(action.ref, 'refs/remotes/origin/main')
        assert.deepEqual(action.commit, {
          message: 'Keep reviewed work',
          changeToken: 'reviewed-tree'
        })
        commits++
        changes = []
        return {
          ok: true,
          files: ['app.ts', 'new.ts'],
          message: 'Pulled origin/main into trezi/main.'
        }
      }
      return originalInvoke(channel, ...args)
    }
  })
  git.refresh = async () => {}
  nativeWorkspace.refreshEnvironment = async () => {}
  const sheet = (title: string) =>
    waitFor(async () => {
      const value = await host.request('sheetInspect')
      return value.visible && value.title === title && !value.busy && value
    }, title)
  try {
    await git.updates(key)
    const initial = await sheet('Git updates')
    assert.match(initial.detail, /app\.ts/)
    assert.ok(initial.actions.includes('fetch'))
    await host.request('sheetPerform', {
      action: 'pull',
      values: { ref: 'refs/remotes/origin/main' }
    })
    const review = await sheet('Commit changes to continue')
    assert.match(review.detail, /Current branch: trezi\/main/)
    assert.match(review.detail, /Pull from: origin\/main/)
    assert.ok(review.fields.includes('review'))
    assert.ok(review.actions.includes('commit'))
    for (const width of [1320, 850]) {
      assert.ok(await host.request('shellPerform', { action: 'window-width', row: String(width) }))
      for (const appearance of ['light', 'dark']) {
        assert.ok(
          await host.request('shellPerform', { action: 'window-appearance', row: appearance })
        )
        assert.ok(await host.request('sheetAppearance', { appearance }))
        const foreground = await host.request('captureVisibleSheet')
        writeFileSync(
          join(artifacts, `git-updates-${width}-${appearance}.png`),
          Buffer.from(foreground.png, 'base64')
        )
        writeFileSync(
          join(artifacts, `git-updates-${width}-${appearance}.json`),
          JSON.stringify(await host.request('sheetInspect'), null, 2)
        )
      }
    }
    await host.request('sheetPerform', { action: 'cancel' })
    await waitFor(async () => !(await host.request('sheetInspect')).visible, 'Git updates cancel')
    assert.equal(commits, 0)
    await git.updates(key)
    await sheet('Git updates')
    await host.request('sheetPerform', {
      action: 'pull',
      values: { ref: 'refs/remotes/origin/main' }
    })
    await sheet('Commit changes to continue')
    await host.request('sheetPerform', {
      action: 'commit',
      values: { message: 'Keep reviewed work' }
    })
    await sheet('Git updates')
    assert.equal(commits, 1)
  } finally {
    Object.defineProperty(git.sheets, 'invoke', { configurable: true, value: originalInvoke })
    git.refresh = originalRefresh
    nativeWorkspace.refreshEnvironment = originalEnvironment
    await host.request('shellPerform', { action: 'window-appearance', row: '' })
    if ((await host.request('sheetInspect')).visible)
      await host.request('sheetAppearance', { appearance: '' })
    await host.request('shellPerform', { action: 'window-width', row: '1320' })
    if ((await host.request('sheetInspect')).visible)
      await host.request('sheetPerform', { action: 'cancel' })
  }
}
