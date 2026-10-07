import { chatIslandControlPurposes, chatIslandGuidance } from '../shared/chat-island-guidance'
import {
  ISLAND_REASON,
  ISLAND_RECOVERY,
  type IslandBlocker,
  type IslandReadiness,
  type IslandRecord
} from '../shared/chat-islands'
import { newIslandName } from './chat-island-bindings'
import { cloneDefinition, findIsland } from './chat-island-context'
import { islandDefinition } from './chat-island-schema'
import { islandSource } from './chat-island-source'
import type { ChatIslands, IslandSession } from './chat-islands'

/**
 * The agent's `chat_island` tool: catalog, read, define, and (LKM-181) show {id} to show an
 * island again at the end of the chat, clone {id, rebind?} to make a new one from it.
 * Errors are the agent's answer, not island UI, so they keep the validation detail.
 */
export async function islandTool(
  islands: ChatIslands,
  chat: string,
  sourceRoot: string,
  raw: any,
  connectionId?: string
) {
  try {
    if (raw?.action === 'catalog')
      return {
        // Answers at once (a pending workspace is reported, not awaited); a ready
        // workspace without a session is attached here.
        readiness: await readiness(islands, chat, sourceRoot),
        version: 1,
        blocks: ['group', 'point', 'shadow'],
        fields: ['number', 'toggle', 'text', 'color', 'select', 'bezier'],
        actions: ['catalog', 'define', 'read', 'show', 'clone'],
        controlPurposes: chatIslandControlPurposes,
        guidance: chatIslandGuidance,
        bindingRules:
          'Existing literal bindings in one file, up to 12 fields. Jev selects/orders whole prepared blocks; keep coupled bindings together. No arbitrary code executes in islands. Read before updating with id/revision. Default auto engine uses Jev if configured. A binding that is no longer a literal of its kind disables its field; show {id} resurfaces an island, clone {id, rebind?} makes a new one from it.'
      }
    // A chat whose session is missing (a new chat's workspace was still being prepared)
    // registers it here, waiting for the workspace (LKM-199).
    const attached = await islands.attach(chat)
    if ('blocked' in attached) return blockedAnswer(chat, attached.blocked)
    const { session } = attached
    await session.opening
    if (raw?.action === 'read') {
      await islands.refresh(chat)
      return {
        islands: [...session.views.values()].filter(
          (v) => !raw.id || raw.id === v.id || raw.id === v.name || `#${raw.id}` === v.name
        )
      }
    }
    if (raw?.action === 'show') return await showIsland(islands, chat, session, raw.id)
    if (raw?.action === 'clone') {
      // A new island from an old one's definition, through the same admission and landing.
      const record = findIsland(session.records, raw.id)
      return await defineIsland(islands, chat, session, sourceRoot, {
        ...cloneDefinition(record, raw.rebind),
        action: 'define',
        engine: 'agent'
      })
    }
    if (raw?.action !== 'define') throw new Error('Unknown island action.')
    return await defineIsland(islands, chat, session, sourceRoot, raw, connectionId)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Whether this chat can host islands now, with the identity of its workspace or why not. */
async function readiness(
  islands: ChatIslands,
  chat: string,
  worktree: string
): Promise<IslandReadiness> {
  const attached = await islands.attach(chat, false)
  if ('session' in attached)
    return {
      ready: true,
      chat,
      root: attached.session.root,
      recordId: attached.session.recordId,
      worktree
    }
  return { ready: false, chat, ...blockedFields(attached.blocked) }
}

function blockedFields({ code, detail }: IslandBlocker) {
  return {
    code,
    reason: ISLAND_REASON[code],
    recovery: ISLAND_RECOVERY[code],
    ...(detail ? { detail } : {})
  }
}

/** A define/read/show/clone that cannot run: the reason code and its recovery step. */
function blockedAnswer(chat: string, blocked: IslandBlocker) {
  const fields = blockedFields(blocked)
  return { error: `${fields.reason} ${fields.recovery}`, chat, ...fields }
}

async function defineIsland(
  islands: ChatIslands,
  chat: string,
  session: IslandSession,
  sourceRoot: string,
  raw: any,
  connectionId?: string
) {
  if (session.composing || session.busy)
    throw new Error('An island operation is already in progress.')
  const definition = islandDefinition(raw)
  const admission = await islands.owner.islandDefine(
    chat,
    session.turn(),
    islands.origin(chat),
    raw.id,
    raw.id ? raw.revision : undefined
  )
  const prior = raw.id ? session.records.find((r) => r.id === raw.id) : undefined
  session.composing = true
  try {
    const name =
      prior?.name ??
      newIslandName(
        definition.manifest.title,
        session.records.flatMap((r) => (r.name ? [r.name] : []))
      )
    const record: IslandRecord = {
      version: 1,
      id: admission.id,
      revision: admission.revision,
      turn: admission.turn,
      ...definition,
      engine: 'agent',
      status: 'waiting',
      initial: {},
      name
    }
    const source = await islandSource(sourceRoot, record)
    const failing = Object.values(source.broken)
    if (failing.length)
      throw new Error(
        `${failing[0].replace(/; this control.*$/, '')}. Bind a literal of its kind, or pass rebind.`
      )
    session.preview = {
      turn: record.turn,
      view: {
        id: record.id,
        name: `#${name}`,
        revision: record.revision,
        title: record.manifest.title,
        blocks: record.blocks,
        fields: record.manifest.params.map((p) => ({ ...p, value: source.values[p.id] ?? null })),
        sourceRevision: source.revision,
        status: 'waiting',
        engine: 'preparing',
        replay: false,
        detail: 'Preparing layout. Controls activate after this turn’s changes land.'
      }
    }
    islands.changed(chat)
    const selection = await islands.select(`island:${chat}`, definition.blocks, {
      engine: raw.engine ?? 'auto',
      prompt: raw.prompt ?? `Choose useful controls for ${record.manifest.title}`,
      connectionId
    })
    if (islands.sessions.get(chat) !== session)
      throw new Error('Chat closed or turn finished during composition.')
    const blocks = selection.controls
    const included = new Set(blocks.flatMap((b) => b.params))
    const manifest = {
      ...record.manifest,
      params: record.manifest.params.filter((p) => included.has(p.id))
    }
    const initial = Object.fromEntries(
      manifest.params.map((p) => {
        const before = prior?.manifest.params.find((old) => old.id === p.id)
        const compatible =
          admission.replacing &&
          prior?.manifest.file === manifest.file &&
          JSON.stringify(before) === JSON.stringify(p)
        return [
          p.id,
          compatible ? (prior!.initial[p.id] ?? source.values[p.id]) : source.values[p.id]
        ]
      })
    )
    const records = await islands.owner.islandCommit(
      chat,
      admission.token,
      { manifest, blocks },
      selection.engine,
      initial,
      selection.fallback,
      name
    )
    islands.adopt(chat, session, records)
    await islands.refresh(chat)
    return {
      id: admission.id,
      name: `#${name}`,
      revision: admission.revision,
      engine: selection.engine,
      fallback: selection.fallback,
      message: 'Island attached to this chat. Controls activate after successful landing.'
    }
  } catch (error) {
    void islands.owner.islandAbort(chat, admission.token).catch(() => {})
    throw error
  } finally {
    session.composing = false
    session.preview = undefined
    if (islands.sessions.get(chat) === session) islands.changed(chat)
  }
}

/** `show {id}`: the same island again, live at the end of the chat. */
async function showIsland(
  islands: ChatIslands,
  chat: string,
  session: IslandSession,
  key: unknown
) {
  if (session.composing || session.busy)
    throw new Error('An island operation is already in progress.')
  const record = findIsland(session.records, key)
  islands.adopt(
    chat,
    session,
    await islands.owner.islandShow(chat, record.id, session.turn(), islands.origin(chat))
  )
  await islands.refresh(chat)
  const view = session.views.get(record.id)
  return {
    id: record.id,
    name: `#${record.name}`,
    status: view?.status,
    ...(view?.reason ? { reason: view.reason } : {}),
    message:
      view?.status === 'disabled'
        ? 'Island shown at the end of this chat, but the code no longer supports it. Use action:clone with rebind.'
        : 'Island shown again at the end of this chat.'
  }
}
