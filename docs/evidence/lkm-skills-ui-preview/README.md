# Settings → Skills evidence (LKM-288, LKM-286)

This folder holds the captures of the native smoke `skills-settings`
(`src/native/smoke-skills.ts` and `src/native/smoke-skills-imports.ts`, group
`settings`). They come from the compiled app, running a disposable profile with the real
Swift Skills owner. GitHub is the launcher's loopback fixture
(`src/native/skills-github-fixture.ts`), never github.com. **No screenshot here is made
by any other means.** The files below come from the LKM-286 worker's native run through
the manager's verification. In that run `skills-settings` passed; the only failure was
the unrelated `core/preview-overlay`. To regenerate them:

```sh
TREZI_SIGN_IDENTITY=- bun run test:native        # or: node test/run.mjs native --only=settings
cp test/artifacts/native/skills-* docs/evidence/lkm-skills-ui-preview/
```

Each `.png` is a foreground window capture. Its `.json` is the rendered state at that
moment (`settingsVerification`): size, sidebar selection and focus, the rendered row
buttons and editors (containment, hit-testing, accessibility labels), the field and
footer-action IDs, disabled actions, the message, and the capture size. 680 is the
window's minimum width and 780 its normal width. Before a detail or add view is captured,
the editor is scrolled into view (`revealEditor`), the way a user would scroll.

| File | Shows |
| --- | --- |
| `skills-1-overview-empty-780` | Skills selected with the Down arrow from AI Providers: no skills yet, and the recommendations (publisher and license, or "Not importable") under "Not installed until you choose Install" |
| `skills-2-add-680`, `-780` | Add a Skill, with the sample SKILL.md typed into the rendered editor |
| `skills-3-library-680`, `-780` | The sample, added by the real owner: "On · Manual" with an Edit… row |
| `skills-4-detail-680`, `-780` | The skill opened from its row: status, source "Added manually", revision, "Chats: Not offered yet", SKILL.md (read on open) |
| `skills-5-detail-edited-780` | After Save Revision: the new revision, marked edited |
| `skills-6-removed-780` | After Remove: the skill under Removed with a Restore… row |
| `skills-7-removed-detail-780` | The removed skill with Restore |
| `skills-8-github-680`, `-780` | Import from GitHub: address, ref, folder and what the checks refuse |
| `skills-9-github-detail-680`, `-780` | The fixture imported at tag `v1`: GitHub source, pinned 40-character commit ("Asked for “v1”. Trezi never updates it by itself."), MIT from the folder's `LICENSE` |
| `skills-10-library-780` | Library with the sample, the imported folder and the GitHub skill |
| `skills-11-recommendation-680`, `-780` | Frontend Design before Install: "Not installed", with an enabled Install |
| `skills-12-recommendation-installed-780` | After Install: "Installed" and no Install button |
| `skills-13-recommendation-unavailable-780` | React Best Practices: "Can’t be installed" (76 files over the 64-file cap) with Install disabled; a scripted Install was refused and the registry revision did not change |
| `skills-14-library-imported-680`, `-780` | The final library; only Frontend Design reads "Installed" among the recommendations |
| `skills-settings-report.json` | Each step's action, message and the registry's skill summary (source, enabled, revision, `modified`, history) |

The smoke also asserts against the registry, not the window:

- The sample is stored as `source: manual`, enabled, with history `create`.
- Save makes a new revision, keeps `installedRevision`, sets `modified`, and `read`
  returns the edited text.
- Turn Off/On is stored.
- Remove keeps the skill, and Restore brings back the edited revision.
- The imported folder is `source: manual` with history `import`, and keeps
  `references/checklist.md`. Its body is still read after the source folder is
  deleted.
- The GitHub skill stores the repository, subpath, resolved commit, asked ref, license
  and license file.
- The recommendation stores the catalog's repository, subpath and license, and its
  pinned commit.

The samples are purged afterwards.
