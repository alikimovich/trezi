import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveClassRule, rewriteClassRule } from '../src/main/style-class-rule.ts'

const root = mkdtempSync(join(tmpdir(), 'trezi-class-rule-'))
try {
  mkdirSync(join(root, 'src/themer-admin'), { recursive: true })
  writeFileSync(
    join(root, 'src/themer-admin/Account.module.css'),
    '.accountAvatar { width: 32px; }\n'
  )
  const classes = ['_accountAvatar_vc9o5_17']
  assert.deepEqual(await resolveClassRule(root, classes), {
    file: 'src/themer-admin/Account.module.css',
    className: 'accountAvatar'
  })
  assert.equal(
    rewriteClassRule(
      '.accountAvatar { padding-top: 32px; }\n',
      'accountAvatar',
      'padding-top',
      '40px'
    ),
    '.accountAvatar { padding-top: 40px; }\n'
  )
  assert.match(
    rewriteClassRule('.accountAvatar { width: 32px; }\n', 'accountAvatar', 'padding-top', '8px'),
    /padding-top: 8px;/
  )
  assert.equal(
    rewriteClassRule('.accountAvatar {} .accountAvatar {}', 'accountAvatar', 'padding-top', '40px'),
    null
  )
  writeFileSync(join(root, 'src/Other.module.css'), '.accountAvatar { width: 40px; }\n')
  assert.equal(
    await resolveClassRule(root, classes),
    null,
    'two matching CSS modules are ambiguous'
  )
  assert.equal(await resolveClassRule(root, ['_unknown_vc9o5_17']), null)
  assert.equal(await resolveClassRule(root, ['../../outside']), null)
  writeFileSync(join(root, 'src/global.css'), '.globalOnly { color: red; }\n')
  assert.equal(
    await resolveClassRule(root, ['_globalOnly_vc9o5_17']),
    null,
    'a hashed module class cannot match a global stylesheet'
  )
  writeFileSync(join(root, 'src/ModuleOnly.module.css'), '.moduleOnly { color: red; }\n')
  assert.equal(
    await resolveClassRule(root, ['moduleOnly']),
    null,
    'a plain class cannot match a CSS module'
  )
  assert.deepEqual(await resolveClassRule(root, ['globalOnly']), {
    file: 'src/global.css',
    className: 'globalOnly'
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log('CSS-module class resolution: unique rule, ambiguity and invalid classes passed')
