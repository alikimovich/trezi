import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatesWatch } from '../src/native/states-watch.ts'

// Drive the unchanged 400 ms poll deterministically: an edit before the first poll must
// compare against registration, not become an asynchronous watchFile initial baseline.
const originalSet = globalThis.setInterval
const originalClear = globalThis.clearInterval
const timers = []
globalThis.setInterval = (tick, interval) => {
  assert.equal(interval, 400)
  const timer = {
    tick,
    cleared: false,
    unreferenced: false,
    unref() {
      this.unreferenced = true
    }
  }
  timers.push(timer)
  return timer
}
globalThis.clearInterval = (timer) => {
  if (timer) timer.cleared = true
}
const root = mkdtempSync(join(tmpdir(), 'states-watch-'))
const file = join(root, 'input.ts')
const watcher = new StatesWatch()
try {
  writeFileSync(file, 'before')
  const changes = []
  watcher.watch([file], (path) => changes.push(path))
  const first = timers.at(-1)
  assert.equal(first.unreferenced, true, 'polling must not keep a closed app alive')
  appendFileSync(file, 'after')
  first.tick()
  assert.deepEqual(changes, [file], 'an immediate edit is observed on the first poll')
  first.tick()
  assert.deepEqual(changes, [file], 'unchanged input does not trigger duplicate rebuilds')
  rmSync(file)
  first.tick()
  writeFileSync(file, 'recreated')
  first.tick()
  assert.equal(changes.length, 3, 'deletion and recreation both trigger updates')
  watcher.watch([file], (path) => {
    changes.push(path)
    watcher.close()
  })
  assert.equal(first.cleared, true, 'replacing inputs cancels the old poll')
  appendFileSync(file, 'new')
  first.tick()
  assert.equal(changes.length, 3, 'a stale queued poll cannot report changes')
  const second = timers.at(-1)
  second.tick()
  assert.equal(changes.length, 4, 'reopened input still reports edits')
  assert.equal(second.cleared, true, 'a change callback may close its own watcher')
  second.tick()
  assert.equal(changes.length, 4)
  watcher.watch([], () => assert.fail('empty inputs cannot change'))
  assert.equal(timers.length, 2, 'empty inputs allocate no timer')
  const files = Array.from({ length: 201 }, (_, index) => join(root, `${index}.ts`))
  for (const path of files) writeFileSync(path, 'before')
  const bounded = []
  watcher.watch(files, (path) => bounded.push(path))
  appendFileSync(files[200], 'outside the bound')
  timers.at(-1).tick()
  assert.deepEqual(bounded, [], 'the 201st input is not polled')
  appendFileSync(files[0], 'inside the bound')
  timers.at(-1).tick()
  assert.deepEqual(bounded, [files[0]])
} finally {
  watcher.close()
  globalThis.setInterval = originalSet
  globalThis.clearInterval = originalClear
  rmSync(root, { recursive: true, force: true })
}
console.log('states-watch: immediate edit, stable input, deletion, recreation and lifecycle PASS')
