import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Preserve the original pixel art and animation timings, without an SVG/WebKit renderer.
export function nativeCatAssets(root) {
  const base = join(root, 'src/native/assets/cat')
  const frame = (file, duration) => {
    const svg = readFileSync(join(base, file), 'utf8')
    if (/<(?:path|circle|polygon|ellipse)\b/.test(svg)) throw new Error(`Unsupported native cat artwork: ${file}`)
    const pixels = [...svg.matchAll(/<rect\b([^>]+)\/?\s*>/g)].map(([, attrs]) => {
      const value = name => Number(attrs.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1] ?? 0)
      return [value('x'), value('y'), value('width'), value('height')]
    })
    return { duration, pixels }
  }
  const result = { rest: [frame('idle.svg', 0)], run: [frame('run-1.svg', 130), frame('run-2.svg', 130)] }
  for (const pose of ['appear', 'think', 'jump', 'idle']) {
    const metadata = JSON.parse(readFileSync(join(base, `selected/${pose}/animation.json`), 'utf8'))
    result[pose] = metadata.frames.map(f => frame(`selected/${pose}/${f.file}`, f.durationMs))
  }
  return result
}
