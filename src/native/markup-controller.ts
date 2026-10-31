import { sendableImages, validImage } from '../main/provider-policy'
import type { NativeBridge } from './bridge'
import type { Attachment, Chat } from './chat-state'
import { type MarkupCapture, markupNote } from './markup-context'

/** The chat and project a session opened in, the only composer it may reach. */
export interface MarkupBinding {
  chat: string
  project: string
}
export type MarkupFile = Pick<Attachment, 'name' | 'type' | 'data'>
export type MarkupResult = { ok: true; notice?: string } | { ok: false; message: string }

interface MarkupAdded extends MarkupFile {
  session: string
  capture?: MarkupCapture
}
interface MarkupState {
  session: string
  state: 'open' | 'failed' | 'cancelled'
  message?: string
}
interface MarkupOptions {
  host: Pick<NativeBridge, 'send'>
  /** The active chat and project now, or null when there is none to bind to. */
  binding(): MarkupBinding | null
  add(
    binding: MarkupBinding,
    file: MarkupFile,
    note: (name: string) => string
  ): Promise<MarkupResult>
  toast(message: string): void
  /** Shows the composer the image went to, when the chat column is hidden. */
  reveal?(): void
}

const DISCARDED = 'Mark up discarded because the chat or project changed. Nothing was attached.'

/**
 * LKM-391: Mark up sessions. The host owns the snapshot and the marks; this owns which chat
 * they belong to. A change of chat or project discards the session and says so, and Add
 * checks the binding again, so a mark up can never reach another composer. Add only appends
 * to the composer: the user's own Send delivers it.
 */
export class NativeMarkupController {
  session: string | null = null
  private bound: MarkupBinding | null = null
  constructor(private readonly options: MarkupOptions) {}

  begin() {
    if (this.session) return
    const bound = this.options.binding()
    if (!bound) {
      this.options.toast('Open a chat in a project to mark up its preview.')
      return
    }
    this.session = crypto.randomUUID()
    this.bound = bound
    this.options.host.send('markupBegin', { session: this.session })
  }
  private clear() {
    this.session = null
    this.bound = null
  }
  /** Run whenever the active chat or project may have changed. */
  check() {
    if (!this.session || !this.bound) return
    const now = this.options.binding()
    if (now?.chat === this.bound.chat && now.project === this.bound.project) return
    this.options.host.send('markupEnd', { session: this.session })
    this.clear()
    this.options.toast(DISCARDED)
  }
  state(event: MarkupState) {
    if (event.session !== this.session || event.state === 'open') return
    this.clear()
    if (event.state === 'failed') this.options.toast(event.message ?? 'Mark up failed.')
  }
  async added(event: MarkupAdded) {
    const { session } = event
    const done = (ok: boolean, message?: string) =>
      this.options.host.send('markupDone', { session, ok, ...(message ? { message } : {}) })
    if (session !== this.session) return done(false, 'This mark up is already closed.')
    this.check()
    if (!this.session || !this.bound) return
    const result = await this.options.add(
      this.bound,
      { name: event.name, type: event.type, data: event.data },
      (name) => markupNote(name, event.capture ?? {})
    )
    if (session !== this.session) return
    if (!result.ok) return done(false, result.message)
    this.clear()
    done(true)
    this.options.reveal?.()
    this.options.host.send('composerFocus', {})
    if (result.notice) this.options.toast(result.notice)
  }
}

/** Appends the image to the composer. Never sends, and never joins a send already leaving. */
export function addMarkupToChat(
  chat: Chat,
  file: MarkupFile,
  note: (name: string) => string,
  takesImages: boolean
): MarkupResult {
  if (chat.submitting)
    return {
      ok: false,
      message: 'This chat is sending a message. Add the mark up once it has gone.'
    }
  if (typeof file.type !== 'string' || !validImage(file.type, file.data))
    return { ok: false, message: 'The marked-up image could not be read, so it was not added.' }
  const images = chat.attachments.flatMap((a) =>
    validImage(a.type, a.data) ? [{ mediaType: a.type, data: a.data }] : []
  )
  if (sendableImages([...images, { mediaType: file.type, data: file.data }]).dropped)
    return {
      ok: false,
      message: 'This message cannot hold another image. Remove one from the composer, then add it.'
    }
  const extension = file.type === 'image/png' ? 'png' : 'jpg'
  const taken = new Set(chat.attachments.map((a) => a.name))
  let name = `Mark up.${extension}`
  for (let n = 2; taken.has(name); n++) name = `Mark up ${n}.${extension}`
  chat.attachments.push({
    id: crypto.randomUUID(),
    name,
    path: '',
    type: file.type,
    data: file.data,
    note: note(name)
  })
  return takesImages
    ? { ok: true }
    : {
        ok: true,
        notice:
          'Mark up added, but this provider cannot take images. Choose another model before sending.'
      }
}

/** Host events to the controller. */
export function installMarkup(host: NativeBridge, options: Omit<MarkupOptions, 'host'>) {
  const markup = new NativeMarkupController({ ...options, host })
  host.on('markup-state', (event) => markup.state(event))
  host.on('markup-add', (event) => void markup.added(event))
  return markup
}
