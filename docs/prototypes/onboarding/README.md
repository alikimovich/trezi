# LKM-223 — Phase 1 interaction proposal

Open [index.html](index.html) locally in a browser. It is a standalone, clickable design artifact: it makes no network requests, stores no credentials, and creates no project. The small **Prototype controls** rail injects simulated provider and creation outcomes so every failure can be reviewed without a real account or a system dialog. The native implementation is not begun.

## Low fidelity flows

### Provider connection

```
First run / AI providers
  ├─ Codex: detect app-server → account/read
  │    ├─ unavailable → Install Codex / Check again
  │    ├─ signed out → explain browser handoff → Start sign-in
  │    │    ├─ browser/consent pending → Waiting, Cancel, Retry
  │    │    ├─ completed → Connected, Switch account, Sign out
  │    │    └─ cancelled / expired / error / offline → reason + recovery
  │    └─ connected on relaunch → Connected (fresh account/read)
  └─ Claude: Console API access (separate billing)
       ├─ no key → Open Console / secure key entry / Connect
       ├─ validation/error/offline → inline reason + retry
       ├─ connected → Connected, Replace key, Clear key
       └─ expired/revoked → replace or clear
```

The Codex in-progress card says, “We’ll open your browser to sign in with ChatGPT. Trezi never sees your password.” If Claude Console is opened, the card says, “We’ll open your browser to create a Claude API key. API usage is billed by Anthropic.” The Claude flow has no subscription login button. A cancelled or closed browser returns to signed out after a bounded wait or explicit Cancel; no pending state survives restart. A status failure remains “Unable to check” rather than falsely “Signed out.” The prototype's outcome switch models these paths; actual timeouts and service behavior belong to Phase 2.

### New Project

```
New Project → opening prompt
  1. Name (free text; suggest from idea when known)
  2. Location (default ~/Projects; editable path; verify on confirmation)
  3. Starting point (React starter / plan with Next.js / Svelte / help me choose)
  4. Preview target (inferred from starting point; optional edit)
  5. Agent (available connection or ask later)
  → review all answers → edit any row → Confirm create
    ├─ success → open created project
    └─ error → keep all answers, retry or edit
```

Trezi opens the conversation and one question is active at a time. The prototype shows previous answers as conversation turns. Quick picks fill the answer, while free text can override it. Back preserves answers. Earlier answers are editable from review; changing a starting point updates its inferred preview only if the preview was not manually changed. The summary lists exactly the values that will be submitted. Cancel asks for confirmation when any answer differs from the defaults. No project is created before confirmation; if creation fails, the dialog stays open with the answers intact. The final name and destination are validated again at confirmation, including duplicate destination and permissions in Phase 2. The prototype simulates that result and never touches the filesystem.

## Content, accessibility and recovery notes

- Tab order follows the question, choices, Back/Continue, and cancel. Enter submits a text answer; Escape requests cancel. Native implementation needs SwiftUI/AppKit focus management, a visible focus ring, Dynamic Type, and VoiceOver announcements for question, validation, auth state and creation result. The prototype uses labels, live status text, keyboard controls and `prefers-reduced-motion`.
- Auth errors have a specific next action: install/check again, return to signed out/retry, reconnect, or use the alternate API-key method. Offline state keeps user input and asks to retry when connected.
- Claude key entry must be a native secure field and held only until the service stores it in scoped Keychain. The prototype uses an HTML password field and does not read, save, log, or display its value.
- The prototype's body text `#17212b` on `#f7f7f4` passes APCA at 16/400 (Lc 98.3); secondary text `#303e4c` passes at 16/400 (Lc 90.4); white on the primary `#234768` passes at 16/400 (|Lc| 96.5). Actual native semantic colors and both appearances need a fresh audit in Phase 2.

## Review gate

Approve or revise the provider language, the five-question order/defaults, and the review step before any Phase 2 code. Authentication and project setup should become linked implementation issues. Native screenshot and VoiceOver/keyboard walkthrough evidence cannot be produced from this isolated HTML proposal; they are Phase 2 acceptance work.
