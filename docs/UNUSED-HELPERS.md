# Retained helper review — 2026-09-25

These helpers are retained at the user's request. “No application callers” means
source/reference inspection found no production consumer, not that usage telemetry
proved a feature unpopular. Tests can exercise an export even when the app never
calls it. TypeScript does not reject an unused exported function by default.

| Helper | Purpose | Why no application caller / current alternative |
| --- | --- | --- |
| `workspaceOwnsAction` in `src/native/workspace-runtime.ts` | Identifies project/chat navigation actions. | Its native-to-React fallback router was removed in commit `e62c9b3`. Native controllers now handle actions directly. No test caller found. |
| `describeRunStats` in `src/shared/run-stats.ts` | Formats tokens, cache counts and elapsed time into a tooltip sentence. | Native `chat-snapshot.ts` builds a different cumulative-chat tooltip directly. Only tests use this older formatter. |
| `isStyleProp` in `src/shared/style-props.ts` | Runtime membership/type guard for supported CSS properties. | Current inspector iterates the property metadata directly. No source or test caller found; not evidence that property validation as a feature is unused. |
| `stylePropMeta` in `src/shared/css-values.ts` | Looks up metadata for one CSS property. | Native inspector reads/iterates `STYLE_PROP_META` directly; the wrapper is used only by tests. The metadata itself is active. |
| `hasActiveTransition` in `src/shared/css-values.ts` | Distinguishes a real transition from defaults such as `all` plus zero duration. | Its previous UI consumer is absent. Tests remain. Potentially useful if native transition visibility/replay needs this semantic check; no equivalent behavior is claimed here. |
| `formatBezier`, `clampBezier` in `src/shared/css-values.ts` | Serialize a CSS curve and clamp its control points. | Native `NativeBezier` in `EditingInspector.swift` formats and clamps in Swift. These TypeScript wrappers remain test-only. |
| `customPropertyNames` in `src/shared/token-match.ts` | Extracts CSS variable names from a token collection for computed-style reads. | The former consumer is absent; tests remain. Retaining it does not mean native token reads are currently wired through it. |
| `declaredVarsFor` in `src/preview/style-provenance.ts` | Reads authored declarations and returns only their CSS variable names. | Commit `3eb7c6d` replaced its caller with `specifiedValues` plus `varRefName`, preserving authored units as well as token evidence. Both lower-level functions remain active. No test caller found for this wrapper. |
| `findRunningServer` in `src/main/devserver-net.ts` | Tries conventional framework ports and adopts a healthy server. | No app caller; tests still exercise it. Current Trezi owns server lifetimes and allocates/manages its servers. A responding conventional port alone does not prove project identity; do not reconnect this blindly. |
| `modularScale` in `src/main/fluid.ts` | Produces fixed sizes using base × ratio^step. | Test-only optional math utility. Production tools use fluid size calculations. No evidence establishes that this particular convenience function ever had a production caller. |
| `typeMetrics` in `src/main/type-metrics.ts` | Combines line height and letter spacing into one result. | Agent tooling calls `lineHeight` and optionally `letterSpacing` separately. The combined wrapper is test-only. |
| `oklchToHex` in `src/main/oklch.ts` | Converts one OKLCH color to gamut-clamped hex. | Test-only convenience wrapper. Production palette generation uses the lower-level gamut and RGB operations directly. |
| `isGitRepo` in `src/main/git.ts` | Checks whether a folder is anywhere inside a Git worktree. | Application branch operations use stricter `isRepoRoot` checks. This broader helper has only a test caller. |

Likely future deletion candidates are obsolete routing/formatting wrappers.
Transition detection and CSS-variable collection deserve a native behavior review
before deletion: absence of their callers could reflect missing parity, rather
than an intentionally removed capability. Small mathematical wrappers can remain
if useful as tested utilities; keeping them does not restore a product feature.

Experimental Gemini is also retained: its environment-gated backend is reachable,
so removing it would retire a supported opt-in path rather than delete dead code.
