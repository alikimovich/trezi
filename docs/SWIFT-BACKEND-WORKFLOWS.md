# Swift workflow owner: publishing, remote Git actions, setup, diagnostics, update (S13)

> **Since LKM-111 (2026-09-29):** the launch-time rollback (`TREZI_BACKEND_OWNER=legacy`,
> `TreziService --legacy`) and the Bun twins it ran are removed. The Swift owner described
> here is the only one; passages about the rollback, the legacy launch or the TS twins
> are history. Current status: [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-100, roadmap row S13 ("Publishing/remote actions/setup/diagnostics/support and shared
sheet routing") of the [canonical plan](SWIFT-BACKEND-PLAN.md) and
[roadmap](SWIFT-BACKEND-ROADMAP.md). It follows [editing](SWIFT-BACKEND-EDITING.md).
Under the default launch (`TREZI_BACKEND_OWNER=swift`) the service's workflow owner runs
Trezi's side-effecting workflows outside a chat turn, and keeps a durable record of each
step. Bun keeps the helpers that only propose bounded results and the sheets that collect
the user's explicit intent. Git effects run in the [repository](SWIFT-BACKEND-REPOSITORY.md)
coordinator's lane.

- `src/service/WorkflowOwner.swift`: requests, validation, dedupe by operation ID, resume
  and busy rules, cancellation, drain; `WorkflowContext` (steps, tools).
- `src/service/WorkflowJournal.swift`: the durable records and their recovery at launch;
  redaction.
- `src/service/WorkflowPublish.swift`: Publish (merge / PR only), the notes handoff PR, a
  saved run's PR, the reconciled push.
- `src/service/WorkflowRemote.swift`: Connect to GitHub, remote status, pull and switch.
- `src/service/WorkflowSetup.swift`: instrumentation helpers, their removal, new projects,
  Trezi's own update, and `WorkflowDiagnoses` (the diagnosis memory).
- `src/service/WorkflowTools.swift` (S15): the in-app feedback issue (`gh issue create` in
  Trezi's checkout; intent journaled first, a retry or a `gh` failure looks for an issue
  with the same title and body before filing) and curated skill-pack installs
  (`npx skills add`, argv built by the owner from a GitHub `owner/name` and plain skill
  names). `src/service/WorkflowContext.swift` holds the outcome type and per-run context.
  `src/main/skills-install.ts` builds the install request.
- `src/native/workflow-service.ts`: Bun's client. `src/main/workflow-owner.ts` is the seam;
  the proposing helpers stay in `src/main/publish.ts`, `github.ts`, `git-remote.ts`,
  `setup.ts`, `scaffold.ts` and `diag-cache.ts`. The rollback twin over them
  (`workflow-legacy.ts`, `feedback-legacy.ts`, `publish-reconcile.ts`) was removed in
  LKM-111.

## The domain, exactly

| Item | Owner (swift launch) | Owner (legacy launch) |
| --- | --- | --- |
| Publish: commit, reconciled push with `refs/trezi/recovery/*`, PR create/reuse, squash merge, local cleanup (`publish:ship`) | Swift, journaled | Bun (`publish.ts`, in-process lock) |
| Handoff PR (`publish:to-pr`) and a saved run's PR (`agent:spawn-pr`) | Swift, journaled | Bun |
| Connect to GitHub (`github:connect`): fast-forward base, create repository, push | Swift, journaled | Bun (`github.ts`) |
| Remote status/fetch, pull, switch to a remote branch (`git:remote-*`) | Swift, in the lane | Bun (`git-remote.ts`, lease) |
| `.trezi/` instrumentation helpers write/remove (`setup:scaffold` / `setup:uninstall`) | Swift (create-only, plain folder) | Bun (`setup.ts`) |
| New project: starter files, first commit, dependency install (`project:create`) | Swift, journaled (a failed install resumes) | Bun (`scaffold.ts`) |
| Trezi's own update: pull, install, build | Swift, journaled (a retry never pulls twice) | Bun (`workflow-legacy.ts`) |
| Diagnosis memory `<profile>/diagnostics.json` (unchanged `JSON.stringify(store, null, 2)`) | Swift | Bun (`diag-cache.ts`) |
| Workflow records `<profile>/service/workflows/<id>.json` | Swift | (not read) |
| PR descriptions (`publish-description.ts`), framework detection and helper sources, starter templates, diagnoses (rules or one tool-less model turn), `github:status`, `setup:detect`, update check | Bun JS helpers (propose only) | Bun |
| Sheets and their routing, feedback issues (`feedback:submit`), the chat seed of a diagnosis | Bun (not moved, see TASKS) | Bun |
| Annotation storage `.trezi/annotations.json` | Bun (S05; publication only reads it) | Bun |

## Rules

- **Explicit intent.** Every mutation names its intent (`publish`, `connect`, `update`,
  `setup`, `uninstall`, `create`, `dismiss`); a request without it is refused. Remote
  mutations start only from the user's sheet or toolbar action, as before. The package
  manager for a new project is the one Bun proposes (bun if installed, else npm; the
  service accepts only those two).
- **Journal first.** A workflow is a record before anything runs; each step's intent is on
  disk (atomic replace, fsync) before its first effect, and its receipt after. At launch a
  record found `running` or `describe` is `interrupted` and its unfinished steps
  `uncertain`. The journal is bounded: a failed or cancelled run with no step (refused before
  its first effect: not signed in, dirty checkout, busy agents) has nothing to reconcile, so
  only the newest 20 remain (enough to answer a lost reply to a refusal); runs that began a
  step and stopped keep the newest 5 per repository and kind (only the last is resumed);
  superseded and dismissed records keep 10; finished results keep 100.
- **One operation, one effect.** Every request carries an operation ID. A request re-sent
  after a lost reply (Bun's client asks again with the same ID when a reply does not arrive
  in time) is answered from the record, or joins the run still under way. So a lost reply
  never repeats a push, a PR, a merge or an update.
- **Reconcile, never repeat.** Before Publish creates a PR it looks at GitHub: an open PR
  for the branch is adopted (and its title/body refreshed, as the legacy reuse path did),
  never duplicated; the handoff and saved-run PRs adopt an open PR when an earlier run of
  theirs got that far, and otherwise keep the legacy behaviour. A later request resumes an unfinished run of the same kind on the
  same repository: a merge the journal asked for is checked on the PR number the journal
  holds, and if GitHub merged it, only the local cleanup runs; a repository creation this
  owner asked for is adopted instead of failing on "already exists" (never one it did not
  ask for); an update skips a pull whose receipt still matches HEAD; a new project whose
  install failed resumes at the install. Resuming never performs a remote mutation the new
  request did not ask for (a merge only in merge mode).
- **Two phases for descriptions.** A publication pushes, then answers `describe` with the
  pushed range; Bun's helper proposes `{title, body}` (or reports why it could not, and the
  owner undoes what the legacy route undid); phase two creates or reuses the PR and merges.
  The lane is not held while the helper runs; phase two leaves the fresh-branch cleanup out
  if the work branch moved since the push (nothing on it is deleted).
- **Busy.** One open publication (publish, handoff, saved-run PR, connect) per repository:
  another answers the legacy message "A publish is already in progress for this repository."
- **Cancellation.** `cancel {kind, root}`: no further step starts; a running local step
  (install, build) is stopped (SIGTERM to its process group); a remote step already sent
  finishes and is recorded. A publication waiting for its description ends at once (its
  branch stays pushed; no PR). A cancelled, failed or interrupted run can be resumed by the
  next request or `dismiss`ed.
- **Redaction.** URL userinfo and GitHub tokens are replaced by `***` in every stored
  message and answer.
- **Setup files.** Only the six known helper paths are written, each only if absent, in a
  `.trezi` that must be a plain folder of the project (a linked `.trezi` is refused; the
  legacy writer followed it). Removal takes the fixed list only and never goes through a
  linked `.trezi` or legacy folder. A hand-edited helper is kept.
- **Diagnoses.** Same file and bytes as the legacy store; a damaged file is refused and
  kept (the legacy store read it as empty and overwrote it on the next save). Bun treats the
  memory as best-effort, as before: a refused read or write is logged and the user still gets
  the diagnosis (`diagnose:run`, `diagnose:record`).
- **Test hooks.** `WORKFLOW_FAULT` crash points and the reply-dropping command exist only
  in the fixture (`test/fixtures/workflow-owner/main.swift`); nothing on the pipe exposes them.

## Protocol

Private pipe, S01 frames, no revision, empty scope:
`{"service":"workflow","id":n,"request":{…,"service":"workflow","method",…}}`. Recorded
workflows answer `{workflow, stage:"done", result}` (result = the legacy route's answer) or
`{workflow, stage:"describe", base, head, branch}`.

| Method | Mode | Body |
| --- | --- | --- |
| `publish` / `handoff` / `branchPr` | mutation | `{root, mode, intent}` / `{root, title, notes, intent}` / `{root, branch, intent}` (+ `leases`) |
| `describe` | mutation | `{workflow, title, body}` or `{workflow, error}` |
| `connect` | mutation | `{root, name, owner, private, intent}` |
| `remoteStatus` / `remoteUpdate` | mutation (fetch changes refs) | `{root, fetch}` / `{root, action, ref, expectedBranch, busy, intent}` |
| `setup` / `uninstall` | mutation | `{root, files:[{path, content}], intent}` / `{root, intent}` |
| `createProject` / `update` | mutation | `{root, files:{path: content}, install, intent}` / `{root, intent}` |
| `diagnosis` / `remember` / `diagnosisStatus` | read / mutation / mutation | `{root, signature}` / `{root, diagnosis}` / `{root, signature, status}` |
| `workflows` / `cancel` / `dismiss` | read / mutation / mutation | `{}` / `{kind, root}` / `{workflow, intent}` |

`busy` in `remoteUpdate` is Bun's view of the project's running agents when the request is
made (the legacy code re-checked it after the fetch; the pull itself runs in the lane, so no
landing can interleave with it).

## Partial effects and recovery

| Cut short after | What exists | What the next request does |
| --- | --- | --- |
| commit / push | commit on the work branch; branch pushed; recovery refs | runs again (both idempotent) |
| PR created, reply lost (crash, gh error) | open PR | adopts it (`pr view`), refreshes title/body |
| merge requested, reply lost | PR merged, remote branch deleted | checks the journal's PR number: merged → cleanup only |
| cleanup | on base, or branch recreated | cleanup is skipped if the branch moved; nothing is deleted |
| repository created (Connect) | GitHub repo, maybe `origin` | adopts the repository this run asked for; pushes |
| pull (update) | new HEAD | pull again (fast-forward: a no-op) or skipped by receipt |
| install / build failed or stopped | pulled checkout, partial `node_modules`/`out` | skips the pull, runs install and build again |
| project install failed | written, committed project | resumes at the install (not refused as non-empty) |

## Rollback (tightened to this domain)

- **Launch-time switch only.** Quit, relaunch with `TREZI_BACKEND_OWNER=legacy`; the profile
  lock admits one owner and no workflow writer is hot-switched.
- **Drain before switching.** At quit, after Bun has exited, the service refuses new workflow
  requests with source and editing ones (a workflow queued behind a released lease answers
  "stopping", retryable), closes the repository coordinator, then waits (bounded, 2 s). A
  run cut short is `interrupted` at the next Swift launch.
- **What is preserved.** Everything a workflow changes is ordinary Git, GitHub or project
  state, which the legacy code handles as it always did: it reuses an open PR (its create
  falls back to `pr view` + `pr edit`), and a project it did not write is still "not empty".
  `diagnostics.json` keeps its format, so both owners read and write the same file (tested
  both ways). `<profile>/service/workflows/` is never read or written by the legacy owner and
  is still there when Swift returns; its records are resumed or superseded by state, not
  replayed (tested: a Swift publish cut short after its PR, finished by the legacy owner,
  then asked of Swift again, creates and merges nothing more).
- **Reverting the code.** A pre-LKM-100 build ignores `service/workflows/`; the records are
  JSON and can be read by hand. Recovery refs stay under `refs/trezi/recovery/`.

## Verification

`test/workflow-owner.mjs` (unit tier) compiles the real owner with the repository
coordinator into a fixture (`test/fixtures/workflow-owner/main.swift`) and drives it through
Bun's client against scratch repositories, bare "GitHub" remotes and a scripted `gh`,
`bun` and `npm` (`fake-gh.mjs`, `fake-pm.mjs`; the test re-runs itself with them on PATH and
Bun's auto-install off, so no real tool, GitHub or registry is reached):
- **parity** (12 scenarios, identical answers and Git/GitHub state on the legacy twin and
  the Swift owner): publish merge, PR only and reuse, conflict (files and recovery refs),
  nothing to publish, handoff, saved run's PR, Connect, remote status/busy/stale/pull/switch
  and the top-level refusal, helpers write/keep/remove, new project, Trezi update,
  diagnoses (file bytes);
- **durability** (Swift): replies lost after phase one and phase two, a crash after the PR
  and after the merge, GitHub failing after creating the PR and after merging, Connect
  crashing and failing after creating the repository, install and build failures resumed
  without a second pull, a crash after the pull, a project install resumed, cancellation of
  a running install and of a publication waiting for its description, busy, restart listing
  and dismissal, rollback both ways, a damaged diagnoses file kept while `diagnose:run` and
  `diagnose:record` still succeed, a bounded journal under repeated refusals, redaction, drain
  and schema.

Not verified here: real GitHub (`gh`) and real installs; the native smoke has no publish,
setup or update path (the manager's run covers the app with this owner installed).
