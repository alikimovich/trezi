import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const message = (id, text) => ({ id, role: 'assistant', text, segments: [{ kind: 'text', text }] })

/** Invoked by native-runtime -> native-chat-scroll under the manager desktop lock. */
export async function checkChatAcceptance(host, artifacts) {
  const inspect = (args) => host.request('chatAcceptance', args)
  const wait = async (predicate, label) => {
    let last
    for (let i = 0; i < 60; i++) {
      last = await inspect({})
      if (predicate(last)) return last
      await delay(50)
    }
    writeFileSync(
      join(artifacts, 'acceptance-failure.json'),
      JSON.stringify({ label, last }, null, 2)
    )
    assert.fail(`${label}: ${JSON.stringify(last)}`)
  }
  const capture = async (name) => {
    const state = await inspect({ capture: true })
    const { image, ...geometry } = state
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.png, 'base64'))
    writeFileSync(
      join(artifacts, `${name}.json`),
      JSON.stringify(
        { ...geometry, text: image.text, pixels: [image.width, image.height] },
        null,
        2
      )
    )
    assert.ok(image.width > 200 && image.height > 400, 'Foreground full-column capture')
    assert.equal(
      state.probeAttached,
      true,
      'Probe configured the actual SwiftUI conversation NSScrollView'
    )
    assert.equal(state.small, true, 'Actual conversation uses native small scroller')
    assert.ok(state.documentHeight > state.viewportHeight + 100, 'Overflowing conversation')
    for (const gap of ['leftGap', 'rightGap', 'bottomGap']) assert.equal(state[gap], 10, gap)
    for (const key of ['contained', 'alignment', 'hitTargets'])
      assert.equal(state.layout[key], true, key)
    return { ...state, capturedText: image.text }
  }
  // Click the native latest button with window-targeted mouse events; its
  // action must run (not merely the scroll position change) before capture.
  // LKM-141: a round button centered over the column, a small gap above the
  // composer, inside its clearance: never over the reading area's text.
  const checkLatestButton = (state, label) => {
    const [x, y, width, height] = (
      String(state.latestButtonFrame).match(/-?[\d.]+(?:e-?\d+)?/g) ?? []
    ).map(Number)
    assert.equal(state.latestButton, true, `${label}: latest button shown`)
    assert.equal(width, height, `${label}: round latest button ${state.latestButtonFrame}`)
    assert.ok(
      Math.abs(x + width / 2 - state.chatWidth / 2) <= 1,
      `${label}: centered over ${state.chatWidth}pt column ${state.latestButtonFrame}`
    )
    assert.ok(
      Math.abs(state.composerTop - (y + height) - state.latestButtonGap) <= 1,
      `${label}: gap above composer top ${state.composerTop} ${state.latestButtonFrame}`
    )
    assert.ok(
      y >= state.readingHeight,
      `${label}: below reading area ${state.readingHeight} ${state.latestButtonFrame}`
    )
    // LKM-190: the conversation is not masked, so history scrolls on under the
    // button and the composer. The button brings its own glass (or blur) circle
    // and claims the click at its center, so the text under it is never hit.
    assert.match(
      state.latestButtonBackdrop,
      /^(NSGlassEffectView|NSVisualEffectView)$/,
      `${label}: button has its own glass background`
    )
    assert.equal(state.latestButtonBackdropFills, true, `${label}: background fills the button`)
    assert.equal(state.latestButtonHit, 'ChatLatestButton', `${label}: no click-through`)
    assert.equal(
      state.latestButtonLabel,
      'Scroll to latest message',
      `${label}: accessibility label`
    )
  }
  // LKM-190: scrolled up, in the window's forced light and dark appearance (never
  // the system's), history text is painted beside the button down to the
  // composer edge: the band the old mask left empty. A gap between messages can
  // sit in that band, so nudge the history a little until a text line does.
  const scrolledUpCaptures = async (width) => {
    for (const appearance of ['light', 'dark']) {
      await host.request('shellPerform', { action: 'window-appearance', row: appearance })
      const name = `acceptance-${width}-scrolled-up-${appearance}`
      let state
      for (let nudge = 0; nudge < 4; nudge++) {
        if (nudge) await inspect({ input: 'wheel', delta: 23 })
        await delay(250)
        state = await capture(name)
        checkLatestButton(state, `${width}pt scrolled up ${appearance}`)
        if (state.latestBandInk > 40) break
      }
      assert.equal(
        /dark/i.test(state.appearance),
        appearance === 'dark',
        `${name}: ${state.appearance}`
      )
      assert.ok(
        state.latestBandInk > 40,
        `${name}: text visible beside the button down to the composer (${state.latestBandInk} ink pixels)`
      )
    }
    await host.request('shellPerform', { action: 'window-appearance', row: '' })
  }
  const clickLatest = async (label) => {
    const before = await inspect({})
    checkLatestButton(before, label)
    await inspect({ input: 'latest' })
    await wait(
      (s) => s.latestButtonClickCount === before.latestButtonClickCount + 1,
      `${label}: latest click runs the button action`
    )
  }
  const latestCapture = async (name) => {
    await wait((s) => s.latestVisible, `${name}: complete latest row above composer clearance`)
    const state = await capture(name)
    assert.equal(state.latestVisible, true)
    // LKM-149: finished history responses have one 28 pt footer row; only the
    // latest keeps the counter's (empty) line under it.
    const footerHeights = Object.entries(state.footerFrames).map(([id, value]) => [
      id,
      String(value)
        .match(/-?[\d.]+(?:e-?\d+)?/g)
        .map(Number)[3]
    ])
    assert.ok(
      footerHeights.some(([id]) => id !== state.latestID),
      `${name}: a history footer is realized ${JSON.stringify(state.footerFrames)}`
    )
    for (const [id, height] of footerHeights)
      assert.equal(
        height,
        id === state.latestID ? 44 : 28,
        `${name}: footer ${id} height ${JSON.stringify(state.footerFrames)}`
      )
    // The tail must be present in actual pixels, not merely in a SwiftUI model.
    assert.match(state.capturedText.join(' '), /LATEST VISIBLE MESSAGE/i)
    return state
  }
  const choices = [
    { label: 'Provider', value: 'codex', options: [{ label: 'Codex', value: 'codex' }] },
    { label: 'Model', value: 'fixture', options: [{ label: 'Fixture', value: 'fixture' }] },
    { label: 'Permission mode', value: 'auto', options: [{ label: 'Auto', value: 'auto' }] }
  ]
  const state = {
    chat: 'chat-acceptance',
    messages: [
      ...Array.from({ length: 40 }, (_, i) =>
        message(`history-${i}`, `History ${i}. ${'Scrollable native conversation. '.repeat(8)}`)
      ),
      message('latest', 'LATEST VISIBLE MESSAGE')
    ],
    cards: [],
    questions: [],
    running: false,
    status: 'Acceptance fixture',
    composer: { enabled: true, text: '', revision: 100, choices }
  }
  host.send('chatState', { state })
  await delay(200)
  const original = await inspect({ prepare: true })
  const results = []
  // Scroller and accessibility modes are switched by the app's in-process
  // override (ephemeral host only). Verification never touches macOS settings.
  const override = (environment) => inspect({ environment })
  try {
    await wait((s) => s.probeAttached, 'Real SwiftUI probe attachment')
    const setDraft = async (lines) => {
      state.composer.text = Array(lines).fill('Multiline composer draft').join('\n')
      state.composer.revision++
      host.send('chatState', { state })
      await wait((s) => s.composer.text === state.composer.text, 'Draft applied')
    }
    for (const width of [440, 320]) {
      await inspect({ width })
      for (const lines of [1, 6, 80]) {
        await setDraft(lines)
        const geometry = await latestCapture(`acceptance-${width}-${lines}-lines`)
        if (lines === 80)
          assert.ok(
            geometry.composer.documentHeight > geometry.composer.inputHeight + 100,
            'Capped draft retains scrollable input'
          )
        else
          assert.ok(
            geometry.composer.documentHeight <= geometry.composer.inputHeight + 1,
            'Uncapped draft fits'
          )
        results.push({
          width,
          lines,
          latestVisible: geometry.latestVisible,
          bottomGap: geometry.bottomGap
        })
      }
      await inspect({ height: 620 })
      await latestCapture(`acceptance-${width}-resized-short`)
      await inspect({ height: 800 })
      await latestCapture(`acceptance-${width}-resized-tall`)
      // Opposite order: shorten the window first, then grow the draft to its cap.
      await setDraft(1)
      await inspect({ height: 620 })
      await latestCapture(`acceptance-${width}-short-1-line`)
      await setDraft(80)
      const grown = await latestCapture(`acceptance-${width}-short-then-grow`)
      assert.ok(
        grown.composer.documentHeight > grown.composer.inputHeight + 100,
        'Capped draft in the short window'
      )
      await inspect({ height: 800 })
      await latestCapture(`acceptance-${width}-short-then-grow-tall`)
      // Scrolled up with a one-line draft: the centered button above the composer.
      await setDraft(1)
      await latestCapture(`acceptance-${width}-before-scroll-up`)
      await inspect({ input: 'wheel', delta: 700 })
      await wait(
        (s) => s.latestButton && !s.latestVisible,
        `${width}pt wheel scrolls history and reveals latest button`
      )
      checkLatestButton(await capture(`acceptance-${width}-scrolled-up`), `${width}pt scrolled up`)
      await scrolledUpCaptures(width)
      await clickLatest(`acceptance-${width}-scrolled-up-latest`)
      await latestCapture(`acceptance-${width}-scrolled-up-latest`)
    }
    // Return to a short draft so the scroller has a large unobstructed track.
    state.composer.text = ''
    state.composer.revision++
    host.send('chatState', { state })
    await delay(200)
    for (const preference of ['WhenScrolling', 'Always', 'WhenScrolling']) {
      const expected = preference === 'Always' ? 'legacy' : 'overlay'
      const before = await inspect({})
      await override({ scrollers: preference })
      await wait(
        (s) =>
          s.environmentOverridden &&
          s.preferredStyle === expected &&
          s.style === expected &&
          s.configurationCount > before.configurationCount,
        `Live ${preference} scroller mode reaches the actual probe`
      )
      const baseline = await inspect({})
      assert.equal(baseline.chatWidth, before.chatWidth, 'Preference changes preserve column width')
      assert.equal(
        baseline.chatHeight,
        before.chatHeight,
        'Preference changes preserve viewport height'
      )
      assert.deepEqual(
        baseline.composer.bounds,
        before.composer.bounds,
        'Preference changes preserve composer placement'
      )
      await wait(
        (s) => s.latestVisible,
        'Latest message remains clear after native scroller style change'
      )
      if (expected === 'legacy') {
        assert.equal(baseline.autohides, false)
        assert.equal(baseline.scrollerHidden, false, 'Always-show native scroller visible')
      } else assert.equal(baseline.autohides, true)
      const prefix = `acceptance-${preference}-${results.length}`
      await inspect({ input: 'away' })
      await delay(1600)
      const idle = await capture(`${prefix}-idle`)
      if (expected === 'legacy')
        assert.equal(idle.scrollerHidden, false, 'Always scroller stays visible while idle')
      // Wheel activity reveals the native overlay thumb before pointer hover.
      const wheelStart = await inspect({})
      await inspect({ input: 'wheel', delta: 700 })
      await wait(
        (s) => Math.abs(s.scrollY - wheelStart.scrollY) > 40 && s.latestButton,
        'Wheel scrolls history and reveals latest button'
      )
      await capture(`${prefix}-active`)
      await inspect({ input: 'hover' })
      await delay(250)
      await capture(`${prefix}-hover`)
      const dragStart = await inspect({})
      const dragReport = await inspect({ input: 'drag' })
      writeFileSync(
        join(artifacts, `${prefix}-drag.json`),
        JSON.stringify(dragReport.lastDrag, null, 2)
      )
      // Dragging the thumb up must move the content toward history by a
      // meaningful amount (scrollY decreases), through the scroller's own tracking.
      const dragged = await wait(
        (s) => dragStart.scrollY - s.scrollY > 40,
        'Native thumb dragging moves content'
      )
      await capture(`${prefix}-dragged`)
      assert.equal(
        dragged.viewportWidth,
        baseline.viewportWidth,
        'Hover/drag causes no viewport width jump'
      )
      assert.equal(dragged.chatWidth, baseline.chatWidth)
      // Activate the actual latest button via mouse events, not scrollTo directly.
      await clickLatest(`${prefix}-latest`)
      await latestCapture(`${prefix}-latest`)
      results.push({ preference, wheelMoved: true, dragMoved: true, latestButtonWorked: true })
    }
    // Switch Increase Contrast, Reduce Transparency and Reduce Motion through
    // the override, and require them to reach the rendering path: the SwiftUI
    // environment keys the conversation's views read. The native scroller
    // keeps AppKit's own macOS contrast handling (appearance never replaced).
    const modes = ['increaseContrast', 'reduceTransparency', 'reduceMotion']
    for (const enabled of [true, false]) {
      await override({ accessibility: Object.fromEntries(modes.map((mode) => [mode, enabled])) })
      await wait(
        (s) =>
          modes.every(
            (mode) => s.accessibility[mode] === enabled && s.rendered[mode] === enabled
          ) &&
          s.environmentOverridden &&
          s.scrollAppearance === '',
        `Accessibility modes ${enabled} reach the conversation's SwiftUI environment`
      )
      const before = await inspect({})
      const contrast = await latestCapture(`acceptance-accessibility-${enabled}`)
      await inspect({ input: 'wheel', delta: 500 })
      await wait((s) => s.latestButton, 'Accessibility scroll remains usable')
      await clickLatest(`acceptance-accessibility-${enabled}-latest`)
      const after = await latestCapture(`acceptance-accessibility-${enabled}-latest`)
      assert.equal(
        after.viewportWidth,
        before.viewportWidth,
        'Accessibility input preserves viewport layout'
      )
      results.push({
        accessibility: enabled,
        appearance: contrast.appearance,
        scroller: contrast.scrollerEffectiveAppearance,
        rendered: contrast.rendered,
        system: contrast.system,
        latestButtonWorked: true
      })
    }
    writeFileSync(join(artifacts, 'acceptance-results.json'), JSON.stringify({ results }, null, 2))
    console.log(
      'CHAT ACCEPTANCE PASS — real SwiftUI probe; foreground width/draft/resize matrix; wheel, thumb drag, latest button; live scroller and accessibility modes via the in-process override (no system settings changed). Inspect acceptance-*.png/json.'
    )
  } catch (error) {
    try {
      const { image, ...state } = await inspect({ capture: true })
      writeFileSync(join(artifacts, 'acceptance-failure.png'), Buffer.from(image.png, 'base64'))
      writeFileSync(
        join(artifacts, 'acceptance-failure.json'),
        JSON.stringify({ error: String(error), ...state, text: image.text }, null, 2)
      )
    } catch (captureError) {
      console.error('Failure capture unavailable:', captureError)
    }
    throw error
  } finally {
    await host.request('shellPerform', { action: 'window-appearance', row: '' })
    await inspect({
      environment: { clear: true },
      width: original.chatWidth,
      height: original.windowContentHeight
    })
  }
}
