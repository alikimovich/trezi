import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * LKM-263 fixtures: a Next.js App Router app and a Vite React app inside one project folder,
 * each with a real component and a call site. The unit tests build them and the native smoke
 * shows their states from a static page whose elements carry the stamps Trezi's instrumentation
 * would put on the rendered components. React is the Trezi checkout's own (symlinked); `next`
 * itself is never needed, since Show states shims it.
 */
export const STATES_FOLDER = 'states-fixtures'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAEjDAGACCDAv8cI7IoAAAAAElFTkSuQmCC'

const NEXT: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'next-fixture',
      private: true,
      dependencies: { next: '15.0.0', react: '19.0.0', 'react-dom': '19.0.0' }
    },
    null,
    2
  ),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'es2022',
        lib: ['dom', 'esnext'],
        module: 'esnext',
        moduleResolution: 'bundler',
        jsx: 'preserve',
        strict: true,
        baseUrl: '.',
        paths: { '@/*': ['./*'] }
      }
    },
    null,
    2
  ),
  'app/page.tsx': `import ProjectCard from '@/app/components/ProjectCard'
import RecentProjects from '@/app/components/RecentProjects'
import { ServerStats } from '@/app/components/ServerStats'

export default function Page() {
  return (
    <main>
      <ProjectCard project={{ name: 'Atlas', description: 'Maps for teams', status: 'active', tags: ['maps', 'teams'], updatedAt: '2026-03-02T10:00:00.000Z' }} />
      <ServerStats count={3} />
      <RecentProjects />
    </main>
  )
}
`,
  'app/providers.tsx': `'use client'
import { createContext, useContext, type ReactNode } from 'react'

const Theme = createContext('none')
export const useTheme = () => useContext(Theme)

export function Providers({ children }: { children: ReactNode }) {
  return <Theme.Provider value="studio">{children}</Theme.Provider>
}
`,
  'lib/format.ts': `export function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'Never' : date.toISOString().slice(0, 10)
}
`,
  'app/components/ProjectCard.module.css': `.card { border: 1px solid rgb(208, 215, 222); border-radius: 12px; padding: 16px; background: rgb(250, 240, 255); color: rgb(31, 35, 40); font: 14px/1.4 system-ui, sans-serif; }
.title { margin: 0 0 4px; font-size: 16px; }
.tags { display: flex; gap: 6px; padding: 0; list-style: none; }
.empty { color: rgb(101, 109, 118); }
.error { color: rgb(207, 34, 46); }
.status { text-transform: capitalize; }
`,
  'app/components/ProjectCard.tsx': `'use client'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Inter } from 'next/font/google'
import { formatDate } from '@/lib/format'
import { useTheme } from '@/app/providers'
import cover from './cover.png'
import styles from './ProjectCard.module.css'

const inter = Inter({ subsets: ['latin'] })

export type Project = {
  name: string
  description: string
  status: 'active' | 'paused' | 'archived'
  tags: string[]
  updatedAt: string
}

export default function ProjectCard({
  project,
  loading = false,
  error = null,
  disabled = false,
  onOpen
}: {
  project: Project
  loading?: boolean
  error?: string | null
  disabled?: boolean
  onOpen?: () => void
}) {
  const pathname = usePathname()
  const theme = useTheme()
  if (loading) return <div className={styles.card} data-card="loading">Loading project…</div>
  if (error) return <div className={\`\${styles.card} \${styles.error}\`} data-card="error">{error}</div>
  return (
    <article className={\`\${styles.card} \${inter.className}\`} data-card="ready" data-theme={theme} data-path={pathname}>
      <Image src={cover} alt="" width={24} height={24} />
      <h3 className={styles.title}>{project.name}</h3>
      <p>{project.description}</p>
      <span className={styles.status}>{project.status}</span>
      {project.tags.length ? (
        <ul className={styles.tags}>{project.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>
      ) : (
        <p className={styles.empty}>No tags yet</p>
      )}
      <small>Updated {formatDate(project.updatedAt)}</small>
      <Link href={\`/projects/\${project.name.toLowerCase()}\`}>Open</Link>
      <button type="button" disabled={disabled} onClick={onOpen}>Edit</button>
    </article>
  )
}
`,
  'app/components/ServerStats.tsx': `import 'server-only'
import { headers } from 'next/headers'

export function ServerStats({ count }: { count: number }) {
  void headers
  return <p>{count} projects</p>
}
`,
  'app/components/RecentProjects.tsx': `export default async function RecentProjects() {
  const projects: { name: string }[] = await fetch('https://example.invalid/projects').then((r) => r.json())
  return <ul>{projects.map((p) => <li key={p.name}>{p.name}</li>)}</ul>
}
`
}

const VITE: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'vite-fixture',
      private: true,
      dependencies: { react: '19.0.0', 'react-dom': '19.0.0' },
      devDependencies: { vite: '6.0.0' }
    },
    null,
    2
  ),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'es2022',
        lib: ['dom', 'esnext'],
        module: 'esnext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true
      }
    },
    null,
    2
  ),
  'vite.config.ts': `import path from 'node:path'
export default { resolve: { alias: { '@': path.resolve(__dirname, './src') } } }
`,
  'src/App.tsx': `import { StatusBadge } from './components/StatusBadge'

export function App() {
  return <StatusBadge status="online" label="API" />
}
`,
  'src/lib/tone.ts': `export const tone = { online: 'rgb(26, 127, 55)', offline: 'rgb(207, 34, 46)', degraded: 'rgb(154, 103, 0)' } as const
`,
  'src/components/StatusBadge.module.css': `.badge { display: inline-flex; gap: 6px; align-items: center; padding: 4px 10px; border-radius: 999px; background: rgb(240, 246, 255); font: 13px system-ui, sans-serif; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
`,
  'src/components/StatusBadge.tsx': `import { useState } from 'react'
import { tone } from '@/lib/tone'
import styles from './StatusBadge.module.css'

export function StatusBadge({ status, label, compact }: { status: 'online' | 'offline' | 'degraded'; label: string; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <span className={styles.badge} data-badge={status} onClick={() => setOpen(!open)}>
      <span className={styles.dot} style={{ background: tone[status] }} />
      {compact ? null : <span>{label}: {status}</span>}
      {open ? <em>details</em> : null}
    </span>
  )
}
`
}

/** `file:line:col` (0-based column, as the instrumentation stamps) of `needle` in `text`. */
function stamp(file: string, text: string, needle: string): string {
  const at = text.indexOf(needle)
  if (at < 0) throw new Error(`fixture stamp: ${needle} not in ${file}`)
  const before = text.slice(0, at).split('\n')
  return `${file}:${before.length}:${before[before.length - 1].length}`
}

export interface StatesFixtures {
  folder: string
  next: string
  vite: string
  /** Element stamps the static page carries: element `source` and component call site. */
  stamps: {
    card: { source: string; componentSource: string }
    badge: { source: string; componentSource: string }
    server: { source: string; componentSource: string }
    async: { source: string; componentSource: string }
  }
  page: string
}

/** Write both apps under `root/states-fixtures` and a static page stamped like their render. */
export function writeStatesFixtures(root: string, react: string): StatesFixtures {
  const folder = join(root, STATES_FOLDER)
  rmSync(folder, { recursive: true, force: true })
  const write = (app: string, files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      const file = join(folder, app, name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
    mkdirSync(join(folder, app, 'node_modules'), { recursive: true })
    for (const name of ['react', 'react-dom'])
      symlinkSync(join(react, name), join(folder, app, 'node_modules', name), 'dir')
  }
  write('next-app', NEXT)
  write('vite-app', VITE)
  writeFileSync(join(folder, 'next-app/app/components/cover.png'), Buffer.from(PNG, 'base64'))
  const nextBase = `${STATES_FOLDER}/next-app`
  const viteBase = `${STATES_FOLDER}/vite-app`
  const page = NEXT['app/page.tsx']
  const card = NEXT['app/components/ProjectCard.tsx']
  const stamps: StatesFixtures['stamps'] = {
    card: {
      source: stamp(`${nextBase}/app/components/ProjectCard.tsx`, card, '<article'),
      componentSource: stamp(`${nextBase}/app/page.tsx`, page, '<ProjectCard')
    },
    badge: {
      source: stamp(
        `${viteBase}/src/components/StatusBadge.tsx`,
        VITE['src/components/StatusBadge.tsx'],
        '<span className={styles.badge}'
      ),
      componentSource: stamp(`${viteBase}/src/App.tsx`, VITE['src/App.tsx'], '<StatusBadge')
    },
    server: {
      source: stamp(
        `${nextBase}/app/components/ServerStats.tsx`,
        NEXT['app/components/ServerStats.tsx'],
        '<p>'
      ),
      componentSource: stamp(`${nextBase}/app/page.tsx`, page, '<ServerStats')
    },
    async: {
      source: stamp(
        `${nextBase}/app/components/RecentProjects.tsx`,
        NEXT['app/components/RecentProjects.tsx'],
        '<ul>'
      ),
      componentSource: stamp(`${nextBase}/app/page.tsx`, page, '<RecentProjects')
    }
  }
  const attrs = (item: { source: string; componentSource: string }) =>
    `data-trezi-source="${item.source}" data-trezi-component-source="${item.componentSource}"`
  const html = `<!doctype html>
<html><head><title>States fixture</title><style>body{font:14px system-ui;margin:24px}.card{border:1px solid #ccc;border-radius:12px;padding:16px;width:320px;margin:12px 0}</style></head><body>
<article id="states-card" class="card" ${attrs(stamps.card)}><h3>Atlas</h3><p>Maps for teams</p></article>
<span id="states-badge" ${attrs(stamps.badge)}>API: online</span>
<p id="states-server" ${attrs(stamps.server)}>3 projects</p>
<ul id="states-async" ${attrs(stamps.async)}><li>Atlas</li></ul>
</body></html>
`
  writeFileSync(join(root, 'states.html'), html)
  return {
    folder,
    next: join(folder, 'next-app'),
    vite: join(folder, 'vite-app'),
    stamps,
    page: 'states.html'
  }
}

export function removeStatesFixtures(root: string): void {
  rmSync(join(root, STATES_FOLDER), { recursive: true, force: true })
  rmSync(join(root, 'states.html'), { force: true })
}

/** Paths of the files a test edits to prove an edit redraws the open view. */
export const STATES_EDIT = {
  next: `${STATES_FOLDER}/next-app/lib/format.ts`,
  vite: `${STATES_FOLDER}/vite-app/src/lib/tone.ts`
}
