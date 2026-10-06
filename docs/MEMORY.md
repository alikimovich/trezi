# Project memory and chat continuity

Each open project has a flat set of peer chats. Every chat uses its generated or
user-edited title, renders newest-first, and can be renamed or closed. The plain
`projectKey(root)` session key still identifies the first process-level session, but
it has no product role or special rail treatment.

When Trezi stops a project's sessions (project close, LRU suspension, or quit), the
last-active chat is persisted as the current continuation and restored on the next
open (the transcript always; a Claude SDK resume when the record carries
`sdkSessionId`). Other stopped chats enter History. Starting a new chat is the way to
begin with fresh model context; closing the old one archives it. Records written by
older Trezi builds with `slot: 'main'` are accepted as the current continuation and
rewritten to `slot: 'current'` on the next save.

Project memory is deliberately separate from chat history and repository state:

- Stored per machine under Trezi userData (`trezi/project-memories/`), keyed by a
  hash of the canonical project root.
- Never placed in `.trezi/`, a Git worktree, a commit, or a published PR.
- Bounded to 16,000 characters because it is model context, not document storage.
- Injected into every new chat and background-agent context.
- If memory changes while a chat stays live, Trezi injects that revision once on the
  chat's next turn instead of repeating it on every turn.
- After every successful interactive turn, the selected provider runs a separate,
  tool-free evaluation that applies the principles below to the unified project memory.
- Evaluations are serialized per project. Each peer chat merges against the latest
  memory, and a manual editor save made during evaluation wins and forces a retry.
- A failed or malformed evaluation is a no-op and never affects the completed chat.
- A current user request outranks saved memory; the model is told to flag a likely
  stale decision rather than silently follow it.

## What memory holds (LKM-177)

1. Memory holds only what a future chat cannot learn from the repository and would
   get wrong without it. Every item must pass three questions: (a) still true next
   month, (b) matters for a different future task, (c) not discoverable by reading
   the code.
2. Store: the user's working preferences (check mobile width after UI changes, ask
   before deleting branches, answer briefly); product and design rules that span many
   changes ("pill-shaped controls use --radius-pill"); constraints and don'ts with the
   reason; project facts outside the repository (asset sources, target platforms,
   audience, deploy target); pitfalls learned the hard way, with the fix.
3. Never store: one-off change requests or their results (once done, the code is the
   truth), plans or unfinished work, what changed in a turn, branch or chat names,
   errors and transient states, guesses, secrets, personal data.
4. Format: one general rule per line, in imperative form, with a short reason when it
   is not obvious, under the fixed headings `## Preferences`, `## Design rules`,
   `## Constraints`, `## Project facts`, `## Pitfalls`. At most about 40 items, similar
   ones merged. A newer user statement replaces the old item.
5. A request becomes a rule only when the user states it as general ("always", "from
   now on", "in this project we…") or repeats it.
6. Memory is never a substitute for work. The agent rules (`src/main/rules.ts`, "Project
   memory is not work") say that saving to memory applies nothing and forbid reporting a
   requested change as "saved in memory". Trezi also checks it: a new design rule that
   names a CSS custom property (`--radius-pill`) is stored only when `git grep` finds the
   token in the chat's worktree or the live checkout. A search that cannot run keeps the rule.
7. Provenance and control: every rule Trezi adds ends with a hidden source tag
   `<!-- added YYYY-MM-DD -->`, visible in the editor and stripped from chat context.
   Trezi, not the model, writes the tags: a kept rule keeps its tag, a new or reworded
   rule gets the day's date, and a rule the user typed stays untagged. Each automatic
   update shows a non-blocking note, "Project memory updated: +1 rule" (or "−3 rules"
   after a cleanup), with View (opens the editor) and Undo. Undo restores the earlier
   memory, even an empty one, only while memory is still the version that update
   wrote; after any later edit it changes nothing and says so.

Cleanup: the evaluator also reviews the current memory and drops items that describe a
one-off change to a specific screen or component, or rewrites one as the general rule
the user gave. It runs on the next evaluation of an existing memory and shows the same
note with Undo.

The prompt is `projectMemoryEvaluationPrompt` (`src/main/backends/memory.ts`), which
keeps the `{"memory": … | null}` JSON protocol. Trezi's pass over a proposal (token
check, source tags) is `src/main/project-memory-evaluation.ts` and
`src/main/project-memory-format.ts`; the note is `src/native/memory-note.ts`.

## Editor and ownership

The memory editor remains the user's direct view and final override. Automatic updates
preserve its current wording unless a completed chat establishes a material addition,
the user explicitly reverses an existing decision, or cleanup drops a one-off item; every
such update can be undone from its note. Claude and Codex/connection chats
support evaluation; the experimental Gemini CLI backend currently does not.

Ownership (S05, LKM-93): the Swift service writes memory files through its operation
ledger; Bun runs evaluations and may only propose. A proposal commits only on the
revision it was evaluated against, so a manual save always wins. Undo is a save on the
revision the update committed, never retried, so it cannot overwrite a later edit; a damaged memory
file is reported and left untouched instead of being read as empty. Injection
compares the owner's digest, and unreadable memory never fails a chat.
There is no Bun writer since LKM-111 (the Bun rollback owner was removed). See
[SWIFT-BACKEND-MEMORY.md](SWIFT-BACKEND-MEMORY.md).

Implementation: `src/main/project-memory.ts`, `src/native/project-memory-service.ts`,
`src/service/MemoryOwner.swift`, `src/service/MemoryFile.swift`, `src/main/agent.ts`,
`src/main/backends/memory.ts`, `src/main/project-memory-evaluation.ts`,
`src/main/project-memory-format.ts`, `src/main/rules.ts`, `src/native/memory-note.ts`,
`src/native/Toast.swift`, `src/native/Sheets.swift` and `src/native/sheets-runtime.ts`.
Regression coverage (the native note: the settings smoke group, `src/native/smoke-alerts.ts`):
`test/project-memory.mjs`, `test/memory-owner.mjs`, `test/project-memory-evaluation.mjs`,
`test/native-sheets.mjs`, `test/rules.mjs`.
