// Tier membership: the one list of registered tests. `test/run.mjs` runs it and
// `test/helpers/test-plan.mjs` selects from it (docs/TESTING.md).

// Backend logic checks run independently of the native desktop.
export const UNIT = [
  'service-contract',
  'service-process',
  'operation-ledger',
  'preferences-owner',
  'workspace-owner',
  'memory-owner',
  'skills-registry',
  'skills-registry-boundaries',
  'skills-registry-safety',
  'skills-github',
  'skills-github-import',
  'settings-skills',
  'skills-projection',
  'session-skills',
  'runtime-owner',
  'repository-owner',
  'agent-git',
  'agent-merge-approval',
  'git-messages',
  'repository-recovery',
  'source-owner',
  'conversation-owner',
  'provider-owner',
  'provider-data',
  'provider-login',
  'provider-feedback-code',
  'provider-sign-in',
  'provider-cold-start',
  'turn-progress',
  'provider-helper-tools',
  'service-session',
  'native-settings-claude',
  'gemini-provider',
  'editing-owner',
  'workflow-owner',
  'workflow-durability',
  'live-publish-attribution',
  'branch-safety',
  'platform-owner',
  'native-visible-capture',
  'native-smoke-runner',
  'native-smoke-report',
  'rename-compat',
  'source-stamp',
  'native-boundary',
  'trezi-agent-tools',
  'preview-agent-tools',
  'agent-browser',
  'agent-runtime-isolation',
  'source-tree',
  'integration-gate',
  'managed-agent-browser',
  'managed-browser-path',
  'managed-browser-provider',
  'browser-setup',
  'browser-setup-recovery',
  'browser-tools-install',
  'agent-interact',
  'browser-verify',
  'browser-verify-bounds',
  'preview-slow-motion',
  'codex-mcp',
  'codex-mcp-approvals',
  'claude-resume',
  'claude-cwd',
  'codex-model',
  'self-heal',
  'self-heal-recovery',
  'native-bridge-close',
  'native-service-launch',
  'native-supervised-bridge',
  'native-preview-recovery',
  'native-workspace-controller',
  'chat-new-instant',
  'smoke-timing',
  'send-path-timing',
  'chat-frames',
  'preview-supervisor',
  'native-support',
  'activity-attention',
  'quit-guard',
  'display-path',
  'native-sheets',
  'native-settings',
  'native-settings-layout',
  'native-settings-evidence',
  'native-chat-controller',
  'chat-start',
  'project-planning',
  'native-long-chat-perf',
  'preview-hover-coalesce',
  'preview-native-cover',
  'preview-hover-drop',
  'preview-edit-lifecycle',
  'chat-attachments',
  'stop-recovery-ui',
  'chat-stuck-turn',
  'chat-send-queue',
  'composer-queue-panel',
  'composer-attach',
  'composer-sent-draft',
  'composer-sending',
  'chat-auto-resolve',
  'live-write-guard',
  'agent-file-access',
  'live-change-watch',
  'project-path',
  'text-edit-agent',
  'network-volume-note',
  'native-composer-layout',
  'native-chat-latest-settle',
  'native-chat-bottom-marker',
  'native-chat-send-follow',
  'native-chat-parallel-stream',
  'native-smoke-wait',
  'native-smoke-shared-chat',
  'native-smoke-stop-cleanup',
  'native-chat-reveal',
  'native-chat-text',
  'native-diff-list',
  'native-changes-fixture',
  'native-island-editing',
  'no-system-preferences',
  'chat-islands',
  'chat-island-status',
  'chat-island-new-chat',
  'chat-island-pending',
  'island-flicker',
  'island-override',
  'dependency-refresh-vite',
  'native-context',
  'native-updates',
  'native-inspector',
  'style-class-rule',
  'style-pair',
  'native-slider-ticks',
  'native-layers',
  'native-editor',
  'native-shell-controller',
  'sidebar-recent-chats',
  'sidebar-chats-accessibility',
  'sidebar-history-rows',
  'sidebar-project-actions',
  'sidebar-shimmer',
  'sidebar-evidence',
  'sidebar-sizing',
  'toolbar-chat-lead',
  'preview-overlay',
  'key-shortcuts',
  'menu-first-shortcuts',
  'agent-load-routing',
  'sidebar-icon',
  'sidebar-favicon',
  'sidebar-focus',
  'native-git',
  'publish-progress',
  'branch-status',
  'dependency-issue',
  'dependency-audit',
  'native-support-sheets',
  'native-cat-assets',
  'project-ui',
  'project-ui-svelte',
  'project-ui-jev',
  'docgen-browserslist',
  'jev-pilot',
  'test-runner',
  'test-selection',
  'swift-build-lock',
  'setup-stamps',
  'setup-vite',
  'setup-vite-real',
  'code-reveal',
  'code-navigation',
  'code-links',
  'branch-diff',
  'preview-open',
  'preview-refresh',
  'editor-freshness',
  'preview-page',
  'preview-identity',
  'turn-timing',
  'syntax-highlight',
  'syntax-bundle',
  'conversation-handoff',
  'pr-body',
  'feedback-body',
  'feedback-endpoint',
  'feedback-diagnostics',
  'build-status',
  'product-log',
  'dreamer-digest',
  'dreamer-export',
  'publish-message',
  'publish-description',
  'commit-message',
  'slash-token',
  'skills-discovery',
  'provider-skills',
  'three-d-contract',
  'github-connect',
  'html-source',
  'project-key',
  'project-create',
  'environment-changes',
  'project-icon',
  'devserver-net',
  'sidecar-migrate',
  'legacy-names-migrate',
  'legacy-names-audit',
  'diag-cache',
  'diag-rules',
  'sessions-store',
  'preferred-model',
  'project-memory',
  'annotation-store',
  'setup-next',
  'shadow-controls',
  'retirement-census',
  'distribution',
  'signing-identity',
  'native-build-cache',
  'keychain-migration',
  'keychain-rebuild',
  'install-update',
  'project-memory-evaluation',
  'providers-store',
  'model-catalog',
  'model-label',
  'codex-retry-cause',
  'codex-stream',
  'codex-terminal-stream',
  'codex-resume',
  'interrupt-escalation',
  'turn-terminal',
  'chat-title',
  'chat-settings',
  'background-model',
  'comment-agents',
  'comment-reconcile',
  'chat-agent-card',
  'landing-check',
  'run-stats',
  'codex-usage',
  'file-tree',
  'media-types',
  'rules',
  'ask-user',
  'chat-ui',
  'chat-ui-model',
  'device-frame',
  'preview-speed-placement',
  'toolbar-island-dividers',
  'tw-classes',
  'tw-styles',
  'token-match',
  'style-tokens',
  'layers-move',
  'layers-labels',
  'measure-distance',
  'guide-distance',
  'sibling-drop',
  'inline-style',
  'css-values',
  'style-provenance',
  'control-panels',
  'control-requests',
  'svelte-instance',
  'docs-links',
  'spring',
  'apca',
  'fluid',
  'oklch',
  'shadows',
  'type-metrics',
  'skills-install',
  'trezi-cli',
  'native-smoke-groups',
  'docs-merge-union',
  'versioning',
  'swift-preview',
  'swift-preview-graph',
  'swift-preview-target',
  'swift-preview-toolchain',
  'swift-preview-settings',
  'swift-preview-shadow',
  'swift-preview-build',
  'swift-preview-generate',
  'lint'
]

export const NATIVE = [
  'native-runtime',
  'native-source-window',
  'native-chat-scroll',
  'native-next-hmr',
  // LKM-313: moved from the unit tier. Real Next and Vite dev servers measured by the native
  // host's WebKit (it SKIPs without TreziHost): 52 s alone, 60–120 s+ and several load-only
  // failures (a watcher that missed a write) in parallel unit runs. Exclusive and serial here.
  'island-flicker-frameworks',
  'browser-setup-packaged'
]
export const LIVE = ['native-runtime-live', 'provider-live-parity']
export const TIERS = { unit: UNIT, native: NATIVE, live: LIVE }
// Unit tests in one group never run at the same time; the other workers keep running the
// rest (`runQueue` in test/helpers/test-runner.mjs). LKM-345: these build through a real
// PreviewSession, outside the swiftc lane: every installed Xcode's metadata, a #Preview
// probe with an empty module cache, xcodebuild, SwiftPM, actool, swiftc and a preview
// host, under tool limits of 20–120 s sized for one build on an idle Mac. Longest-first
// ordering started them together, and on the 3-vCPU, 7 GB hosted runner they starved each
// other past those limits and their own budgets (docs/TESTING.md "GitHub CI").
export const UNIT_GROUPS = {
  'swift-preview': [
    'swift-preview',
    'swift-preview-target',
    'swift-preview-toolchain',
    'swift-preview-build',
    'swift-preview-generate'
  ]
}
// Unit tests share workers: every fixture swiftc compile goes through the 2-wide swiftc
// lane in test/helpers/swift-build.mjs (LKM-167), so no unit test needs to run alone. These
// still get a longer budget for a cold Swift cache.
export const UNIT_TIMEOUT_MS = {
  'service-process': 240_000,
  // Its Swift fixtures queue behind other tests' swiftc runs; it takes 110 s+ under load.
  // The sections themselves are ~25 s warm (LOCAL-WEBKIT-PUBLISH: a 3-worker CI run with a
  // cold Swift cache hit 240 s inside the sections after `crash`, with no hang).
  // LKM-314: its parity suites may now take 300 s under three parallel unit runs, then the
  // sections; passes already took up to 232 s.
  'repository-owner': 600_000,
  // LKM-354: every section passed and the summary line printed, but only after the 120 s limit
  // in two full unit runs of 8 workers (13.5 s alone): its Swift fixtures queue behind the
  // swiftc lane like repository-owner's, now with the chat fixtures' compiles ahead of it.
  'conversation-owner': 240_000,
  // Same: 17 s warm, but over 120 s in a cold 8-worker run while the swiftc lane is saturated.
  'runtime-owner': 240_000,
  // Same (LKM-209): the checks take ~10 s, but the workflow fixture is a cold compile of
  // most service sources after nearly every service change, queued behind other swiftc runs.
  // LKM-314: no hang in any logged TIMEOUT: each was still finishing a scenario every 5–30 s
  // at 240 s, and passes took up to 239 s.
  'workflow-durability': 420_000,
  'workflow-owner': 420_000,
  // Compiles the same workflow fixture (LKM-355: now first, in the test, then through the
  // LKM-255 operator script); queued in the swiftc lane it can take as long as theirs.
  'live-publish-attribution': 420_000,
  // Runs Next and Vite dev servers in turn: 52 s alone, over 120 s at load average 35. Now in
  // the native tier (LKM-313); the budget applies there too (`test/run.mjs`).
  'island-flicker-frameworks': 240_000,
  // Same (LKM-217): Swift fixtures that compile the shared service or host sources. A cold
  // 8-worker run took 120 s+ for the first two and 106–120 s for the last two, against
  // 22–40 s on a warm tree; a longer budget separates queueing from a real hang.
  // LKM-313: passes took up to 225 s while three unit runs shared the Mac.
  'platform-owner': 420_000,
  // LKM-313: a helper, a fake provider CLI and an MCP bridge per turn; 75 s+ under load.
  'provider-helper-tools': 300_000,
  // LKM-313: every fake CLI call is two Bun starts. browser-verify is 3 s idle and 90 s+
  // under load; the bounds test retries a deadline the fake missed (15 s idle, ~100 s worst).
  'browser-verify': 240_000,
  'browser-verify-bounds': 240_000,
  // LKM-313: real Bun/bash stand-in processes (a catalog probe, the SDK's own CLI, hung tools
  // killed at probe limits). 10–25 s idle, 98 s+ and six 120 s TIMEOUTs under parallel load.
  'codex-model': 240_000,
  'managed-browser-path': 240_000,
  'browser-setup-recovery': 240_000,
  // LOCAL-WEBKIT-4: the same platform fixture compile, then scripted installs.
  'browser-tools-install': 240_000,
  'native-settings-layout': 240_000,
  'native-composer-layout': 240_000,
  // LKM-381: the same composer source compile, then one short sending delay.
  'composer-attach': 240_000,
  'native-chat-latest-settle': 240_000,
  // LKM-312: a compile of the 33 real chat and composer sources (24 s with a warm module
  // cache), then 5 s of samples.
  'native-chat-bottom-marker': 240_000,
  // LKM-354: the same compile, then seven sends sampled for ~4 s each and two forced cases that
  // wait for the bounded settles to end (up to 20 s each), two more while the reply streams (up
  // to 25 s each); 90 s in a loaded unit run before those, 140 s alone after. LKM-365: the forced
  // cases end on the app's bound, not a time (90 s hang cap each), and the fixture run (about
  // 125 s alone) may take 300 s before it is stopped, so the compile plus that.
  'native-chat-send-follow': 420_000,
  // LKM-287: a cold compile of 19 service sources (26 s alone), then 248 creates through
  // the real SkillsOwner, each F_FULLFSYNC'd objects plus a ledger-backed manifest
  // replace (~88-190 ms each, growing with the library), for the 128 × 64 regression.
  // 59 s cold alone, 33 s warm; it passed four sections and then hit 120 s in CI.
  'skills-projection': 240_000,
  'keychain-rebuild': 300_000,
  // LKM-271: four compiles of the preview host and a fixture (6 s warm) outside the lane.
  'swift-preview': 240_000,
  // LKM-273: three module compiles per build, six builds, then the driver's own build.
  'swift-preview-target': 300_000,
  // LKM-274: scripted toolchains are instant; the real check probes Xcode and then the
  // driver builds the fixture with a cold module cache for that toolchain.
  'swift-preview-toolchain': 300_000,
  // LKM-275: a cold `swift build`, actool and three module compiles for the fixture, then
  // a disposable Scraib copy (its settings, then a 40-file app target).
  'swift-preview-build': 600_000,
  // LKM-276: the SwiftSyntax scanner's first compile, then two generated module builds.
  'swift-preview-generate': 300_000,
  // Real Vite install, Swift runtime fixture and a WebKit load.
  'dependency-refresh-vite': 300_000,
  'setup-vite-real': 300_000
}
// `--typecheck` runs these next to the tests (quick verification in one command).
// `typecheck-native` is dropped while it would check the same program as `typecheck`
// (`typecheckPlan` in test/helpers/test-plan.mjs).
export const TYPECHECKS = {
  typecheck: ['run', 'typecheck'],
  'typecheck-native': ['run', 'typecheck:native']
}
