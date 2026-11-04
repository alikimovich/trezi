import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildStamp } from './app-version'
import type { NativeBridge } from './bridge'
import {
  assertMarkupAppearance,
  assertMarkupBaseline,
  assertPressedTransition,
  type MarkupSemantic
} from './markup-acceptance-state'
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
  const semantic = async (): Promise<MarkupSemantic> => {
    const [s, m] = await Promise.all([shell(), markup()])
    return {
      selectMode: s.selectMode,
      markupOpen: m.open,
      selectAccent: s.selectSegmentProminent,
      markupAccent: s.markupSegmentProminent
    }
  }
  const restoreBaseline = async (label: string) => {
    let state = await semantic()
    if (state.markupOpen) {
      await click('markup')
      await waitFor(async () => !(await markup()).open, `${label}: Mark up cancel`)
    }
    state = await semantic()
    if (state.selectMode) {
      await click('select-object')
      await waitFor(async () => !(await shell()).selectMode, `${label}: Select off`)
    }
    assertMarkupBaseline(label, await semantic())
  }
  const segments = [
    'select-object',
    'overlay',
    'speed',
    'markup',
    'code',
    'layers',
    'device',
    'expand'
  ]
  const routes: Record<string, string> = {
    idle: 'no input (resting)',
    hover: 'posted mouseMoved (tracking-area hover not guaranteed)',
    pressed: 'posted AppKit pointer',
    focus: 'synthetic focus setup, posted key',
    disabled: 'synthetic disabled setup'
  }
  /** One shared treatment across all eight segments: glyph, size, weight, alignment, hit area. */
  const sharedTreatment = (label: string, states: Record<string, any>[]) => {
    const first = states[0]
    const near = (a: number, b: number, tolerance: number, what: string) =>
      assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${what} (${a} vs ${b})`)
    const glyphs = states.map((state) => state.glyph as string)
    assert.ok(
      glyphs.every((glyph) => glyph) && new Set(glyphs).size === states.length,
      `${label}: every button keeps its own glyph (${glyphs.join(', ')})`
    )
    for (const state of states) {
      const id = `${label} ${state.segment}`
      assert.equal(state.iconFamily, 'SF Symbols', `${id}: icon family`)
      assert.equal(state.imageWidth, first.imageWidth, `${id}: image width`)
      assert.equal(state.imageHeight, first.imageHeight, `${id}: image height`)
      assert.equal(state.symbolWeight, first.symbolWeight, `${id}: symbol weight`)
      near(state.frame.width, first.frame.width, 1, `${state.segment} hit width`)
      near(state.frame.height, first.frame.height, 1, `${state.segment} hit height`)
      near(state.windowFrame.midY, first.windowFrame.midY, 1, `${state.segment} vertical centre`)
      assert.ok(state.frame.width >= 32 && state.frame.height >= 24, `${id}: hit area`)
      // The painted glyph against a fresh render of its symbol at the shared spec.
      const { ink, expectedInk } = state
      assert.ok(ink && expectedInk && ink.coverage > 0, `${id}: glyph is painted`)
      near(ink.width, expectedInk.width, 1, `${state.segment} ink width`)
      near(ink.height, expectedInk.height, 1, `${state.segment} ink height`)
      near(ink.centerX, expectedInk.centerX, 1, `${state.segment} ink centre x`)
      near(ink.centerY, expectedInk.centerY, 1, `${state.segment} ink centre y`)
      assert.ok(
        Math.abs(ink.coverage / expectedInk.coverage - 1) < 0.02,
        `${id}: symbol weight matches the shared spec (${ink.coverage} vs ${expectedInk.coverage})`
      )
      // Optical size: every glyph's longer side and its centre in the image agree.
      near(
        Math.max(ink.width, ink.height),
        Math.max(first.ink.width, first.ink.height),
        3,
        `${state.segment} optical size`
      )
      near(ink.centerX, 20, 2, `${state.segment} glyph centred horizontally`)
      near(ink.centerY, 20, 2, `${state.segment} glyph centred vertically`)
    }
  }
  const matrix = async (appearance: string, toggle: ReturnType<typeof markupToggleChecks>) => {
    await host.request('shellPerform', { action: 'window-appearance', row: appearance })
    for (const phase of ['idle', 'hover', 'pressed', 'focus', 'disabled'] as const) {
      const measuredStates: Record<string, any>[] = []
      for (const segment of segments) {
        const label = `${appearance} ${phase} ${segment}`
        await restoreBaseline(`${label} before`)
        const state = (await host.request('markupAcceptanceProbe', { segment, phase })) as Record<
          string,
          any
        > & { prominent: boolean; focused: boolean; semantic: MarkupSemantic }
        assert.equal(state.error, undefined, `${appearance} ${phase} ${segment}: ${state.error}`)
        assert.equal(state.route, routes[phase], `${phase} route`)
        assert.ok(state.label && state.tooltip && state.glyph, `${segment}: identity and help`)
        assert.ok(state.axLabel, `${segment}: accessibility label`)
        if (phase === 'disabled')
          assert.equal(state.enabled, false, `${segment}: disabled appearance`)
        else assert.equal(state.enabled, true, `${segment}: enabled`)
        assertMarkupAppearance(label, segment, state, phase === 'focus')
        if (phase !== 'pressed') assertMarkupBaseline(`${label} measured`, state.semantic)
        const { pressedPNG, ...measured } = state
        measuredStates.push(measured)
        ;(evidence.steps as Record<string, unknown>)[`${appearance}-${phase}-${segment}`] = measured
        if (phase === 'pressed') {
          const observedAction = assertPressedTransition(
            label,
            segment,
            state.before,
            state,
            state.after
          )
          const transition = {
            before: state.before.semantic,
            held: state.semantic,
            after: state.after.semantic,
            observedAction
          }
          ;(evidence.steps as Record<string, unknown>)[
            `${appearance}-pressed-transition-${segment}`
          ] = transition
          record()
          assert.equal(state.released, true, `${segment}: the press ended before the next step`)
          assert.ok(
            state.segmentPixelsChanged > 0,
            `${appearance} ${segment}: pressed capture is identical to the resting segment`
          )
          assert.ok(pressedPNG, `${segment}: mouse-down foreground PNG`)
          const name = `${appearance}-${phase}-${segment}`
          writeFileSync(join(dir, `${name}.png`), Buffer.from(pressedPNG, 'base64'))
          ;(evidence.captures as Record<string, string>)[name] = `${name}.png`
          record()
          assert.deepEqual(
            await semantic(),
            state.after.semantic,
            `${label}: observed release state`
          )
          // An outside release can complete Select's click. Its accent is then valid until
          // the normal Select action turns it off for the next matrix step.
        } else await capture(`${appearance}-${phase}-${segment}`)
        await host.request('markupAcceptanceProbe', { segment, phase: 'reset' })
        await restoreBaseline(`${label} after reset`)
      }
      sharedTreatment(`${appearance} ${phase}`, measuredStates)
    }
    await toggle.states(`${appearance}-`)
    const selectOn = (evidence.steps as Record<string, any>)[`${appearance}-select-on`]
    assert.equal(selectOn.shell.selectSegmentProminent, true, `${appearance}: Select active accent`)
    assert.equal(
      selectOn.shell.markupSegmentProminent,
      false,
      `${appearance}: Select on does not light Mark up`
    )
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
    const speedOn = await shell()
    assert.equal(speedOn.selectSegmentProminent, false, `${appearance}: Slow Motion on, Select off`)
    assert.equal(
      speedOn.markupSegmentProminent,
      false,
      `${appearance}: Slow Motion on, Mark up off`
    )
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
    const markupOn = await shell()
    assert.equal(markupOn.selectSegmentProminent, false, `${appearance}: Mark up on, Select off`)
    assert.equal(
      ((await host.request('previewSpeedInspect')) as { speedProminent: boolean }).speedProminent,
      false,
      `${appearance}: Mark up on, Slow Motion off`
    )
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
