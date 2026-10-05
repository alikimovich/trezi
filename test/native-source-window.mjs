import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const result = spawnSync('bun', ['test/helpers/native-source-window.mjs'], {
  stdio: 'inherit',
  timeout: 60000
})
if (result.error) throw result.error
assert.equal(result.status, 0)
