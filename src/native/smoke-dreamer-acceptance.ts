import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { buildStamp } from './app-version'
import type { NativeBridge } from './bridge'
import {
  acceptanceFixture,
  archiveProblems,
  DREAMER_ACCEPTANCE_RED_MODES,
  DREAMER_WIDTHS,
  type FooterMeasure,
  footerProblems,
  stepLog
} from './dreamer-acceptance'
import type { NativeDreamerController } from './dreamer-controller'
import type { PreferenceEntry } from './preferences'
import { DREAMER_FIXTURE, LEGACY_AGENT_OS_KEYS } from './smoke-dreamer'
import { inspectUntil, waitFor } from './smoke-wait'

/**
 * LKM-447: the LKM-443 acceptance on the shipping code, opt-in (`--dreamer-acceptance`;
 * the operator command is `bun run acceptance:dreamer`, docs/DREAMER.md). Trezi →
 * Dreamer Proposals… from the real menu; the Overview's footer measured and captured in
 * the foreground at the ordinary and the minimum width; Export… clicked, and separately
 * Return pressed, each into the real NSSavePanel (pickExport is never stubbed) that saves
 * into a temp folder; that panel's Cancel writing nothing; no request to Agent OS.
 * Evidence: test/artifacts/native/dreamer-acceptance/.
 */
export async function checkDreamerAcceptance(
  host: NativeBridge,
  dreamer: NativeDreamerController,
  artifacts: string
) {
  if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1')
    throw new Error(
      'The Dreamer acceptance needs the foreground; unset TREZI_NATIVE_BACKGROUND_TEST'
    )
  const red = process.env.TREZI_DREAMER_ACCEPTANCE_RED || ''
  if (red && !(DREAMER_ACCEPTANCE_RED_MODES as readonly string[]).includes(red))
    throw new Error(`Unknown TREZI_DREAMER_ACCEPTANCE_RED: ${red}`)
  const dir = join(artifacts, 'dreamer-acceptance')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // biome-ignore lint/suspicious/noExplicitAny: host step payloads are untyped JSON
  const step = (op: string, extra: Record<string, unknown> = {}): Promise<any> =>
    host.request('dreamerAcceptance', { op, ...extra })
  const evidence: Record<string, unknown> = {
    check: 'dreamer-export-primary',
    build: buildStamp(),
    red: red || null,
    startedAt: new Date().toISOString(),
    captures: {},
    widths: {},
    exports: [],
    steps: []
  }
  const record = () =>
    writeFileSync(join(dir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  // LKM-452: every input and every wait that can fail is written to `steps` first; a failed
  // wait adds the save panel and sheet as they were then, before `finally` dismisses them.
  const log = stepLog((steps) => {
    evidence.steps = steps
    record()
  })
  const hostState = async () => ({
    savePanel: await step('savePanel').catch((error) => String(error)),
    sheet: await host.request('sheetInspect').catch((error) => String(error))
  })
  const until = (
    label: string,
    check: () => any,
    timeout = 10000,
    describe?: () => Promise<unknown>
  ) => log.wait(label, () => waitFor(check, label, timeout, describe), hostState)
  const sheet = (label: string, check: (state: any) => boolean, timeout = 10000) =>
    log.wait(
      label,
      () =>
        inspectUntil((method) => host.request(method), 'sheetInspect', check, undefined, timeout),
      hostState
    )

  const requests: string[] = []
  // A local stand-in at the old Agent OS URL: nothing may reach it.
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.writeHead(500).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const saved = LEGACY_AGENT_OS_KEYS.map(
    (key): PreferenceEntry => [key, dreamer.preferences.get(key)]
  )
  const result = dreamer.result
  const pickExport = dreamer.host.pickExport
  const out = mkdtempSync(join(tmpdir(), 'trezi-dreamer-acceptance-'))
  try {
    await dreamer.preferences.apply([
      [LEGACY_AGENT_OS_KEYS[0], `http://127.0.0.1:${port}`],
      [LEGACY_AGENT_OS_KEYS[1], 'acceptance'],
      [LEGACY_AGENT_OS_KEYS[2], 'acceptance-token']
    ])
    dreamer.result = {
      file: acceptanceFixture(DREAMER_FIXTURE),
      digest: null,
      selected: ['speed-bash'],
      model: 'fixture'
    }
    // RED: a stub answers Export… instead of the save panel, which the check must catch.
    if (red === 'stub-save-panel') dreamer.host.pickExport = async () => join(out, 'stub.zip')

    evidence.menu = await step('menu')
    log.note('menu', { result: evidence.menu })
    const overview = await sheet(
      'Dreamer Proposals open on Overview',
      (s) => s.visible && s.title === 'Dreamer Proposals' && s.section === 'overview'
    )
    evidence.overview = overview
    assert.equal(overview.defaultAction, 'export', 'Return runs Export… (the default action)')
    assert.ok(!overview.actions.includes('send'), 'no Send to Agent OS')
    assert.doesNotMatch(
      JSON.stringify(dreamer.sheets.current?.state),
      /Agent OS/i,
      'no Agent OS copy'
    )

    // The footer in the foreground at both widths: measured, captured, then judged.
    for (const [name, width] of Object.entries(DREAMER_WIDTHS)) {
      await step('prepare', { width })
      log.note('prepare', { width })
      const measure: FooterMeasure = await until(
        `Dreamer window ${width} pt wide in the foreground`,
        async () => {
          const m = await step('measure')
          return m.foreground && Math.abs(m.width - width) <= 1 && m.buttons.length > 0 && m
        }
      )
      const png = `dreamer-${name}-${width}.png`
      writeFileSync(
        join(dir, png),
        Buffer.from((await host.request('captureVisibleSheet')).png, 'base64')
      )
      ;(evidence.captures as Record<string, string>)[png] = 'foreground'
      ;(evidence.widths as Record<string, unknown>)[name] = measure
      record()
      assert.deepEqual(footerProblems(measure, width), [], `Dreamer footer at ${width} pt`)
    }

    // Export… opens the real save panel; it saves into `folder`, or Cancel writes nothing.
    const exportVia = async (
      trigger: 'click' | 'return',
      folder: string,
      button: 'save' | 'cancel'
    ) => {
      // Recorded at once and filled in as it goes, so a timeout still leaves this export.
      const entry: Record<string, unknown> = { trigger, button, closed: false }
      ;(evidence.exports as unknown[]).push(entry)
      await step('prepare')
      log.note('prepare', { trigger, button })
      await until(
        'Dreamer window in the foreground',
        async () => (await step('measure')).foreground
      )
      const input =
        trigger === 'click'
          ? await step('click', { action: 'export' })
          : await step('key', { key: 'return' })
      entry.input = input
      log.note(`export ${trigger}`, { input })
      const panel = await until(
        `real NSSavePanel opened by ${trigger === 'click' ? 'an Export… click' : 'Return'}`,
        async () => {
          const p = await step('savePanel')
          return p.open && p.visible && p
        },
        10000,
        async () => ({ sheet: await host.request('sheetInspect') })
      )
      entry.panel = panel
      log.note('save panel opened', { panel })
      assert.equal(panel.attached, true, 'the save panel is a sheet on the Dreamer window')
      assert.match(panel.name, /^Dreamer Report \d{4}-\d{2}-\d{2}\.zip$/)
      log.note('saveTo', { panel: await step('saveTo', { directory: folder }) })
      await until('save panel in the temp folder', async () => {
        const p = await step('savePanel')
        return p.directory && realpathSync(p.directory) === realpathSync(folder)
      })
      const press = await step('savePress', { button })
      entry.press = press
      // The route (local click or remote window-server key), the preflight and focus guard,
      // the button pressed and the panel then. A refused route sent nothing: fail now, with
      // the access receipt, instead of waiting for a panel that cannot close.
      if (press.receipt) evidence.access = press.receipt
      log.note(`savePress ${button}`, { press })
      if (!press.sent)
        throw new Error(`save panel ${button} not sent (${press.route} route): ${press.refused}`)
      await until('save panel closed', async () => !(await step('savePanel')).open)
      entry.closed = true
      return { name: panel.name as string, entry }
    }

    for (const trigger of ['click', 'return'] as const) {
      const folder = mkdtempSync(join(out, `${trigger}-`))
      const { name, entry } = await exportVia(trigger, folder, 'save')
      const done = await sheet(
        `export message for the ${trigger} export`,
        (s) => !s.busy && s.message.includes(`${basename(folder)}/${name}`),
        20000
      )
      entry.message = done.message
      assert.doesNotMatch(done.message, /Agent OS|Not sent|instead/)
      assert.deepEqual(
        readdirSync(folder),
        [name],
        'the save panel wrote one zip where it was told'
      )
      const unzipped = join(out, `unzipped-${trigger}`)
      execFileSync('/usr/bin/ditto', ['-x', '-k', join(folder, name), unzipped])
      const report = join(unzipped, 'Dreamer Report')
      const entries = existsSync(report) ? readdirSync(report).sort() : []
      const archive = {
        root: readdirSync(unzipped).sort(),
        entries,
        files: Object.fromEntries(
          entries.map((file) => [file, readFileSync(join(report, file), 'utf8')])
        )
      }
      entry.archive = {
        root: archive.root,
        entries,
        proposals: JSON.parse(archive.files['proposals.json'] ?? '{}')
      }
      record()
      assert.deepEqual(archiveProblems(archive, ['speed-bash']), [], `the ${trigger} export`)
    }

    // Cancel in the real panel: no file and no message (the last export's message clears).
    const folder = mkdtempSync(join(out, 'cancel-'))
    const before = readdirSync(out).sort()
    const { entry } = await exportVia('click', folder, 'cancel')
    const cancelled = await sheet(
      'no message after Cancel',
      (s) => !s.busy && s.visible && s.message === ''
    )
    entry.message = cancelled.message
    assert.deepEqual(readdirSync(folder), [], 'a cancelled export writes nothing')
    assert.deepEqual(readdirSync(out).sort(), before, 'a cancelled export writes nothing')

    evidence.requests = requests
    assert.equal(requests.length, 0, 'no request reaches the Agent OS stand-in')
    await host.request('sheetPerform', { action: 'closeWindow' })
    log.note('closeWindow')
    await sheet('Dreamer window closed', (s) => !s.visible)
    evidence.outcome = 'pass'
  } catch (error) {
    evidence.outcome = 'fail'
    evidence.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await step('dismissSavePanel').catch(() => {})
    dreamer.host.pickExport = pickExport
    dreamer.result = result
    server.close()
    rmSync(out, { recursive: true, force: true })
    await dreamer.preferences.apply(saved).catch(() => {})
    evidence.requests = requests
    evidence.finishedAt = new Date().toISOString()
    record()
  }
}
