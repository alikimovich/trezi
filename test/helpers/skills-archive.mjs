// Deterministic GitHub-style `tar.gz` archives for the skills import tests (LKM-285):
// what `git archive` writes for a commit (a pax global header carrying the commit, one
// top folder `<repo>-<commit>/`, ustar entries), plus the malformed and hostile
// variants the reader must refuse. Nothing here touches the network or the disk.
import { gzipSync } from 'node:zlib'

const field = (buffer, offset, length, text) => {
  buffer.write(text, offset, Math.min(length, Buffer.byteLength(text)), 'utf8')
}
const octal = (value, digits) => `${value.toString(8).padStart(digits, '0')}\0`

/** One 512-byte ustar header. `raw` overrides header bytes after the checksum is set. */
export function header(
  name,
  { type = '0', size = 0, mode = 0o644, link = '', prefix = '', raw, checksum = true } = {}
) {
  const block = Buffer.alloc(512)
  field(block, 0, 100, name)
  field(block, 100, 8, octal(mode, 7))
  field(block, 108, 8, octal(0, 7))
  field(block, 116, 8, octal(0, 7))
  field(block, 124, 12, octal(size, 11))
  field(block, 136, 12, octal(1_700_000_000, 11))
  block.fill(0x20, 148, 156)
  field(block, 156, 1, type)
  field(block, 157, 100, link)
  field(block, 257, 6, 'ustar\0')
  field(block, 263, 2, '00')
  field(block, 345, 155, prefix)
  if (raw) for (const [offset, bytes] of raw) Buffer.from(bytes).copy(block, offset)
  const sum = block.reduce((total, byte) => total + byte, 0)
  field(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  if (!checksum) block[150] = block[150] === 0x30 ? 0x31 : 0x30
  return block
}

const pad = (data) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])

/** `"<length> key=value\n"` with the length counting itself. */
export function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body) + 1
  while (String(length).length + Buffer.byteLength(body) !== length) length++
  return `${length}${body}`
}

/**
 * An entry: `{ path, text | data, type, mode, link, pax: {key: value}, gnuLong }`. `path`
 * is taken as is (relative to the archive, so it includes the top folder).
 */
export function entry({ path, text, data, type = '0', mode, link = '', pax, gnuLong, ...rest }) {
  const bytes = data ?? Buffer.from(text ?? '')
  const parts = []
  if (pax) {
    const records = Buffer.from(
      Object.entries(pax)
        .map(([key, value]) => paxRecord(key, value))
        .join('')
    )
    parts.push(header('PaxHeader', { type: 'x', size: records.length }), pad(records))
  }
  if (gnuLong) {
    const name = Buffer.from(`${path}\0`)
    parts.push(header('././@LongLink', { type: 'L', size: name.length }), pad(name))
  }
  const size = type === '0' ? bytes.length : 0
  parts.push(
    header(gnuLong ? path.slice(0, 99) : path, {
      type,
      size,
      mode: mode ?? (type === '5' ? 0o755 : 0o644),
      link,
      ...rest
    })
  )
  if (size) parts.push(pad(bytes))
  return Buffer.concat(parts)
}

export const globalHeader = (records) => {
  const body = Buffer.from(
    Object.entries(records)
      .map(([key, value]) => paxRecord(key, value))
      .join('')
  )
  return Buffer.concat([header('pax_global_header', { type: 'g', size: body.length }), pad(body)])
}

export const END = Buffer.alloc(1024)

/**
 * A repository archive at `commit`: `files` maps repository paths to text; folders are
 * added as `git archive` does. `before`/`after` are extra raw entries (Buffers or entry
 * specs relative to the top folder when `relative: true`).
 */
export function repository({
  repo = 'skills',
  commit,
  files = {},
  extra = [],
  global,
  end = END,
  trailer
}) {
  const root = `${repo}-${commit}`
  const blocks = [
    globalHeader(global ?? { comment: commit }),
    entry({ path: `${root}/`, type: '5' })
  ]
  const folders = new Set()
  for (const path of Object.keys(files).sort()) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      const folder = parts.slice(0, depth).join('/')
      if (!folders.has(folder)) {
        folders.add(folder)
        blocks.push(entry({ path: `${root}/${folder}/`, type: '5' }))
      }
    }
    blocks.push(entry({ path: `${root}/${path}`, text: files[path] }))
  }
  for (const item of extra)
    blocks.push(
      Buffer.isBuffer(item)
        ? item
        : entry({ ...item, path: item.absolute ? item.path : `${root}/${item.path}` })
    )
  blocks.push(end)
  if (trailer) blocks.push(trailer)
  return Buffer.concat(blocks)
}

export const gzip = (tar) => gzipSync(tar)

export const MIT = `MIT License

Copyright (c) 2026 Acme

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
`
export const APACHE = `
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/
`
