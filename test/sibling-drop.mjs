import assert from 'node:assert/strict'
import { siblingSlot } from '../src/preview/sibling-drop.ts'

const b = (left, top, width = 100, height = 40) => ({ left, top, width, height })
const column = [b(0, 0), b(0, 50), b(0, 100)]
let slot = siblingSlot(column, 0, 50, 138, false, false)
assert.equal(slot.index, 2)
assert.equal(slot.position, 'after')
assert.equal(slot.vertical, false)
assert.equal(
  siblingSlot(column, 0, 50, 51, false, false),
  null,
  'adjacent original position is a no-op'
)
slot = siblingSlot(column, 2, 50, 1, false, false)
assert.equal(slot.index, 0)
assert.equal(slot.position, 'before')
const row = [b(0, 0), b(110, 0), b(220, 0)]
slot = siblingSlot(row, 0, 319, 20, true, false)
assert.equal(slot.index, 2)
assert.equal(slot.position, 'after')
assert.equal(slot.vertical, true)
slot = siblingSlot([...row].reverse(), 0, 1, 20, true, true)
assert.equal(slot.index, 2)
assert.equal(slot.position, 'after', 'RTL after is on the left')
const grid = [b(0, 0), b(110, 0), b(0, 50), b(110, 50)]
slot = siblingSlot(grid, 0, 209, 70, true, false)
assert.equal(slot.index, 3)
assert.equal(slot.position, 'after')
assert.equal(siblingSlot([b(0, 0)], 0, 0, 0, false, false), null)
console.log('PASS sibling drop geometry: columns, rows, grids, reverse, no-ops')
