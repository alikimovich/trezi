// LKM-202: the Dreamer's deterministic digest over fixture sessions and product-log
// lines (a slow tool, a repeated failure, a repeated request, corrections), its
// redaction, the version 1 proposal format, and a run with a stub model and with each
// fallback. No provider, no files: every input is in memory.
import assert from 'node:assert/strict'
import {
  createDreamer,
  digestProposals,
  dreamerPrompt,
  parseDreamerAnswer,
  sanitizeProposal
} from '../src/main/dreamer.ts'
import {
  buildDigest,
  dreamerRedact,
  parseLogLine,
  promptPattern,
  quote,
  toolName
} from '../src/main/dreamer-digest.ts'
import { formatLogLine } from '../src/main/product-log.ts'
import {
  DREAMER_LIMITS,
  dreamerErrors,
  dreamerMarkdown,
  dreamerTaskIds,
  normalizeProposal,
  uniqueIds
} from '../src/shared/dreamer.ts'

const HOME = '/Users/tester'
const DAY = 24 * 60 * 60_000
const NOW = Date.parse('2026-10-07T12:00:00.000Z')
const SECRET = 'sk-abcdefghijklmnopqrstuvwx'

let at = NOW - 3 * DAY
const tick = (ms = 1000) => (at += ms)
const user = (text, ms) => {
  const start = tick()
  return { role: 'user', text, at: start, ...(ms ? { completedAt: start + ms } : {}) }
}
const reply = (text) => ({ role: 'assistant', text, at: tick() })
const session = (id, projectKey, projectName, transcript) => ({
  id,
  projectKey,
  projectRoot: `${HOME}/dev/${projectName}`,
  projectName,
  startedAt: transcript[0].at,
  endedAt: null,
  filesTouched: [],
  transcript
})

const alpha = session('s-alpha', 'k-alpha', 'Alpha', [
  user(`Add a dark mode toggle to ${HOME}/dev/Alpha/src/App.tsx`, 60_000),
  reply('Done.'),
  user('run the tests and fix failures', 300_000),
  reply('Two tests still fail.'),
  user('run the tests and fix failures', 200_000),
  reply('Fixed one.'),
  user('No, that is wrong: you forgot the header', 90_000),
  reply("I can't open that file from here.")
])
const beta = session('s-beta', 'k-beta', 'Beta', [
  user('run the tests and fix failures', 30_000),
  reply('API Error: 500 the server had an error'),
  user(`mail the result to jane.doe@example.com with key ${SECRET}`, 400_000),
  reply('Sent.')
])
at = NOW - 30 * DAY
const old = session('s-old', 'k-alpha', 'Alpha', [user('an old request', 5000), reply('ok')])
const sessions = [old, beta, alpha]

const line = (offset, level, area, message, fields) =>
  formatLogLine({ at: NOW - offset, level, process: 'backend', area, message, fields }, HOME)
const logLines = [
  line(DAY, 'debug', 'tool', 'Tool step', {
    chat: 's-alpha',
    turn: 't1',
    tool: 'Bash',
    ms: 40_000
  }),
  line(DAY, 'debug', 'tool', 'Tool step', {
    chat: 's-alpha',
    turn: 't1',
    tool: 'Bash',
    ms: 50_000
  }),
  line(DAY, 'debug', 'tool', 'Tool step', { chat: 's-beta', turn: 't2', tool: 'Bash', ms: 30_000 }),
  line(DAY, 'debug', 'tool', 'Tool step', { chat: 's-alpha', turn: 't1', tool: 'Read', ms: 200 }),
  line(DAY, 'debug', 'tool', 'Tool step', { chat: 's-beta', tool: 'IslandPreview', ms: 120 }),
  line(DAY, 'error', 'landing', 'Landing failed; work held on the chat branch', {
    chat: 's-alpha',
    error: `merge failed in ${HOME}/dev/Alpha`
  }),
  line(DAY, 'error', 'landing', 'Landing failed; work held on the chat branch', {
    chat: 's-alpha'
  }),
  line(DAY, 'error', 'landing', 'Landing failed; work held on the chat branch', { chat: 's-beta' }),
  line(DAY, 'info', 'landing', 'Landing', { chat: 's-alpha', outcome: 'landed', files: 2 }),
  line(DAY, 'info', 'landing', 'Landing', { chat: 's-beta', outcome: 'parked', files: 1 }),
  line(DAY, 'info', 'parking', 'Parked work applied', { chat: 's-alpha' }),
  line(DAY, 'info', 'parking', 'Parked work discarded', { chat: 's-beta' }),
  line(DAY, 'info', 'git', 'Merge conflict resolved', { chat: 's-beta' }),
  line(DAY, 'info', 'feedback', 'Feedback posted'),
  // Outside the 14-day window, and not a log line at all.
  line(20 * DAY, 'error', 'landing', 'Landing failed; work held on the chat branch', {
    chat: 's-alpha'
  }),
  'not a log line'
]

// --- parsing helpers ---
{
  const parsed = parseLogLine(
    line(0, 'debug', 'tool', 'Tool step', { chat: 'c1', turn: 't9', tool: 'Bash', ms: 12 })
  )
  assert.equal(parsed.area, 'tool')
  assert.equal(parsed.chat, 'c1')
  assert.equal(parsed.turn, 't9')
  assert.equal(parsed.message, 'Tool step')
  assert.deepEqual(parsed.fields, { tool: 'Bash', ms: '12' })
  assert.equal(parseLogLine('garbage'), null)
  assert.equal(toolName('$ bun test'), 'Bash')
  assert.equal(toolName('Read · src/a.ts'), 'Read')
  assert.equal(toolName('mcp__trezi__island_open · x'), 'island_open')
  assert.equal(toolName('Thinking'), null)
  assert.equal(promptPattern('Fix the bug in src/a.ts line 12'), 'fix the bug in path line')
  assert.equal(promptPattern('ok'), '')
  const redacted = dreamerRedact(`mail jane@example.com ${SECRET} at /Users/someone/x`, HOME)
  assert.doesNotMatch(redacted, /jane@|sk-abc|someone/)
  assert.ok(quote('x'.repeat(500), HOME).length <= 160)
  console.log('dreamer-digest: parsing and redaction PASS')
}

// --- the digest ---
const digest = buildDigest({ sessions, logLines, now: NOW, days: 14, project: null, home: HOME })
{
  assert.deepEqual(
    digest,
    buildDigest({
      sessions: [...sessions].reverse(),
      logLines,
      now: NOW,
      days: 14,
      project: null,
      home: HOME
    }),
    'the digest is deterministic'
  )
  assert.equal(digest.totals.sessions, 2, 'the 30-day-old chat is outside the window')
  assert.equal(digest.totals.turns, 6)
  assert.equal(digest.totals.timedTurns, 6)
  assert.deepEqual(digest.slowTurns[0], {
    session: 's-beta',
    turn: 2,
    quote: 'mail the result to [email] with key [redacted]',
    ms: 400_000
  })
  assert.equal(digest.slowTurns[1].ms, 300_000)
  // Slow tool.
  assert.equal(digest.tools[0].tool, 'Bash')
  assert.equal(digest.tools[0].count, 3)
  assert.equal(digest.tools[0].totalMs, 120_000)
  assert.equal(digest.tools[0].maxMs, 50_000)
  assert.equal(digest.totals.toolSteps, 5)
  assert.equal(digest.totals.islandSteps, 1)
  // Repeated failure (the 20-day-old line is not counted).
  const landing = digest.failures.find((f) => f.message.startsWith('landing:'))
  assert.equal(landing.count, 3)
  assert.deepEqual(landing.sessions.sort(), ['s-alpha', 's-beta'])
  assert.equal(landing.example, 'merge failed in ~/dev/Alpha')
  assert.ok(digest.failures.some((f) => f.kind === 'refusal'))
  assert.ok(digest.failures.some((f) => f.kind === 'error-reply'))
  assert.equal(digest.totals.refusals, 1)
  // Repeated request and corrections.
  assert.deepEqual(
    digest.retries.map((r) => [r.session, r.turn, r.reason]),
    [
      ['s-alpha', 3, 'repeat'],
      ['s-alpha', 4, 'correction']
    ]
  )
  assert.equal(digest.patterns[0].pattern, 'run the tests and fix failures')
  assert.equal(digest.patterns[0].count, 3)
  assert.equal(digest.patterns[0].sessions, 2)
  // Landings, parks, conflicts, feedback.
  assert.deepEqual(digest.landings, { landed: 1, parked: 1 })
  assert.deepEqual(digest.parks, { 'Parked work applied': 1, 'Parked work discarded': 1 })
  assert.equal(digest.conflicts, 1)
  assert.equal(digest.totals.feedback, 1)
  // Nothing private leaves the digest.
  const text = JSON.stringify(digest)
  assert.doesNotMatch(text, /jane\.doe|example\.com|sk-abc|\/Users\/tester/)
  // One project: its chats and only the log lines about them.
  const one = buildDigest({ sessions, logLines, now: NOW, days: 14, project: 'k-beta', home: HOME })
  assert.equal(one.totals.sessions, 1)
  assert.equal(one.totals.turns, 2)
  assert.deepEqual(
    one.tools.map((t) => [t.tool, t.count]),
    [
      ['Bash', 1],
      ['IslandPreview', 1]
    ]
  )
  assert.equal(one.totals.feedback, 0, 'app-wide lines stay out of a project run')
  console.log('dreamer-digest: digest PASS')
}

// --- version 1 format ---
const valid = (proposals) => ({ version: 1, generatedAt: new Date(NOW).toISOString(), proposals })
{
  const fromDigest = digestProposals(digest)
  assert.deepEqual(
    fromDigest.map((p) => p.id),
    ['speed-bash', 'repeated-failure', 'repeated-corrections', 'request-template', 'landing-parks']
  )
  assert.deepEqual(dreamerErrors(valid(fromDigest)), [])
  assert.deepEqual(dreamerErrors(null), ['The file is not a JSON object.'])
  assert.ok(dreamerErrors({ ...valid(fromDigest), version: 2 }).includes('version must be 1'))
  assert.ok(dreamerErrors(valid([])).includes('proposals must be a non-empty list'))
  const bad = { ...fromDigest[0], category: 'feature', effort: 'XL', acceptance: 'one' }
  bad.evidence = [{ turn: 0, quote: 'q'.repeat(DREAMER_LIMITS.quote + 1), numbers: { n: 'x' } }]
  const errors = dreamerErrors(valid([bad, { ...fromDigest[1], id: bad.id }, 'nope']))
  for (const expected of [
    /category must be one of/,
    /effort must be S, M or L/,
    /acceptance must be a list of strings/,
    /evidence\[0\]\.turn must be a positive whole number/,
    /evidence\[0\]\.quote must be a string of at most 200/,
    /evidence\[0\]\.numbers must map names to numbers/,
    /proposals\[1\]\.id speed-bash is not unique/,
    /proposals\[2\] must be an object/
  ])
    assert.ok(
      errors.some((e) => expected.test(e)),
      `${expected} in ${errors.join('; ')}`
    )
  assert.ok(
    dreamerErrors(valid([{ ...fromDigest[0], title: 't'.repeat(201) }])).some((e) =>
      /title is longer than 200/.test(e)
    )
  )

  const normal = normalizeProposal(
    {
      id: 'Fix it now!',
      title: '  Fix it  ',
      category: 'feature',
      effort: 's',
      acceptance: 'one\n\ntwo',
      evidence: [{ session: 's-alpha', turn: '2', numbers: { a: 1, b: 'x' } }, 'junk', {}],
      extra: 'dropped'
    },
    0
  )
  assert.deepEqual(normal, {
    id: 'Fix-it-now-',
    title: 'Fix it',
    category: 'improvement',
    problem: '',
    evidence: [{ session: 's-alpha', turn: 2, numbers: { a: 1 } }],
    proposal: '',
    impact: '',
    effort: 'S',
    acceptance: ['one', 'two'],
    areas: []
  })
  assert.equal(normalizeProposal({ title: ' ' }, 0), null)
  assert.equal(normalizeProposal({ title: 'x' }, 4).id, 'p5')
  assert.deepEqual(
    uniqueIds([normal, normal, normal]).map((p) => p.id),
    ['Fix-it-now-', 'Fix-it-now--2', 'Fix-it-now--3']
  )
  assert.deepEqual(dreamerErrors(valid([normal])), [])

  const markdown = dreamerMarkdown({ ...valid(fromDigest), summary: 'What stood out.' })
  assert.match(markdown, /^# Dreamer report/)
  assert.match(markdown, /### Speed up Bash steps/)
  assert.match(markdown, /- \[ \] /)
  assert.deepEqual(
    dreamerTaskIds({ created: [{ proposal: 'a', issue: 'AOS-1' }, { issue: 'AOS-2' }] }),
    ['AOS-1', 'AOS-2']
  )
  assert.deepEqual(dreamerTaskIds({ tasks: [{ id: 'T-1' }], taskIds: ['T-2', 'T-1'] }), [
    'T-1',
    'T-2'
  ])
  assert.deepEqual(dreamerTaskIds('nope'), [])
  console.log('dreamer-digest: version 1 format PASS')
}

// --- the model's answer ---
{
  const answer = {
    summary: `Tests are retried often; ask jane.doe@example.com.`,
    proposals: [
      {
        id: 'test-loop',
        title: 'Run tests once per turn',
        category: 'speed',
        problem: `The test loop in ${HOME}/dev/Alpha repeats.`,
        evidence: [
          { session: 's-alpha', turn: 3, quote: 'run the tests and fix failures' },
          { session: 'invented', turn: 9, quote: `token ${SECRET}` }
        ],
        proposal: 'Cache results.',
        impact: 'Shorter turns.',
        effort: 'M',
        acceptance: ['One test run per turn.'],
        areas: ['tools']
      },
      { title: '' }
    ]
  }
  const fenced = parseDreamerAnswer(`Here you go:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``)
  assert.equal(fenced.proposals.length, 1)
  assert.equal(fenced.summary, answer.summary)
  assert.equal(parseDreamerAnswer(JSON.stringify(answer.proposals)).proposals.length, 1)
  assert.equal(parseDreamerAnswer(`Sure. ${JSON.stringify(answer)} Done.`).proposals.length, 1)
  assert.equal(parseDreamerAnswer('no json here'), null)
  assert.equal(parseDreamerAnswer('{"proposals": []}'), null)
  const clean = sanitizeProposal(fenced.proposals[0], new Set(['s-alpha']), HOME)
  assert.equal(clean.problem, 'The test loop in ~/dev/Alpha repeats.')
  assert.deepEqual(clean.evidence[0], {
    session: 's-alpha',
    turn: 3,
    quote: 'run the tests and fix failures'
  })
  assert.deepEqual(clean.evidence[1], { quote: 'token [redacted]' }, 'unknown sessions dropped')

  // A run with a stub model.
  let prompt = ''
  const dreamer = createDreamer({
    sessions: () => sessions,
    completion: () => ({
      label: 'stub · model',
      complete: async (text) => {
        prompt = text
        return `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``
      }
    }),
    logLines: () => logLines,
    now: () => NOW,
    home: HOME
  })
  const [all, beta14] = dreamer.estimates([
    { project: null, days: 14 },
    { project: 'k-beta', days: 14 }
  ])
  assert.equal(all.sessions, 2)
  assert.equal(all.model, 'stub · model')
  assert.ok(all.tokens > beta14.tokens && beta14.tokens > 4000)
  const run = await dreamer.run({ project: null, days: 14 })
  assert.equal(prompt, dreamerPrompt(digest), 'the model gets the digest and nothing else')
  assert.doesNotMatch(prompt, /jane\.doe|sk-abc|\/Users\/tester/)
  assert.equal(run.fallback, undefined)
  assert.equal(run.model, 'stub · model')
  assert.deepEqual(
    run.file.proposals.map((p) => p.id),
    ['test-loop']
  )
  assert.match(run.file.summary, /\[email\]/)
  assert.match(run.file.summary, /Looked at 2 chats, 6 turns/)
  assert.deepEqual(dreamerErrors(run.file), [])

  // Fallbacks: an unusable answer, a failing model, no model, an empty range.
  const fallback = async (completion, scope = { project: null, days: 14 }) =>
    createDreamer({
      sessions: () => sessions,
      completion: () => completion,
      logLines: () => logLines,
      now: () => NOW,
      home: HOME
    }).run(scope)
  const prose = await fallback({ label: 'x', complete: async () => 'I have no proposals.' })
  assert.match(prose.fallback, /no valid proposals/)
  assert.deepEqual(
    prose.file.proposals.map((p) => p.id),
    digestProposals(digest).map((p) => p.id)
  )
  assert.match(prose.file.summary, /These proposals come from the digest alone/)
  const failing = await fallback({
    label: 'x',
    complete: async () => {
      throw new Error('offline')
    }
  })
  assert.match(failing.fallback, /could not be reached \(offline\)/)
  assert.ok(failing.file.proposals.length)
  const none = await fallback(null)
  assert.match(none.fallback, /cannot run a one-shot completion/)
  assert.equal(none.model, null)
  const empty = await fallback(null, { project: 'k-nothing', days: 7 })
  assert.match(empty.fallback, /No chat turns/)
  assert.deepEqual(empty.file.proposals, [])
  // Cancelling the run is not a fallback.
  const stop = new AbortController()
  stop.abort()
  await assert.rejects(
    createDreamer({
      sessions: () => sessions,
      completion: () => ({
        label: 'x',
        complete: async (_prompt, signal) => {
          signal.throwIfAborted()
          return null
        }
      }),
      logLines: () => logLines,
      now: () => NOW,
      home: HOME
    }).run({ project: null, days: 14 }, stop.signal)
  )
  console.log('dreamer-digest: run and fallbacks PASS')
}
console.log('DREAMER DIGEST OK')
