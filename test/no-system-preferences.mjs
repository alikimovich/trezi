// Guard: verification must never read-modify-write the user's macOS settings.
// Fails if app code, test helpers or the native harness invoke the `defaults`
// tool (any domain, com.apple.* included), write CFPreferences/other-domain
// UserDefaults, broadcast system preference notifications, or name the
// system keys earlier fixtures toggled. Modes are switched by the in-process
// ChatSystemEnvironment override instead (see docs/TESTING.md).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const self = fileURLToPath(import.meta.url)
const RULES = [
  [
    'runs the defaults tool',
    /(spawn|spawnSync|exec|execSync|execFile|execFileSync|Bun\.spawn|Bun\.spawnSync|Bun\.\$|\$)\s*\(\s*\[?\s*['"`](\/usr\/bin\/)?defaults['"`\s]/
  ],
  ['runs the defaults tool', /["'`]\/usr\/bin\/defaults["'`]/],
  [
    'defaults write/delete command',
    /\bdefaults\s+(-currentHost\s+)?(write|delete|import|rename)\b/
  ],
  ['com.apple domain via defaults', /\bdefaults\b[^\n]{0,80}\bcom\.apple\./],
  [
    'writes CFPreferences',
    /CFPreferences(SetValue|SetAppValue|SetMultiple|AppSynchronize|Synchronize)\s*\(/
  ],
  [
    'writes another preferences domain',
    /UserDefaults\s*\(\s*suiteName:\s*"(com\.apple|NSGlobalDomain|Apple)/
  ],
  ['writes a persistent domain', /\.(setPersistentDomain|removePersistentDomain)\s*\(/],
  [
    'broadcasts a system notification',
    /DistributedNotificationCenter\s*\.\s*default\s*\(\s*\)\s*\.\s*post/
  ],
  ['names a system preference domain/key', /com\.apple\.universalaccess|AppleShowScrollBars/]
]
const violations = (text) =>
  RULES.filter(([, pattern]) => pattern.test(text)).map(([label]) => label)

// The detector itself must catch every form earlier fixtures used, and not
// flag ordinary identifiers named "defaults".
for (const bad of [
  "spawn('defaults', ['write', '-g', 'Key', '-string', 'x'])",
  "spawnSync('defaults', ['read', 'com.apple.universalaccess', 'reduceMotion'])",
  'Bun.spawnSync(["defaults", "delete", "com.apple.dock"])',
  'execSync(`defaults write com.apple.finder X -bool true`)',
  'process.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")',
  'CFPreferencesAppSynchronize("com.apple.universalaccess" as CFString)',
  'CFPreferencesSetAppValue(key, value, app)',
  'UserDefaults(suiteName: "com.apple.universalaccess")?.set(true, forKey: "x")',
  'UserDefaults.standard.setPersistentDomain(d, forName: "x")',
  'DistributedNotificationCenter.default().postNotificationName(name, object: nil)'
])
  assert.ok(violations(bad).length > 0, `Guard must flag: ${bad}`)
for (const good of [
  'const defaults = { a: 1 }',
  'Object.assign({}, defaults, options)',
  'withDefaults(config)',
  'UserDefaults.standard.set(true, forKey: "trezi.sidebar")'
])
  assert.deepEqual(violations(good), [], `Guard must not flag: ${good}`)

const SKIP = new Set(['node_modules', 'artifacts', '.git', 'out', 'dist'])
const files = []
const walk = (directory) => {
  for (const name of readdirSync(directory)) {
    if (SKIP.has(name)) continue
    const path = join(directory, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(mjs|cjs|js|ts|tsx|swift|sh)$/.test(name) && path !== self) files.push(path)
  }
}
for (const directory of ['src', 'test', 'scripts', 'bin']) {
  try {
    walk(join(root, directory))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
const install = join(root, 'install.sh')
try {
  statSync(install)
  files.push(install)
} catch {}
assert.ok(
  files.some((path) => path.endsWith('test/helpers/chat-acceptance.mjs')),
  'Scans the acceptance harness'
)
assert.ok(
  files.some((path) => path.endsWith('src/native/ChatAcceptance.swift')),
  'Scans the native acceptance host command'
)

const found = files.flatMap((path) => {
  const lines = readFileSync(path, 'utf8').split('\n')
  return lines.flatMap((line, index) =>
    violations(line).map((label) => `${relative(root, path)}:${index + 1} ${label}: ${line.trim()}`)
  )
})
assert.deepEqual(
  found,
  [],
  `System preference access in verification/app code:\n${found.join('\n')}`
)
console.log(
  `NO-SYSTEM-PREFERENCES OK — ${files.length} files; no defaults tool, CFPreferences writes, system domains or preference broadcasts`
)
