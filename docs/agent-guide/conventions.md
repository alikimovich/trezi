# Agent guide — conventions, secrets and legacy names

Moved from the old `CLAUDE.md` (intro, "Conventions") and `AGENTS.md` ("Conventions
and hard-won constraints"). Linked from [AGENTS.md](../../AGENTS.md).

## Code

- Application UI is Swift/AppKit/SwiftUI. Reuse existing system font sizes, line
  heights and native controls rather than introducing arbitrary scales. Tailwind
  support remains in source-editing tools for the user's projects.
- The Claude Agent SDK (like the other provider SDKs) is **ESM-only** — `main` is CJS,
  so it's loaded via dynamic `import()` in `agent.ts`/`backends/` (never
  static/`require`).
- All cross-process types go in `src/shared/api.ts`; keep service handlers, Bun
  controllers, preview transport and Swift state/action contracts in sync. Preview
  message names live in `src/shared/preview-channels.ts`; keep producers and
  consumers in sync.
- Keep files under ~500 lines; extract modules instead of growing oversized files.
- New test = new `.mjs` in `test/` **plus** its name in the right tier array in
  `test/run.mjs` (`unit` / `native` / `live`). `bun run test` and `verify` dispatch
  through the runner — don't hand-edit `&&` chains.
- Prop editing requires `PropInspection.hasSchema`; unresolved components remain
  prompt-only. React and Svelte have separate splice engines.
- Project memory and Main-context reset are documented in `docs/MEMORY.md`.

## Auth and secrets

- Auth is per-user at runtime; never commit secrets. Nothing sensitive in-repo.
- Distributed as source (clone + `bun install` + `bun run dev`); each user
  authenticates with their own provider subscription (`claude setup-token` /
  `claude login`; Codex and Gemini backends exist behind the same seam) or endpoint
  credentials.
- The two built-in seats use subscription login (Claude `setup-token` / Codex
  sign-in-with-ChatGPT). A v10 *connection* is the one path that uses an API key —
  the user's own, encrypted with `safeStorage` under userData and confined to main.
  It must never reach the renderer, argv, a log line, or an error string; the UI
  only ever observes `hasKey`.

## Earlier names

Trezi had two earlier names. Code, UI and docs use only Trezi names: the stamp is
`data-trezi-source`, the sidecar is `.trezi/`, work branches are `trezi/*`, env vars
are `TREZI_*`. The earlier names survive only as the read-compatibility shims listed
in [legacy names](legacy-names.md), each in the files named there. Don't
"fix" those strings, and don't add new ones: `test/legacy-names-audit.mjs` fails when
an earlier name appears in a file the list does not name. Keep `docs/PROGRESS.md`
history as written (do not rewrite historical entries).
