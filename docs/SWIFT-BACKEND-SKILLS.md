# Trezi Skills registry: app-scoped, immutable, service-owned (LKM-284)

Trezi Skills 1/4. This task adds the foundation that the provider, GitHub import and
Settings tasks build on. It adds one app-scoped registry of skill packages in Trezi's
application data, written only by the Swift service, plus one shared TS/Swift contract
for it. Nothing in this task offers a skill to a provider, fetches from GitHub or adds
UI. The project and user skill discovery in `src/main/skills.ts`, the skill-pack
installs (`WorkflowTools.swift`) and the managed-browser environment and hooks are unchanged.

- `src/service/SkillsOwner.swift`: the owner actor. It serves the `skills` pipe
  domain, runs every request one at a time in arrival order, and exposes the
  `pin`/`install` seams to other service owners.
- `src/service/SkillsStore.swift`: the manifest, snapshot, source and provider
  records, and the on-disk store (bounded no-follow reads, immutable writes, sweep).
- `src/service/SkillsPackage.swift`: limits, path and name rules, `SKILL.md`
  frontmatter, content addressing, and the bounded no-follow folder walk used by import.
- `src/service/SkillsPlan.swift`: the pure manifest transition for each mutation.
- `src/service/SkillsRequest.swift`: strict parsing of method, mode and body.
- `src/shared/skills-registry.ts`: the TS types, `SKILLS_LIMITS` (parity-tested
  against Swift), `SKILLS_METHOD_MODES` and the validators.
- `src/native/skills-service.ts`: Bun's client, `serviceSkills(link)`.

## Wire contract (v1)

Frames use the pipe envelope shared with memory and workspace:
`{"service":"skills","id":n,"request":{connection,requestID,operationID,scope:{},mode,expectedRevision?,service:"skills",method,body}}`.
`ServiceRuntime` routes them to a `DomainChannel<SkillsOwner>` and drains it at stop.
Parsing is strict:

- extra or missing fields are refused
- UUIDs must be lowercase
- the mode must match the method
- `expectedRevision` is required exactly for ledger methods
- a non-empty `scope` is `unauthorized`, because skills are app-scoped and never per project

| Method | Mode | Body | Result |
| --- | --- | --- | --- |
| `list` | read | `{}` | `SkillsList`: domain revision, digest, metadata only (never package text) |
| `read` | read | `{skill, revision?, session?}` | `SkillBody`: `SKILL.md` text plus the reference entries (path, size, digest) |
| `reference` | read | `{skill, revision, path}` | one file's text |
| `pins` | read | `{session}` | the session's `SkillSnapshot`, or `notFound` |
| `create` | ledger | `{files: [{path,text}]}` | `SkillMutation` (`skill`, `skillRevision`) |
| `import` | ledger | `{folder}` (absolute local path) | `SkillMutation` plus `skipped` hidden entries |
| `edit` | ledger | `{skill, base, changes: [{path, text\|null}]}` | a new revision; `base` must be the current one |
| `enable` | ledger | `{skill, enabled}` | `changed` false when already so |
| `providers` | ledger | `{skill, providers: {claude,codex,gemini}}` | |
| `remove` / `restore` | ledger | `{skill}` | recoverable; restore refuses if the name is taken again |
| `purge` | ledger | `{skill}` | only after `remove`; pinned revisions stay readable |
| `snapshot` | session | `{session}` | creates the session's pins once (`created`), reports unreadable ones in `skipped` |
| `release` | session | `{session}` | `{session, released}` |

On the wire, "ledger" and "session" methods both use `mode: "mutation"`, but only
ledger methods carry `expectedRevision`. A stale revision returns `conflict` with
`currentRevision`. Ledger replies carry the committed list as their `snapshot`.
Failure codes:

- `invalidRequest`
- `unauthorized` (a scoped frame, or an import of links, hard links or special files)
- `conflict` (a stale revision or base, a taken name, purge before remove, snapshot capacity)
- `notFound`
- `recoveryRequired` (damaged data, a linked registry folder, or a ledger that cannot be reconciled)
- `ioFailure` (retryable)
- `busy`
- `unavailable`

`serviceSkills` runs calls one at a time and remembers the last revision. For a
`conflict` that names `currentRevision`, it retries the same intent up to twice. That
is safe because every plan re-checks its own preconditions, such as `edit`'s `base`,
so a real conflict still surfaces. A timeout rejects with `deadlineExceeded`.

## Storage and invariants

```
<profile>/skills/manifest.json            the only mutable file; ledger domain `skills`
<profile>/skills/objects/<sha256>         one file's bytes, 0400
<profile>/skills/revisions/<sha256>.json  a revision: name, description, file list; 0400
<profile>/skills/snapshots/<sha256(session)>.json   a session's pins
```

- **Immutable, content-addressed packages.** An edit or a source update writes a new
  revision and never rewrites one. The same content always gets the same ID, so an
  edit back to the installed content clears `modified`. A record keeps its current
  revision, its installed revision and up to `maxHistory` history entries.
- **Manifest commit.** It uses the memory owner's protocol:
  1. re-read the manifest; a valid external change is adopted as a new revision, never overwritten
  2. write a temp file and `F_FULLFSYNC` it
  3. `beginEffect`, which records the target digest
  4. rename
  5. sync the directory
  6. write the receipt

  Objects and revisions are written before the manifest names them. A crash is
  reconciled from the file and never replayed:

  | Manifest after the crash | Outcome |
  | --- | --- |
  | matches the target digest | applied |
  | matches the prior digest | `ioFailure`, retryable |
  | anything else | `conflict` |

  A repeated `operationID` is answered from its receipt.
- **Collection.** It runs only on open and inside the serial queue, after the
  manifest and every snapshot have been read whole. It removes temp files, the
  manifest temp file, and revisions and objects that no record or pin keeps. Nothing
  is collected while any pin or kept revision is unreadable.
- **Snapshots** live outside the ledger: they are per-session, written once, and
  removed only by an explicit `release`. At `maxSnapshots`, a *new* session gets a
  `conflict`; existing pins are never evicted.
- **Damaged data is never replaced.** This covers:
  - a manifest that is not valid JSON, is off-format, or has out-of-range or fractional counters
  - a tampered object or revision
  - a linked `skills/` folder

  Each one answers `recoveryRequired` and stays on disk.
- **Input bounds.** Package-relative paths only: no `..`, `.` or empty components,
  absolute paths, backslashes, hidden components, trailing dots, case-duplicate paths
  or NUL. Text must be valid UTF-8. Limits on file count, file size, package size,
  depth and directory entries apply (`SKILLS_LIMITS`). `SKILL.md` must have a valid
  `name`/`description`.
- **Import.** It walks the folder with `O_NOFOLLOW` and refuses symlinks, hard links,
  FIFOs and devices. It copies text only: hidden entries (`.git`, `.DS_Store`) are
  skipped, and the source folder is never written.
- **Nothing executes and nothing is granted.** Scripts, `hooks:` frontmatter and MCP
  declarations are stored as inert text. Stored objects are not executable. The
  registry never writes a project, a provider's home or a grant, and never runs a command.

## Seams for the follow-up tasks

- **2/4, providers.** When a provider session starts, its owner calls
  `SkillsOwner.pin(session:)` with the chat's session key, which is idempotent. It
  offers only pins whose `providers[name]` is true. It reads content with
  `read {skill, session}` and `reference {skill, revision: pin.revision, path}`. A
  resumed session calls `pin` again and gets the same pins. The provider owner
  calls `release` when the chat is deleted. How a pin is offered is that task's
  decision: a Trezi tool, generated context, or materialising files into a per-session
  temp folder outside the project and the user's provider homes. It must not install
  anything into a project or a global skills folder.
- **3/4, GitHub import.** The service-side fetcher resolves the commit, reads the
  files and the license, then calls
  `SkillsOwner.install(files:source:replacing:)`:
  - `source` is `{kind: github, repository, subpath, commit (40 or 64 hex), license}`.
  - `replacing` updates an existing skill to the fetched revision and clears `modified`.

  Bun cannot claim a source: `create` refuses a `source` field. The downloaded files
  are not executed.
- **4/4, Settings UI.** Use `serviceSkills` from `src/native/skills-service.ts`:
  `list` for rows (`modified`, `enabled`, `removed`, `providers`, `source`), `read`
  and `reference` for lazy previews, and `edit` with the shown revision as `base`.
  Show `conflict` as "changed elsewhere, reload". `recoveryRequired` needs a recovery
  affordance; until that is designed, the registry stays read-blocked.

## Tests

| Test | Covers |
| --- | --- |
| `test/skills-registry.mjs` | contract parity, create/list/read, revisions and the `modified` flag, enable/providers, remove/restore/purge, snapshot stability across edit/remove/purge/restart, GitHub provenance, Bun's client |
| `test/skills-registry-safety.mjs` | injected write failures, SIGKILL at each commit step, receipts, damaged data, malicious paths and files, strict frames, concurrent writers, isolation from two repositories and two provider homes |
| `test/skills-registry-boundaries.mjs` | corrupt counters, snapshot capacity, the directory-entry budget |

All three drive the real owner and ledger in `test/fixtures/skills-owner/main.swift`
on disposable profiles.
