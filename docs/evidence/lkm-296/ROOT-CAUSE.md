# LKM-296 root cause: toolbar controls overflow at ample width

## Where the overflow decision is made

AppKit makes it, in the unified `NSToolbar` layout pass. When the items' widths don't fit, it
drops items to the overflow menu (») in `visibilityPriority` order: "…" (`more`, `.low`,
`src/native/ToolbarMore.swift:13`) first, then the address block (standard), then the
`.high` items (chat header `src/native/Shell.swift:294`, right groups `:265`/`:316`).

Trezi only feeds it widths:

- **Address block width.** `ToolbarAddressLayout.width` (`src/native/ToolbarAddress.swift:308`)
  computes `windowWidth - rightInset - gap(20) - extra - blockLeading`.
  - `blockLeading` (`:306`) is the chat header's trailing edge plus `chatOffset`, or the
    measured `leading` when there is no chat header.
- **Chat header width.** `alignChatHeader` (`src/native/Shell.swift:222`) sets it from its
  leading edge to the chat column's edge, capped by `chatLimit`.
- **Inputs.** `measureToolbar` / `measure` / `backOff` (`ToolbarAddress.swift:173`, `:286`,
  `:299`) read them from the last toolbar layout: `leading`, `chatOffset`, `rightInset` and
  `extra`.
- **When it runs.** Asynchronously, after:
  - a toolbar or chat-header layout (`Shell.swift:5`);
  - a split resize (`splitResized`, `Shell.swift:195`);
  - a window resize.

AppKit needs 14–16 pt between the block and the first right group, and `gap` is 20. That
leaves 4–6 pt of slack. Any width computed for a position more than about 5 pt left of
where the item actually lays out overflows "…", or the block itself.

## Mechanism (from frame-by-frame passive traces, no forced layout)

Expanding or restoring the preview (`update`, `Shell.swift:483–502`) does two things in
one turn:

- animates `sidebarItem.isCollapsed` (0.24 s);
- removes or inserts the `chat` toolbar item.

Every input above is a **position from the previous layout**. The widths are always one
layout behind the items' real positions:

1. **Expanding** (sidebar closes, chat header removed). With no chat header, the block's
   leading came from `leading` (140 pt). That is where the block starts only after the
   sidebar has fully closed. During the animation the block still started further right, so
   it was sized too wide.
   - Address and "…" went to the overflow menu for 1–4 frames.
   - `backOff` (+40 pt to `rightInset`) then repaired it.
   - Captured in `before-fix/toolbar-overflow-session-first-expand-transition.png`: the
     address is gone and » shows at the top right.
2. **Restoring** (sidebar opens, chat header inserted). The widths followed the sidebar
   instead of leading it:
   - The chat header's target used the detail column's *current* edge.
   - Its leading edge used the header's frame, which lags the split by a layout (6–10 pt
     near the end of the animation).
   - Each animation step moved the items right before their widths shrank, so near the end
     the block and header together ran 2–6 pt past the slack and "…" overflowed for 1–5
     frames.
   - Earlier in the animation the block itself overflowed.
3. **Inserting the chat item** while the block still had its expanded width (712 pt at
   1320) made AppKit overflow the chat header until the next measure. This happened in rapid
   expand/restore.
4. **Resizing the sidebar** (split resize). `splitResized` measured before AppKit laid the
   toolbar out for the new split. With the block already overflowed there was nothing left
   to measure, so in an earlier native run the block stayed in the overflow menu at a
   340 pt sidebar.

`extra` (frame minus constant) could also go negative when read from a frame laid out
before the constant grew, which widened the block.

## Fix (smallest change to those inputs)

- **Expanding: `blockSlot`** (`ToolbarAddress.swift:199`). With no chat header, the block
  is sized from where it was last laid out (never left of `leading`) rather than its final
  position.
- **Restoring: `sidebarOpening`** (`:208`) and **`chatHeaderLeading`** (`:221`) in
  `alignChatHeader` (`Shell.swift:228–238`).
  - The chat header and block are sized for where the chat column **settles**: the detail
    edge plus the remaining sidebar travel.
  - The header's leading edge uses the offset from the detail column seen at rest, not its
    lagging frame.
  - The opening sidebar then only moves items to the right, into room already reserved.
- **Inserted chat header** (`Shell.swift:240`, `:507–511`). It takes the block's slot.
  `update` narrows the block and lays the toolbar out right after inserting it, so AppKit
  never fits it beside the wide block.
- **Split resize** (`Shell.swift:195`). The toolbar is laid out before it is measured.
- **`extra`** is never negative (`measure`, `ToolbarAddress.swift:286`).

Narrow windows are unchanged:

- Below the 850 pt minimum the real controls (address, publish) still overflow.
- "…" is hidden on purpose by `fitMore`.

## Evidence

All captures are foreground windows (`captureVisibleWindow`), taken before any forced layout.
The JSON holds per-transition summaries plus every frame that had an overflow.

| Transition (900 ms trace, every frame) | Before: frames with address / "…" in » | After |
| --- | --- | --- |
| first expand of the session, 1320 | 2 / 2 | 0 / 0 |
| expand, 1320 and 1810 (launch and again) | 1–4 / 2–4 | 0 / 0 |
| restore, 1320 and 1810 (launch and again) | 1–2 / 3–5 | 0 / 0 |
| expand / restore with sidebar 340, 180, 230 | 1–4 / 3–4 | 0 / 0 |
| restore after a narrow window was widened | 1 / 3 | 0 / 0 |
| rapid expand (5 toggles) | 3 address / 3 | 0 / 0 |
| rapid restore (5 toggles) | 1 chat / 0 | 0 / 0 |
| narrow window (688 pt), collapsed | address + publish (expected) | address + publish (expected) |

- `before-fix/`: run before any product change. `after-fix/`: run with this fix, strict
  assertions, native core 42/42.
- `before/`: earlier fixture captures of the collapsed and expanded toolbar.
- The settled captures `toolbar-overflow-session-first-expand.png` and
  `toolbar-overflow-narrow-collapsed.png` are byte-identical before and after. The bug was
  transient in those states and the fixture is deterministic.
- Full screen was not exercised.

## Regression introduced by the first fix, and its repair

The manager's full suite failed the existing `toolbar-address` check at 850 pt before the
overflow fixture ran: gap 28, expected 20, with the block 8 pt too narrow.

A diagnostic native run (sidebar, settings and core, manager log `worker-verify-2.log`)
reproduced it:

| Field | Reproduced value | Real settled value |
| --- | --- | --- |
| `sidebarInset` | 16 | 8 |
| `chatLead` | -34 | 8 |
| `extra` | 0 | 0 |
| `addressConstant` | 109 | — |

**Cause.** The first fix's `sidebarOpening` learned `sidebarInset` on every alignment as
`min(16, max(previous, detail - open))`, so it could only grow.

- During the sidebar group's 260/180 pt resizes (`setPosition`), a transient split frame
  latched it at 16.
- Every later at-rest alignment then reserved an 8 pt "opening" that never came, so the
  chat header was assumed to start 8 pt right of where it is.
- The block lost those 8 pt.
- Core-only runs never resized the sidebar before `toolbar-address`, so they passed.

The baseline code has no such cache. That it passes this assertion is inferred from the
source; it was not re-run.

**Repair** (`ToolbarAddress.swift:208–229`, `Shell.swift:486–498`):

- The reservation applies only while `update`'s own sidebar animation is in flight. The
  `sidebarAnimations` count goes up there and back down in the animation's completion.
- At rest the reservation is 0 and the layout is the pre-LKM-296 one.
- `sidebarInset` and `chatLead` are relearned at rest as the latest value, clamped to
  0–16, so a transient frame lasts at most until the next layout.

**Regression.** After each sidebar resize plus expand/restore, the overflow fixture asserts
the block's 20 pt gap at rest.

### Second repair: the end of the restore animation

With the repair above, the 850 pt gap passed (native sidebar, settings and core). The strict
trace then failed with "…" in the overflow menu for exactly one frame (about 254 ms) in three
of the 24 transitions: `launch-restore-1320`, `sidebar-340-restore` and `sidebar-230-restore`.
Zero frames had actionable overflow. The raw PNG and JSON are kept by the manager
(`settled-offset-attempt-1`).

In that frame the chat item reached its settled x (234) but was 5–7 pt wider than settled
(439 vs 434 at 1320; 323 vs 316 at sidebar 340). The block moved right by the same amount
and pushed the right groups.

**Cause.** The header's width had been computed from its lagging, laid-out x, in two cases:

- With the detail column settled (`opening` 0) but the toolbar items not yet caught up,
  `chatHeaderLeading` took its at-rest path.
- After the animation's completion zeroed `sidebarAnimations`, the next alignment ran
  before AppKit had laid the items out at the destination. That alignment also relearned
  `chatLead` from those lagging frames.

**Repair.**

- While `sidebarAnimations` is non-zero and the sidebar is open, `chatHeaderLeading` always
  uses the settled position: the larger of the laid-out x plus the remaining travel, and the
  settled detail edge plus `chatLead`. This holds even once `opening` is 0.
- The completion lays the window out at the destination, then leaves transition mode, then
  aligns once.

**Verified.** Native sidebar, settings and core: 50/50 (agentos `worker-verify-2`,
e3c98885). That covers groups only, not the full suite.

- In the overflow fixture, 1,125 frames were at ample width across the 22 wide transitions.
  None had actionable overflow and none had "…" in the overflow menu.
- Narrow (688 pt) still overflows address and publish, with "…" hidden on purpose.
- `toolbar-address` at 850 pt: gap 20, `sidebarInset` 8, `chatLead` 8.
- Evidence is in `after-repair/`:
  - `toolbar-overflow-summary.json`: per-transition counts;
  - `toolbar-address-minimum.json`;
  - two foreground transition captures.
- `before-fix/` and `after-fix/` are unchanged. The failed runs (`full-suite-attempt-1`,
  `settled-offset-attempt-1`) are kept by the manager.

### Review follow-up: every frame asserted

The independent review of e61c3ad9 asked that the manual sidebar resizes (340/180/230) be
asserted frame by frame too. Their earlier settled-only exemption is gone; only the test
changed.

- **Focused native run (agentos 493ec0cc).** `toolbar-address` passed: 1,122 ample-width
  frames, 0 actionable, 0 "…". That includes 53/52/53 frames for the sidebar resizes.
- **Not a full suite pass.** The run was stopped after that check at the user's request. The
  user chose to reuse e61c3ad9's full native 66/66, since the application code is unchanged.
- **Raw evidence.** Kept by the owner (`review-followup-focused-evidence`).
