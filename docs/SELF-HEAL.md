# Self-healing incidents

Trezi classifies errors in `src/main/self-heal/catalog.ts`. The native chat shows a compact incident row with collapsed, copyable Details instead of placing CLI output in the response. Errors of the same class in a turn share one row. An error the catalog does not know keeps a short, redacted first line of the message as its row line (`summarizeError`), because it often names the action to take. The product log records class, intended recovery and outcome for Dreamer.

| Class | Recovery |
| --- | --- |
| Provider network | Codex retries the prompt up to three times after a helper-side reachability probe, with bounded backoff; then the turn moves to the other provider ([fallback](#provider-fallback)). |
| Provider auth | Existing sign-in card. |
| Provider limit | Wait or choose another provider. Queueing a message until the limit resets is not implemented. |
| Model unavailable | Existing Codex model fallback. |
| Helper crash | The helper restarts and the same turn resumes, at most twice ([helper restart](#helper-restart)). |
| Dev server, stale preview | The preview supervisor (`src/native/preview-supervisor.ts`, LKM-146) restarts a dev server that stopped by itself, with backoff and a limit; otherwise use Trezi's restart or reload tools. |
| Dependency install | Diagnose and retry through the dependency owner. |
| Conflict, landing/parking | A drift park is resolved once automatically ([auto Resolve](#automatic-resolve)); a second park needs the user. |
| Git lock | A stale `index.lock` is removed by the Swift repository owner and the Git effect runs once more ([Git lock](#git-lock)). |
| Disk full, unknown | The [doctor](#doctor) reads safe diagnostics and gives one exact next step. |

## Provider fallback

When every Codex retry failed to connect and the turn produced no output, the turn runs on the other provider (Codex → Claude, Claude → Codex) if that provider is signed in. The helper session (`src/main/backends/helper-session.ts`, with `turn-recovery.ts`) holds the failed turn's `error` and `done`, closes the helper, opens one on the other provider without resuming, posts the status "Codex could not connect; this turn used Claude", and sends the prompt with the recorded conversation ahead of it (`handoffPrompt`). The chat keeps its own provider: its next message goes back to it, again with the recorded conversation, because it has not seen the fallback turn. A fallback turn never falls back again, and background spawns are never moved.

**Settings → General → Automatic provider fallback** (default on) gates it (`src/main/self-heal/fallback.ts`, `src/native/settings-provider-fallback.ts`, preference `trezi:provider-fallback:v1`, stored only when off). If both providers fail the one provider-network error remains.

## Helper restart

A provider helper that crashed (the Swift owner emits `error`, `done`, `exit`) is restarted in the same turn: the session reopens with the chat's resume id and sends the original prompt, or a short "continue where you left off" prompt when output was already produced (so the work is not repeated). The chat shows one "Restarting provider…" status, then "Recovered" when the turn ends without an error. At most two restarts per turn; none after Stop, after a helper that broke its grant (`violation`), in a background run or on a fallback turn. When the restarts fail, the one crash error is shown.

## Git lock

A Git effect that fails on `index.lock` (the turn's landing `completeTurn`, the live commit `commitLiveTurn`) calls `withGitLockRecovery` (`src/main/self-heal/git-lock.ts`). It asks the repository owner's `clearStaleLock` method (`src/service/RepositoryLock.swift`) to remove the lock in the live checkout and the chat worktree, and runs the effect once more. The owner removes a lock only when it is older than 30 seconds and no Git process works in that checkout; Bun never touches the file. A fresh lock, a running Git or any other error leaves the original error.

## Automatic Resolve

When a finished turn parks because the live tree moved, the chat runs the same path as the Resolve button once (`src/native/chat-auto-resolve.ts`): the agent fixes the conflict markers in its own turn and the result lands. It is off in the smoke suite (the parked card must stay visible). A park that clears logs a `conflict` incident as recovered; a second park, or a Resolve that cannot start, logs it as failed and leaves the card to the user. It never interrupts a running turn.

## Telemetry

`src/main/self-heal/incidents.ts` writes one `Incident` product-log line per class per turn when the turn ends, with the class's final outcome: `recovered` (a retry or restart worked), `fell-back` (the other provider ran the turn) or `failed`. Retries and restarts of a class count as attempts of that one incident; recovery progress travels as plain `status` events whose text is a shared contract (`self-heal/status.ts`), because the provider event protocol is an allowlist. No prompt, file content or secret is logged. A failed incident also gets one `Doctor` line with the diagnosis.

## Doctor

`src/main/self-heal/doctor.ts` is a deterministic module, not a model: for a class nothing recovered, `diagnose` returns `{cause, fixApplied, nextStep}`. Its only reads are free disk space and a stale Git lock (through the owner); its only fix is that stale-lock removal. The bundled `trezi-doctor` skill instructs agents to diagnose repeated or unknown failures with redacted logs and read-only checks, then apply only the safe actions above. There is no separate tool-limited doctor subagent.

Network probes and provider retries run inside the supervised helper; they inherit the same allowlisted proxy and certificate variables as the bundled Codex CLI (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `ALL_PROXY`, lower-case variants, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`). Values available to Trezi's launch environment are passed through; a GUI launch does not read arbitrary interactive shell startup files.
