/**
 * Tailwind class-swap classifier (v8 T2) — pure unit test. Guards the color
 * detector against the false-positive class it used to have: any `text-`/
 * `border-`/`shadow-` prefix counted as a color, so dropping a color token onto
 * an element with `text-center` etc. silently rewrote the wrong class into source.
 *
 * Run with: bun test/tw-classes.mjs
 */
import { colorClassFamily, swapTailwindClass } from '../src/main/tw-classes.ts'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

// --- real colors ARE detected ---
for (const c of [
  'text-gray-500',
  'bg-red-500',
  'border-blue-200',
  'text-white',
  'bg-transparent',
  'text-primary', // semantic design token
  'bg-card',
  'text-muted-foreground',
  'ring-primary',
  'bg-red-500/50' // opacity modifier
]) {
  assert(colorClassFamily(c) != null, `should classify as color: ${c}`)
}

// --- non-color utilities sharing a color prefix are NOT colors ---
for (const c of [
  'text-center',
  'text-left',
  'text-sm',
  'text-2xl',
  'text-balance',
  'text-ellipsis',
  'border-2',
  'border-b',
  'border-solid',
  'shadow-lg',
  'shadow-none',
  'shadow-inner',
  'divide-y',
  'ring-2',
  'outline-none',
  'decoration-2',
  'from-10%',
  'bg-cover',
  'bg-no-repeat'
]) {
  assert(colorClassFamily(c) == null, `should NOT be a color: ${c}`)
}

// --- variants / arbitrary values are skipped (too ambiguous) ---
assert(colorClassFamily('hover:text-red-500') == null, 'variant skipped')
assert(colorClassFamily('text-[#abc]') == null, 'arbitrary value skipped')

// --- swap picks the single color utility, preserving the rest ---
assert(
  swapTailwindClass('text-gray-500 text-center', 'color', 'primary') === 'text-primary text-center',
  'swap changes only the color, leaving text-center intact'
)
// The regression: `bg-red-500 shadow-lg` is exactly ONE color now (was 2 → refused).
assert(
  swapTailwindClass('bg-red-500 shadow-lg', 'color', 'card') === 'bg-card shadow-lg',
  'shadow-lg no longer counts as a color → unambiguous swap'
)
// Genuinely ambiguous (two colors) still refuses.
assert(
  swapTailwindClass('text-gray-500 bg-white', 'color', 'primary') === null,
  'two color utilities → refuse (agent fallback)'
)
// No color to swap → refuse.
assert(swapTailwindClass('text-center flex', 'color', 'primary') === null, 'no color → refuse')

if (failed) {
  console.error(`TW-CLASSES: ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('TW-CLASSES OK — color detection, non-color rejection, single-match swap')
