import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { CHANGES_ROWS, git, gitState, lines, writeChangesProject } from './smoke-changes-fixture'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const PROJECT = '../Changes Project'
const DRAFT = '\n<!-- changes panel draft -->'
/** The branch the list names: opening the project moves `feature` onto Trezi's work branch. */
const WORK_BRANCH = 'trezi/feature'

interface Row {
  kind: 'section' | 'file' | 'hunk' | 'note'
  section: string
  path: string
  title: string
  status: string
  added: string
  removed: string
}

/**
 * LKM-366: the editor's read-only Changes list (LKM-364) in the running app, over a temp
 * Git project. The base label names the merge-base ref and short SHA; committed changes
 * are listed apart from staged, unstaged and untracked ones, each file with its +/−
 * counts; a file click opens it and a hunk click opens its exact lines in Trezi's editor,
 * over a kept draft; the list has no Git controls besides Refresh; HEAD, branches, index
 * and work tree are unchanged after use; a project switch refreshes the list and shows
 * nothing of the other project.
 */
export async function checkChangesPanel(host: NativeBridge, fixture: string, artifacts: string) {
  const project = join(fixture, PROJECT)
  const first = nativeWorkspace.state.activeKey!
  writeChangesProject(project)
  const base = git(project, 'rev-parse', '--short=7', 'main')
  const head = git(project, 'rev-parse', '--short=7', 'HEAD')
  const editor = (root = project) => host.request('sourceInspect', { root })
  const navigation = (params: Record<string, unknown> = {}, root = project) =>
    host.request('sourceNavigation', { root, ...params })
  const perform = (action: Record<string, unknown>, root = project) =>
    host.request('sourcePerform', { action: { root, ...action } })
  const capture = async (stem: string, state: unknown, root = project) => {
    writeFileSync(join(artifacts, `${stem}.json`), JSON.stringify(state, null, 2))
    if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
      console.log(
        `SKIP foreground ${stem} capture: TREZI_NATIVE_BACKGROUND_TEST (offscreen editor)`
      )
      const png = await host.request('captureSource', { root })
      writeFileSync(join(artifacts, `${stem}.png`), Buffer.from(png, 'base64'))
      return
    }
    const image = await navigation({ capture: 'editor' }, root)
    writeFileSync(join(artifacts, `${stem}.png`), Buffer.from(image.png, 'base64'))
  }
  // The listed changes once a read has finished.
  const listed = (
    label: string,
    check: (s: { base: string; rows: Row[] }) => boolean,
    root = project
  ) =>
    waitFor(
      async () => {
        const s = await navigation({}, root)
        return (
          s.changesShown &&
          !s.diffBusy &&
          s.base &&
          !/Refreshing|Reading/.test(s.base) &&
          check(s) &&
          s
        )
      },
      label,
      15_000
    )
  const opened = async (
    target: Record<string, unknown>,
    file: RegExp,
    range?: [number, number]
  ) => {
    const before = (await navigation()).reveal
    const row = await navigation({ open: target })
    return waitFor(
      async () => {
        const s = { ...(await editor()), ...(await navigation()) }
        if (!s.visible || !file.test(s.source)) return false
        if (!range) return { row, ...s }
        const [start, end] = range
        return (
          s.reveal > before &&
          s.revealed?.startLine === start &&
          s.revealed?.endLine === end &&
          s.revealed?.bandMatchesSelection &&
          s.revealed?.firstLineVisible && { row, ...s }
        )
      },
      `${JSON.stringify(target)} opened ${file}${range ? ` ${range.join('-')}` : ''}`
    )
  }

  try {
    await nativeWorkspace.command({ type: 'open', root: project })
    const key = nativeWorkspace.state.activeKey!
    assert.notEqual(key, first)
    await perform({ action: 'open', source: 'index.html' })
    await waitFor(
      async () => (await editor()).visible && (await editor()).source === 'index.html',
      'editor open'
    )
    // Trezi's own project setup settles before the state viewing must keep is taken: opening
    // moves the checkout onto its `trezi/feature` work branch (`ensureBranch`).
    await waitFor(
      () => git(project, 'symbolic-ref', '--short', 'HEAD') === WORK_BRANCH,
      `checkout on ${WORK_BRANCH}`
    )
    await delay(1000)
    const before = gitState(project)

    // 1. The Changes list, through the sidebar's segmented control.
    await navigation({ panel: 'changes' })
    const list = await listed('Changes listed', (s) =>
      s.rows.some((r) => r.path === 'untracked.txt')
    )
    assert.ok(
      list.treeHidden && list.operationsHidden,
      'The file tree and its file operations hide'
    )
    assert.match(list.base, new RegExp(`^Branch ${WORK_BRANCH} @ ${head}$`, 'm'))
    assert.match(list.base, new RegExp(`^Base: merge-base with main @ ${base}$`, 'm'))
    const rows: Row[] = list.rows
    const sections = rows.filter((r) => r.kind === 'section')
    assert.deepEqual(
      sections.map((r) => r.section),
      ['committed', 'staged', 'unstaged', 'untracked'],
      'Committed changes are listed apart from each kind of uncommitted change'
    )
    assert.match(sections[0].title, new RegExp(`^Committed since ${base} \\(main\\)`))
    assert.deepEqual(
      sections.slice(1).map((r) => r.title),
      ['Staged (uncommitted)', 'Unstaged (uncommitted)', 'Untracked (uncommitted)']
    )
    // Dot paths aside: whatever Trezi's own project setup may leave untracked.
    const files = (section: string) =>
      rows
        .filter((r) => r.kind === 'file' && r.section === section && !r.path.startsWith('.'))
        .map((r) => [r.status, r.title, r.added, r.removed].join(' '))
        .sort()
    for (const [section, expected] of Object.entries(CHANGES_ROWS))
      assert.deepEqual(files(section), expected, `${section} files and their +/− counts`)
    for (const section of sections)
      assert.match(
        `${section.added} ${section.removed}`,
        /^\+\d+ −\d+$/,
        `${section.section} totals`
      )

    // 2. No Git controls: Refresh is the list's one control.
    assert.deepEqual(list.controls, ['diff-refresh'], 'Only Refresh: no stage, discard or commit')
    await capture('changes-panel-list', list)

    // 3. Clicks open Trezi's editor over a kept draft: a file at its first hunk, a hunk at
    //    its lines, an untracked file at its top; a deleted file says why it cannot open.
    const { text } = await editor()
    await perform({ action: 'edit', source: 'index.html', revision: 1_000, text: text + DRAFT })
    await waitFor(async () => (await editor()).dirty, 'index.html draft')
    const file = await opened(
      { section: 'committed', path: 'feature.css' },
      /^feature\.css/,
      [1, 3]
    )
    const hunk = await opened(
      { section: 'committed', path: 'app.css', hunk: 0 },
      /^app\.css/,
      [5, 6]
    )
    assert.equal(hunk.selectedText, '.app line 5 { changed }\n.app line 6 { changed }')
    await capture('changes-panel-hunk', { file, hunk })
    const staged = await opened(
      { section: 'staged', path: 'staged.txt', hunk: 0 },
      /^staged\.txt/,
      [3, 3]
    )
    const untracked = await opened(
      { section: 'untracked', path: 'untracked.txt' },
      /^untracked\.txt/
    )
    await navigation({ open: { section: 'committed', path: 'remove-me.txt' } })
    const deleted = await waitFor(
      async () => /remove-me\.txt was deleted/.test((await editor()).error) && (await editor()),
      'deleted file explains itself'
    )
    assert.match(deleted.source, /^untracked\.txt/, 'A deleted file opens nothing')
    await perform({ action: 'open', source: 'index.html' })
    const draft = await waitFor(async () => {
      const s = await editor()
      return s.source === 'index.html' && s
    }, 'index.html reopened')
    assert.ok(draft.dirty && draft.text.includes(DRAFT.trim()), 'The draft is kept across opens')

    // 4. Viewing changed nothing in Git or on disk.
    const after = gitState(project)
    assert.deepEqual(after, before, 'HEAD, branches, index and work tree are unchanged')
    writeFileSync(
      join(artifacts, 'changes-panel-git.json'),
      JSON.stringify(
        { before, after, opened: { staged, untracked, deleted: deleted.error } },
        null,
        2
      )
    )

    // 5. Another project's list shows only its own state; coming back re-reads this one.
    await perform({ action: 'reload' })
    await waitFor(async () => !(await editor()).dirty, 'draft dropped')
    await host.request('shellPerform', { action: 'select-row', row: `project:${first}` })
    await waitFor(() => nativeWorkspace.active?.key === first, 'first project selected')
    await perform({ action: 'open', source: 'index.html' }, fixture)
    await waitFor(async () => (await editor(fixture)).visible, 'first project editor')
    await navigation({ panel: 'changes' }, fixture)
    const elsewhere = await listed('first project Changes', () => true, fixture)
    const names = rows.filter((r) => r.path).map((r) => r.path)
    assert.ok(
      !elsewhere.rows.some((r: Row) => names.includes(r.path)) && !elsewhere.base.includes(head),
      `The other project's list shows nothing of this one: ${JSON.stringify(elsewhere.rows)}`
    )
    await capture('changes-panel-switch', elsewhere, fixture)
    await navigation({ panel: 'files' }, fixture)
    await perform({ action: 'hide' }, fixture)
    writeFileSync(join(project, 'later.txt'), lines('later', 2))
    await host.request('shellPerform', { action: 'select-row', row: `project:${key}` })
    await waitFor(() => nativeWorkspace.active?.key === key, 'changes project selected')
    const back = await listed('Changes re-read on return', (s) =>
      s.rows.some((r) => r.section === 'untracked' && r.path === 'later.txt')
    )
    writeFileSync(
      join(artifacts, 'changes-panel-switch.json'),
      JSON.stringify({ elsewhere, back }, null, 2)
    )
    console.log(
      'Changes panel: merge-base label, committed apart from staged/unstaged/untracked with +/− counts, file and hunk clicks open the exact range over a kept draft, only Refresh, Git and work tree unchanged, project switch refreshes without leaking.'
    )
  } finally {
    await restoreChangesPanel(host, fixture)
  }
}

/** Back to the first project with its editor on Files and hidden; the temp project closed and removed. */
export async function restoreChangesPanel(host: NativeBridge, fixture: string) {
  const project = join(fixture, PROJECT)
  const first = nativeWorkspace.state.projects.find((p) => p.root === fixture)?.key
  const entry = nativeWorkspace.state.projects.find((p) => p.root.endsWith('/Changes Project'))
  if (entry) {
    const open = await host.request('sourceInspect', { root: project }).catch(() => null)
    if (open?.dirty)
      await host.request('sourcePerform', { action: { root: project, action: 'reload' } })
    await host.request('sourceNavigation', { root: project, panel: 'files' }).catch(() => {})
  }
  if (first && nativeWorkspace.active?.key !== first) {
    await host.request('shellPerform', { action: 'select-row', row: `project:${first}` })
    await waitFor(() => nativeWorkspace.active?.key === first, 'first project selected')
  }
  if (entry) await nativeWorkspace.command({ type: 'close', key: entry.key })
  await host.request('sourceNavigation', { root: fixture, panel: 'files' }).catch(() => {})
  if ((await host.request('sourceInspect', { root: fixture })).visible)
    await host.request('sourcePerform', { action: { root: fixture, action: 'hide' } })
  // Switching back restarts the first project's preview; the next checks drive it.
  await waitFor(
    async () =>
      nativeWorkspace.state.status.kind === 'running' &&
      !(await host.request('layoutInspect')).previewHidden,
    'first project preview shown',
    30_000
  )
  rmSync(project, { recursive: true, force: true })
}
