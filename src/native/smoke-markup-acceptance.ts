import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildStamp } from './app-version'
import type { NativeBridge } from './bridge'
import { markupToggleChecks } from './smoke-markup-toggle'
import { waitFor } from './smoke-wait'

// Opt-in only. The launcher creates an immutable directory before the native host starts.
export async function checkMarkupAcceptance(host: NativeBridge) {
  const dir = process.env['TREZI_MARKUP_ACCEPTANCE_DIR']
  if (!dir || process.env['TREZI_NATIVE_BACKGROUND_TEST'] === '1')
    throw new Error('Foreground markup acceptance directory required')
  mkdirSync(dir, { recursive: true })
  const red = process.env['TREZI_MARKUP_ACCEPTANCE_RED'] || ''
  if (red && red !== 'active-fill') throw new Error(`Unknown markup RED mode: ${red}`)
  const evidence: Record<string, unknown> = {
    check: 'markup-toggle-overlay-native',
    build: buildStamp(),
    startedAt: new Date().toISOString(),
    input: 'posted AppKit pointer and keyboard events; disabled and focus setup are synthetic',
    red: red || null,
    outcome: 'running',
    captures: {},
    steps: {},
    cycles: {}
  }
  const record = () =>
    writeFileSync(join(dir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  const shell = () => host.request('shellInspect') as Promise<Record<string, any>>
  const markup = () => host.request('previewMarkupInspect') as Promise<Record<string, any>>
  const page = async () =>
    JSON.parse(
      (await host.request('evaluate', {
        view: 'preview',
        code: 'JSON.stringify({innerWidth,innerHeight,scrollY})'
      })) as string
    )
  const capture = async (name: string) => {
    const state = { shell: await shell(), markup: await markup(), page: await page() }
    ;(evidence.steps as Record<string, unknown>)[name] = state
    record() // Preserve the state even if the foreground capture fails.
    const png = ((await host.request('captureVisibleWindow')) as { png: string }).png
    assert.ok(png, `${name}: foreground PNG`)
    writeFileSync(join(dir, `${name}.png`), Buffer.from(png, 'base64'))
    ;(evidence.captures as Record<string, string>)[name] = `${name}.png`
    record()
  }
  const click = async (segment: string) => {
    const reply = (await host.request('previewMarkupTest', {
      action: 'toolbarSegment',
      segment
    })) as { route?: string; error?: string }
    assert.equal(reply.error, undefined, `${segment}: ${reply.error}`)
    assert.equal(reply.route, 'real event route', `${segment}: posted AppKit click`)
    return reply
  }
  const matrix = async (appearance: string, toggle: ReturnType<typeof markupToggleChecks>) => {
    await host.request('shellPerform', { action: 'window-appearance', row: appearance })
    for (const phase of ['idle', 'hover', 'pressed', 'focus', 'disabled'] as const) {
      for (const segment of [
        'select-object',
        'overlay',
        'speed',
        'markup',
        'code',
        'layers',
        'device',
        'expand'
      ]) {
        const state = (await host.request('markupAcceptanceProbe', { segment, phase })) as Record<
          string,
          any
        >
        assert.equal(state.error, undefined, `${appearance} ${phase} ${segment}: ${state.error}`)
        assert.equal(
          state.route,
          phase === 'disabled'
            ? 'synthetic disabled setup'
            : phase === 'focus'
              ? 'synthetic focus setup, posted key'
              : 'posted AppKit pointer',
          `${phase} route`
        )
        assert.equal(state.iconFamily, 'SF Symbols', `${segment}: icon family`)
        assert.equal(state.imageWidth, 20, `${segment}: optical width`)
        assert.equal(state.imageHeight, 20, `${segment}: optical height`)
        assert.equal(state.symbolWeight, 'regular', `${segment}: symbol weight`)
        assert.ok(state.frame.width >= 32 && state.frame.height >= 24, `${segment}: hit area`)
        assert.ok(state.label && state.tooltip && state.glyph, `${segment}: identity and help`)
        assert.ok(state.axLabel, `${segment}: accessibility label`)
        if (phase === 'disabled')
          assert.equal(state.enabled, false, `${segment}: disabled appearance`)
        if (phase === 'idle') assert.equal(state.prominent, false, `${segment}: no idle accent`)
        if (phase === 'focus') assert.equal(state.focused, true, `${segment}: keyboard focus`)
        const { pressedPNG, ...measured } = state
        ;(evidence.steps as Record<string, unknown>)[`${appearance}-${phase}-${segment}`] = measured
        if (phase === 'pressed') {
          assert.ok(pressedPNG, `${segment}: mouse-down foreground PNG`)
          const name = `${appearance}-${phase}-${segment}`
          writeFileSync(join(dir, `${name}.png`), Buffer.from(pressedPNG, 'base64'))
          ;(evidence.captures as Record<string, string>)[name] = `${name}.png`
          record()
        } else await capture(`${appearance}-${phase}-${segment}`)
        await host.request('markupAcceptanceProbe', { segment, phase: 'reset' })
      }
    }
    await toggle.states(`${appearance}-`)
    const selectOn = (evidence.steps as Record<string, any>)[`${appearance}-select-on`]
    assert.equal(selectOn.shell.selectSegmentProminent, true, `${appearance}: Select active accent`)
    assert.equal(
      (await shell()).selectSegmentProminent,
      false,
      `${appearance}: Select returns to off`
    )
    assert.equal(
      await host.request('shellPerform', { action: 'preview-speed', row: '0.5' }),
      true,
      'synthetic speed-menu selection setup'
    )
    await waitFor(
      async () =>
        ((await host.request('previewSpeedInspect')) as { speedProminent: boolean }).speedProminent,
      `${appearance}: Slow Motion active`
    )
    await capture(`${appearance}-selected-speed`)
    await host.request('shellPerform', { action: 'preview-speed', row: '1' })
    await waitFor(
      async () =>
        !((await host.request('previewSpeedInspect')) as { speedProminent: boolean })
          .speedProminent,
      `${appearance}: Slow Motion off`
    )
    await click('markup')
    await waitFor(async () => (await markup()).open, `${appearance}: Mark up open`)
    await capture(`${appearance}-selected-markup`)
    assert.equal(
      (await shell()).markupSegmentProminent,
      true,
      `${appearance}: Mark up selected accent`
    )
    await click('markup')
    await waitFor(async () => !(await markup()).open, `${appearance}: Cancel`)
    if (red === 'active-fill') {
      const injection = (await host.request('markupAcceptanceProbe', {
        phase: 'red-active-fill'
      })) as { prominent: boolean }
      assert.equal(injection.prominent, true, 'RED makes the real segment retain active fill')
    }
    await capture(`${appearance}-after-cancel`)
    const off = await shell()
    assert.equal(off.markupSegmentProminent, false, 'RED active-fill: no active fill after Cancel')
  }
  record()
  try {
    assert.ok(!(await shell()).moreMenu.includes('Mark up'), '… has no Mark up entry')
    const attachment = join(dir, 'existing-attachment.txt')
    writeFileSync(attachment, 'Existing draft attachment for Mark up acceptance\n')
    await host.request('composerPerform', { text: 'Keep this existing draft' })
    await host.request('composerPerform', { files: [attachment] })
    await waitFor(
      async () =>
        ((await host.request('composerInspect')) as { attachments: unknown[] }).attachments
          .length === 1,
      'existing attachment'
    )
    await capture('seeded-draft')
    const originalWidth = Math.round((await shell()).windowWidth)
    const results: Record<string, unknown> = {}
    const toggle = markupToggleChecks(host, click, capture, results, capture)
    await toggle.cycle('default', 3)
    await toggle.states()
    await matrix('light', toggle)
    await matrix('dark', toggle)
    await host.request('shellPerform', { action: 'window-width', row: '850' })
    await waitFor(async () => Math.abs((await shell()).windowWidth - 850) < 1, '850 pt')
    await toggle.cycle('minimum', 3)
    await toggle.resize(850, 1000)
    await host.request('shellPerform', { action: 'window-width', row: String(originalWidth) })
    evidence.cycles = results
    evidence.outcome = 'pass'
  } catch (error) {
    evidence.outcome = 'fail'
    evidence.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    evidence.finishedAt = new Date().toISOString()
    record()
    await host.request('markupAcceptanceProbe', { phase: 'reset' }).catch(() => {})
    await host.request('previewMarkupTest', { action: 'cancel' }).catch(() => {})
    await host.request('shellPerform', { action: 'window-appearance', row: '' }).catch(() => {})
  }
}
