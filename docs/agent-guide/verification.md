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
| `bun run typecheck` | Type-check native/backend/shared code and isolated preview |
| `bun run check:feedback --base=origin/main` | Local feedback: lint, applicable typechecks, and audited selected unit tests; emits a structured partial-evidence receipt |
| `bun run typecheck:native` | Native/backend/shared check only |
| `node test/run.mjs unit` | Backend and controller tests, no desktop |
| `bun run test:quick` | Quick verification in one command: the typecheck next to the unit tier (`typecheck:native` too once its config differs from `typecheck:node`), plus the 20 slowest tests (`--typecheck --report`, `docs/TESTING.md`) |
| `node test/run.mjs unit --changed=main` | Only the tests the diff against `main` needs, with reasons; anything outside the audited docs, test and UI rules runs everything (`docs/TESTING.md`, "Changed-file selection") |
| `node test/run.mjs unit --shard=2/3` | One CI shard of the (selected) unit tier; PR CI runs 3, main runs 1 (`docs/TESTING.md`, "GitHub CI") |
| `bun run test:<name>` | One test (see package.json for ~40 aliases) |
| `bun run test:native` | Disposable-profile native desktop integration |
| `bun run test` | Unit + native UI tiers (via `test/run.mjs`) |
| `bun run test:native-live` | Real provider fixture edit; requires authorization |
| `bun run test:provider-live` | Bounded Claude + Codex parity, in-process vs helper (`TREZI_LIVE_PROVIDERS=1`); requires authorization |
| `bun run verify` | Everything incl. live-agent e2e (needs display + creds) |
| `bun run lint` | Biome lint and format check over `src` + `test`; `test/lint.mjs` runs it in the unit tier, so it gates quick verification |

The `dev:native`, `build:native`, and `typecheck:native` aliases remain supported.

## Verify your own work WITHOUT asking the user

- After coherent edits use `bun run check:feedback --base=origin/main`. It fails
  immediately if a command fails. It uses the audited changed-file plan. SELECTED
  runs that plan's unit tests after lint and any applicable typechecks. FULL runs
  lint and applicable typechecks, then leaves the broad unit gate to CI. The final
  `FEEDBACK_RECEIPT` JSON lists executed checks, selection reasons and checks still
  required. Invalid base refs and diffs fail before any check runs. This local
  receipt is partial evidence, never merge acceptance.
- Required CI checks on the PR head, independent review and the exact-head merge
  gate remain required. Agent OS schedules native checks under its shared desktop
  lock; native acceptance and native-failure pre-merge verification still require
  their explicit evidence. Nightly native checks continue. `bun run test` remains
  the full unit and native command for authorized local use.
- `bun run lint` must exit 0. `test/lint.mjs` runs it in the unit tier, so quick
  verification fails on a new lint or format error; fix it with
  `bunx biome check --write <files>`. Warnings and infos do not fail. `biome.json`
  neither formats nor sorts imports in `test/fixtures/**`: fixtures stand in for user
  apps and tests depend on their bytes and line numbers.
- For test, docs or copy-only changes with unchanged application behavior, the
  feedback receipt provides scoped local evidence. Use `bun test/run.mjs unit
  --filter=name,name --list` or `node test/run.mjs unit --changed=main --list`
  to inspect a plan separately.
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
  `shadow-light`, `sidebar`, `settings`, `chat`, `composer`, `agent-browser`, `selection`. An unknown name fails
  before the build; no flag runs every group, which acceptance still requires.
  Groups are defined in `src/native/smoke-groups.ts`.
- Focused selection acceptance: `bun test/native-runtime.mjs --only=selection`
  runs `selection-input` and `text-edit` plus the prelude, using disposable fixtures.
- Native test builds use the `-Onone` test profile and a shared Swift binary cache, so
  a ticket that does not touch Swift compiles nothing (LKM-175). `bun run build`
  stays `-O`. Details: `docs/TESTING.md`, "Native build speed".
- `test/docs-links.mjs` (unit tier) fails CI if an anchored path (`src/…`, `docs/…`,
  `test/…`, …) referenced in `AGENTS.md`, `CLAUDE.md`, `README.md` or
  `docs/agent-guide/*.md` no longer exists.

## Evidence budget

The Evidence budget is kept verbatim in `AGENTS.md` (every agent must see it).
