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

Trezi Skills 2/4 (LKM-285) adds the pinned GitHub import and the curated
recommendations ([GitHub import](#github-import-lkm-285)):

- `src/service/SkillsImport.swift`: the `github`/`cancel` methods on the owner.
- `src/service/SkillsGitHub.swift`: the address parser and the fetcher.
- `src/service/SkillsHTTP.swift`: bounded, credential-free GETs.
- `src/service/SkillsArchive.swift`: the streaming `tar.gz` reader.
- `src/service/SkillsScope.swift`: the skills-only content scope and license evidence.
- `src/shared/skills-recommendations.ts`: the import side of `SKILL_RECOMMENDATIONS`
  (`src/shared/skills-catalog.ts`, shared with LKM-288).

Trezi Skills 4/4 (LKM-287) offers the pinned library to provider sessions
([provider sessions](#provider-sessions-lkm-287)):

- `src/service/SkillsProjection.swift`: the `project` method's read-only layout per
  session and provider, its reuse/rebuild and its collection.
- `src/main/session-skills.ts`: the durable skills identity, the projection call, the
  Claude plugin entry and the Codex/Gemini compatibility catalog.

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
| `release` | session | `{session}` | `{session, released}`; also removes the session's projections |
| `project` | session | `{session, provider}` | `SkillProjection`: pins once like `snapshot`, then `{path, created, skills, omitted}` for that provider (LKM-287) |
| `github` | fetch | `{url, ref?, subpath?, replacing?}` | `SkillGitHubImport`: `SkillMutation` plus `name`, the pinned `source`, `skipped`, `attribution`; answered when the fetch ends |
| `cancel` | fetch | `{operation}` | `{operation, cancelled}`; only this connection's import, only before it commits |

On the wire, "ledger", "session" and "fetch" methods all use `mode: "mutation"`, but only
ledger methods carry `expectedRevision`. A stale revision returns `conflict` with
`currentRevision`. Ledger replies carry the committed list as their `snapshot`.
Failure codes:

- `invalidRequest` (also a malformed or ambiguous GitHub address, an archive over a bound)
- `unauthorized` (a scoped frame, or an import of links, hard links or special files; for
  GitHub also a redirect, a wrong commit pin, a hostile archive or out-of-scope content)
- `conflict` (a stale revision or base, a taken name, purge before remove, snapshot
  capacity, a running operation ID, `replacing` a skill from another source)
- `notFound`
- `recoveryRequired` (damaged data, a linked registry folder, or a ledger that cannot be reconciled)
- `ioFailure` (retryable)
- `busy` (also two GitHub imports already running; retryable)
- `unavailable` (also GitHub unreachable, rate-limited or answering nonsense; retryable)
- `cancelled`, `deadlineExceeded` (GitHub import only; nothing was installed)

`serviceSkills` runs calls one at a time and remembers the last revision. For a
`conflict` that names `currentRevision`, it retries the same intent up to twice. That
is safe because every plan re-checks its own preconditions, such as `edit`'s `base`,
so a real conflict still surfaces. A timeout rejects with `deadlineExceeded`.
`importGitHub(input, {signal})` is not queued (a fetch can take minutes and its reply
arrives out of order, matched by frame `id`); aborting the signal sends `cancel`.

## Storage and invariants

```
<profile>/skills/manifest.json            the only mutable file; ledger domain `skills`
<profile>/skills/objects/<sha256>         one file's bytes, 0400
<profile>/skills/revisions/<sha256>.json  a revision: name, description, file list; 0400
<profile>/skills/snapshots/<sha256(session)>.json   a session's pins
<profile>/skills/projections/<sha256(session)>/<provider>/   its read-only layout (LKM-287)
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
- **Nothing executes and nothing is granted.** Every stored revision, whether created,
  imported from a folder, edited or installed from GitHub, passes the same skills-only
  scope (`SkillsScope`, [step 5](#github-import-lkm-285)) with the same `unauthorized`
  refusal: `hooks:`, `allowed-tools:` and other non-allowed frontmatter, hook/MCP/plugin
  and dependency manifests, dynamic `!` preprocessing and scripts (executable or not) are
  refused. Stored objects are not executable. The registry never writes a project, a
  provider's home or a grant, and never runs a command.
- **Scope on every write.** `create`, `import` and the service's `install` check the
  whole file set; `edit` checks the final set, so files carried over from the previous
  revision are read back and checked too. A refusal writes no object, revision or
  manifest change. A revision stored before LKM-285 that is out of scope is still
  readable, but an edit has to remove the offending content.

## GitHub import (LKM-285)

An explicit `github` request is the only way GitHub content enters the registry.
Nothing is preinstalled, and the curated recommendations are metadata only.

1. **Address.** `SkillsGitHubAddress.parse` accepts `https://github.com/<owner>/<repo>`
   (optional `.git`, `ref`, `subpath`) or `…/tree/<ref>/<folder>`. Only `A-Z a-z 0-9 . _ - /`
   may follow the host. It refuses:
   - another scheme or host, credentials, a port, a query, a fragment, percent-encoding
     or a backslash
   - empty, `.`, `..` or hidden components
   - `HEAD`, an abbreviated commit, and git-invalid ref components

   A tree address cannot say where a ref containing `/` ends, so every split is
   resolved. More than one match is refused as ambiguous.
2. **Pin.** The ref, or the default branch from `GET /repos/<o>/<r>`, is resolved with
   `GET /repos/<o>/<r>/commits/<ref>` (`Accept: application/vnd.github.sha`) to a full
   commit. A full-commit ref must resolve to itself. The archive is downloaded by that
   commit (`codeload …/tar.gz/<commit>`), never by a branch. Its pax global header
   `comment` (what `git archive` writes) must name the same commit, or the import is
   refused.
3. **HTTP** (`SkillsHTTP`):
   - one ephemeral session: no cookies, cache or credential store
   - every authentication challenge except server trust is cancelled, so no keychain
     item or client identity is ever looked up
   - redirects are not followed, and a 3xx is refused
   - HTTPS only (plain `127.0.0.1` exists only for the test endpoints)
   - a byte cap per response, from `Content-Length` and while streaming
4. **Archive** (`SkillsArchive`). Exactly one gzip member, inflated by the system zlib
   in 64 KB chunks with its CRC-32 and length checked. Then a ustar/pax/GNU stream with
   checksummed headers. It refuses:
   - absolute paths, traversal, NUL, non-UTF-8 or overlong names, and paths outside the
     single top folder
   - sparse or unknown entry types
   - in the imported folder: symlinks, hard links, devices, FIFOs, executable modes,
     duplicate or case-colliding paths, and a file whose ancestor is a file
   - base-256 sizes, a second global header, entries after the end marker, trailing
     data and truncation

   Only the requested folder is kept; hidden entries are skipped. The bounds apply to
   the whole archive: compressed 64 MB, expanded 256 MB, 20 000 entries and 64 KB of
   extended headers (`SKILLS_GITHUB_LIMITS`). The package limits then apply to the folder.
5. **Scope** (`SkillsScope`). Skills-only content; nothing a provider could run,
   connect or be granted. It applies to every write (`create`, folder `import`, `edit`
   and this import), not only to GitHub. It refuses:
   - dynamic preprocessing (`!` followed by a backtick) in any Markdown file
   - `SKILL.md` frontmatter beyond `name`, `description`, `license`, `compatibility`
     and `metadata`, which means `allowed-tools`, `hooks`, `context`, `agent`, `model`
     and similar are refused, as are flow mappings
   - hook, MCP, plugin, settings and dependency manifests (`package.json`,
     `requirements.txt`, `Makefile`, …)
   - a script, whether or not it is executable: a file with a script extension
     (`.sh .bash .zsh .fish .ksh .csh .py .rb .pl .php .lua .js .mjs .cjs .ts .mts .cts
     .ps1 .bat .cmd .command .scpt .applescript`, any case) or whose text starts with
     `#!`. The refusal names the file.
   - every Codex `openai.yaml` / `openai.yml` (any case, any folder, usually
     `agents/openai.yaml`). It is provider-control metadata that can declare tool and MCP
     `dependencies`, and YAML has too many spellings of that key (indented root, flow
     mapping, quoted or escaped key, complex key) for a partial parser to vet, so the
     file is refused whole and never parsed. Other YAML files are not affected.

   Nothing from a package is run. Untrusted skill text never becomes policy or a
   permission; normal tool approval still applies.
6. **License.** Evidence comes from the folder's own `LICENSE*` file, then the
   `SKILL.md` `license:` field, then the repository root `LICENSE*`. A root license is
   copied into the package as `attribution`. An unrecognised license is `NOASSERTION`
   and a missing one is `null`. `skillLicenseStatus` classes it as permissive,
   copyleft, restricted or unknown, and is shown honestly, never inferred.
7. **Commit.** A fetch writes nothing. Once it is validated, the import becomes
   uncancellable and stores the package through `install(files:source:replacing:)`
   in one ledger commit. A failure or cancellation at any earlier step leaves the
   registry byte-identical. `source` records `repository`, `subpath`, `commit`,
   `license`, the requested `ref` and `licenseFile`. `replacing` must name a skill
   imported from the same repository folder.
8. **Bounds.** At most 2 imports run at once (`busy`). A running operation ID is
   `conflict`. Each import has a 120 s deadline (`deadlineExceeded`). `close` stops
   running fetches.

Recommendations (`SKILL_RECOMMENDATIONS` with `SKILL_RECOMMENDATION_IMPORTS`):

| ID | Category | Source (path verified) | License evidence | Importable | Upstream evidence |
| --- | --- | --- | --- | --- | --- |
| `frontend-design` | UI craft | `anthropics/skills` `skills/frontend-design` | Apache-2.0 (the folder's `LICENSE.txt`) | yes | `dbd4588f`: 2 files, 19 564 B, largest 10 174 B |
| `vercel-react-best-practices` | React | `vercel-labs/agent-skills` `skills/react-best-practices` | MIT (`SKILL.md` frontmatter) | **no**: 76 files, over the 64-file cap | `063bee94`: 76 files (75 `.md`, 1 `.json`), 230 383 B, largest 108 261 B |
| `vercel-composition-patterns` | design systems | `vercel-labs/agent-skills` `skills/composition-patterns` | MIT (`SKILL.md` frontmatter) | yes | `063bee94`: 14 files, 50 339 B, largest 22 627 B |
| `swiftui-view-refactor` | SwiftUI | `steipete/agent-scripts` `skills/swiftui-view-refactor` | MIT (repository `LICENSE`) | yes | `d602e8ad`: 2 UTF-8 `.md` files, 12 565 B, largest 7 961 B (`/tmp/trezi-swiftui-compatible-recommendation.json`) |
| `swiftui-expert-skill` | SwiftUI | `AvdLee/SwiftUI-Agent-Skill` `skills/swiftui-expert-skill` | MIT (repository `LICENSE`) | **no**: scripts, images and a file over 256 KiB | `204dba7c`: 51 files (34 `.md`, 13 `.py`, 2 `.png`, 1 `.svg`, 1 `.yaml`), 901 559 B, largest 398 841 B |

The evidence was measured on the upstream trees at those commits and is recorded in
`SKILL_RECOMMENDATION_IMPORTS`. The earlier catalog path `swiftui-expert-skill` was wrong;
the folder is `skills/swiftui-expert-skill`. A recommendation is `importable` only when its
folder is instructions only and fits `SKILLS_LIMITS`; the caps are not weakened to fit a
folder. A non-importable entry carries an `unavailableReason` for the UI and
`recommendationImport` returns `null` for it, so it is never offered an import.
`test/skills-github.mjs` asserts that `importable` follows the evidence against the
caps, and that every importable entry has a verified path and a permissive license. Every
category (UI craft, design systems, SwiftUI) has an importable entry; React is the one
deliberate exception, because its only curated skill is over the file cap. If a
maintainer raises `maxFiles` (and the evidence then fits), the React entry can become
importable.

`recommendationImport` builds the `github` request on `main`. The service pins it.
`recommendationMismatch` then reports a moved folder, a renamed skill or a changed
license instead of hiding it. `skills/web-design-guidelines` is left out on purpose:
it declares no license and fetches mutable guidelines on every use.

## Settings → Skills (LKM-286)

This section is 3/4. It builds on the reviewed LKM-288 pane. The state and every
registry call are in `src/native/settings-skills.ts`. The rows and buttons of each
view are in `src/native/settings-skills-views.ts`. Both are a section of the Settings
window, wrapped like the Dreamer and Claude panes. They use only the client above, and
the UI never reads a folder or the network.

- **Overview.** One `list` gives the Installed, Recommended and Removed rows. The
  window opens at once with "Loading skills…".
  - A failed `list` (for example `recoveryRequired` or a timeout) shows "Skills are
    unavailable" and the service's message instead of an empty library.
  - The footer has Add Skill…, Import Folder… and Import from GitHub….
  - While an import runs, a "Importing <repo>…" row is shown.
- **Detail.** `read` runs only when a skill is opened.
  - The editor's row ID carries the skill and revision
    (`skill-body:<id>@<revision>`), so each revision gets a fresh draft.
  - Save Revision is `edit` with the shown revision as `base`. A `conflict` keeps the
    draft and shows the service's message.
  - Turn Off/On is `setEnabled`. Remove and Restore are `remove`/`restore`. Purge is
    not offered.
  - Source says "Added manually", "Imported from a folder" (a `manual` source whose
    first revision is `import`) or `GitHub: <repo>/<folder>`.
  - A GitHub skill also shows its pinned 40-character commit, with the ref that was
    asked for and a note that Trezi never updates it by itself. Its License row
    follows `skillLicenseStatus` and names the file the license was found in.
  - The Chats row names each enabled provider's availability (`chatsText`: "Claude:
    native", "Codex: compatibility", "Gemini: experimental"; "Off: not in new chats"
    or "No provider" otherwise). Its help states the exclusions (utility calls,
    provider sub-agents, a resume in an outside CLI) and that a chat keeps the
    revision it started with, so a saved edit reaches only chats started later.
- **Add.** A pasted SKILL.md goes to `create` with a single `SKILL.md` file. The
  service's validation message is shown as is.
- **Import Folder.** The host's open panel (`pick`) only names a folder. The service
  reads and checks it with `importFolder` and keeps its own copy. Skipped hidden
  entries are named in the message. In the native smoke, `nativeSkills.pickFolder`
  replaces the panel.
- **Import from GitHub.** The form has an address, an optional ref and an optional
  folder. `importGitHub` runs in the background, so the window stays usable.
  - Cancel Import aborts its `AbortSignal`, and the service ends it with nothing
    installed.
  - Success opens the new skill. Its message names the repository, the short commit
    and the ref.
  - A failure keeps the form and its values and starts with "Nothing was installed:".
  - The pane runs one import at a time.
- **Recommendations.** `src/shared/skills-catalog.ts` is read-only metadata. A row
  reads Installed or Removed only when a library skill comes from that
  repository folder. The group starts with "Not installed until you choose Install".
  - Install appears only when the folder is not in the library. It runs
    `importGitHub(recommendationImport(entry))`, and any `recommendationMismatch` is
    named in the message.
  - Entries that cannot be imported show "Can’t be installed" with
    `unavailableReason`, and a disabled Install. A disabled action is refused by
    `NativeSheetController.action` too, and Swift draws it with `.disabled`.
- **Legacy installer.** The agent tools keep their names, so provider policies and
  their golden file do not change.
  - `install_skills` now answers that skills are managed in Settings → Skills and that
    nothing was installed. It never reaches the workflow owner. Skills already in a
    project's or the user's `.claude/skills` are neither migrated nor deleted.
  - `list_recommended_skills` lists this catalog.
  - The prompt rules tell agents to suggest, not install.
- **Native evidence.** The native smoke `skills-settings` (`src/native/smoke-skills.ts`
  and `src/native/smoke-skills-imports.ts`, group `settings`) runs on the disposable
  profile. It covers add, open, save, on/off and remove/restore, then a folder import,
  a GitHub import pinned to tag `v1`, a recommendation install and a disabled Install.
  `src/native/skills-verification.ts` checks every capture against the rendered window.
- **Loopback GitHub for tests.** `scripts/start-native.mjs --test` starts
  `src/native/skills-github-fixture.ts` on port 0 and passes the port as
  `TREZI_SKILLS_GITHUB_FIXTURE_PORT`. `SkillsGitHubEndpoints.fixture` exists only in a
  binary compiled with `-D TREZI_TEST_PROFILE` (`profileDefines('test')` in
  `scripts/native-swift.mjs`, i.e. `TREZI_BUILD_PROFILE=test`); a release build has no
  such code and no environment variable can redirect it. Even a test build uses the
  fixture only when `TREZI_NATIVE_TEST_DIR` is set and the profile is inside it. Every
  other launch uses github.com, with the production host and commit-pin checks intact.
  The native smoke therefore exercises the real service importer (hostname, archive and
  commit-pin logic, vetting, registry writes) against a loopback HTTP server; it does
  not reach github.com. `test/skills-github-import.mjs` covers the importer's
  refusals, and `test/native-build-cache.mjs` asserts the define is test-only.

## Provider sessions (LKM-287)

Every session Trezi starts pins the library once and keeps those pins for its life.
That covers foreground, additional, resumed, background, comment and visual-edit
sessions, and custom endpoints too: they all go through `startProviderSession`.

- **Identity.** The pins hang on `SessionRecord.skillsSession`, not the chat's
  `emitKey`. It is a new `trezi-<uuid>` for a new session, and the saved one for a
  restored chat, a resume, a model or backend restart, or a stale-resume fallback.
  `seedFromRecord` copies it. A record saved before LKM-287 gets an identity on its
  next start and keeps it from then on. Pins are never swapped while a session runs.
- **Projection.** `project {session, provider}` creates the pins like `snapshot` and
  lays out the revisions offered to that provider under
  `<profile>/skills/projections/<sha256(session)>/<provider>/`. Every file is 0400
  and every folder 0700. The folder holds `catalog.json`
  (`trezi-skills-catalog-v1`: names, descriptions, revisions, entry paths and sizes)
  and `skills/<name>/…`. For Claude it also holds `.claude-plugin/plugin.json`, which
  names `trezi-library` and nothing else.
  - The layout depends only on the snapshot. An intact projection is reused. A
    changed byte, an extra file or a missing folder rebuilds it in a temp folder,
    which is swapped in whole with `renamex_np(RENAME_SWAP)`.
  - Each revision is checked against `SkillsScope` again. A revision that is
    unreadable, outside the skills-only scope (one stored before LKM-285) or a
    duplicate name is left out. It is named in `omitted`, and the chat shows it
    once, at the start of its first turn.
  - `release` removes the session's projections. Collection on open removes the
    projections of sessions that have no snapshot, and temp leftovers.
- **Release.** Bun releases an identity only when no saved record and no live
  session still names it: a background run that landed, or a chat removed from
  History. A kept conversation keeps its pins, so a later resume reads exactly
  what it started with.
- **Handing it to the provider.** A helper-hosted session passes the folder in its
  open frame as `context.skills`. `ProviderOwner` accepts only
  `<profile>/skills/projections/<64 hex>/<that provider>`
  (`ProviderLaunch.skillsProjection`). A fallback helper projects the same pins for
  its own provider. A custom endpoint (Codex in Bun) projects in
  `startProviderSession`. A failure or a timeout leaves the session without app
  skills and says so once. It never blocks the chat.
- **Claude: native.** The folder is one more SDK `plugins` entry, placed after the
  bundled `trezi` plugin with `skipMcpDiscovery: true`. Skills appear as
  `trezi-library:<name>`. Everything else is unchanged and is asserted by
  `test/session-skills.mjs`: `settingSources` user/project/local (so managed
  policies and the user's and repo's own skills still load), strict MCP with only
  the `trezi` server, the personal-plugin preference, `allowedTools`, the original
  HOME and auth, the managed-browser env and the combined hooks.
- **Codex and custom endpoints: compatibility.** The first turn carries a labelled
  "Trezi Skills (compatibility catalog)" section after the Trezi rules. For each
  skill it gives a one-line name and description (whitespace and backticks
  flattened) and the read-only `SKILL.md` path, within a 24 KB budget. The rest is
  counted and pointed to `catalog.json`. Codex reads a body with its existing file
  tools only when a task matches.
  - No Codex config, `skills/extraRoots`, MCP server, tool or sandbox setting
    changes. The Git and browser guard hooks are kept.
  - This is not Codex's native skills system. The SDK's Codex 0.160.1 accepts
    `skills/extraRoots/set` only in a dedicated app-server, which `codex exec` does
    not expose, and Trezi does not migrate to the app-server.
- **Gemini: experimental.** Gemini gets the same catalog, labelled experimental.
  Gemini CLI may limit file reads to the workspace, so the catalog tells it to say
  so rather than guess.
- **Not covered.** Utility calls never get skills. That means Claude
  `generateTitle`, `complete` and `updateProjectMemory` (still `settingSources: []`,
  no tools, strict MCP, deny-all) and Codex `complete` (an isolated temp cwd/config,
  read-only, no network). Trezi does not claim that a provider's own sub-agents
  (Claude's Task agents, Codex's sub-agents) inherit the plugin or the catalog: this
  is unverified, so the UI says they don't get skills. A conversation resumed
  outside Trezi in the provider's own CLI keeps whatever its history already says.
  Trezi never edits that history or the CLI's config and auth.
- **Isolation.** Nothing is written to a project, `~/.claude`, `~/.codex`,
  `~/.gemini` or any global skills folder. Projections live only in Trezi's
  profile, which `ProviderPolicy` already keeps agents from editing.

## Seams for the follow-up tasks

- **Providers (LKM-287, done).** See [provider sessions](#provider-sessions-lkm-287).
- **2/4, GitHub import (LKM-285, done).** See [GitHub import](#github-import-lkm-285). Bun
  still cannot claim a source: `create` refuses a `source` field, and only the
  service's own fetch reaches `install`.
- **3/4, Settings UI (LKM-286, done).** See
  [Settings → Skills](#settings--skills-lkm-286). `recoveryRequired` still has no
  recovery affordance: the pane shows the service's message, and the registry stays
  read-blocked until one is designed.

## Tests

| Test | Covers |
| --- | --- |
| `test/skills-projection.mjs` | `project` over the real owner: layout, plugin manifest, provider filter, modes, strict frames, versions/removal/resume pinned, reuse and swap-in rebuild, release and collection, legacy out-of-scope and unreadable revisions omitted, hostile descriptions, concurrent sessions, two projects and provider homes untouched, Bun's catalog budget and the Claude plugin entry |
| `test/session-skills.mjs` | the session seams: durable identity (new, resumed, never `emitKey`), release rules, the note inside a turn, `startProviderSession` (Bun and helper paths, `context.skills` per provider), Claude options with the SDK mock (plugins, settingSources, strict MCP, HOME, browser env, hooks), Codex first-turn catalog with its hooks and config untouched, utility calls still isolated |
| `test/provider-owner.mjs` (LKM-287 part) | the owner refuses a skills path for another provider, outside the projections, traversing or malformed, and accepts a well-formed one |
| `test/skills-registry.mjs` | contract parity, create/list/read, revisions and the `modified` flag, enable/providers, remove/restore/purge, snapshot stability across edit/remove/purge/restart, GitHub provenance, Bun's client |
| `test/skills-registry-safety.mjs` | injected write failures, SIGKILL at each commit step, receipts, damaged data, malicious paths and files, create/import/edit refusals for out-of-scope frontmatter, control manifests and dynamic shell with the registry unchanged, strict frames, concurrent writers, isolation from two repositories and two provider homes |
| `test/skills-registry-boundaries.mjs` | corrupt counters, snapshot capacity, the directory-entry budget |
| `test/skills-github.mjs` | GitHub limits/modes/recommendation parity; address parsing; archive reading, license evidence, hostile archives (zip-slip, links, specials, executables, header tricks, truncation, trailing data, bombs) and the skills-only scope (dynamic shell, tool/hook/agent frontmatter, manifests, Codex dependencies), offline |
| `test/skills-github-import.mjs` | the import over a loopback GitHub (`node:http`, port 0): the commit pin and provenance, ambiguous/missing/short/mismatched refs, bad pins, redirects, 403/404, hostile content with no partial install, size bound, cancel (same and other connection), deadline, close, busy, duplicate operation, `replacing`, Bun's client and abort |
| `test/settings-skills.mjs` | the Settings pane through the sheet runtime, over `src/native/skills-github-fixture.ts`: catalog metadata, overview, lazy read, add, save as revision, edit conflict, on/off, remove/restore, folder import (cancelled picker, skipped entries, a file refused), a pinned GitHub import, a failed one keeping the form, cancel, recommendation install and a disabled Install, an unavailable service, and the rendered-evidence checks (`test/helpers/settings-skills-evidence.mjs`) |

All of them drive the real owner and ledger in `test/fixtures/skills-owner/main.swift`
on disposable profiles. Archives come from `test/helpers/skills-archive.mjs`; no test
reaches the network.
