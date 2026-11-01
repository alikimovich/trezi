import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PeerGateNote } from '../shared/api'
import { landedPeers, peerView } from './peer-work'
import { productLog, redact } from './product-log'

/**
 * What a landing sees of its peers at the gate (LKM-403). Called inside the repository
 * lease, so nothing else lands between this read and the owner's write. `base..HEAD`
 * covers every landing since this work forked: peers from the ring, and anything else
 * (a user's commit, a peer from before a restart) by its commit subject. It informs and
 * never decides: a slow or failed read is reported as stale and the landing goes on.
 */

const git = promisify(execFile)
const REFRESH_MS = 3000
const MAX_LANDED = 6
const MAX_SUBJECT = 120
const MAX_BYTES = 1536

const lines = async (root: string, args: string[]): Promise<string[]> =>
  (await git('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 2000 })).stdout
    .split('\n')
    .filter(Boolean)

async function read(liveRoot: string, self: string, base: string): Promise<PeerGateNote> {
  const [current] = await lines(liveRoot, ['rev-parse', 'HEAD'])
  const commits = await lines(liveRoot, [
    'log',
    '--max-count=256',
    '--format=%H%x09%s',
    `${base}..${current}`
  ])
  const subject = new Map(
    commits.map((line) => [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)])
  )
  const known = landedPeers(liveRoot, self).filter((peer) => subject.has(peer.revision))
  const seen = new Set(known.map((peer) => peer.revision))
  const landed: PeerGateNote['landed'] = [
    ...known.map((peer) => ({
      task: peer.id,
      origin: peer.origin,
      goal: peer.goal.slice(0, MAX_SUBJECT),
      revision: peer.revision,
      files: peer.files.slice(0, 4)
    })),
    ...[...subject]
      .filter(([revision]) => !seen.has(revision))
      .map(([revision, text]) => ({
        origin: 'commit',
        goal: redact(text).slice(0, MAX_SUBJECT),
        revision,
        files: []
      }))
  ].slice(0, MAX_LANDED)
  const view = await peerView(liveRoot, self)
  return {
    base,
    current,
    landed,
    more: Math.max(0, subject.size - landed.length),
    active: view.rows.length,
    advisories: view.advisories.length,
    stale: false,
    combinedRechecked: false,
    tree: null
  }
}

/** Never throws, and answers within `REFRESH_MS`. */
export async function peerGateRefresh(
  liveRoot: string,
  self: string,
  base: string
): Promise<PeerGateNote> {
  const stale: PeerGateNote = {
    base,
    current: null,
    landed: [],
    more: 0,
    active: 0,
    advisories: 0,
    stale: true,
    combinedRechecked: false,
    tree: null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const note = await Promise.race([
    read(liveRoot, self, base).catch(() => stale),
    new Promise<PeerGateNote>((resolve) => {
      timer = setTimeout(() => resolve(stale), REFRESH_MS)
    })
  ])
  if (timer) clearTimeout(timer)
  while (note.landed.length && Buffer.byteLength(JSON.stringify(note)) > MAX_BYTES) {
    note.landed.pop()
    note.more++
  }
  productLog.info('landing', 'Peer state refreshed at the gate', {
    landed: note.landed.length + note.more,
    active: note.active,
    stale: note.stale
  })
  return note
}

/** Whether this note says anything worth keeping on the landing's record. */
export const peerGateMatters = (note: PeerGateNote): boolean =>
  note.stale || note.combinedRechecked || note.active > 0 || note.landed.length > 0
