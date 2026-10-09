/**
 * SessionStore unit test: the on-disk store for agent-session history (v5-D) with
 * its writes going through the real Swift conversation owner (the only writer since
 * LKM-111): save/list/get/remove, per-project filtering, newest-first sort, the
 * per-project prune cap, the current slot, and defensive id validation.
 *
 * Run with: bun run test:sessionstore
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setConversationOwner, swiftConversationOwner } from '../src/main/conversation-owner.ts'
import { createSessionStore } from '../src/main/sessions-store.ts'
import { serviceProfile } from './helpers/with-service-owners.mjs'

const base = join(serviceProfile, 'trezi')
let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

const rec = (id, projectKey, startedAt, extra = {}) => ({
  id,
  projectKey,
  projectRoot: projectKey,
  projectName: 'app',
  startedAt,
  endedAt: startedAt + 10,
  filesTouched: [],
  transcript: [{ role: 'user', text: 'hi', at: startedAt }],
  ...extra
})

try {
  const store = createSessionStore(base)

  // Empty store lists nothing.
  ok(store.list('/p/a').length === 0, 'empty list before any save')
  ok(store.get('nope') === null, 'get of missing id is null')

  // Save + get round-trips, before and after the owner acknowledges it.
  store.save(rec('s1', '/p/a', 100, { branch: 'trezi/x', filesTouched: ['src/A.tsx'] }))
  ok(store.get('s1')?.branch === 'trezi/x', 'an unacknowledged save reads back')
  await store.flush()
  const got = store.get('s1')
  ok(got && got.branch === 'trezi/x', 'get returns saved record with branch')
  ok(got && got.filesTouched[0] === 'src/A.tsx', 'filesTouched persisted')

  // Per-project filtering + newest-first ordering.
  store.save(rec('s2', '/p/a', 300))
  store.save(rec('s3', '/p/a', 200))
  store.save(rec('s4', '/p/b', 999))
  await store.flush()
  const a = store.list('/p/a')
  ok(a.length === 3, 'list filters to project a (3)')
  ok(a[0].id === 's2' && a[1].id === 's3' && a[2].id === 's1', 'list sorts newest startedAt first')
  ok(store.list('/p/b').length === 1, 'project b isolated')

  // Remove.
  store.remove('s1')
  ok(store.get('s1') === null, 'an unacknowledged remove reads as gone')
  await store.flush()
  ok(store.get('s1') === null, 'removed record is gone')
  ok(store.list('/p/a').length === 2, 'list reflects removal')

  // Prune cap: 50 per project — saving the 60th leaves the 50 most recent.
  for (let i = 0; i < 60; i++) store.save(rec(`c${i}`, '/p/c', 1000 + i))
  await store.flush()
  const c = store.list('/p/c')
  ok(c.length === 50, `prune keeps 50 (got ${c.length})`)
  ok(c[0].id === 'c59', 'newest survives prune')
  ok(!c.some((r) => r.id === 'c0'), 'oldest pruned away')

  // The last-active chat is not History: saveCurrent replaces the prior current
  // slot, and prune never drops it.
  store.saveCurrent(rec('m1', '/p/m', 1))
  await store.flush()
  store.saveCurrent(rec('m2', '/p/m', 2))
  ok(store.get('m1') === null, 'a new current chat replaces the previous one at once')
  await store.flush()
  ok(store.get('m1') === null, 'a new current chat replaces the previous one')
  const current = store.current('/p/m')
  ok(
    current && current.id === 'm2' && current.slot === 'current',
    'current returns the active slot'
  )
  for (let i = 0; i < 60; i++) store.save(rec(`h${i}`, '/p/m', 3000 + i))
  await store.flush()
  ok(store.get('m2') && store.get('m2').slot === 'current', 'prune never drops current')
  ok(
    store.list('/p/m').filter((r) => r.slot !== 'current' && r.slot !== 'main').length === 50,
    'history still caps at 50'
  )

  // A record from an older version (the `main` slot, written before the service)
  // still reads as current, and saving current replaces it.
  mkdirSync(join(base, 'sessions'), { recursive: true })
  writeFileSync(
    join(base, 'sessions/legacy-main.json'),
    JSON.stringify(rec('legacy-main', '/p/legacy', 1, { slot: 'main' }))
  )
  ok(store.current('/p/legacy')?.id === 'legacy-main', 'legacy Main slot migrates as current')
  store.saveCurrent(rec('legacy-current', '/p/legacy', 2))
  await store.flush()
  ok(store.get('legacy-main') === null, 'saving current replaces a legacy Main slot')

  // A corrupt record is skipped, not fatal.
  writeFileSync(join(base, 'sessions/broken.json'), '{nope')
  ok(store.list('/p/a').length === 2, 'a corrupt record is skipped')

  // LKM-120: a title that came from an error is renamed to the neutral one on load.
  writeFileSync(
    join(base, 'sessions/err-title.json'),
    JSON.stringify(rec('err-title', '/p/titles', 5, { title: 'Not logged in · Please run /login' }))
  )
  writeFileSync(
    join(base, 'sessions/real-title.json'),
    JSON.stringify(rec('real-title', '/p/titles', 6, { title: 'Make Header Sticky' }))
  )
  const titled = store.list('/p/titles')
  ok(titled.length === 2, `a renamed record is listed once (${titled.length})`)
  ok(
    titled.find((r) => r.id === 'err-title')?.title === 'New chat',
    'an error title lists as New chat'
  )
  ok(
    titled.find((r) => r.id === 'real-title')?.title === 'Make Header Sticky',
    'a real title is kept'
  )
  await store.flush()
  const onDisk = JSON.parse(readFileSync(join(base, 'sessions/err-title.json'), 'utf8'))
  ok(onDisk.title === 'New chat', `the neutral title is saved through the owner (${onDisk.title})`)
  writeFileSync(
    join(base, 'sessions/err-get.json'),
    JSON.stringify(rec('err-get', '/p/titles', 7, { title: 'Invalid API key · Please run /login' }))
  )
  ok(store.get('err-get')?.title === 'New chat', 'get renames an error title too')
  await store.flush()

  // Unsafe ids are rejected on save and ignored on get/remove (id → filename).
  let threw = false
  try {
    store.save(rec('../escape', '/p/a', 1))
  } catch {
    threw = true
  }
  ok(threw, 'save rejects path-traversal id')
  ok(store.get('../escape') === null, 'get of unsafe id is null')

  // With no service there is no writer: writes throw, reads still work.
  const owner = swiftConversationOwner()
  setConversationOwner(null)
  let refused = ''
  try {
    store.save(rec('s9', '/p/a', 9))
  } catch (err) {
    refused = err.message
  }
  setConversationOwner(owner)
  ok(/service is not running/.test(refused), `a write with no service throws (${refused})`)
  ok(store.list('/p/a').length === 2, 'reads need no service')

  if (failed === 0) {
    console.log(
      'SESSIONS-STORE OK — owner-backed save/list/get/remove, per-project, sort, prune cap, current slot, id guard'
    )
  } else {
    process.exitCode = 1
  }
} catch (err) {
  console.error('SESSIONS-STORE FAILED:', err?.message ?? err)
  process.exitCode = 1
}
