// LKM-166: an attachment never fails the turn. SVG and other non-provider images keep
// their original on disk (listed by path) and send a PNG preview; other files are listed
// by path; oversized or unsendable images are named, not refused. Provider-policy is the
// judge of what "sendable" means, so the payload is checked against it.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS, sendableImages, validImage, validImages } from '../src/main/provider-policy.ts'
import { planAttachments } from '../src/native/chat-attachments.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'

const scratch = mkdtempSync(join(tmpdir(), 'trezi-chat-attachments-'))
try {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')
  const preview = Buffer.alloc(30_000, 5).toString('base64')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
  const svgPath = join(scratch, 'bag.fill.svg')
  writeFileSync(svgPath, svg)
  const attachment = (over) => ({
    id: crypto.randomUUID(),
    name: 'a',
    path: '',
    type: '',
    data: '',
    ...over
  })
  const savedPaths = []
  const save = async (a) => {
    const path = join(scratch, `saved-${savedPaths.length}-${a.name}`)
    writeFileSync(path, Buffer.from(a.data, 'base64'))
    savedPaths.push(path)
    return path
  }

  // An SVG is accepted: its path is listed, the file exists, and a PNG preview is sent.
  const svgPlan = await planAttachments(
    [
      attachment({
        name: 'bag.fill.svg',
        path: svgPath,
        type: 'image/svg+xml',
        data: Buffer.from(svg).toString('base64'),
        preview
      })
    ],
    save
  )
  assert.match(svgPlan.header, /^\[Attached files\]\n/)
  assert.ok(svgPlan.header.includes(`${svgPath} (image/svg+xml;`))
  assert.ok(existsSync(svgPath) && readFileSync(svgPath, 'utf8') === svg)
  assert.deepEqual(svgPlan.images, [{ mediaType: 'image/png', data: preview }])
  assert.ok(validImages(svgPlan.images) && validImage('image/png', svgPlan.images[0].data))
  assert.ok(svgPlan.images[0].data.length <= LIMITS.imageBase64)
  assert.doesNotMatch(svgPlan.header, /Not attached/)

  // A pasted SVG has no path: the original is saved in the attachments folder first.
  const pasted = await planAttachments(
    [
      attachment({
        name: 'logo.svg',
        type: 'image/svg+xml',
        data: Buffer.from(svg).toString('base64'),
        preview
      })
    ],
    save
  )
  assert.equal(savedPaths.length, 1)
  assert.ok(pasted.header.includes(savedPaths[0]))
  assert.equal(readFileSync(savedPaths[0], 'utf8'), svg)
  assert.equal(pasted.images.length, 1)

  // An oversized PNG is accepted: it is listed by path and not sent inline.
  const huge = 'A'.repeat(LIMITS.imageBase64 + 4)
  assert.ok(!validImage('image/png', huge))
  const hugePath = join(scratch, 'huge.png')
  const oversized = await planAttachments(
    [attachment({ name: 'huge.png', path: hugePath, type: 'image/png', data: huge })],
    save
  )
  assert.deepEqual(oversized.images, [])
  assert.equal(oversized.header, `[Attached files]\n${hugePath}\n\n`)
  // …but with a downscaled preview the turn still carries a picture.
  const withPreview = await planAttachments(
    [attachment({ name: 'huge.png', path: hugePath, type: 'image/png', data: huge, preview })],
    save
  )
  assert.deepEqual(withPreview.images, [{ mediaType: 'image/png', data: preview }])
  assert.ok(withPreview.header.includes(hugePath))

  // A within-limits image is sent as an image and listed by path; a file is listed by path.
  const mixed = await planAttachments(
    [
      attachment({ name: 'shot.png', path: '/tmp/shot.png', type: 'image/png', data: png }),
      attachment({ name: 'spec.pdf', path: '/tmp/spec.pdf', type: 'application/octet-stream' })
    ],
    save
  )
  assert.equal(
    mixed.header,
    '[Attached files]\n/tmp/spec.pdf\n\n[Attached images — the image(s) in this message are on disk at]\n/tmp/shot.png\n\n'
  )
  assert.deepEqual(mixed.images, [{ mediaType: 'image/png', data: png }])

  // Too many images: the extra ones are named, never an error.
  const many = Array.from({ length: LIMITS.images + 2 }, (_, i) =>
    attachment({ name: `p${i}.png`, path: `/tmp/p${i}.png`, type: 'image/png', data: png })
  )
  const crowd = await planAttachments(many, save)
  assert.equal(crowd.images.length, LIMITS.images)
  assert.match(crowd.header, /\[Not attached: p16\.png \(too many[^;]*; p17\.png/)
  assert.equal(sendableImages(crowd.images).dropped, 0)

  // A failed save, or an unreadable file, is reported and does not throw.
  const failed = await planAttachments(
    [
      attachment({ name: 'pasted.png', type: 'image/png', data: png }),
      attachment({ name: 'gone', type: 'application/octet-stream' })
    ],
    async () => {
      throw new Error('disk full')
    }
  )
  // The pasted image is still sent inline; only its path is missing.
  assert.match(failed.header, /gone \(the agent cannot read it\)/)
  assert.deepEqual(failed.images, [{ mediaType: 'image/png', data: png }])
  const empty = await planAttachments(
    [attachment({ name: 'p.png', type: 'image/png', data: png })],
    async () => ''
  )
  assert.equal(empty.header, '')
  assert.equal(empty.images.length, 1)
  // A pasted SVG whose original cannot be saved still sends its preview and says so.
  const unsaved = await planAttachments(
    [attachment({ name: 'logo.svg', type: 'image/svg+xml', data: 'PHN2Zz4=', preview })],
    async () => {
      throw new Error('disk full')
    }
  )
  assert.match(
    unsaved.header,
    /logo\.svg \(the original could not be saved; only its preview is attached\)/
  )
  assert.equal(unsaved.images.length, 1)

  // End to end through the chat controller: the turn reaches agent:send with the path
  // text and a payload the provider owner accepts.
  const calls = []
  const controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args])
      if (channel === 'agent:workspace-snapshot')
        return {
          projects: [
            {
              root: '/fixture',
              chats: [
                {
                  sessionKey: 'a',
                  record: { transcript: [], title: 'A' },
                  isRunning: false,
                  options: { provider: 'codex', permissionMode: 'auto' }
                }
              ]
            }
          ]
        }
      if (channel === 'providers:choices') return []
      if (channel === 'agent:send') {
        const images = args[1]
        if (images && !validImages(images))
          throw new Error('The pasted images are not supported or too large.')
      }
      return { ok: true }
    },
    render() {},
    effect() {}
  })
  await controller.command({
    type: 'context',
    context: {
      chat: 'a',
      root: '/fixture',
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    }
  })
  await controller.composer({
    chat: 'a',
    action: 'files',
    files: [
      {
        name: 'bag.fill.svg',
        path: svgPath,
        type: 'image/svg+xml',
        data: Buffer.from(svg).toString('base64'),
        preview
      },
      { name: 'huge.png', path: hugePath, type: 'image/png', data: huge, preview }
    ]
  })
  await controller.composer({
    chat: 'a',
    action: 'input',
    text: 'Use these',
    caret: 9,
    revision: 1
  })
  await controller.composer({ chat: 'a', action: 'send' })
  for (let i = 0; i < 20 && !calls.some((c) => c[0] === 'agent:send'); i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const send = calls.find((c) => c[0] === 'agent:send')
  assert.ok(send, 'the turn was sent')
  assert.ok(send[1].includes(svgPath) && send[1].endsWith('Use these'))
  assert.equal(send[2].length, 2)
  assert.ok(send[2].every((i) => i.mediaType === 'image/png' && validImage(i.mediaType, i.data)))
  assert.doesNotMatch(controller.get('a').messages.at(-1).text ?? '', /Unable to send/)
  console.log(
    'Chat attachments: SVG, oversized, file, pasted and failed attachments never fail the turn.'
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
