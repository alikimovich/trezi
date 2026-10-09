import { fileURLToPath } from 'node:url'
import { NATIVE_SMOKE_GROUPS, parseSmokeGroups } from '../src/native/smoke-groups.ts'
import { requireSupportedPlatform } from './requirements.mjs'

try {
  requireSupportedPlatform()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

if (process.argv.includes('--help')) {
  console.log(
    [
      'bun run dev:native [--project /path/to/repo]',
      'bun run dev:native --test [--only=group,group] [--live]',
      'Build and launch Trezi with Bun + WebKit. Use bun run test:native for integration checks.',
      `--only (with --test) runs only the named smoke groups: ${NATIVE_SMOKE_GROUPS.join(', ')}.`,
      'Without --only every group runs.'
    ].join('\n')
  )
  process.exit(0)
}
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project' && args[i + 1]) {
    i++
    continue
  }
  if (['--test', '--live'].includes(args[i]) || args[i] === '--only' || args[i].startsWith('--only=')) continue
  console.error(
    `Unknown native argument: ${args[i]}. Use --project /path/to/repo; Trezi manages its dev server.`
  )
  process.exit(1)
}
// Fail before the build: a typo in a group name should not cost a full build.
if (args.some(arg => arg === '--only' || arg.startsWith('--only='))) {
  if (!args.includes('--test')) {
    console.error('--only selects native smoke groups and requires --test.')
    process.exit(1)
  }
  try {
    parseSmokeGroups(args)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

console.log('Building Trezi (Bun + system WebKit)…')
const cwd = fileURLToPath(new URL('../', import.meta.url))
const build = Bun.spawn([process.execPath, 'scripts/build-native.mjs'], {
  cwd,
  // A test build signs with an existing identity but never adds one to the keychain, and
  // compiles the fast -Onone test profile unless TREZI_BUILD_PROFILE says otherwise (LKM-175).
  env: args.includes('--test')
    ? { ...process.env, TREZI_SIGN_CREATE: '0', TREZI_BUILD_PROFILE: process.env.TREZI_BUILD_PROFILE || 'test' }
    : process.env,
  stdout: 'inherit',
  stderr: 'inherit'
})
const code = await build.exited
if (code) process.exit(code)
const child = Bun.spawn([process.execPath, 'scripts/start-native.mjs', ...args], {
  cwd,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit'
})
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
process.on('SIGHUP', () => child.kill('SIGHUP'))
process.exit(await child.exited)
