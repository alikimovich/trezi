import { inflateSync } from 'node:zlib'

/** LKM-374: a non-interlaced 8-bit RGB/RGBA PNG (the visible-capture format) → rgb(x, y) and
 *  alpha(x, y), y down.
 *  Anything else throws, so a check that reads pixels fails closed. */
export function decodePng(buffer: Buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG')
  let at = 8
  let width = 0
  let height = 0
  let channels = 0
  const chunks: Buffer[] = []
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('ascii', at + 4, at + 8)
    const data = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0
      if (data[8] !== 8 || !channels || data[12] !== 0)
        throw new Error(
          `Unsupported PNG: depth ${data[8]}, colour ${data[9]}, interlace ${data[12]}`
        )
    }
    if (type === 'IDAT') chunks.push(data)
    at += 12 + length
  }
  if (!width || !height || !chunks.length) throw new Error('PNG has no image data')
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  if (raw.length < height * (stride + 1)) throw new Error('Truncated PNG image data')
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    if (filter > 4) throw new Error(`Bad PNG filter ${filter}`)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0
      const p = a + b - c
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter]
      out[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255
    }
  }
  const rgb = (x: number, y: number) => {
    const i = (y * width + x) * channels
    return [out[i], out[i + 1], out[i + 2]]
  }
  const alpha = (x: number, y: number) => (channels === 4 ? out[(y * width + x) * 4 + 3] : 255)
  return { width, height, rgb, alpha }
}
