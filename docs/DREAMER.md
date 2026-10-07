# Dreamer (LKM-202)

The Dreamer reads past chat sessions on this Mac, finds what slowed the user down or
went wrong, and proposes improvements. The user reviews and edits the proposals, then
exports them or sends them to Agent OS, which turns each into a task. It never edits
code, and nothing leaves the Mac until the user exports or sends.

## Menu

- **Trezi → Run Dreamer…** (`dreamer-run`): choose the chats (all projects or one) and
  the time range (7, 14, 30, 60 or 90 days, default 14). The sheet shows each range's
  estimated size (chats, turns, tokens) and the model before the run. Closing the sheet
  during a run lets it finish in the background; a toast offers Review.
- **Trezi → Dreamer Proposals…** (`dreamer-review`): the review window for the last run.
- **Trezi → Export Dreamer Report…** (`dreamer-export`): the save panel for the zip.

The last result, with the user's edits and selection, is kept in the preference
`trezi:dreamer:last`, so the review window reopens it after a relaunch.

## Inputs

All local, read only:

- saved chat records (`SessionRecord`, plus live chats): user turns with their start
  and finish times, assistant replies, refusals and error replies;
- the product log (`~/Library/Logs/Trezi`, kept 7 days, so a longer range has log
  statistics for the last 7 days only):
  - `tool` `Tool step tool=<name> ms=<n>` debug lines (`src/main/turn-log.ts`, from the
    provider's status events; written only for turns run after LKM-202);
  - `landing` `Landing outcome=…` lines, `parking` lines and anything mentioning a
    conflict;
  - error lines and chat warnings (failures, turns not sent);
  - `feedback` `Feedback posted` lines.

A one-project run keeps only log lines about that project's chats.

## Stage (a): the digest

`buildDigest` in `src/main/dreamer-digest.ts` is pure and deterministic: the same
records, log lines and time give the same digest. It holds:

- totals: chats, turns, timed turns, median and 90th-percentile turn time, tool steps,
  retries, failures, refusals, island steps, feedback;
- per project: chats and turns;
- the five slowest turns;
- the ten tools with the most total time (count, total, average, p90, max);
- repeated failures grouped by message, with up to five chat ids;
- retries: a turn that repeats the previous request, or corrects the agent ("no,",
  "that's wrong", "you forgot", "still broken", …);
- repeated request patterns (lowercased words with paths, quotes and numbers replaced)
  seen at least twice;
- landing outcomes, parking events and conflicts.

Every quote is redacted and cut to 160 characters. Nothing else from a transcript is
in the digest.

## Stage (b): the proposals

`createDreamer().run` in `src/main/dreamer.ts` sends the digest as one tool-free
completion to the provider and model of the active chat (`dreamerCompletion` in
`src/main/agent.ts`), with a 5-minute limit, and parses the JSON answer. The answer is
normalised to version 1 (at most 10 proposals), every text is redacted again, and
evidence pointing at a chat id that does not exist is dropped. Cancel stops the run.

If there are no turns in the range, the provider has no one-shot completion, the
model fails, or its answer has no valid proposal, the digest's own findings become the
proposals (`digestProposals`: slowest tool, repeated failure, repeated corrections,
request template, parks and conflicts, slow turns). The report says so.

The estimate before the run is the prompt's length / 4 plus 4000 answer tokens.

## The file: version 1

`src/shared/dreamer.ts` (`dreamerErrors` validates, `normalizeProposal` repairs).
The schema and limits match Agent OS's importer exactly: only `version`, `proposals`
and each proposal's `id`, `title` and `category` are required. `generatedAt` and
`effort` are optional, a missing `problem`, `proposal`, `impact`, `evidence`,
`acceptance` or `areas` is empty, and an evidence item is a string or any object.
Trezi's own runs always write `generatedAt` and object evidence.

```json
{
  "version": 1,
  "generatedAt": "2026-10-07T09:00:00.000Z",
  "scope": { "project": null, "days": 14 },
  "summary": "Short Markdown: what the run looked at and what stood out.",
  "proposals": [
    {
      "id": "speed-bash",
      "title": "Speed up Bash steps",
      "category": "speed",
      "problem": "Bash took the most tool time: 12 steps, 340 s in total.",
      "evidence": [
        { "session": "<chat id>", "turn": 3, "quote": "run the tests again",
          "numbers": { "steps": 12, "totalMs": 340000 }, "note": "optional" },
        "a plain string is also valid evidence"
      ],
      "proposal": "Cache the test run between turns.",
      "impact": "Shorter turns.",
      "effort": "M",
      "acceptance": ["Bash p90 drops in the next digest."],
      "areas": ["tools"]
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `version` | `1` |
| `generatedAt` | optional string (Trezi writes an ISO date) |
| `scope` | optional: `project` (a project key or `null` for all), `projectName`, `days` |
| `summary` | optional string |
| `proposals` | 1–50 items |
| `id` | non-empty, unique, at most 100 characters |
| `title` | non-empty, at most 200 |
| `category` | `improvement`, `template`, `tool`, `speed` or `bug` |
| `problem` / `proposal` / `impact` | optional strings, at most 5000 / 10000 / 2000 |
| `effort` | optional: `S`, `M` or `L` |
| `acceptance` / `areas` | optional: at most 30 strings of at most 1000 / 200 |
| `evidence` | optional: at most 30 items, each a string of at most 1000 characters or an object. Trezi writes objects with optional `session` (chat id), `turn` (1-based user turn), `quote` (≤ 200), `numbers` (name → finite number) and `note` (≤ 1000); only `session` opens a chat |

The zip's `report.md` is `dreamerMarkdown`: the summary and one section per proposal
with its evidence and an acceptance checklist.

## Review window

A sectioned window (`src/native/dreamer-review.ts`, `src/native/dreamer-controller.ts`):

- **Overview**: a category filter, how many proposals are selected, the run's summary,
  where Send goes, and the task ids of the last send.
- **One pane per proposal**: Send to Agent OS (Selected / Not selected), editable
  title, category, problem, proposal, acceptance criteria (one per line) and expected
  impact, the evidence, and Open Chat buttons for the first three evidence chats (they
  open the saved chat, not the turn).
- Actions: Select All, Select None, Copy as JSON, Export…, Send to Agent OS.
  Edits save automatically. With nothing selected, Copy and Export take every proposal.

## Send to Agent OS

Settings → Dreamer holds the Agent OS URL (default `http://127.0.0.1:4317`), the
project ID, an optional token (Save Token / Remove Token), "When tasks are created"
(Only create them, the default, or Start them on import) and Run the Dreamer (Off, or
Weekly, while Trezi is idle). Send (`sendToAgentOs` in
`src/native/dreamer-export.ts`) makes one request:

- `POST <url>/proposals` with `{ "projectId": "<projectId>", "file": <file>, "start": false }`.
  `file` is the version 1 file of the selected proposals, redacted again. `start` is
  `true` only when "Start them on import" is chosen; Agent OS then starts a worker on
  each created task. `Authorization: Bearer <token>` is sent when a token is set;
  30-second limit.
- The answer's task ids are read from `created[].issue` (Agent OS), `tasks[].id`,
  `taskIds` or `ids`, and shown in the window and on the Overview.
- On any failure the window says why and opens the save panel for the export instead.
  An HTTP error keeps Agent OS's own message (`Agent OS answered 400: …`).

Agent OS listens on 127.0.0.1 only, so Send works only on the Mac that runs it. When
Agent OS cannot be reached the window says so ("accepts connections only on this Mac
(127.0.0.1)") and offers the export.

**Another Mac.** Export the report (or Copy as JSON), copy `proposals.json` to the Mac
that runs Agent OS and import it there:

```sh
bun run cli import-proposals <project> <file.json> [--start]
```

`--start` is the same as "Start them on import".

The token is stored in Trezi's preferences, not the Keychain, and is never shown again
after it is saved.

## Export

`exportDreamerReport` writes a temporary `Dreamer Report` folder and zips it with
`ditto`: `report.md`, `proposals.json` (the version 1 file) and `evidence.json` (the
digest: statistics and short quotes, never transcripts or file contents). Everything
is redacted again on the way out, because the user may have edited the text.

## Privacy

- `dreamerRedact` = the product log's `redact` (token shapes, `key=value` secrets, URL
  credentials, private keys, the home folder) plus emails (`[email]`) and any
  `/Users/<name>` or `/home/<name>` path (`~`).
- Quotes are one line of at most 160 characters in the digest, 200 in the file.
- The model sees only the digest. Export and Send run only on the user's action.
- The product log records only counts: `Dreamer run sessions= turns= proposals=
  fallback= ms=`, `Proposals sent|not sent`, `Report exported`, `Weekly run failed`.

## Weekly run

Off by default. With Settings → Dreamer → Run the Dreamer set to weekly, an hourly check starts an
all-projects, 14-day run when the last run is at least a week old, no chat is
streaming, sending or queued, and no sheet is open. A toast offers Review.

## Tests

- `test/dreamer-digest.mjs`: the digest over fixture chats and log lines (a slow tool,
  a repeated failure, a repeated request, corrections, a refusal), redaction, the
  version 1 validation, answer parsing, and a run with a stub model and each fallback.
- `test/dreamer-export.mjs`: the zip's contents are redacted; Send's URL, token header,
  404 fallback and errors; the review window's Send shows task ids and falls back to
  the export; the weekly run's conditions.
- Native smoke `dreamer` (group `settings`, `src/native/smoke-dreamer.ts`): the review
  window from the menu with a fixture result; Send to a local stub shows the task id; a
  proposal pane. Both panes are captured in the foreground with the test-only
  `captureVisibleSheet` host request (`captureSheet`'s cached display leaves a sectioned
  window's split view blank); `dreamer-review.json` records which capture was used.
