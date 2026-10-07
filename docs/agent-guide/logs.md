# Agent guide — product logs

Trezi's product log (LKM-168). Linked from [AGENTS.md](../../AGENTS.md). Every
process writes to one folder, so a support report or a bug hunt reads one timeline.

## Where and how long

- Folder: `~/Library/Logs/Trezi/`. `TREZI_LOG_DIR` (an absolute path) overrides it.
- One file per UTC day: `trezi-YYYY-MM-DD.log`. Files are kept for 7 days and pruned
  when a day's file opens. A day's file stops at 20 MB with one "Daily log limit
  reached" line.
- Every process opens the day file with `O_APPEND` and locks it across the size
  check and append. Logging never throws; the Swift writer uses a private queue.

## Writers

| Process tag | Writer | Started by |
| --- | --- | --- |
| `app` | `src/service/ProductLog.swift` | `Host.startProductLog()` (`src/native/HostLogs.swift`) |
| `service` | `src/service/ProductLog.swift` | `ServiceRuntime` after the host's hello |
| `backend` | `src/main/product-log.ts` | `initProductLog('backend')` in `src/native/index.ts` |
| `helper` | `src/main/product-log.ts` | `src/main/backends/provider-helper-entry.ts` |
| `preview` | backend, on the bridge's behalf | a once-a-minute message count from `src/native/log-support.ts` |
| `devserver` | backend, on the dev server's behalf | `src/main/devserver.ts`, fixed output categories and lengths |

Until a process configures its writer every call is a no-op. Owner and unit tests
therefore write nothing. The provider helper's scrubbed environment keeps
`TREZI_LOG_DIR` (`ProviderHelper.swift`) so a test's helper logs into the test folder.

## Line format

```
2026-10-05T21:52:43.463Z info backend chat chat=abc turn=t-1 Turn started provider=claude model=default
```

The fields are: ISO time (UTC, milliseconds), level (`debug|info|warn|error`), process,
area, optional `chat=` and `turn=`, then the message and its `key=value` fields. A
value with spaces is JSON-quoted. Newlines become ` ⏎ `. A message is cut at 1000
characters. The Bun and Swift writers format identically; `test/product-log.mjs`
checks this.

## What is logged

Lifecycle facts only:

- chat turn start, end and failure, with the provider and the requested and resolved
  model (`src/main/turn-log.ts`);
- landing, parking and resolve steps, with the Git result;
- worktree create, sync and remove;
- New chat timing (LKM-182): `New chat composer ready` with each step's ms
  (`src/native/workspace-controller.ts`), then `New chat workspace ready`, `New chat
  provider started`, `New chat registered`, `New chat ready` and `New chat first send`
  (wait and age) from `src/main/agent.ts`, the spare's ready/taken/removed lines and
  background dependency installs;
- provider helper start, exit and crash with status, and backend start and exit;
- target dev server output category and length (the raw line stays in Activity);
- preview load, reload, load failure and web-content crash;
- host commands that hold the main thread for more than 250 ms;
- XPC errors and lost connections;
- Copy and Export of the logs.

**Never logged:** prompts, replies, file contents, secrets, API keys or tokens. Every
line passes through `redact` (`product-log.ts` / `ProductLog.redact`). It removes
known token shapes, `key=value` secrets, URL credentials and private keys, and shortens
the home folder to `~`. Console output and helper stderr are not copied into the log. Add a new pattern to
both writers and to `test/product-log.mjs`.

## Reading the log

- `trezi logs [--since 30m] [--follow]` prints the merged lines of every process,
  oldest first (`bin/trezi.mjs`).
- Help → Copy Logs for Support copies the last 30 minutes (debug lines dropped,
  newest kept, about 60 KB).
- Help → Show Logs in Finder opens the folder.
- Help → Export Logs… zips the last 24 hours and `summary.txt`: app version, build
  and sha, macOS, Bun, provider harness versions, the open project's framework.
- The feedback sheet attaches the last 30 minutes with the user's consent
  (`src/main/feedback-diagnostics.ts`).

## Tests

- `test/product-log.mjs` covers redaction, Swift parity, rotation, the cap, pruning,
  the CLI, the support text and the export.
- The native chat smoke (`src/native/smoke-logs.ts`) checks that a chat turn writes
  its start and end lines. It also checks that `app`, `service` and `backend` all wrote
  to the run's own folder.
- `scripts/start-native.mjs` points `--test` runs at `<test dir>/logs`.
- `test/helpers/test-runner.mjs` points every test at its own profile.
- No test writes to `~/Library/Logs/Trezi`.
