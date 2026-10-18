import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'

/**
 * LKM-286: a loopback "GitHub" for the native smoke's Skills imports. `start-native.mjs
 * --test` runs it next to the app and passes its port as
 * `TREZI_SKILLS_GITHUB_FIXTURE_PORT`; the service uses it only for a disposable test
 * profile (`SkillsGitHubEndpoints.fixture`). It answers the same paths as GitHub's API
 * and codeload (ref → full commit, commit → `git archive`-style tar.gz), so the real
 * importer pins, downloads and checks these archives. Nothing reaches the network.
 */

export const SKILLS_FIXTURE_PORT_ENV = 'TREZI_SKILLS_GITHUB_FIXTURE_PORT'

interface FixtureRepository {
  /** `owner/name`. */
  repository: string
  refs: Record<string, string>
  commit: string
  files: Record<string, string>
}

const MIT = `MIT License

Copyright (c) 2026 Trezi fixtures

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
`
const APACHE = `
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

Fixture text for the Trezi native smoke; not the upstream file.
`

/** A skill imported by address: tag `v1` of a folder, with its own MIT license. */
export const SKILLS_FIXTURE_IMPORT = {
  url: 'https://github.com/trezi-fixtures/skills/tree/v1/skills/trezi-smoke-github',
  repository: 'trezi-fixtures/skills',
  subpath: 'skills/trezi-smoke-github',
  ref: 'v1',
  name: 'trezi-smoke-github',
  commit: '5a1e7c0ffee5a1e7c0ffee5a1e7c0ffee5a1e7c0',
  license: 'MIT',
  licenseFile: 'skills/trezi-smoke-github/LICENSE'
} as const
/** The `frontend-design` recommendation's folder as the fixture serves it on `main`. */
export const SKILLS_FIXTURE_RECOMMENDATION = {
  id: 'frontend-design',
  repository: 'anthropics/skills',
  subpath: 'skills/frontend-design',
  commit: 'f0e1d2c3b4a5968778695a4b3c2d1e0f0e1d2c3b',
  license: 'Apache-2.0'
} as const

/** A repository the fixture never answers for, so an import of it can be cancelled. */
export const SKILLS_FIXTURE_SLOW = 'trezi-fixtures/slow'

const REPOSITORIES: FixtureRepository[] = [
  {
    repository: SKILLS_FIXTURE_IMPORT.repository,
    refs: { v1: SKILLS_FIXTURE_IMPORT.commit },
    commit: SKILLS_FIXTURE_IMPORT.commit,
    files: {
      'README.md': '# Trezi fixture skills\n',
      'skills/trezi-smoke-github/SKILL.md': `---
name: ${SKILLS_FIXTURE_IMPORT.name}
description: Fixture skill imported from a pinned GitHub tag by the Trezi native smoke.
license: MIT
---

# GitHub fixture

Read references/usage.md before changing layout code.
`,
      'skills/trezi-smoke-github/references/usage.md':
        '# Usage\n\n- Keep spacing on the 4 pt grid.\n',
      'skills/trezi-smoke-github/LICENSE': MIT
    }
  },
  {
    repository: SKILLS_FIXTURE_RECOMMENDATION.repository,
    refs: { main: SKILLS_FIXTURE_RECOMMENDATION.commit },
    commit: SKILLS_FIXTURE_RECOMMENDATION.commit,
    files: {
      'skills/frontend-design/SKILL.md': `---
name: ${SKILLS_FIXTURE_RECOMMENDATION.id}
description: Fixture copy of the frontend-design recommendation for the Trezi native smoke.
---

# Frontend design (fixture)

Choose a clear visual direction before writing components.
`,
      'skills/frontend-design/LICENSE.txt': APACHE
    }
  }
]

// --- A minimal `git archive` tar: pax global header with the commit, then ustar entries ---
const octal = (value: number, digits: number) => `${value.toString(8).padStart(digits, '0')}\0`
function header(name: string, type: string, size: number) {
  const block = Buffer.alloc(512)
  const put = (offset: number, length: number, text: string) =>
    block.write(text, offset, Math.min(length, Buffer.byteLength(text)), 'utf8')
  put(0, 100, name)
  put(100, 8, octal(type === '5' ? 0o755 : 0o644, 7))
  put(108, 8, octal(0, 7))
  put(116, 8, octal(0, 7))
  put(124, 12, octal(size, 11))
  put(136, 12, octal(1_700_000_000, 11))
  block.fill(0x20, 148, 156)
  put(156, 1, type)
  put(257, 6, 'ustar\0')
  put(263, 2, '00')
  const sum = block.reduce((total, byte) => total + byte, 0)
  put(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return block
}
const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])
function pax(key: string, value: string) {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body) + 1
  while (String(length).length + Buffer.byteLength(body) !== length) length++
  return `${length}${body}`
}

/** The archive codeload would serve for `repo` at its commit. */
export function fixtureArchive(repo: FixtureRepository) {
  const top = `${repo.repository.split('/')[1]}-${repo.commit}`
  const comment = Buffer.from(pax('comment', repo.commit))
  const blocks = [header('pax_global_header', 'g', comment.length), pad(comment)]
  blocks.push(header(`${top}/`, '5', 0))
  const folders = new Set<string>()
  for (const path of Object.keys(repo.files).sort()) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      const folder = parts.slice(0, depth).join('/')
      if (folders.has(folder)) continue
      folders.add(folder)
      blocks.push(header(`${top}/${folder}/`, '5', 0))
    }
    const data = Buffer.from(repo.files[path])
    blocks.push(header(`${top}/${path}`, '0', data.length), pad(data))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** Starts the fixture on a free loopback port. `requests` lists every path asked for. */
export async function startSkillsGitHubFixture(): Promise<{
  port: number
  requests: string[]
  close(): Promise<void>
}> {
  const requests: string[] = []
  const archives = new Map(REPOSITORIES.map((repo) => [repo.commit, fixtureArchive(repo)]))
  const server: Server = createServer((request, response) => {
    const path = request.url ?? ''
    requests.push(path)
    // Never answered until close: an import that is still running when it is cancelled.
    if (path.startsWith(`/api/repos/${SKILLS_FIXTURE_SLOW}`)) return
    const text = (status: number, body: string | Buffer, type = 'text/plain') => {
      response.writeHead(status, { 'content-type': type })
      response.end(body)
    }
    for (const repo of REPOSITORIES) {
      if (path === `/api/repos/${repo.repository}`)
        return text(200, JSON.stringify({ default_branch: 'main' }), 'application/json')
      const prefix = `/api/repos/${repo.repository}/commits/`
      if (path.startsWith(prefix)) {
        const ref = decodeURIComponent(path.slice(prefix.length))
        const commit = repo.refs[ref] ?? (ref === repo.commit ? repo.commit : undefined)
        return commit ? text(200, commit) : text(422, '{"message":"No commit found"}')
      }
      if (path === `/codeload/${repo.repository}/tar.gz/${repo.commit}`)
        return text(200, archives.get(repo.commit) ?? '', 'application/x-gzip')
    }
    text(404, 'not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        // A kept-alive connection of the service must not hold the launcher open.
        server.closeAllConnections?.()
      })
  }
}
