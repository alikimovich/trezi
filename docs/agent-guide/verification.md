# Agent guide — commands and verification

Moved from the old `CLAUDE.md` ("Commands", "Verify your own work WITHOUT asking the
user") and `AGENTS.md` ("Commands and verification"). Linked from
[AGENTS.md](../../AGENTS.md). Runner details: `docs/TESTING.md`.

## Commands

Use **bun**, not npm/yarn. Node 22 (`.nvmrc`) remains available for tooling/tests.
Native builds require macOS 13.3+ and command-line tools with the macOS 26 SDK. The
supported platform (macOS 13.3, SDK 26.0, Bun 1.3.0) has one source,
`scripts/requirements.mjs`; the build, launcher, CLI and installer enforce it and
`test/distribution.mjs` keeps `package.json` and the docs in sync with it.

The retirement census (`test/retirement-census.mjs`, `docs/SWIFT-BACKEND-RETIREMENT.md`)
lists every Bun module with a file, process or signal effect as helper / test / Bun-owned
and fails on an unlisted one; the gate requires 0 Bun-owned rows and no rollback switch. Add a row when you add such a module.

| Command | What |
| --- | --- |
| `bun run dev` / `bun run dev:native` | Build and launch the native app (Swift host + Bun services) |
| `bun run build` / `bun run build:native` | Build `out/native/Trezi.app` (Swift host and service, bundled Bun, backend and preview) |
| `bun run start` | Launch the existing native build (development launcher) |
| `open -a Trezi` / `trezi [path]` | The start path: open the app, optionally on a project |
| `bun run typecheck` | Type-check native/backend/shared code and isolated preview. Run after every change |
| `bun run typecheck:native` | Native/backend/shared check only |
| `node test/run.mjs unit` | Backend and controller tests, no desktop |
| `bun run test:quick` | Quick verification in one command: both typechecks next to the unit tier, plus the 20 slowest tests (`--typecheck --report`, `docs/TESTING.md`) |
| `bun run test:<name>` | One test (see package.json for ~40 aliases) |
| `bun run test:native` | Disposable-profile native desktop integration |
| `bun run test` | Unit + native UI tiers (via `test/run.mjs`) |
| `bun run test:native-live` | Real provider fixture edit; requires authorization |
| `bun run test:provider-live` | Bounded Claude + Codex parity, in-process vs helper (`TREZI_LIVE_PROVIDERS=1`); requires authorization |
| `bun run verify` | Everything incl. live-agent e2e (needs display + creds) |
| `bun run lint` | Biome lint and format check over `src` + `test`; `test/lint.mjs` runs it in the unit tier, so it gates quick verification |

The `dev:native`, `build:native`, and `typecheck:native` aliases remain supported.

## Verify your own work WITHOUT asking the user

- After changes run `bun run typecheck` and the relevant unit tests. Native changes
  also require `bun run typecheck:native` and `bun run test:native`. `bun run test`
  combines unit and native checks.
- `bun run lint` must exit 0. `test/lint.mjs` runs it in the unit tier, so quick
  verification fails on a new lint or format error; fix it with
  `bunx biome check --write <files>`. Warnings and infos do not fail. `biome.json`
  neither formats nor sorts imports in `test/fixtures/**`: fixtures stand in for user
  apps and tests depend on their bytes and line numbers.
- Live provider calls (`test:native-live` / `verify`) require authorization. Do not
  run real provider calls without it.
- The runner tiers are `unit`, `native`, `live`, and `all`. Unit jobs are bounded
  (bounded concurrency); native/live jobs are serial and use disposable profiles. Use
  `--serial` for diagnosis. Logs and JSON reports live in `test/artifacts/runs/`.
  SKIP is distinct from PASS. See `docs/TESTING.md` for filtering, logs, timeouts and
  isolation rules.
- Read captured PNGs to verify UI without asking the user. Offscreen AppKit captures
  (image caching) cannot reliably paint Liquid Glass; use visible checks when needed.
- `TREZI_NATIVE_BACKGROUND_TEST=1` skips real preview pointer gestures and animation
  timing; report that reduced coverage.
- No Electron tests remain.
- `bun run dev:native --test --only=group,group` (or `bun test/native-runtime.mjs
  --only=…`) runs only the named native smoke groups: `core`, `islands`,
  `shadow-light`, `sidebar`, `settings`, `chat`, `composer`. An unknown name fails
  before the build; no flag runs every group, which acceptance still requires.
  Groups are defined in `src/native/smoke-groups.ts`.
- `test/docs-links.mjs` (unit tier) fails CI if an anchored path (`src/…`, `docs/…`,
  `test/…`, …) referenced in `AGENTS.md`, `CLAUDE.md`, `README.md` or
  `docs/agent-guide/*.md` no longer exists.

## Evidence budget

The Evidence budget is kept verbatim in `AGENTS.md` (every agent must see it).
