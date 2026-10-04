// LKM-155, no desktop: the shared project-relative path helper, and every agent prompt
// that names a stamp source (controls, animation, selection, props, text, styles, the
// Svelte variants, moves) built from absolute stamps under a fake live root must name
// them relative to it, so a worktree chat never edits the live checkout.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMoveNode } from '../src/main/move-node.ts'
import { toAgent } from '../src/main/move-node-agent.ts'
import { agentPromptFor, applyPropEdit, textAgentPrompt } from '../src/main/props.ts'
import { applySvelteEdit, applySvelteTextEdit } from '../src/main/props-svelte.ts'
import { styleAgentPrompt } from '../src/main/styles.ts'
import {
  applyStyleEditSvelte,
  styleAgentPrompt as svelteStyleAgentPrompt
} from '../src/main/styles-svelte.ts'
import { animationControlsPrompt, controlsPrompt } from '../src/shared/controls-prompt.ts'
import { touchedFile } from '../src/shared/dev-error.ts'
import { projectRelative } from '../src/shared/project-path.ts'
import { describeSelectionForPrompt } from '../src/shared/selection-context.ts'

// The helper: in-root, out-of-root, trailing separators, Windows roots, positions.
const live = '/Users/me/app'
assert.equal(projectRelative(`${live}/src/a.tsx`, live), 'src/a.tsx')
assert.equal(projectRelative(`${live}/src/a.tsx:81:5`, live), 'src/a.tsx:81:5')
assert.equal(projectRelative(`${live}/src/a.tsx:81`, live), 'src/a.tsx:81')
assert.equal(
  projectRelative(`${live}/src/a.tsx:81:5`, `${live}/`),
  'src/a.tsx:81:5',
  'a trailing slash on the root'
)
assert.equal(projectRelative(`${live}/src/a.tsx`, `${live}//`), 'src/a.tsx')
assert.equal(projectRelative('src/a.tsx:3', live), 'src/a.tsx:3', 'already relative')
assert.equal(
  projectRelative('/Users/me/app-other/a.tsx:1', live),
  '/Users/me/app-other/a.tsx:1',
  'a sibling is outside the root'
)
assert.equal(
  projectRelative('/elsewhere/a.tsx:1:2', live),
  '/elsewhere/a.tsx:1:2',
  'outside the root is unchanged'
)
assert.equal(projectRelative(`${live}/src/a.tsx:1`, null), `${live}/src/a.tsx:1`, 'no root')
assert.equal(projectRelative(`${live}/src/a.tsx:1`, ''), `${live}/src/a.tsx:1`)
assert.equal(
  projectRelative('C:\\Users\\me\\app\\src\\a.tsx:81:5', 'C:\\Users\\me\\app'),
  'src/a.tsx:81:5',
  'a Windows root'
)
assert.equal(
  projectRelative('C:\\Users\\me\\app\\src\\a.tsx:81:5', 'C:\\Users\\me\\app\\'),
  'src/a.tsx:81:5',
  'a Windows root with a trailing separator'
)
assert.equal(
  projectRelative('C:/Users/me/app/src/a.tsx:2', 'C:\\Users\\me\\app'),
  'src/a.tsx:2',
  'mixed separators'
)
assert.equal(
  projectRelative('c:\\users\\me\\app\\src\\a.tsx', 'C:\\Users\\me\\app'),
  'src/a.tsx',
  'Windows paths compare case-insensitively'
)
assert.equal(
  projectRelative('D:\\other\\a.tsx:1', 'C:\\Users\\me\\app'),
  'D:\\other\\a.tsx:1',
  'outside a Windows root is unchanged'
)
assert.equal(
  projectRelative(`${live}/src/My\\File.tsx:1`, live),
  'src/My\\File.tsx:1',
  'a POSIX root keeps backslashes in names'
)
// `served`: a file as a dev server printed it (dev-error's former `projectPath`).
assert.equal(projectRelative(`${live}/src/a.tsx`, live, { served: true }), 'src/a.tsx')
assert.equal(projectRelative('/src/a.tsx', live, { served: true }), 'src/a.tsx', 'root-relative')
assert.equal(projectRelative('./src/a.tsx', live, { served: true }), 'src/a.tsx')
assert.equal(projectRelative('/elsewhere/a.tsx', live, { served: true }), 'elsewhere/a.tsx')
assert.equal(
  touchedFile({ file: `${live}/src/a.tsx`, message: '' }, `${live}/`, ['src/a.tsx']),
  'src/a.tsx'
)

// Every agent prompt, from absolute stamps under a fake live root (a real directory, so
// the Svelte engines can read their fixture and fall back to the agent).
const root = await mkdtemp(join(tmpdir(), 'trezi-live-'))
try {
  await writeFile(join(root, 'Broken.svelte'), '<div class="a" {\n')
  const at = (file, line, column) => `${root}/${file}:${line}:${column}`
  const element = {
    tag: 'button',
    id: '',
    classes: ['cta'],
    selector: 'button.cta',
    text: 'Buy',
    source: at('src/Button.tsx', 12, 4),
    componentSource: at('src/App.tsx', 30, 6)
  }
  const svelte = { file: join(root, 'Broken.svelte'), line: 1, column: 0 }
  const svelteSource = at('Broken.svelte', 1, 0)
  const prompts = {
    selection: describeSelectionForPrompt(element, root),
    controls: controlsPrompt(element, root, null, undefined, 'claude'),
    'controls (gemini)': controlsPrompt(element, root, null, 'speed', 'gemini'),
    'controls (regenerate)': controlsPrompt(element, root, null, undefined, 'claude', {
      json: '{}',
      brokenIds: ['a']
    }),
    animation: animationControlsPrompt(element, root, null, 'fade', 'claude'),
    props: agentPromptFor(
      { source: element.source, name: 'variant', kind: 'string', value: 'primary' },
      root
    ),
    'props (applied)': (
      await applyPropEdit(root, {
        source: element.source,
        name: 'onClick',
        kind: 'other',
        value: 'x'
      })
    ).agentPrompt,
    text: textAgentPrompt(element.source, 'Buy now', root),
    style: styleAgentPrompt(
      { source: element.source, prop: 'color', value: 'red', classes: [] },
      root,
      'button'
    ),
    'style (token)': styleAgentPrompt(
      { source: element.source, prop: 'color', value: 'red', classes: [] },
      root,
      undefined,
      { name: 'brand', ref: 'var(--brand)' }
    ),
    'svelte props': (
      await applySvelteEdit(
        root,
        { source: svelteSource, name: 'label', kind: 'string', value: 'x' },
        svelte
      )
    ).agentPrompt,
    'svelte text': (await applySvelteTextEdit(root, { source: svelteSource, text: 'Hi' }, svelte))
      .agentPrompt,
    'svelte style': (
      await applyStyleEditSvelte(
        root,
        { source: svelteSource, prop: 'color', value: 'red', classes: [] },
        svelte
      )
    ).agentPrompt,
    'svelte style (builder)': svelteStyleAgentPrompt(
      { source: svelteSource, prop: 'color', value: 'red', classes: [] },
      root,
      null
    ),
    move: toAgent(
      root,
      {
        dragged: { source: element.source },
        target: { source: element.componentSource },
        position: 'before',
        sessionId: 's'
      },
      'Reorder.'
    ).agentPrompt,
    'move (applied)': (
      await applyMoveNode(root, {
        dragged: { source: element.source },
        target: { source: element.source },
        position: 'after',
        sessionId: 's'
      })
    ).agentPrompt
  }
  for (const [name, prompt] of Object.entries(prompts)) {
    assert.equal(typeof prompt, 'string', `${name} builds a prompt`)
    assert.ok(!prompt.includes(root), `${name} prompt never names the live root: ${prompt}`)
  }
  assert.match(prompts.selection, / in src\/Button\.tsx:12:4 with text/)
  for (const name of ['controls', 'animation'])
    assert.match(prompts[name], /owning component instance is at src\/App\.tsx:30:6\./)
  assert.match(prompts.props, /^In src\/Button\.tsx:12:4, set the `variant` prop/)
  assert.match(prompts['props (applied)'], /^In src\/Button\.tsx:12:4, /)
  assert.match(prompts.text, /^In src\/Button\.tsx:12:4, change only/)
  assert.match(prompts.style, /^In src\/Button\.tsx:12:4, set the css property `color`/)
  assert.match(prompts['svelte props'], /^In Broken\.svelte:1:0, /)
  assert.match(prompts['svelte text'], /^In Broken\.svelte:1:0, /)
  assert.match(prompts['svelte style'], /on the element at Broken\.svelte:1:0\. Its styles/)
  assert.match(
    prompts.move,
    /^Move the element at src\/Button\.tsx:12:4 to be before the element at src\/App\.tsx:30:6\./
  )
  assert.match(prompts['move (applied)'], /^Move the element at src\/Button\.tsx:12:4 to be after/)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('project-path: ok')
