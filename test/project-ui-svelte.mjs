import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import {
  cancelProjectUi,
  exportProjectUi,
  runProjectUiTool,
  setProjectUiEnabled
} from '../src/main/project-ui.ts'
import { discoverProjectUi } from '../src/main/project-ui-catalog.ts'
import { composeProjectUiWithJev } from '../src/main/project-ui-jev.ts'

await mkdir('test/artifacts', { recursive: true })
const root = await mkdtemp(join(process.cwd(), 'test/artifacts/project-ui-svelte-'))
try {
  const files = {
    'Card.svelte': `<script lang="ts">export let title: string; export let tone: 'quiet' | 'loud' = 'quiet';</script><section class={tone}><h2>{title}</h2><slot /></section>`,
    'Panel.svelte': `<script lang="ts">import type { Snippet } from 'svelte'; interface Props { title: string; children?: Snippet; count?: number; active?: boolean }; let { title, children, count = 2, active = true }: Props = $props();</script><article data-count={count} data-active={active}><h1>{title}</h1>{@render children?.()}</article>`,
    'Required.svelte': `<script lang="ts">import type { Snippet } from 'svelte'; let { children }: {children: Snippet} = $props();</script>{@render children()}`,
    'Button.svelte': `<script>export let label = 'Save'; export let disabled = false;</script><button {disabled}>{label}</button>`,
    'BadRest.svelte': `<script>let { title, ...rest } = $props();</script><div {...rest}>{title}</div>`,
    'BadType.svelte': `<script lang="ts">import type {Props} from './types'; let {title}: Props = $props();</script><p>{title}</p>`,
    'BadNamed.svelte': `<slot name="header"/>`,
    'BadCallback.svelte': `<script lang="ts">export let callback: () => void;</script><button onclick={callback}>Go</button>`,
    'BadSnippet.svelte': `<script lang="ts">import type {Snippet} from 'svelte'; let {children}: {children: Snippet<[string]>} = $props();</script>{@render children('x')}`,
    'BadSlotProps.svelte': `<slot value="x" />`,
    'BadDynamic.svelte': `<div {...$$restProps}/>`,
    '+page.svelte': `<p>Route</p>`,
    'ReactCard.tsx': `export function ReactCard({title}: {title:string}) {return <p>{title}</p>}`
  }
  for (const [file, code] of Object.entries(files)) await writeFile(join(root, file), code)
  const catalog = await discoverProjectUi(root)
  assert.deepEqual(catalog.components.map((c) => c.name).sort(), [
    'Button',
    'Card',
    'Panel',
    'ReactCard',
    'Required'
  ])
  for (const name of Object.keys(files).filter((n) => n.startsWith('Bad')))
    assert.ok(
      catalog.warnings.some((w) => w.startsWith(name)),
      name
    )
  const text = '</script><script>alert("x")</script> & {braces} "quote" \u2028'
  const spec = {
    root: 'card',
    elements: {
      card: { type: 'Card', props: { title: text, tone: 'loud' }, children: ['panel'] },
      panel: {
        type: 'Panel',
        props: { title: 'Panel', count: 3, active: false },
        children: ['button', 'text']
      },
      button: { type: 'Button', props: { label: 'Save' }, children: [] },
      text: { type: 'Text', props: { text }, children: [] }
    }
  }
  async function rendered(output) {
    assert.doesNotMatch(output.code, /json-render|React|react/)
    await writeFile(join(root, output.file), output.code)
    for (const file of ['Card.svelte', 'Panel.svelte', 'Button.svelte', output.file]) {
      const code = compile(await readFile(join(root, file), 'utf8'), {
        filename: file,
        generate: 'server'
      }).js.code.replace(/\.svelte(['"])/g, '.mjs$1')
      await writeFile(join(root, file.replace('.svelte', '.mjs')), code)
    }
    const { default: Page } = await import(join(root, output.file.replace('.svelte', '.mjs')))
    return render(Page).body
  }
  const output = await exportProjectUi(catalog, { file: 'Page.svelte', spec })
  assert.match(output.code, /from "\.\/Card.svelte"/)
  const html = await rendered(output)
  assert.match(html, /class="loud"/)
  assert.match(html, /data-count="3" data-active="false"/)
  assert.match(html, /<button>Save<\/button>/)
  assert.match(html, /&lt;\/script>/)
  assert.doesNotMatch(html, /<script>/)
  const bad = async (mutate, pattern) => {
    const next = structuredClone(spec)
    mutate(next)
    await assert.rejects(exportProjectUi(catalog, { file: 'Bad.svelte', spec: next }), pattern)
  }
  await bad((s) => (s.elements.card.props.tone = 'invalid'), /Invalid/)
  await bad((s) => (s.elements.card.props.unknown = true), /Invalid|Unrecognized/)
  await bad((s) => delete s.elements.card.props.title, /Invalid/)
  await bad((s) => (s.elements.card.type = 'ReactCard'), /react|Invalid/)
  await assert.rejects(exportProjectUi(catalog, { file: 'Page.tsx', spec }), /svelte/)
  await assert.rejects(
    exportProjectUi(catalog, {
      file: 'Required.svelte',
      spec: { root: 'r', elements: { r: { type: 'Required', props: {}, children: [] } } }
    }),
    /requires children/
  )
  for (const file of [
    '../escape.svelte',
    '.trezi/Page.svelte',
    '/Page.svelte',
    'node_modules/Page.svelte',
    'Page.vue'
  ])
    await assert.rejects(exportProjectUi(catalog, { file, spec }), /repo-relative/)
  await assert.rejects(exportProjectUi(catalog, { file: 'Card.svelte', spec }), /replace/)
  let calls = 0
  const evaluate = async ({ questions }) => {
    calls++
    return {
      answers: Object.fromEntries(
        Object.entries(questions).map(([key, q]) => [
          key,
          {
            type: 'choice',
            choice:
              key === 'root' ? 'card' : Object.keys(q.criteria).find((k) => k.startsWith('use:'))
          }
        ])
      )
    }
  }
  const input = {
    file: 'JevPage.svelte',
    prompt: 'Welcome',
    candidates: [
      {
        id: 'card',
        description: 'Container',
        element: { type: 'Card', props: { title: 'Welcome' } }
      },
      { id: 'text', description: 'Copy', element: { type: 'Text', props: { text } }, root: false }
    ]
  }
  const jev = await composeProjectUiWithJev(catalog, input, { evaluate })
  assert.equal(jev.stopReason, 'finish')
  assert.match(await rendered(jev), /Welcome/)
  assert.equal(calls, 1)
  await assert.rejects(
    composeProjectUiWithJev(catalog, { ...input, file: 'Bad.tsx' }, { evaluate }),
    /react/
  )
  await assert.rejects(
    composeProjectUiWithJev(
      catalog,
      {
        ...input,
        candidates: [{ ...input.candidates[0], element: { type: 'Card', props: { title: 5 } } }]
      },
      { evaluate }
    )
  )
  assert.equal(calls, 1, 'invalid inputs rejected before evaluation')
  const abort = new AbortController()
  await assert.rejects(
    composeProjectUiWithJev(catalog, input, {
      signal: abort.signal,
      evaluate: async (args) => {
        abort.abort()
        return evaluate(args)
      }
    }),
    /abort/i
  )
  await symlink('/tmp', join(root, 'outside'))
  setProjectUiEnabled('stale-svelte', true)
  assert.match(
    (
      await runProjectUiTool(root, 'stale-svelte', 'compose_project_ui', {
        file: 'outside/Escape.svelte',
        spec
      })
    ).error,
    /symlink/
  )
  const pending = runProjectUiTool(root, 'stale-svelte', 'compose_project_ui', {
    file: 'Late.svelte',
    spec
  })
  setProjectUiEnabled('stale-svelte', true)
  assert.match((await pending).error, /changed|cancelled/)
  const cancelled = runProjectUiTool(root, 'stale-svelte', 'project_ui_catalog')
  cancelProjectUi('stale-svelte')
  assert.match((await cancelled).error, /changed|cancelled/)
  console.log(
    'PROJECT-UI-SVELTE OK: legacy/runes discovery, real SSR, both engines, escaping, unsupported contracts, mixed frameworks, cancellation/staleness'
  )
} finally {
  cancelProjectUi('stale-svelte')
  await rm(root, { recursive: true, force: true })
}
