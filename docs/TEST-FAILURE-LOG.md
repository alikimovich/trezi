# Test failure log (LKM-776, two-week evidence window)

Started 2026-11-21; the window closes 2026-12-05. Every test failure you fix, in a
Forge round, in CI or locally before a commit, gets one row here in the same commit
as the fix. Newest first. The file union-merges like the progress log.

After the window a separate task reads the log. A test file whose rows are all
**change detector** may be deleted and its pattern banned in `AGENTS.md`. Nothing is
deleted during the window. Tests for authorization, privacy, migrations or
concurrency are never deleted, whatever their rows say.

Kinds:

- **caught regression**: the product was wrong, and the test failing stopped the bug.
- **change detector**: the product was right; the test failed only because it pins
  something that changed on purpose (copy, layout numbers, file lists, call order).
- **test bug**: the test itself was wrong (race, leak, timing, fixture). Fix the test;
  a test that needs a retry has a bug. Never retry, widen a timeout or skip to pass.

| Date | Ticket | Test file | Kind | What failed, and why |
| --- | --- | --- | --- | --- |
| 2026-11-25 | LKM-827 | `test/trezi-cli.mjs` | test bug | GitHub shard 3 lost the end of a large piped stdout write when the fixture called `process.exit(7)` before its stream drained. Setting `process.exitCode` preserves the failure status and lets Node flush both streams. |
| 2026-11-25 | LKM-830 | `test/preview-measure-stacking.mjs` | test bug | Forge's 302.3 s fast check timed out waiting for two `requestAnimationFrame` callbacks in an offscreen WKWebView. The fixture now waits for its badge pixels in WebKit snapshots with a deadline, then applies the same pixel assertions. Local WebKit still cannot load its page in the sandbox; the unsandboxed verdict is pending. |
| 2026-11-25 | LKM-830 | `test/preview-measure-stacking.mjs` | test bug | PR #478 unit shard 2 sampled the selected-panel hover chip's blue pixels while the badge's DOM geometry was already present. The fixture now waits for two animation frames before its WebKit snapshot so layout and paint belong to the same frame; all pixel assertions remain. The visual verdict awaits unsandboxed CI because local WebKit cannot load its page. |
| 2026-11-25 | LKM-830 | `test/test-runner.mjs` | test bug | The new green CLI fixture gave Bun only 100 ms to start and finish under parallel lint, so it timed out before its pass assertion. Its green process budget now allows startup; the red fixture keeps its 100 ms timeout to exercise cancellation. |
| 2026-11-25 | LKM-816 | `test/conversation-owner.mjs` | test bug | GitHub shard 3 admitted the late-orphan peer after 2050 ms, crossing a 2000 ms wall-clock assertion that included runner scheduling. The fixture now observes the queued status and requires successful admission within a shortened writer-wait deadline, while retaining the separate bounded-wait rejection case. |
| 2026-11-25 | LKM-816 | `test/swift-preview.mjs` | test bug | GitHub shard reached the library build at 234.7 s after two earlier cold builds took 78.7 s and 90.9 s, then hit the 240 s process limit. The independent stop and library scenarios now run as separate grouped tests with unchanged assertions and limits. |
| 2026-11-25 | LKM-816 | `test/native-composer-layout.mjs` | test bug | Fixed-time scroll settle missed a delayed main-queue reattach callback under concurrent load; the fixture now waits for pinned state and checks the callback sequence. |
| 2026-11-25 | LKM-816 | `test/spawn-phases.mjs` | test bug | Cross-run setup-time bound failed at 1807 ms under load; lease and setup attribution now use chronological phase marks. |
| 2026-11-25 | LKM-817 | `test/browser-verify-bounds.mjs` | test bug | The 8 s run-budget attempt took 13.7 s under load. The wall-clock assertion omitted the mandatory browser-session close, which has its own bounded 15 s allowance; the corrected bound includes it and still verifies the hung wrapper and child exit. |
| 2026-11-25 | LKM-817 | `test/peer-coordination.mjs` | test bug | The new split guard counted 13 source calls, but a two-case loop runs 16 scenarios. The guard and partition now count all 16. |
| 2026-11-25 | LKM-817 | `test/conversation-owner-part-1.mjs`, `test/conversation-owner-part-2.mjs` | test bug | The first split combined parity and two independent live-checkout waits in one agent section, then the agent section alone timed out at 240 s. Parity, each live-checkout case, the other agent assertions and recovery now run separately. |
| 2026-11-21 | LKM-776 | `test/sidebar-marquee.mjs` | test bug | Fixture `resize()` let a late plan sample before the title's next frame applied the new travel (offset 155 > travel 115); it now waits for that frame, as `select()` does. |
| 2026-11-21 | LKM-776 | `test/session-skills.mjs` | test bug | A `< 2000 ms` wall-clock ceiling read 2053 ms at load ~190; replaced by the ordering it stood for (the start gives up before the stuck edit settles). |
| 2026-11-20 | LKM-763 | `test/browser-tools-install.mjs` | test bug | Cancelled install's rejection was handled too late; Bun flagged it unhandled. |
| 2026-11-20 | LKM-763 | `test/spawn-phases.mjs` | test bug | 400 ms lease timer started before Apply reached the lane. |
