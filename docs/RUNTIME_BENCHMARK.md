# Native versus Electron — 2026-09-23

The original comparison below is a historical snapshot. See the native
React-free follow-up and optimization follow-up first: a controlled rerun did not reproduce the earlier
2.54-second native startup result. Do not use that number as an engine ranking.

Measured on this workspace's Mac mini, Apple M4 Pro (12 cores), 48 GB RAM,
macOS 26.4.1; Bun 1.3.13 and Electron 43.1.0. Application source: `c9db2e8`.
These are local measurements of the current builds, not general engine rankings.

| Measurement | Native | Electron |
| --- | ---: | ---: |
| Runtime + application files, excluding external dependencies | 63.7 MiB | 309.0 MiB |
| Launch to ready UI, successful runs | 2.54 s | 0.66 s |
| Open project to ready preview | 1.62 s | 1.13 s |
| Settled total process RSS | 732 MiB | 1,022 MiB |
| RSS excluding the automatically launched Claude helper | 386 MiB | 652 MiB |
| Idle CPU, percent of one core | 3.48% | 1.49% |
| Median preview animation-frame interval | 33 ms | 33.3 ms |
| Successful / attempted benchmark launches | 2 / 4 | 3 / 3 |

Values are medians across successful runs. Native total RSS was 728–737 MiB;
Electron was 1,020–1,034 MiB. Successful native startup was 2.38–2.70 s versus
0.56–0.74 s for Electron. CPU varied from 2.82–4.14% native and 0.83–2.65%
Electron. This small sample does not establish a stable CPU advantage.

## React-free native follow-up — 2026-09-24

After migrating the application UI to Swift, three fresh-profile native launches
completed successfully with the same 200-card static fixture. Electron was not
rerun during this native-only work. These are a new snapshot, not a paired
comparison with either historical build above.

| Measurement | React-free native median |
| --- | ---: |
| Launch to native ready UI | 0.606 s |
| Open project to ready preview | 0.676 s |
| Settled total process RSS | 787 MiB |
| RSS excluding the Claude helper | 411 MiB |
| Idle CPU, percent of one core | 1.43% |
| Processes with project open | 6 |
| Native application files | 3.98 MiB |
| Application files plus Bun | 64.13 MiB |

The only application-owned WebView was the project preview. All measured app and
WebKit helper processes exited after cleanup. Startup ranged 0.572–0.634 s;
preview readiness 0.657–0.739 s; RSS 704–788 MiB; idle CPU 1.14–2.42%.
The native-ready checkpoint now uses native state rather than a React DOM, so
startup values are not strictly interchangeable with the earlier readiness test.
No scrolling or transition frame-rate claim is made for this follow-up.

As before, RSS sums shared pages, includes provider prewarming, and comes from
four seconds of settling followed by six seconds of samples. Disk size excludes
external dependencies, system WebKit, caches, source maps and generated build
intermediates. The development installation still has shared dependencies used
by Electron; these figures are not the size of the entire repository.
Raw local artifacts: `test/artifacts/runtime-benchmark/react-free-results.json`
and `react-free-size.json`.

## Native optimization follow-up — 2026-09-24

Alternated three baseline native launches (`f4e3ed1`, before these optimizations)
with three optimized launches on the same machine, using fresh profiles and the
same fixture and measurement procedure. All six launched successfully. These
runs used normal local-app permissions; restricted attempts produced blank-page
WebKit launches and are excluded. This does not prove the cause of every earlier
startup failure, nor establish a native-versus-Electron startup result.

| Measurement | Native before | Native optimized |
| --- | ---: | ---: |
| Launch to ready UI, median | 0.856 s | 0.860 s |
| Project preview ready, median | 1.033 s | 1.033 s |
| Idle summed RSS, median | 976 MiB | 898 MiB |
| Idle CPU, percent of one core, median | 2.16% | 1.82% |
| Processes after opening the project | 8 | 7 |
| Median preview frame interval | 33 ms | 33 ms |
| Successful launches | 3/3 | 3/3 |

Memory fell about 78 MiB (8%). The unused property panel previously loaded the
whole renderer in its own WebKit process; it now loads on first explicit use
and remains available for fast reopening. Its memory is needed once opened, so
the saving applies while that panel has not been used. Startup ranges overlap:
0.826–1.288 s before, 0.826–0.860 s after. No startup or scrolling speedup is
claimed. CPU ranges also overlap (1.82–2.66% versus 1.66–2.16%); the lower median
is encouraging but six-second samples are too short for a battery-life claim.

The composer no longer scans its DOM every 150 ms. React commits, input events,
relevant DOM changes and resize notifications keep native controls current.
A follow-up idle probe observed ten composer geometry reads in 1.5 seconds
before and zero afterward. Unchanged sidebar snapshots reuse rows/favicons, and toolbar symbols reuse their
rendered images. These changes preserve controls, animations and provider
prewarming. The Claude helper still accounts for roughly 370 MiB in this workload;
deferring it would trade first-message latency for idle memory, so that tradeoff
was not silently introduced. Application disk size is essentially unchanged.

Raw paired data is in the ignored local artifact
`test/artifacts/runtime-benchmark/paired-results.json`; the final idle probe is
in `idle-results.json`. Full native integration covers first-use panel state and
reuse, per-chat drafts, skills, permissions, attachments, project actions,
preview expansion, source edits, undo/redo, editor pop-outs, Web Inspector and
preview IPC isolation. No Electron tests or provider prompts ran for this work.
Electron remains available: native platform/functionality gaps listed in
`NATIVE.md` still need validation before retiring it.

## Size accounting

Native: Bun 60.15 MiB, AppKit host 0.50 MiB, and application/preload/renderer files
3.03 MiB. Electron: runtime distribution including licenses 295.18 MiB and
application/preload/renderer files 13.82 MiB. This measured subset is 79% smaller
for native. It is **not** a complete standalone installer comparison.

Both builds depend on external packages. In this checkout, the Claude platform
package alone occupies roughly 208 MiB on disk and Codex's platform package about
288 MiB; these are not removed by switching rendering engines. Native also uses
macOS's installed WebKit, which is not counted as application disk usage. The
native output directory contains a roughly 297 MiB Swift module cache, excluded
because it is a compiler artifact. Source maps, temporary benchmark wrappers and
compiler sources are excluded. Build bundling/minification differs between the
current pipelines, so the application-code delta is not solely an engine effect.

## Workload and measurement

- Built the current Electron output; used the freshly built native output.
- Launched isolated profiles with onboarding skipped. Used 1320 × 860 windows.
- Opened equivalent fresh Git repositories containing the same static HTML page:
  200 cards with headings, text and buttons. Trezi owned its preview server.
- No prompts were sent to a provider. Both apps nevertheless launched a Claude
  SDK helper while opening the project; total RSS includes that helper.
- Used lightweight temporary stdin bridges in copies of the built entrypoints
  to check readiness. Launch timing ends when the main API and Open Project
  control exist and two animation frames complete. Project timing ends when the
  preview marker exists and two animation frames complete. Build time is excluded.
- Allowed four seconds after preview readiness, then sampled RSS every 250 ms
  for six seconds. CPU is the sum of process CPU-time deltas over that interval,
  where 100% means one fully occupied core. The launcher itself is excluded.
- Counted app descendants plus newly created WebKit XPC helpers (which are
  parented by launchd). Existing WebKit processes were excluded using a baseline.
  All recorded benchmark processes were confirmed gone after cleanup.
- Reported total resident set size, **not** macOS physical footprint or unique
  memory. Summed RSS can count shared pages more than once. Core-only RSS is
  a settled end-of-interval snapshot with the Claude helper subtracted.
- Scrolled the preview for 120 requestAnimationFrame callbacks. Both engines
  delivered about 30 callbacks/second on this setup. This is not a maximum-FPS
  result or a comprehensive test of input latency, native transitions or chat.
- Other existing desktop apps, including the user's own Trezi instance,
  remained open. Runs were sequential, using fresh profiles but warm OS caches.

## Failures and limits

Two native attempts failed the 45-second readiness check with the existing
WebKit/evaluation unsupported-result issue. They are retained in the raw results
but excluded from successful-run timing and memory medians. This does not prove
a general 50% failure rate; it does make startup reliability an unresolved issue.
Electron completed all three measured attempts.

An earlier Playwright-based exploratory harness stalled attaching to Electron;
that harness and its measurements were discarded. The reported comparison uses
the same lightweight readiness approach for both runtimes. An abandoned isolated
Electron process overlapped part of the measured sequence before cleanup, adding
a further desktop-load limitation to these exploratory timing/CPU results.

Raw process samples, sizes, summaries and the temporary measurement harness are
in `test/artifacts/runtime-benchmark/` (ignored local artifacts). The benchmark
copies of built entrypoints were removed afterwards; product source was not
instrumented or changed.

The next useful measurements are long chat transcripts, a representative Next.js
project, repeated layout transitions, and longer settled memory/CPU sampling.
First, address native startup reliability; the current evidence supports a
size/memory benefit, not an overall performance win.
