import '../shared/rename-compat'
import { nativeProfilePath } from './profile-path'
/** Native application services and the isolated WebKit message boundary. */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { platformOwner } from '../main/platform-owner'
import { AGENT_CAPTURE } from '../main/preview-state'
import * as channels from '../shared/preview-channels'
import { bridge } from './bridge'

export const app = Object.assign(new EventEmitter(), {
  getPath(name: string) {
    if (name === 'temp') return tmpdir()
    if (name === 'userData')
      return (
        process.env.TREZI_USER_DATA ||
        nativeProfilePath(join(homedir(), 'Library/Application Support'))
      )
    throw new Error(`Unsupported native path: ${name}`)
  },
  getAppPath: () => resolve(__dirname, '../..')
})
export interface NativeIpcEvent {
  sender: NativeWebContents
}
type Handler = (event: NativeIpcEvent, ...args: any[]) => any
const requests = new Map<string, Handler>()
/** Trusted in-process observation; preview IPC cannot emit these events. */
export const serviceEvents = new EventEmitter()
export const ipcMain = Object.assign(new EventEmitter(), {
  handle(channel: string, handler: Handler) {
    if (requests.has(channel)) throw new Error(`Duplicate native IPC handler: ${channel}`)
    requests.set(channel, handler)
  }
})
export const previewSendChannels = new Set([
  channels.PREVIEW_PICKED,
  channels.PREVIEW_CANCELLED,
  channels.PREVIEW_SELECTION_LOST,
  channels.PREVIEW_TOGGLE_SELECT,
  channels.PREVIEW_TOOLBAR_ACTION,
  channels.PREVIEW_READINESS,
  channels.PREVIEW_TEXT_EDIT,
  channels.PREVIEW_PIN_CLICK,
  channels.PREVIEW_COMMENT_MODE,
  channels.PREVIEW_COMMENT,
  channels.STYLES_READ_REPLY,
  channels.LAYERS_READ_REPLY,
  channels.LAYERS_CHANGED,
  channels.PREVIEW_MOVE_NODE,
  channels.ISLAND_OVERRIDE_REPLY,
  channels.PREVIEW_STATES_KEY,
  channels.PREVIEW_THREE_D_STATE
])
export async function dispatchIPC(view: string, message: any) {
  if (!message || typeof message.channel !== 'string' || !Array.isArray(message.args))
    throw new Error('Invalid IPC message')
  if (view === 'preview' && (message.type !== 'send' || !previewSendChannels.has(message.channel)))
    throw new Error('Preview cannot invoke application commands')
  const sender = views.get(view)?.webContents
  if (!sender) throw new Error('Unknown IPC sender')
  const event = { sender }
  // JSON otherwise changes omitted optional arguments into null, defeating JS
  // default parameters in the shared handlers (for example newChat(root)).
  const undefinedArgs = new Set(Array.isArray(message.undefinedArgs) ? message.undefinedArgs : [])
  const args = message.args.map((value: unknown, index: number) =>
    undefinedArgs.has(index) ? undefined : value
  )
  if (message.type === 'invoke') {
    const handler = requests.get(message.channel)
    if (!handler) throw new Error(`Unsupported native command: ${message.channel}`)
    const result = await handler(event, ...args)
    serviceEvents.emit('command', message.channel, args, result)
    return result
  }
  ipcMain.emit(message.channel, event, ...args)
}

/** Opening outside Trezi: the platform owner runs `open` (LKM-102). */
export const shell = {
  async openExternal(url: string) {
    await platformOwner().openLink(url)
  },
  async openPath(path: string) {
    return platformOwner()
      .openFile(resolve(path))
      .catch((error) => String(error))
  }
}

/** The host's answer to an agent capture: base64 JPEG, pixel size and its own timings. */
export interface AgentCaptureReply {
  jpeg: string
  width: number
  height: number
  snapshotMs?: number
  encodeMs?: number
}

export class NativeImage {
  constructor(private result: { png: string; jpeg: string; width: number; height: number }) {}
  isEmpty() {
    return !this.result.png
  }
  getSize() {
    return { width: this.result.width, height: this.result.height }
  }
  toPNG() {
    return Buffer.from(this.result.png, 'base64')
  }
  toJPEG(_quality?: number) {
    return Buffer.from(this.result.jpeg, 'base64')
  }
  toDataURL() {
    return `data:image/png;base64,${this.result.png}`
  }
  // Swift generates a bounded JPEG alongside the full PNG for agent/feedback use.
  resize(_options?: { width?: number; height?: number }) {
    return this
  }
}
export class NativeView {
  url = ''
  destroyed = false
  webContents: {
    isDestroyed: () => boolean
    getURL: () => string
    send: (channel: string, ...args: any[]) => void
    /** `hard` (LKM-197): WebKit's caches are cleared first; the same URL reloads from origin. */
    loadURL: (url: string, options?: { hard?: boolean }) => void
    capturePage: () => Promise<NativeImage>
    executeJavaScript: (code: string) => Promise<any>
    insertCSS: (css: string) => Promise<string>
    removeInsertedCSS: (key: string) => Promise<any>
    /** Agent preview tools (LKM-138): the TreziPreview or the handler-less TreziAgent world. */
    evaluateIn: (code: string, world: 'preview' | 'agent', timeout: number) => Promise<unknown>
    captureRect: (rect: {
      x: number
      y: number
      width: number
      height: number
    }) => Promise<NativeImage>
    setViewport: (width: number | null) => Promise<{ width: number | null; zoom: number }>
    /** A small JPEG (base64, at most 160 px wide unless `width`, up to 480) of the current
     *  frame or of `rect` (CSS px), for chat rows and answer-component previews (LKM-208). */
    captureThumbnail: (options?: {
      width?: number
      rect?: { x: number; y: number; width: number; height: number }
    }) => Promise<string>
    /** The agent's frame (LKM-200): one JPEG rendered at its bounded size, with host timings. */
    captureAgent: (options: { full?: boolean }) => Promise<AgentCaptureReply>
  }
  constructor(readonly id: string) {
    views.set(id, this)
    this.webContents = {
      isDestroyed: () => this.destroyed,
      getURL: () => this.url,
      send: (channel: string, ...args: unknown[]) => {
        if (id === 'main') serviceEvents.emit('event', channel, ...args)
        else bridge().send('deliver', { view: id, message: { type: 'event', channel, args } })
      },
      loadURL: (url: string, options?: { hard?: boolean }) => {
        this.url = url
        bridge().send('load', { view: id, url, ...(options?.hard ? { hard: true } : {}) })
      },
      capturePage: async () =>
        new NativeImage(
          id === 'main'
            ? await bridge().request('captureShellImage')
            : await bridge().request('capture', { view: id })
        ),
      executeJavaScript: (code: string) => bridge().request('evaluate', { view: id, code }),
      insertCSS: async (css: string) => {
        const key = randomUUID()
        await bridge().request('evaluate', {
          view: id,
          isolated: true,
          code: `(()=>{const s=document.createElement('style');s.id=${JSON.stringify(key)};s.textContent=${JSON.stringify(css)};document.documentElement.append(s)})()`
        })
        return key
      },
      removeInsertedCSS: (key: string) =>
        bridge().request('evaluate', {
          view: id,
          isolated: true,
          code: `document.getElementById(${JSON.stringify(key)})?.remove()`
        }),
      evaluateIn: (code, world, timeout) =>
        bridge().request(
          'evaluate',
          { view: id, code, isolated: world === 'preview', world },
          timeout
        ),
      captureRect: async (rect) =>
        new NativeImage(await bridge().request('capture', { view: id, rect })),
      captureThumbnail: async (options) =>
        (await bridge().request('capture', { view: id, thumbnail: true, ...options })).jpeg,
      captureAgent: (options) =>
        bridge().request('capture', {
          view: id,
          agent: { maxPixels: AGENT_CAPTURE.maxPixels, quality: AGENT_CAPTURE.quality, ...options }
        }),
      setViewport: (width) => bridge().request('previewViewport', { view: id, width })
    }
  }
  setBounds(bounds: object) {
    bridge().send('bounds', { view: this.id, bounds })
  }
  setBorderRadius(radius: number) {
    bridge().send('radius', { view: this.id, radius })
  }
  setVisible(visible: boolean) {
    bridge().send('visible', { view: this.id, visible })
  }
}
export const views = new Map<string, NativeView>()
export type NativeWebContents = NativeView['webContents']
