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
assert(TREZI_RULES_VERSION === 36, 'version bumped to 36')
assert(/Never end with[\s\S]*"when this turn lands"/.test(r), 'forbids deferred landing reply')
assert(/"after Trezi lands"/.test(r), 'forbids deferred publish reply')
assert(/"click Publish again"/.test(r), 'forbids repeat Publish reply')
// LKM-199: a provider without a native question tool asks through ask_user, then waits;
// a choice that is not the user's proceeds with a stated default.
const asking = treziRules({ questionTool: true })
assert(/## Asking the user \(ask_user\)/.test(asking), 'ask_user: section present')
assert(/end your turn right after/.test(asking), 'ask_user: ends the turn to wait')
assert(/proceed with a stated\s+default/.test(asking), 'ask_user: stated default otherwise')
assert(!/ask_user/.test(r), 'ask_user: absent without the tool')
const bgAsking = treziRules({ questionTool: true, background: true })
assert(!/ask_user|AskUserQuestion/.test(bgAsking), 'ask_user: background agents never ask')
assert(/you cannot ask them a question/.test(bgAsking), 'ask_user: background told to choose')
// LKM-196: open_preview reports the real load; only a deferred open is "requested".
assert(/report exactly that/.test(treziRules({ previewTools: true })), 'open_preview result rule')
// LKM-197: stale CSS/JS → a hard reload, then a clean restart; never a self-started server.
assert(
  /reload_preview with hard: true[\s\S]*restart_dev_server with\s+cleanCache: true/.test(
    treziRules({ previewTools: true })
  ),
  'stale assets rule'
)
// LKM-195: no ownerless pending items; finish the step, name the user action, or a true
// automatic owner. Every provider gets these, with or without preview tools.
for (const rules of [r, treziRules({ previewTools: true }), treziRules({ background: true })]) {
  assert(/## No ownerless pending items/.test(rules), 'R-owner: section present')
  assert(
    /Never end a turn with an open item that has no owner/.test(rules),
    'R-owner: forbids ownerless pending items'
  )
  assert(/do it now with your tools/.test(rules), 'R-owner: do it now')
  assert(/a concrete user action/.test(rules), 'R-owner: concrete user action')
  assert(/land_now during the turn/.test(rules), 'R-owner: lands within the turn')
  assert(
    /Never ask the user to report back so you can\s+continue/.test(rules),
    'R-owner: no "tell me when it is there"'
  )
  // Releases: end to end with the Git/publish tools; questions only for real decisions.
  assert(/## Releases and version bumps/.test(rules), 'R-release: section present')
  assert(
    /finish it end to end with Trezi's Git and publish tools/.test(rules),
    'R-release: end-to-end completion'
  )
  assert(/publish_update for an existing/.test(rules), 'R-release: publishes with the tool')
  assert(/merge when the project's settings allow it/.test(rules), 'R-release: merges if allowed')
  assert(/tag the release\s+unless the project's workflow tags/.test(rules), 'R-release: tags')
  assert(
    /Ask only for real decisions: the version number when the request does not settle it,\s+or merge approval when the project's settings require it/.test(
      rules
    ),
    'R-release: asks only for the version or a required merge approval'
  )
  assert(/never "tell me when it's merged and I'll tag it"/.test(rules), 'R-release: no handoff')
  assert(!/report verification as pending/.test(rules), 'R-owner: no "pending" verification')
}
// The automatic post-landing check exists for chat turns only: background landings get none,
// so a claim that Trezi checks would leave their visual check with a false owner.
const AUTO_CHECK = /Trezi checks the preview by itself after a turn lands/
for (const rules of [r, treziRules({ previewTools: true })])
  assert(
    AUTO_CHECK.test(rules) &&
      /a screenshot and console errors\)\s+and posts the result/.test(rules),
    'R-owner: the post-landing check owns a visual check that waits for landing'
  )
for (const rules of [
  treziRules({ background: true }),
  treziRules({ background: true, previewTools: true }),
  treziRules({ background: true, previewObservationTools: true })
]) {
  assert(!AUTO_CHECK.test(rules), 'R-owner: background agents are not promised the check')
  assert(!/Trezi checks the preview after landing/.test(rules), 'R-owner: no automatic claim')
  assert(!/posts the result in this chat/.test(rules), 'R-owner: no chat row promised')
  assert(
    /Trezi does not check the preview after a background agent lands/.test(rules) &&
      /Open the preview and check the Home tab/.test(rules),
    'R-owner: background agents name the user action for a visual check'
  )
}
assert(
  /Do not call it pending either: Trezi does not check after a background agent lands/.test(
    treziRules({ background: true, previewTools: true })
  ),
  'R-owner: background preview verification names a user action'
)
assert(
  /Do not call it pending either: Trezi does not check after a background agent lands/.test(
    treziRules({ background: true })
  ),
  'R-owner: background browser verification names a user action'
)
// LKM-193: background agents ask only for the user's own choices, else default and say so.
assert(!/## Background agents/.test(r), 'R-bg: interactive chats get no background section')
const bg = treziRules({ background: true })
assert(/## Background agents/.test(bg), 'R-bg: background section present')
assert(/only when a choice is truly the user's/.test(bg), 'R-bg: ask only for real choices')
assert(/reasonable default/.test(bg) && /name each choice/.test(bg), 'R-bg: default and report')
assert(r.includes(`v${TREZI_RULES_VERSION}`), 'rules carry the version marker')
assert(/closing a turn/i.test(r), 'closing-a-turn rule present')
assert(
  /do not announce that the preview will reload/i.test(r),
  'agent must not announce preview reloads'
)
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
  for (const tool of [
    'preview_inspect',
    'preview_evaluate',
    'preview_console',
    'preview_viewport',
    'preview_speed'
  ])
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
    /never report verification as passed/.test(rules),
    'preview tools: stale previews cannot prove an edit'
  )
  // LKM-195: a change already in the preview is checked with preview_screenshot in the turn.
  assert(
    /already in the preview during the turn, you MUST check it with\s+`preview_screenshot` before finishing/.test(
      rules
    ),
    'preview tools: screenshot a change that lands within the turn'
  )
  assert(
    /Do not call it pending either: Trezi\s+checks the preview after landing/.test(rules),
    'preview tools: a landing check is not pending'
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
    /never report verification as passed/.test(rules),
    'browser: stale previews cannot prove an edit'
  )
  assert(
    /Do not call it\s+pending either: Trezi checks the preview after landing/.test(rules),
    'browser: a landing check is not pending'
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
  // LKM-201: readiness and preview identity first, only the relevant code, define early.
  assert(
    /first call chat_island action:catalog and check its readiness;\s+when ready is false, follow its recovery and stop/.test(
      rules
    ),
    'R-islands: catalog readiness first'
  )
  assert(/check the preview identity/.test(rules), 'R-islands: preview identity first')
  assert(
    /Inspect only the code that computes the requested values/.test(rules),
    'R-islands: inspect only the relevant code'
  )
  assert(
    /define the island early, before\s+editing source: action:define with planned:true/.test(rules),
    'R-islands: define a planned island before editing source'
  )
  assert(
    /planned binding resolves; otherwise the island shows the reason with Recreate/.test(rules),
    'R-islands: pending island activates or shows why with Recreate'
  )
}
assert(
  /\(1\) call catalog and check readiness.*\(2\).*preview identity.*\(3\) Inspect only the code.*\(4\) Define the island early, before editing source: define with planned:true/.test(
    chatIslandGuidance
  ),
  'Catalog guidance orders readiness, preview identity, focused inspection, early planned define'
)
assert(
  !/Define controls before long checks/.test(chatIslandGuidance),
  'The old late-define hint is replaced'
)
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
