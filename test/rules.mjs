/**
 * trezi agent rules (v9 R) — pure unit test of the rules builder. Runs under bun
 * (no electron), like project-key/xcode/git.
 *
 * Run with: bun test/rules.mjs
 */

import { TREZI_RULES_VERSION, treziRules } from '../src/main/rules.ts'
import { chatIslandGuidance } from '../src/shared/chat-island-guidance.ts'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

const r = treziRules()
assert(typeof r === 'string' && r.length > 0, 'rules render to a non-empty string')
assert(typeof TREZI_RULES_VERSION === 'number', 'version is a number')
assert(TREZI_RULES_VERSION === 28, 'version bumped to 28')
assert(r.includes(`v${TREZI_RULES_VERSION}`), 'rules carry the version marker')
assert(r.includes('before scaffolding or'), 'new projects ask about unresolved setup choices')
assert(r.includes('after these files successfully land'), 'environment refresh follows landing')
// v3 naming — the product is Trezi in the rule text now.
assert(/trezi/i.test(r), 'names the product Trezi')
assert(!/\bdsgn operating rules\b/i.test(r), 'no stale "dsgn operating rules" header')
// v3 context — designer pointing at UI, selections carry data-trezi-source, hot-reload.
assert(/data-trezi-source/.test(r), 'context mentions the data-trezi-source stamp')
assert(/hot-reload/i.test(r), 'context mentions instant hot-reload')
// R1 — scope of an element edit.
assert(/scope of an element edit/i.test(r), 'R1: scope-of-edit heading present')
assert(/\blocal\b/i.test(r) && /project-wide/i.test(r), 'R1: local vs project-wide distinction')
assert(/search first|grep/i.test(r), 'R1: search-first guidance')
assert(/report/i.test(r), 'R1: report-what-changed guidance')
// LKM-188: Managed uses Trezi Git tools; Full can make chat-worktree commits.
assert(/git and pull requests/i.test(r), 'R-git: heading present')
assert(/trezi\/chat-/.test(r), 'R-git: names the chat worktree branch scheme')
assert(/git_sync_base/.test(r) && /git_merge_continue/.test(r), 'R-git: teaches conflict tools')
assert(
  /Never reset or otherwise rewrite the live checkout/.test(r),
  'R-git: protects live checkout'
)
assert(/read-only git is allowed/.test(r), 'R-git: read-only git allowed')
const fullGit = treziRules({ agentGitAccess: 'full' })
assert(/may commit, merge, rebase/.test(fullGit), 'R-git: Full permits raw worktree Git')
assert(
  /Never rewrite or delete commits already landed/.test(fullGit),
  'R-git: Full protects landed commits'
)
// R2: browser inspection → agent-browser, never Chrome DevTools unless asked.
assert(/agent-browser/i.test(r), 'R2: directs the agent to agent-browser')
assert(
  /devtools/i.test(r) && /unless the user explicitly asks/i.test(r),
  'R2: no DevTools unless asked'
)
// Deterministic (same output every call — safe to inject per turn).
assert(treziRules() === r, 'treziRules is deterministic')

const withMemory = treziRules({ projectMemory: '- Use trezi/master as integration.' })
assert(/project memory/i.test(withMemory), 'memory: durable context section present')
assert(/Use trezi\/master as integration/.test(withMemory), 'memory: saved decision injected')
assert(!/<project-memory>/.test(r), 'memory: empty default adds no section')
// LKM-177: memory never stands in for the requested change, with or without memory.
assert(/## Project memory is not work/.test(r), 'memory: not-work section is always present')
assert(
  /Never report a requested change as "saved in\s+memory"/.test(r),
  'memory: forbids reporting a change as saved in memory'
)
assert(/never applies a\s+change/.test(r), 'memory: saving to memory applies nothing')
assert(
  !treziRules({ projectMemory: '- Answer briefly. <!-- added 2026-10-06 -->' }).includes(
    'added 2026-10-06'
  ),
  'memory: source tags stay out of chat context'
)

// R3 — preview tools appear only when a provider opts into observation.
// Generic/Gemini prompts do not advertise them.
const withTools = treziRules({ previewTools: true })
assert(/preview_location/.test(withTools), 'previewTools: mentions preview_location')
assert(/preview_screenshot/.test(withTools), 'previewTools: mentions preview_screenshot')
assert(/seeing the user's preview/i.test(withTools), 'previewTools: has the preview section')
assert(!/preview_location/.test(r), 'default rendering omits preview_location')
assert(!/preview_screenshot/.test(r), 'default rendering omits preview_screenshot')
assert(treziRules({ previewTools: true }) === withTools, 'previewTools rendering is deterministic')
// LKM-138: with preview tools, verification happens in the Trezi preview and
// agent-browser is reserved for scripted multi-step interactions.
const codexObservers = treziRules({
  previewObservationTools: true,
  controlTools: true,
  workspaceTools: true
})
for (const rules of [withTools, codexObservers]) {
  for (const tool of ['preview_inspect', 'preview_evaluate', 'preview_console', 'preview_viewport'])
    assert(rules.includes(tool), `preview tools: teaches ${tool}`)
  assert(
    /MUST use Trezi's preview tools/.test(rules),
    'preview tools: required for visual verification'
  )
  assert(
    /only for scripted multi-step interactions/.test(rules),
    'preview tools: agent-browser only for scripted flows'
  )
  assert(
    /never just to inspect, evaluate, or screenshot/.test(rules),
    'preview tools: no agent-browser screenshots'
  )
  assert(!/MUST use `agent-browser`/.test(rules), 'preview tools: agent-browser is not mandatory')
  assert(/--session trezi-<task-id>/.test(rules), 'preview tools: isolated agent-browser sessions')
  assert(
    /report verification as pending, never passed/.test(rules),
    'preview tools: stale previews cannot prove an edit'
  )
  assert(/untrusted data/.test(rules), 'preview tools: console output is untrusted')
  assert(
    /devtools/i.test(rules) && /user request for another tool overrides/.test(rules),
    'preview tools: no DevTools unless asked'
  )
}
assert(!/preview_inspect/.test(r), 'default rendering omits preview_inspect')
// Without preview tools (Gemini), agent-browser verification stays mandatory.
for (const opts of [{}, { workspaceTools: true }]) {
  const rules = treziRules(opts)
  assert(/MUST use `agent-browser` when available/.test(rules), 'browser: required when available')
  assert(/command -v agent-browser/.test(rules), 'browser: check the runtime PATH')
  assert(/agent-browser --help/.test(rules), 'browser: inspect installed CLI capabilities')
  assert(
    /CLI is missing, or its browser cannot launch/.test(rules),
    'browser: missing binary and launch failure'
  )
  assert(
    /Do not install packages without the user's permission/.test(rules),
    'browser: no silent installation'
  )
  assert(/--session trezi-<task-id>/.test(rules), 'browser: isolated task sessions')
  assert(/Close only your own session/.test(rules), 'browser: preserve other sessions')
  for (const size of ['390 844', '768 1024', '1440 900']) {
    assert(rules.includes(`set viewport ${size}`), `browser: responsive coverage at ${size}`)
  }
  assert(
    /capture and inspect a screenshot at each size/.test(rules),
    'browser: require visual inspection'
  )
  assert(
    /report verification as pending, never passed/.test(rules),
    'browser: stale previews cannot prove an edit'
  )
  assert(
    /user request for another tool overrides/.test(rules),
    'browser: explicit user choice wins'
  )
}
// Chat controls have one destination and no competing panel tool.
assert(/chat_island/.test(withTools), 'previewTools: teaches chat islands')
assert(/const STAGGER_MS = /.test(withTools), 'previewTools: shows literal anchor shape')
assert(/\.trezi\//.test(withTools), 'previewTools: forbids sidecar writes')
assert(!/chat_island/.test(r), 'unsupported providers omit island tool')
const codexControls = treziRules({ controlTools: true })
for (const rules of [withTools, codexControls]) {
  assert(
    rules.includes(chatIslandGuidance),
    'Every control-capable provider gets the catalog guidance'
  )
  assert(
    !/define_controls|open_controls|animation-controls/.test(rules),
    'No legacy panel instructions'
  )
  assert(
    /Never substitute a separate panel/.test(rules),
    'Chat is the required control destination'
  )
}
assert(!/spring_to_css/.test(codexControls), 'Codex does not advertise Claude-only calculators')
// R5 (spring) — spring_to_css rides with the Claude-only in-process tools too.
assert(/spring_to_css/.test(withTools), 'previewTools: teaches spring_to_css')
assert(/prefers-reduced-motion/.test(withTools), 'previewTools: spring reduced-motion guidance')
assert(!/spring_to_css/.test(r), 'default rendering omits spring_to_css')
// R6 (accessible colors) — check_contrast rides with the Claude-only in-process tools.
assert(/check_contrast/.test(withTools), 'previewTools: teaches check_contrast')
assert(/APCA/.test(withTools), 'previewTools: mentions APCA')
assert(!/check_contrast/.test(r), 'default rendering omits check_contrast')
// R7 (design-system calculators) — fluid/color/shadow tools ride with previewTools too.
assert(/fluid_clamp/.test(withTools), 'previewTools: teaches fluid_clamp')
assert(/color_scale/.test(withTools), 'previewTools: teaches color_scale')
assert(/layered_shadow/.test(withTools), 'previewTools: teaches layered_shadow')
assert(!/fluid_clamp/.test(r), 'default rendering omits fluid_clamp')
// R8a (line-height) — size-aware line_height calculator rides with previewTools.
// v9: promoted to its own trigger-first section ("Whenever you write or change
// text styles…") — the buried calculator bullet never made the agent reach for it
// (caught by test/tool-invocation.mjs).
assert(/line_height/.test(withTools), 'previewTools: teaches line_height')
assert(
  /type metrics \(line_height\)/i.test(withTools),
  'previewTools: line_height has its own section'
)
assert(
  /whenever you write or change text styles/i.test(withTools),
  'previewTools: line_height trigger-first phrasing'
)
assert(!/line_height/.test(r), 'default rendering omits line_height')
// R8b (skills install) — offer-to-install skill packs rides with previewTools too.
assert(/list_recommended_skills/.test(withTools), 'previewTools: teaches list_recommended_skills')
assert(/install_skills/.test(withTools), 'previewTools: teaches install_skills')
assert(!/install_skills/.test(r), 'default rendering omits install_skills')

// R9 (Codex Trezi control) — workspace tools appear only for a backend that
// actually wires the local MCP server. The generic/Gemini prompt must not claim
// tools it cannot call.
const withWorkspaceTools = treziRules({ workspaceTools: true })
assert(/workspace_state/.test(withWorkspaceTools), 'workspaceTools: teaches authoritative status')
assert(
  /prepare_conflict_resolution/.test(withWorkspaceTools),
  'workspaceTools: teaches safe conflict preparation'
)
assert(
  /do not tell the user to open a terminal/i.test(withWorkspaceTools),
  'workspaceTools: forbids terminal handoff'
)
assert(!/workspace_state/.test(r), 'default rendering omits workspace_state')

const codexPreview = treziRules({ previewObservationTools: true, controlTools: true })
assert(
  codexPreview.includes('preview_location') && codexPreview.includes('preview_screenshot'),
  'Codex learns both preview observers'
)
assert(
  !codexPreview.includes('spring_to_css'),
  'preview observation does not advertise unavailable calculators'
)

if (failed) {
  console.error(`RULES FAILED — ${failed} assertion(s)`)
  process.exit(1)
}
console.log(
  `RULES OK — v${TREZI_RULES_VERSION} builder, Trezi naming, R1 scope + preview-tools gating, deterministic`
)
