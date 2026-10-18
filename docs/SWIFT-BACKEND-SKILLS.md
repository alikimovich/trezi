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
   - a Codex `agents/openai.yaml` that declares `dependencies` (tools, MCP servers) in
     any form, or is not a plain block mapping: the word `dependencies` as a key
     (plain, quoted or inside a flow mapping) anywhere in the file, and any top-level
     line that is not a plain `key:` (flow `{`/`[`, complex `?`, anchor `&`, alias `*`,
     or a quoted key) is refused.

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

## Seams for the follow-up tasks

- **Providers.** When a provider session starts, its owner calls
  `SkillsOwner.pin(session:)` with the chat's session key, which is idempotent. It
  offers only pins whose `providers[name]` is true. It reads content with
  `read {skill, session}` and `reference {skill, revision: pin.revision, path}`. A
  resumed session calls `pin` again and gets the same pins. The provider owner
  calls `release` when the chat is deleted. How a pin is offered is that task's
  decision: a Trezi tool, generated context, or materialising files into a per-session
  temp folder outside the project and the user's provider homes. It must not install
  anything into a project or a global skills folder.
- **2/4, GitHub import (LKM-285, done).** See [GitHub import](#github-import-lkm-285). Bun
  still cannot claim a source: `create` refuses a `source` field, and only the
  service's own fetch reaches `install`.
- **Settings UI.** Use `serviceSkills` from `src/native/skills-service.ts`:
  `list` for rows (`modified`, `enabled`, `removed`, `providers`, `source`), `read`
  and `reference` for lazy previews, and `edit` with the shown revision as `base`.
  Show `conflict` as "changed elsewhere, reload". `recoveryRequired` needs a recovery
  affordance; until that is designed, the registry stays read-blocked. Offer
  importable recommendations with `importGitHub(recommendationImport(entry))` (show
  `unavailableReason` for the others), show
  `skillLicenseStatus(source.license)` and any `recommendationMismatch`, and pass an
  `AbortSignal` for Cancel.

## Tests

| Test | Covers |
| --- | --- |
| `test/skills-registry.mjs` | contract parity, create/list/read, revisions and the `modified` flag, enable/providers, remove/restore/purge, snapshot stability across edit/remove/purge/restart, GitHub provenance, Bun's client |
| `test/skills-registry-safety.mjs` | injected write failures, SIGKILL at each commit step, receipts, damaged data, malicious paths and files, create/import/edit refusals for out-of-scope frontmatter, control manifests and dynamic shell with the registry unchanged, strict frames, concurrent writers, isolation from two repositories and two provider homes |
| `test/skills-registry-boundaries.mjs` | corrupt counters, snapshot capacity, the directory-entry budget |
| `test/skills-github.mjs` | GitHub limits/modes/recommendation parity; address parsing; archive reading, license evidence, hostile archives (zip-slip, links, specials, executables, header tricks, truncation, trailing data, bombs) and the skills-only scope (dynamic shell, tool/hook/agent frontmatter, manifests, Codex dependencies), offline |
| `test/skills-github-import.mjs` | the import over a loopback GitHub (`node:http`, port 0): the commit pin and provenance, ambiguous/missing/short/mismatched refs, bad pins, redirects, 403/404, hostile content with no partial install, size bound, cancel (same and other connection), deadline, close, busy, duplicate operation, `replacing`, Bun's client and abort |

All of them drive the real owner and ledger in `test/fixtures/skills-owner/main.swift`
on disposable profiles. Archives come from `test/helpers/skills-archive.mjs`; no test
reaches the network.
