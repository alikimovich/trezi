import './helpers/with-service-owners.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import { islandDefinition } from '../src/main/chat-island-schema.ts'
import { islandSource, undoIsland, writeIsland } from '../src/main/chat-island-source.ts'
import { ChatIslands } from '../src/main/chat-islands.ts'
import { undo } from '../src/main/edit-history.ts'
import { shadowLight } from '../src/main/shadows.ts'
import { applyStyleEdit } from '../src/main/styles.ts'
import { rewriteClassList } from '../src/main/tw-styles.ts'

const initial = {
  x: 0.72,
  y: -0.28,
  distance: 12,
  blur: 24,
  layers: 3,
  decay: 0.6,
  color: 'rgba(0, 0, 0, 0.35)'
}
const css = shadowLight(initial).css
const jsxClass = (code) => {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
  const element = ast.program.body.find((n) => n.type === 'ExportNamedDeclaration').declaration
    .declarations[0].init.body
  const attr = element.openingElement.attributes.find((a) => a.name?.name === 'className')
  return attr?.value.type === 'JSXExpressionContainer'
    ? attr.value.expression.value
    : attr?.value.value
}
assert.equal(shadowLight({ ...initial, layers: 1 }).css, '-8.64px 3.36px 24px rgba(0,0,0,0.35)')
assert.equal(shadowLight({ ...initial, x: 0, y: 0, distance: 0 }).layers[2].blurPx, 24)
assert.deepEqual(
  shadowLight({ ...initial, decay: 0 }).layers.map((l) => l.alpha),
  [0.35, 0, 0]
)
assert.equal(
  shadowLight({ ...initial, layers: 8, blur: 80, distance: 64, x: -1, y: 1, decay: 1 }).layers
    .length,
  8
)
for (const [key, values] of Object.entries({
  x: [-1.01, 1.01, NaN],
  y: [-2, 2],
  distance: [-1, 65],
  blur: [-1, 81],
  layers: [0, 9, 2.5],
  decay: [-0.1, 1.1],
  color: ['red', 'rgba(256,0,0,1)', 'rgba(0,0,0,1.1)', 'rgba(0,0,0,0); color:red']
})) {
  for (const value of values) assert.throws(() => shadowLight({ ...initial, [key]: value }))
}
const otherClasses = 'p-4 hover:shadow-lg shadow-red-500 shadow-[color:var(--ink)]'
const replaced = rewriteClassList(`${otherClasses} shadow-md`, 'box-shadow', css)
assert.ok(replaced.startsWith(otherClasses + ' shadow-['))
assert.equal(rewriteClassList(replaced, 'box-shadow', css), replaced)
assert.equal(rewriteClassList('shadow-md shadow-lg', 'box-shadow', css), null)

const root = await mkdtemp(join(tmpdir(), 'trezi-shadow-'))
const store = await mkdtemp(join(tmpdir(), 'trezi-shadow-store-'))
const ranges = [
  [-1, 1],
  [-1, 1],
  [0, 64],
  [0, 80],
  [1, 8],
  [0, 1]
]
const keys = Object.keys(initial)
const params = keys.map((id, i) => ({
  id,
  label: id,
  kind: i === 6 ? 'color' : 'number',
  ...(i < 6 ? { min: ranges[i][0], max: ranges[i][1], step: i === 4 ? 1 : 0.01 } : {}),
  apply: { strategy: 'literal', anchor: `const LIGHT_${id} = ` }
}))
const constants =
  keys.map((id) => `const LIGHT_${id} = ${JSON.stringify(initial[id])};`).join('\n') + '\n'
try {
  for (const extension of ['ts', 'mts', 'cts']) {
    const file = `assertion.${extension}`
    const code =
      'const distance = 12; const typed = <number>distance;\nconst identity = <T>(value: T): T => value;\n'
    await writeFile(join(root, file), code)
    const definition = islandDefinition({
      manifest: {
        file,
        component: 'Config',
        title: 'Distance',
        params: [
          {
            id: 'distance',
            label: 'Distance',
            kind: 'number',
            min: 0,
            max: 64,
            apply: { strategy: 'literal', anchor: 'const distance = ' }
          }
        ]
      },
      blocks: [{ id: 'settings', title: 'Settings', kind: 'group', params: ['distance'] }]
    })
    const record = {
      ...definition,
      version: 1,
      id: extension,
      revision: 1,
      turn: 1,
      engine: 'agent',
      status: 'ready',
      initial: { distance: 12 }
    }
    const before = await islandSource(root, record)
    assert.equal(before.values.distance, 12)
    const edit = await writeIsland(root, record, before.values, { distance: 24 }, () => true)
    assert.equal((await islandSource(root, record)).values.distance, 24)
    assert.equal(
      await readFile(join(root, file), 'utf8'),
      code.replace('distance = 12', 'distance = 24')
    )
    await undoIsland(root, edit.group, () => true)
    assert.equal(await readFile(join(root, file), 'utf8'), code)
  }
  for (const output of ['css', 'tailwind']) {
    const file = `${output}.tsx`
    const classList = `before:content-["hello"] after:content-[\\2713] data-[label=a&b]:block p-4 hover:shadow-xl shadow-[${css.replaceAll(' ', '_')}]`
    const code =
      constants +
      (output === 'css'
        ? `export const Card = () => <div style={{ color: 'red', boxShadow: ${JSON.stringify(css)}, opacity: 0.8 }} />;\n// keep me\n`
        : `export const Card = () => <div className='${classList.replaceAll('&', '&amp;')}' title="keep me" />;\n// keep me\n`)
    await writeFile(join(root, file), code)
    const request = {
      action: 'define',
      engine: 'agent',
      manifest: {
        file,
        component: 'Card',
        title: 'Shadow Light',
        params: [
          ...params,
          {
            id: 'output',
            label: 'CSS',
            kind: 'text',
            apply: { strategy: 'literal', anchor: output === 'css' ? 'boxShadow: ' : 'className=' }
          }
        ]
      },
      blocks: [
        { id: 'shadow', title: 'Shadow Light', kind: 'shadow', output, params: [...keys, 'output'] }
      ]
    }
    assert.equal(islandDefinition(request).blocks[0].output, output)
    assert.throws(
      () =>
        islandDefinition({
          ...request,
          manifest: {
            ...request.manifest,
            params: request.manifest.params.map((p) =>
              p.id === 'layers' ? { ...p, step: 0.1 } : p
            )
          }
        }),
      /integer/
    )
    const islands = new ChatIslands(() => {})
    islands.register(output, root, output, () => 1)
    const made = await islands.tool(output, root, request)
    assert.ok(made.id, JSON.stringify(made))
    await islands.settle(output, true)
    const view = () => islands.sessions.get(output).views.get(made.id)
    const command = (action, values) => ({
      chat: output,
      id: made.id,
      revision: view().revision,
      sourceRevision: view().sourceRevision,
      operation: crypto.randomUUID(),
      action,
      values
    })
    await islands.interact(command('commit', { x: -1, layers: 8 }))
    const after = await readFile(join(root, file), 'utf8')
    assert.ok(after.includes('const LIGHT_x = -1;'))
    assert.ok(after.includes('keep me'))
    assert.equal(
      (
        view()
          .fields.find((p) => p.id === 'output')
          .value.match(/rgba\(/g) ?? []
      ).length,
      8
    )
    if (output === 'tailwind')
      assert.equal(
        jsxClass(after),
        view().fields.find((p) => p.id === 'output').value,
        'JSX parses and decoded classes survive'
      )
    assert.ok(after.includes(output === 'css' ? "color: 'red'" : 'p-4 hover:shadow-xl'))
    await assert.rejects(islands.interact(command('commit', { layers: 1.5 })), /integer/)
    await assert.rejects(islands.interact(command('commit', { x: 2 })), /Invalid shadow/)
    assert.equal(await readFile(join(root, file), 'utf8'), after)
    await islands.interact(command('undo'))
    assert.equal(await readFile(join(root, file), 'utf8'), code)
    await islands.interact(command('commit', { x: 0.12345678, distance: 64 }))
    const current = Object.fromEntries(view().fields.map((p) => [p.id, p.value]))
    const generated = shadowLight(current).css
    assert.equal(
      current.output,
      output === 'css' ? generated : rewriteClassList(current.output, 'box-shadow', generated),
      'CSS uses the persisted numeric precision'
    )
    await islands.interact(command('commit', { blur: 0, decay: 0 }))
    await islands.interact(command('reset'))
    assert.equal(view().fields.find((p) => p.id === 'blur').value, 24)
    assert.equal(
      view().fields.find((p) => p.id === 'output').value,
      output === 'css' ? css : rewriteClassList(classList, 'box-shadow', css)
    )
    if (output === 'tailwind')
      assert.equal(
        jsxClass(await readFile(join(root, file), 'utf8')),
        rewriteClassList(classList, 'box-shadow', css)
      )
    islands.close(output)
  }
  // Exercise the real Styles engine too (not just its string helpers).
  for (const tailwind of [false, true]) {
    const file = tailwind ? 'utility.tsx' : 'inline.tsx'
    const original = tailwind
      ? 'export const Card = () => <div className="p-4 before:content-[&quot;hello&quot;] shadow-md hover:shadow-xl" title="kept" />'
      : 'export const Card = () => <div style={{ color: "red", boxShadow: "none", opacity: 0.8 }} title="kept" />'
    await writeFile(join(root, file), original)
    const value = shadowLight({ ...initial, layers: 8 }).css
    for (const next of [value, css]) {
      const result = await applyStyleEdit(root, {
        source: `${file}:1`,
        prop: 'box-shadow',
        value: next,
        classes: tailwind ? ['p-4'] : []
      })
      assert.equal(result.applied, true, JSON.stringify(result))
      assert.equal(result.strategy, tailwind ? 'tailwind' : 'inline')
      const after = await readFile(join(root, file), 'utf8')
      assert.ok(after.includes('title="kept"'))
      if (tailwind)
        assert.equal(jsxClass(after), rewriteClassList(jsxClass(original), 'box-shadow', next))
      else
        assert.doesNotThrow(() =>
          parse(after, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
        )
      assert.equal((after.match(/rgba\(/g) ?? []).length, next === value ? 8 : 3)
    }
    await undo(root)
    assert.equal(await readFile(join(root, file), 'utf8'), original)
  }
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(store, { recursive: true, force: true })
}
console.log(
  'Shadow controls: generation, validation, island lifecycle and source round trips passed'
)
