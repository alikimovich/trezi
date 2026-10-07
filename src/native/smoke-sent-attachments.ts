import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { LIMITS, validImage, validImages } from '../main/provider-policy'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { preparePreviewInput } from './smoke-input'
import { inspectUntil, waitFor } from './smoke-wait'

/** A minimal RGBA PNG, so the transparent fixture needs no image tooling. */
function png(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const stride = width * 4 + 1
  const rows = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * stride + 1 + x * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** `NSStringFromRect` text, `{{x, y}, {w, h}}`, in the conversation's coordinates. */
const rect = (value: string) => {
  const [x, y, width, height] = (value.match(/-?[\d.]+(e[-+]?\d+)?/g) ?? []).map(Number)
  return { x, y, width, height, maxX: x + width, maxY: y + height }
}

/** LKM-166: a message sent with several SVG/PNG/JPG attachments shows compact,
 *  bounded thumbnails in a wrapping row, with its text right below them. The
 *  composer strip uses the same tiles. The provider call is intercepted. */
export async function checkSentAttachments(host: NativeBridge, artifacts: string) {
  const dir = join(artifacts, 'sent-attachments')
  mkdirSync(dir, { recursive: true })
  // The reported case: black icons with a large intrinsic size and no background.
  const svg = join(dir, 'icon.svg')
  writeFileSync(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 24 24"><path d="M12 2 2 22h20z" fill="#000"/></svg>'
  )
  const transparent = join(dir, 'dot.png')
  writeFileSync(
    transparent,
    png(120, 80, (x, y) => ((x - 60) ** 2 + (y - 40) ** 2 < 900 ? [20, 20, 20, 255] : [0, 0, 0, 0]))
  )
  const photo = join(dir, 'shell.jpg')
  writeFileSync(photo, Buffer.from((await host.request('captureShellImage')).jpeg, 'base64'))
  const files = [svg, transparent, photo, svg, transparent, photo, svg, transparent]
  const transparentCount = files.filter((file) => file !== photo).length

  const chat = nativeChat.get(nativeChat.active)
  const invoke = nativeChat.services.invoke
  const sent: unknown[][] = []
  nativeChat.services.invoke = async (channel, ...args) => {
    if (channel === 'agent:send') {
      sent.push(args)
      return
    }
    return invoke(channel, ...args)
  }
  try {
    await host.request('composerPerform', { files })
    const composer = await inspectUntil(
      (m) => host.request(m),
      'composerInspect',
      (s) => s.attachmentPreviews.count === files.length && s.enabled
    )
    const previews = composer.attachmentPreviews
    assert.equal(
      previews.images,
      files.length,
      `SVG, PNG and JPG all decode: ${JSON.stringify(previews)}`
    )
    assert.equal(
      previews.checkerboards,
      transparentCount,
      'Transparent tiles sit on a checkerboard'
    )
    for (const tile of previews.tiles.map(rect))
      assert.ok(
        tile.width <= 96 && tile.height <= 96,
        `Composer tile is compact: ${JSON.stringify(tile)}`
      )
    assert.ok(previews.height <= 96, `Composer strip stays compact: ${previews.height}`)
    writeFileSync(
      join(artifacts, 'sent-attachments-composer.png'),
      Buffer.from(await host.request('captureComposer'), 'base64')
    )

    const text = 'Here are the icons for the toolbar.'
    await host.request('composerPerform', { text })
    await inspectUntil(
      (m) => host.request(m),
      'composerInspect',
      (s) => s.text === text && s.enabled
    )
    await host.request('composerPerform', { action: 'send' })
    await waitFor(() => sent.length === 1, 'attachment message reaches the provider')
    // The SVG did not fail the turn: its original is listed by path and a bounded PNG
    // preview stands in for it; every image sent is one the provider accepts.
    const [prompt, images] = sent[0] as [string, { mediaType: string; data: string }[]]
    assert.ok(existsSync(svg) && prompt.includes(svg), `The SVG's path is listed: ${prompt}`)
    assert.match(prompt, /\[Attached files\]\n/)
    assert.ok(validImages(images), 'Every image sent is within the provider limits')
    const previewSizes = images
      .filter((image) => image.mediaType === 'image/png')
      .map((image) => Buffer.from(image.data, 'base64').subarray(16, 24))
      .map((ihdr) => [ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)])
    assert.ok(
      previewSizes.some(([w, h]) => Math.max(w, h) === 512),
      `The SVG sends a 512 px PNG preview: ${JSON.stringify(previewSizes)}`
    )
    const message = [...chat.messages].reverse().find((m) => m.role === 'user' && m.text === text)
    assert.ok(message, 'The sent message is in the conversation')
    const ids = (message.attachments ?? []).map((a) => a.id)
    assert.equal(ids.length, files.length)
    const state = await inspectUntil(
      (m) => host.request(m),
      'chatInspect',
      (s) => ids.every((id) => s.attachmentFrames[id]) && !!s.messageFrames[message.id]
    )
    const bubble = rect(state.messageFrames[message.id])
    const cells = ids.map((id) => rect(state.attachmentFrames[id]))
    for (const cell of cells) {
      assert.ok(
        cell.width >= 48 && cell.width <= 96 && cell.height >= 48 && cell.height <= 96,
        `Sent thumbnail is bounded: ${JSON.stringify(cell)}`
      )
      assert.ok(
        cell.x >= bubble.x && cell.maxX <= bubble.maxX + 0.5,
        `Thumbnail stays inside the bubble: ${JSON.stringify({ cell, bubble })}`
      )
    }
    const rows = [...new Set(cells.map((cell) => Math.round(cell.y)))]
    assert.ok(rows.length >= 2, `Thumbnails wrap into rows: ${JSON.stringify(cells)}`)
    assert.ok(
      rows.length * 96 >=
        Math.max(...cells.map((c) => c.maxY)) - Math.min(...cells.map((c) => c.y)),
      'Rows are packed, one thumbnail high each'
    )
    // The text follows the last row: one line plus the bubble's spacing and padding.
    const below = bubble.maxY - Math.max(...cells.map((cell) => cell.maxY))
    assert.ok(below < 80, `Text stays right below the thumbnails: ${below}pt`)
    writeFileSync(
      join(artifacts, 'sent-attachments.png'),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
    // A click sets this preview; the popover shows the larger image and its name.
    // A transient popover needs the window in front; a background run checks the state only.
    const foreground = await host.request('chatAcceptance', { prepare: true }).then(
      () => true,
      () => false
    )
    await host.request('chatAttachmentPreview', { attachment: ids[0] })
    await inspectUntil(
      (m) => host.request(m),
      'chatInspect',
      (s) => s.attachmentPreview === ids[0] && (s.attachmentPopover || !foreground)
    )
    if (!foreground) console.log('Sent attachments: background run, popover window not checked.')
    await host.request('chatAttachmentPreview', { attachment: null })
    await inspectUntil(
      (m) => host.request(m),
      'chatInspect',
      (s) => s.attachmentPreview === '' && !s.attachmentPopover
    )
    nativeChat.event({ type: 'delta', projectKey: chat.chat, text: 'Thumbnails received.' })
    nativeChat.event({ type: 'done', projectKey: chat.chat, landingPending: false })
    await waitFor(() => !chat.isRunning, 'attachment turn ends')

    // LKM-171: keep the actual SwiftUI transcript and decoded SVG thumbnails open
    // while WebContent handles a burst of pointer moves and one real selection.
    const originalText = message.text
    message.text = `\`\`\`svg\n${'<path d="M0 0h24v24H0z"/>'.repeat(90)}\n\`\`\``
    nativeChat.changed(chat)
    await inspectUntil(
      (m) => host.request(m),
      'chatInspect',
      (s) => ids.every((id) => s.attachmentFrames[id])
    )
    await host.request('shellPerform', { action: 'select-object' })
    // The baseline is the settled transcript: the follow/pin pass after the edit above
    // renders rows for a few frames, and only evaluations after it are hover's.
    let settled = { count: -1, since: 0 }
    await waitFor(
      async () => {
        const { messageBodyEvaluations: count } = await host.request('chatInspect')
        if (count !== settled.count) settled = { count, since: Date.now() }
        return Date.now() - settled.since >= 500
      },
      'the transcript stops rendering rows after the edit',
      10000
    )
    const chatBeforeHover = await host.request('chatInspect')
    assert.ok(
      chatBeforeHover.messageBodyEvaluations > 0,
      'chatInspect reports actual transcript row body evaluations'
    )
    const evaluate = (code: string) =>
      host.request('evaluate', { view: 'preview', isolated: true, code })
    const hoverTiming = await evaluate(`(async () => {
      const target = document.querySelector('#native-title');
      const alternate = target?.parentElement;
      const metrics = globalThis.__treziPreviewTimings;
      if (!target || !alternate || !metrics) throw new Error('Preview timing fixture missing');
      const box = document.querySelector('[data-trezi-overlay]')?.shadowRoot?.children[1];
      target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (box?.style.display !== 'none') throw new Error('Mouseout restored a stale highlight');
      target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      window.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (box?.style.display !== 'none') throw new Error('Scroll restored a stale highlight');
      metrics.enabled = true; metrics.hover.length = 0; metrics.hoverWork.length = 0;
      metrics.hoverPaintUpperBound.length = 0;
      metrics.select.length = 0; metrics.roundTrip.length = 0; metrics.hops.length = 0;
      const start = performance.now();
      for (let i = 0; i < 100; i++) (i % 2 ? alternate : target).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      const enqueue = performance.now() - start;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = alternate.getBoundingClientRect();
      return { enqueue, hover: metrics.hover, work: metrics.hoverWork, paintUpperBound: metrics.hoverPaintUpperBound,
        visible: box?.style.display, finalTarget: Math.abs(parseFloat(box?.style.left ?? 'NaN') - rect.left) < 1
          && Math.abs(parseFloat(box?.style.top ?? 'NaN') - rect.top) < 1
          && Math.abs(parseFloat(box?.style.width ?? 'NaN') - rect.width) < 1 };
    })()`)
    assert.equal(
      hoverTiming.hover.length,
      2,
      `100 alternating moves coalesce into two draws: ${JSON.stringify(hoverTiming)}`
    )
    assert.equal(hoverTiming.visible, 'block', 'hover highlight is drawn in WebContent')
    assert.ok(hoverTiming.finalTarget, 'the final highlight matches the last pointer target')
    assert.ok(
      hoverTiming.enqueue < 16,
      `100 moves blocked WebContent for ${hoverTiming.enqueue} ms`
    )
    assert.ok(hoverTiming.hover[0] < 16, `Hover highlight took ${hoverTiming.hover[0]} ms`)
    assert.ok(
      hoverTiming.work[0] < 16,
      `Hover draw blocked WebContent for ${hoverTiming.work[0]} ms`
    )
    assert.ok(
      hoverTiming.enqueue + hoverTiming.work[1] < 16,
      `100 hovers and their final draw blocked WebContent for ${hoverTiming.enqueue + hoverTiming.work[1]} ms`
    )
    const chatAfterHover = await host.request('chatInspect')
    assert.equal(
      chatAfterHover.messageBodyEvaluations,
      chatBeforeHover.messageBodyEvaluations,
      'preview hover does not render the transcript'
    )
    await preparePreviewInput(host)
    const point = await evaluate(
      `(() => { const r = document.querySelector('#native-title').getBoundingClientRect(); return {x:r.x+20,y:r.y+r.height/2}; })()`
    )
    await host.request('previewInput', point)
    const selectionTiming = await evaluate(`(async () => {
      const metrics = globalThis.__treziPreviewTimings;
      for (let i = 0; i < 60 && !metrics.roundTrip.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      return { select: metrics.select, roundTrip: metrics.roundTrip, hops: metrics.hops };
    })()`)
    assert.ok(selectionTiming.select.length, 'the real click reached the preview selection handler')
    assert.ok(
      selectionTiming.select[0] < 50,
      `Local selection took ${selectionTiming.select[0]} ms`
    )
    assert.ok(
      selectionTiming.roundTrip.length,
      `Selection did not return through host/service/Bun: ${JSON.stringify(selectionTiming)}`
    )
    assert.ok(
      selectionTiming.roundTrip[0] < 50,
      `Selection bridge took ${selectionTiming.roundTrip[0]} ms`
    )
    const chatAfterSelection = await host.request('chatInspect')
    assert.equal(
      chatAfterSelection.messageBodyEvaluations,
      chatBeforeHover.messageBodyEvaluations,
      'preview selection does not render the transcript'
    )
    const hops = selectionTiming.hops[0]
    for (const stamp of ['pageAt', 'hostAt', 'serviceAt', 'bunAt', 'bunDoneAt', 'hostReturnAt'])
      assert.ok(
        Number.isFinite(hops?.[stamp]),
        `Missing selection ${stamp}: ${JSON.stringify(hops)}`
      )
    console.log(
      `Preview with SVG chat: 100 hover enqueue ${hoverTiming.enqueue.toFixed(1)} ms, highlight ${hoverTiming.hover[0].toFixed(1)} ms, work ${hoverTiming.work[0].toFixed(1)} ms, paint upper bound ${hoverTiming.paintUpperBound[0]?.toFixed(1)} ms; select ${selectionTiming.select[0].toFixed(1)} ms, round trip ${selectionTiming.roundTrip[0].toFixed(1)} ms; hops ${JSON.stringify(selectionTiming.hops[0])}`
    )
    await host.request('shellPerform', { action: 'select-object' })
    message.text = originalText
    nativeChat.changed(chat)

    // An oversized PNG is downscaled by the composer to the provider's limit, not refused.
    const big = join(dir, 'noise.png')
    const noise = Buffer.alloc(2600 * 1000 * 4)
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.imul(i, 2654435761) >>> 13) & 255
    writeFileSync(
      big,
      png(2600, 1000, (x, y) => [...noise.subarray((y * 2600 + x) * 4, (y * 2600 + x) * 4 + 4)])
    )
    await host.request('composerPerform', { files: [big], text: 'Big picture' })
    await inspectUntil(
      (m) => host.request(m),
      'composerInspect',
      (s) => s.attachmentPreviews.count === 1 && s.text === 'Big picture' && s.enabled
    )
    await host.request('composerPerform', { action: 'send' })
    await waitFor(() => sent.length === 2, 'oversized image message reaches the provider')
    const [bigPrompt, bigImages] = sent[1] as [string, { mediaType: string; data: string }[]]
    assert.ok(bigPrompt.includes(big), `The original's path is listed: ${bigPrompt}`)
    assert.equal(bigImages.length, 1)
    assert.ok(validImage(bigImages[0].mediaType, bigImages[0].data))
    assert.ok(
      bigImages[0].data.length <= LIMITS.imageBase64,
      `The image is within the provider limit: ${bigImages[0].data.length}`
    )
    nativeChat.event({ type: 'delta', projectKey: chat.chat, text: 'Big picture received.' })
    nativeChat.event({ type: 'done', projectKey: chat.chat, landingPending: false })
    await waitFor(() => !chat.isRunning, 'oversized image turn ends')
    console.log(
      `Sent attachments: ${cells.length} thumbnails in ${rows.length} rows, ${below}pt to the bubble end, preview opened and closed.`
    )
  } finally {
    nativeChat.services.invoke = invoke
  }
}
