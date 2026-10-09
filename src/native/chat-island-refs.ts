import type { IslandReference } from '../shared/chat-islands'
import { rankSlashMatches } from '../shared/slash-menu'
import { parseSlashToken } from '../shared/slash-token'
import type { Chat } from './chat-state'

/**
 * LKM-181: the composer's menu. "/" picks a command; "#" picks one of the chat's islands
 * (`#island-shadow-2`), which the message then references. Copy reference adds the same
 * name as a chip; a sent message carries every chip's name in its text.
 */
export interface MenuItem {
  title: string
  description: string
  /** Replaces the token from `start` to the caret. */
  insert: string
  start: number
}

/** The "#" token that contains the caret, as `parseSlashToken` reads "/". */
export function parseHashToken(input: string, caret: number) {
  const m = input.slice(0, caret).match(/(?:^|\s)#([\w-]*)$/)
  return m ? { query: m[1], start: caret - m[1].length - 1 } : null
}

let directory: (chat: string) => IslandReference[] = () => []
/** The chat runtime names each chat's islands (hidden ones too: Show brings them back). */
export function setIslandDirectory(list: (chat: string) => IslandReference[]) {
  directory = list
}

const STATUS: Record<IslandReference['status'], string> = {
  waiting: 'waiting',
  ready: 'ready',
  'partially-disabled': 'partly disabled',
  disabled: 'disabled',
  hidden: 'hidden'
}

export function menuItems(chat: Chat): MenuItem[] {
  if (chat.dismissed) return []
  const slash = parseSlashToken(chat.text, chat.caret)
  if (slash)
    return rankSlashMatches(chat.commands, slash.query).map((command) => ({
      title: `/${command.name}`,
      description: command.description ?? '',
      insert: `/${command.name} `,
      start: slash.start
    }))
  const hash = parseHashToken(chat.text, chat.caret)
  if (!hash) return []
  const query = hash.query.toLowerCase()
  return directory(chat.chat)
    .filter(
      (island) => island.name.slice(1).includes(query) || island.title.toLowerCase().includes(query)
    )
    .slice(0, 8)
    .map((island) => ({
      title: island.name,
      description: `${island.title} · ${STATUS[island.status]}`,
      insert: `${island.name} `,
      start: hash.start
    }))
}

/** What the menu is open on, so a changed query resets its selection. */
export function menuQuery(text: string, caret: number) {
  const slash = parseSlashToken(text, caret)
  if (slash) return `/${slash.query}`
  const hash = parseHashToken(text, caret)
  return hash ? `#${hash.query}` : undefined
}

let described: (chat: Chat, name: string) => string | undefined = () => undefined
/** LKM-220: what a sent message says about a non-island chip (a states workbench's). */
export function setReferenceDetails(describe: (chat: Chat, name: string) => string | undefined) {
  described = describe
}

/** Copy reference: a chip for the island, once. LKM-220: or a states workbench (`#states-…`). */
export function addReference(chat: Chat, name: string) {
  if (!/^#(?:island|states)-[a-z0-9-]+$/.test(name)) return
  chat.references = [...new Set([...(chat.references ?? []), name])]
}

/** The text a message sends: chip names it does not already mention come first, and a
 *  workbench chip's description last. */
export function withReferences(chat: Chat, text: string) {
  const references = chat.references ?? []
  const missing = references.filter(
    (name) => !new RegExp(`(?:^|[^\\w#-])${name}(?![\\w-])`).test(text)
  )
  const details = references.map((name) => described(chat, name)).filter(Boolean)
  chat.references = []
  const sent = missing.length ? `${missing.join(' ')} ${text}`.trim() : text
  return details.length ? `${sent}\n\n${details.join('\n')}` : sent
}
