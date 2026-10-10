---
name: trezi-doctor
description: Diagnose and recover from provider, workspace, Git and preview errors in Trezi
---

# Trezi doctor

Read `docs/SELF-HEAL.md` for the incident catalog. Keep one short user-facing status and the exact next step when recovery fails. Do not paste raw logs into the chat.

Use read-only diagnostics first: Trezi's redacted product logs, `git status`, process status, available disk space and the relevant provider's connectivity from its helper. Do not print credentials or full environment values; report variable names only. Never run a target dev server yourself.

Safe actions: retry a failed read or provider request with a bound; use Trezi's Restart Dev Server and Reload Preview tools; use the existing Git and Publish Resolve tools for conflicts; ask Trezi to reinstall dependencies through its owner. For `index.lock`, confirm it is old and no Git process is running, then use the repository owner's repair path. Never delete a lock from an agent shell. Never reset, rewrite, or delete user work.

For auth, use the existing sign-in card. For rate or usage limits, wait for a known reset or offer another configured provider. For unknown or repeated errors, gather the narrow diagnostics above, apply only a listed safe action, and otherwise state one cause and one next step. Stop after three attempts; do not recurse into another doctor run.
