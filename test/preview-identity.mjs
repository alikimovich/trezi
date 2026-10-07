// LKM-200: every preview observation (location, screenshot, DOM inspect, console) carries
// the same identity: preview session, navigation, document start and served revision.
// A document older than the live checkout is flagged stale; an observation the page
// navigated away from mid-read, or of another project's server, is refused.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewServers } from '../src/main/preview-evidence.ts'
import { installPreviewIdentity, liveHead } from '../src/main/preview-identity.ts'
import { previewLoads } from '../src/main/preview-loads.ts'
import { observeAgentPreview } from '../src/main/preview-observation-tools.ts'
import { PAGE_PROBE, previewShows } from '../src/main/preview-page.ts'
import { registerPreviewSource } from '../src/main/preview-state.ts'
import { projectKey } from '../src/shared/projectKey.ts'

const repo = mkdtempSync(join(tmpdir(), 'trezi-preview-identity-'))
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Trezi Test',
      '-c',
      'user.email=test@trezi.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args
    ],
    { cwd: repo, env, encoding: 'utf8' }
  ).trim()
const commit = (message) => {
  git('commit', '--allow-empty', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}

try {
  git('init', '-q')
  const first = commit('first')
  const origin = 'http://127.0.0.1:7801'
  let href = `${origin}/home`
  let startedAt = 1_760_000_000_000.4
  let ready = 'complete'
  let duringInspect = () => {}
  const evaluated = []
  registerPreviewSource({
    getUrl: () => href,
    capture: async () => null,
    captureAgent: async () => ({
      jpeg: Buffer.from('jpeg').toString('base64'),
      width: 1280,
      height: 800,
      snapshotMs: 20,
      encodeMs: 4
    }),
    agent: {
      evaluate: async (code) => {
        evaluated.push(code)
        if (code === PAGE_PROBE) return { href, startedAt, ready }
        if (code.includes('__treziAgentInspect')) {
          duringInspect()
          return { element: '<main>' }
        }
        if (code.includes('__treziAgentConsole')) return { total: 0, dropped: 0, entries: [] }
        return null
      },
      captureRect: async () => null,
      setViewport: async () => ({ width: null, zoom: 1 })
    }
  })
  previewServers.set(projectKey(repo), { url: `${origin}/`, pid: 1 })
  installPreviewIdentity()
  const navigate = (url) => {
    previewLoads.record({ type: 'start', url })
    previewLoads.record({ type: 'response', url, status: 200 })
    previewLoads.record({ type: 'loaded', url })
  }
  navigate(href)

  const observe = (action, args = {}) => observeAgentPreview(action, args, repo)
  const identityOf = (result) => {
    const block = result.content.at(-1).text
    assert.match(block, /^Preview identity: session ps-\d+, navigation \d+, /)
    return JSON.parse(block.split('\n').at(-1)).preview
  }

  // Location, screenshot, inspect and console describe one document, the same way.
  const answers = {}
  for (const action of [
    'preview_location',
    'preview_screenshot',
    'preview_inspect',
    'preview_console'
  ])
    answers[action] = await observe(
      action,
      action === 'preview_inspect' ? { selector: 'main' } : {}
    )
  const identity = identityOf(answers.preview_location)
  assert.match(identity.session, /^ps-\d+$/)
  assert.deepEqual(identity, {
    session: identity.session,
    navigation: previewLoads.navigation,
    documentStartedAt: new Date(1_760_000_000_000).toISOString(),
    servedRevision: first,
    liveRevision: first,
    stale: false
  })
  for (const [action, answer] of Object.entries(answers)) {
    assert.notEqual(answer.isError, true, action)
    assert.deepEqual(identityOf(answer), identity, `${action} carries the same identity`)
  }
  assert.equal(answers.preview_screenshot.content[0].type, 'image')
  assert.equal(answers.preview_screenshot.content[1].text, 'Screenshot: 1280×800 px JPEG.')

  // The live checkout moves on: the same document is flagged stale, with both revisions.
  const second = commit('second')
  await liveHead(repo, true)
  const stale = await observe('preview_location')
  assert.deepEqual(identityOf(stale), {
    ...identity,
    servedRevision: first,
    liveRevision: second,
    stale: true
  })
  assert.match(
    stale.content.at(-1).text,
    new RegExp(
      `Stale: this document loaded at ${first.slice(0, 10)} .* moved to ${second.slice(0, 10)}`
    )
  )
  // A new navigation serves the new revision and is a new navigation id.
  startedAt += 5000
  navigate(href)
  const fresh = identityOf(await observe('preview_inspect', { selector: 'main' }))
  assert.equal(fresh.navigation, identity.navigation + 1)
  assert.equal(fresh.servedRevision, second)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.session, identity.session, 'the same dev server is the same session')

  // The page navigates while an observation reads it: the answer is refused, not mixed.
  duringInspect = () => previewLoads.record({ type: 'start', url: `${origin}/other` })
  const mixed = await observe('preview_inspect', { selector: 'main' })
  duringInspect = () => {}
  assert.equal(mixed.isError, true)
  assert.equal(mixed.content.length, 1)
  assert.match(
    mixed.content[0].text,
    /navigated while preview_inspect ran .* Call preview_inspect again/
  )
  previewLoads.record({ type: 'loaded', url: `${origin}/other` })

  // A restarted dev server is a new preview session.
  previewServers.set(projectKey(repo), { url: `${origin}/`, pid: 2 })
  const restarted = identityOf(await observe('preview_location'))
  assert.notEqual(restarted.session, identity.session)

  // Another project's server in the preview: refused, naming both sessions.
  const other = '/fixture/identity-other'
  previewServers.set(projectKey(other), { url: 'http://127.0.0.1:7802/', pid: 3 })
  href = 'http://127.0.0.1:7802/'
  const foreign = await observe('preview_screenshot')
  assert.equal(foreign.isError, true)
  assert.equal(foreign.content.length, 1)
  assert.match(
    foreign.content[0].text,
    /\(port 7802, preview session ps-\d+\), not this project's dev server http:\/\/127\.0\.0\.1:7801 \(port 7801, preview session ps-\d+\)/
  )

  // open_preview's fast path: only a loaded page at exactly that URL, with no navigation running.
  href = `${origin}/home`
  assert.equal(await previewShows(`${origin}/home`), true)
  assert.equal(await previewShows(`${origin}/home#top`), false)
  assert.equal(await previewShows(`${origin}/about`), false)
  ready = 'interactive'
  assert.equal(await previewShows(`${origin}/home`), false, 'a page still loading is reloaded')
  ready = 'complete'
  previewLoads.record({ type: 'start', url: `${origin}/home` })
  const probes = evaluated.length
  assert.equal(await previewShows(`${origin}/home`), false, 'a navigation under way is not "shown"')
  assert.equal(evaluated.length, probes, 'nothing is read from a page that is navigating')
  previewLoads.record({ type: 'loaded', url: `${origin}/home` })
} finally {
  rmSync(repo, { recursive: true, force: true })
}

console.log(
  'PREVIEW-IDENTITY OK — one identity per observation, stale flag, mid-navigation and foreign-session refusals, already-loaded check'
)
