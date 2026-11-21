# Test failure log (LKM-776, two-week evidence window)

Started 2026-11-21; the window closes 2026-12-05. Every test failure you fix, in a
Forge round, in CI or locally before a commit, gets one row here in the same commit
as the fix. Newest first. The file union-merges like the progress log.

After the window a separate task reads the log. A test file whose rows are all
**change detector** may be deleted and its pattern banned in `AGENTS.md`. Nothing is
deleted during the window. Tests for authorization, privacy, migrations or
concurrency are never deleted, whatever their rows say.

Kinds:

- **caught regression**: the product was wrong, and the test failing stopped the bug.
- **change detector**: the product was right; the test failed only because it pins
  something that changed on purpose (copy, layout numbers, file lists, call order).
- **test bug**: the test itself was wrong (race, leak, timing, fixture). Fix the test;
  a test that needs a retry has a bug. Never retry, widen a timeout or skip to pass.

| Date | Ticket | Test file | Kind | What failed, and why |
| --- | --- | --- | --- | --- |
| 2026-11-21 | LKM-776 | `test/sidebar-marquee.mjs` | test bug | Fixture `resize()` let a late plan sample before the title's next frame applied the new travel (offset 155 > travel 115); it now waits for that frame, as `select()` does. |
| 2026-11-21 | LKM-776 | `test/session-skills.mjs` | test bug | A `< 2000 ms` wall-clock ceiling read 2053 ms at load ~190; replaced by the ordering it stood for (the start gives up before the stuck edit settles). |
| 2026-11-20 | LKM-763 | `test/browser-tools-install.mjs` | test bug | Cancelled install's rejection was handled too late; Bun flagged it unhandled. |
| 2026-11-20 | LKM-763 | `test/spawn-phases.mjs` | test bug | 400 ms lease timer started before Apply reached the lane. |
