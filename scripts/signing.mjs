import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Stable code signing for Trezi.app (LKM-137).
 *
 * An ad hoc signature is the binary's own hash, so every rebuild looked like a new app
 * to macOS: Keychain "Always Allow" and privacy (TCC) grants reset each time. The build
 * now signs with one identity that stays the same across rebuilds:
 * 1. `TREZI_SIGN_IDENTITY`, when set: `-` means ad hoc, anything else names an identity;
 * 2. else an "Apple Development" identity, when the user has a valid one;
 * 3. else the local self-signed "Trezi Local" identity in the login keychain, created
 *    once on first build.
 * When none can be used or created, the build signs ad hoc and prints one warning.
 */

export const LOCAL_IDENTITY = 'Trezi Local'
const SECURITY = '/usr/bin/security'
const OPENSSL = '/usr/bin/openssl'

const exec = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') }
}

/** The "Matching identities" section of `security find-identity -p codesigning`. */
export function parseIdentities(text) {
  const matching = text.split(/Valid identities only/)[0]
  const out = []
  for (const line of matching.split('\n')) {
    const found = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.*)"(?:\s+\((\S+)\))?\s*$/)
    if (found) out.push({ hash: found[1], name: found[2], problem: found[3] ?? null })
  }
  return out
}

/**
 * The identity to sign with, from the parsed list: Apple Development first, then
 * "Trezi Local" (an untrusted self-signed certificate is fine for code signing; an
 * expired or revoked one is not). The first match wins, so the choice is stable.
 */
export function pickIdentity(identities, override) {
  if (override === '-') return { kind: 'adhoc' }
  if (override) {
    const named = identities.find(item => item.hash === override.toUpperCase() || item.name === override)
    return named ? { kind: 'named', hash: named.hash, name: named.name } : null
  }
  const apple = identities.find(item => item.name.startsWith('Apple Development:') && !item.problem)
  if (apple) return { kind: 'apple', hash: apple.hash, name: apple.name }
  const local = identities.find(item => item.name === LOCAL_IDENTITY && (!item.problem || item.problem === 'CSSMERR_TP_NOT_TRUSTED'))
  return local ? { kind: 'local', hash: local.hash, name: local.name } : null
}

/** The user's login keychain, or undefined for the default keychain. */
export function loginKeychain(home = homedir()) {
  const path = join(home, 'Library/Keychains/login.keychain-db')
  return existsSync(path) ? path : undefined
}

export function listIdentities({ keychain, run = exec } = {}) {
  const result = run(SECURITY, ['find-identity', '-p', 'codesigning', ...(keychain ? [keychain] : [])])
  return result.status === 0 ? parseIdentities(result.stdout) : []
}

/**
 * Creates the self-signed "Trezi Local" code-signing identity in `keychain` (default:
 * the login keychain). Its private key is not extractable and only codesign may use it
 * without asking. Throws with the failing step.
 */
export function createLocalIdentity({ keychain = loginKeychain(), run = exec } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trezi-identity-'))
  try {
    writeFileSync(join(dir, 'identity.cnf'), [
      '[req]', 'distinguished_name = dn', 'prompt = no', 'x509_extensions = ext',
      '[dn]', `CN = ${LOCAL_IDENTITY}`,
      '[ext]', 'basicConstraints = critical,CA:false', 'keyUsage = critical,digitalSignature', 'extendedKeyUsage = critical,codeSigning', ''
    ].join('\n'), { mode: 0o600 })
    const password = randomBytes(18).toString('hex')
    const steps = [
      [OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '7300', '-config', join(dir, 'identity.cnf'),
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')]],
      [OPENSSL, ['pkcs12', '-export', '-inkey', join(dir, 'key.pem'), '-in', join(dir, 'cert.pem'), '-name', LOCAL_IDENTITY,
        '-out', join(dir, 'identity.p12'), '-passout', `pass:${password}`]],
      [SECURITY, ['import', join(dir, 'identity.p12'), ...(keychain ? ['-k', keychain] : []), '-f', 'pkcs12', '-P', password,
        '-x', '-T', '/usr/bin/codesign']]
    ]
    for (const [command, args] of steps) {
      const result = run(command, args)
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout).trim().split('\n').pop()
        throw new Error(`${command.split('/').pop()} ${args[0]} failed${detail ? `: ${detail}` : ''}`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The one warning line printed whenever a build signs ad hoc instead of with an identity. */
export const adhocWarning = reason =>
  `warning: signing Trezi ad hoc (${reason}); macOS will ask again for Keychain and privacy access after each rebuild. See README "Code signing".`

/**
 * The signer for this build. `create: false` uses an existing identity but never makes
 * one (test builds must not change the user's keychain). Never throws: any failure
 * becomes ad hoc with exactly one `warn` line.
 */
export function signingIdentity({ env = process.env, keychain = loginKeychain(), create = true, run = exec, warn = message => console.warn(message) } = {}) {
  const fallback = reason => {
    warn(adhocWarning(reason))
    return { kind: 'adhoc' }
  }
  try {
    const override = env.TREZI_SIGN_IDENTITY?.trim()
    // Ad hoc needs no identity: don't even list the keychain's (LKM-175).
    if (override === '-') return { kind: 'adhoc' }
    const chosen = pickIdentity(listIdentities({ run }), override)
    if (chosen) return chosen
    if (override) return fallback(`no code-signing identity "${override}"`)
    if (!create) return fallback(`no "${LOCAL_IDENTITY}" identity yet, and this build does not create one`)
    createLocalIdentity({ keychain, run })
    return pickIdentity(listIdentities({ run })) ?? fallback(`the new "${LOCAL_IDENTITY}" identity is not usable for code signing`)
  } catch (error) {
    return fallback(`could not create the "${LOCAL_IDENTITY}" identity: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * The designated requirement macOS checks a rebuild against. For "Trezi Local" it is
 * pinned to the identifier and the certificate; Apple Development and named identities
 * keep codesign's own (team-based) one; ad hoc has none but the code hash.
 */
export function designatedRequirement(signer, identifier) {
  return signer.kind === 'local' ? `designated => identifier "${identifier}" and certificate leaf = H"${signer.hash.toLowerCase()}"` : null
}

export function codesignArgs(signer, path, identifier) {
  const requirement = designatedRequirement(signer, identifier)
  return ['--force', '--sign', signer.kind === 'adhoc' ? '-' : signer.hash, '--timestamp=none',
    ...(identifier ? ['--identifier', identifier] : []), ...(requirement ? ['-r', `=${requirement}`] : []), path]
}

/** Signs `path`; throws with codesign's message. */
export function sign(signer, path, identifier, run = exec) {
  const result = run('/usr/bin/codesign', codesignArgs(signer, path, identifier))
  if (result.status !== 0) throw new Error(`codesign ${path}: ${(result.stderr || result.stdout).trim()}`)
}

/**
 * Runs `work(signer)`, which signs every piece. When signing with an identity fails (a
 * locked login keychain over SSH, a denied key-access prompt, a deleted certificate), the
 * whole of `work` runs again ad hoc, as before this build had identities, with the one
 * warning line. An ad hoc failure is a real error and is thrown. Returns the signer used.
 */
export function signWithFallback(signer, work, { warn = message => console.warn(message) } = {}) {
  try {
    work(signer)
    return signer
  } catch (error) {
    if (signer.kind === 'adhoc') throw error
    const reason = String(error instanceof Error ? error.message : error).split('\n').map(line => line.trim()).filter(Boolean).join(' ')
    warn(adhocWarning(`signing with "${signer.name}" failed: ${reason}`))
    const adhoc = { kind: 'adhoc' }
    work(adhoc)
    return adhoc
  }
}

export function describeSigner(signer) {
  return signer.kind === 'adhoc' ? 'ad hoc' : `${signer.name} (${signer.hash.slice(0, 8)})`
}
