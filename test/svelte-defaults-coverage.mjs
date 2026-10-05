// Shared by the Svelte Electron test; exercises real inspector IPC and row controls.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function checkSvelteDefaults(app, win, artifacts) {
  const root = mkdtempSync(join(tmpdir(), 'trezi-svelte-defaults-'))
  const defaults = {
    copiedDurationMs: 1400,
    blurPx: 0.5,
    blurDurationMs: 80,
    blurHoldMs: 150,
    blurEasing: 'ease-out',
    negative: -3,
    zero: 0,
    enabled: true,
    disabled: false,
    empty: ''
  }
  const declarations = Object.entries(defaults).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
  const code = `<script lang="ts">\ninterface Props { ${Object.entries(defaults)
    .map(([k, v]) => `${k}?: ${typeof v}`)
    .join(
      '; '
    )}; dynamic?: number; unused?: string }\nlet { ${declarations.join(', ')}, dynamic = Math.random(), unused }: Props = $props();\n</script>\n<button>Copy</button>\n`
  const file = join(root, 'CodeBlock.svelte')
  const inspect = (source) =>
    win.evaluate(({ root, source }) => window.api.props.inspect(root, source), { root, source })
  const select = async (source) => {
    await win.evaluate(
      ({ root, source }) => {
        window.__treziSession.getState().setProjectRoot(root)
        window.__treziSelection.getState().setSelected({
          tag: 'button',
          id: null,
          classes: [],
          selector: 'button',
          source,
          text: 'Copy',
          rect: { x: 0, y: 0, width: 0, height: 0 },
          styles: {}
        })
        window.__treziPropsIsland.getState().setOpen(true)
      },
      { root, source }
    )
  }
  try {
    writeFileSync(file, code)
    writeFileSync(
      join(root, 'Legacy.svelte'),
      `<script lang="ts">\n${declarations.map((d) => `export let ${d};`).join('\n')}\nexport let dynamic: number = Math.random();\n</script>\n<button>Legacy</button>`
    )
    for (const source of ['CodeBlock.svelte:5', `Legacy.svelte:${declarations.length + 4}`]) {
      const inspection = await inspect(source)
      assert.ok(inspection, `inspection for ${source}`)
      for (const [name, value] of Object.entries(defaults)) {
        const field = inspection.fields.find((f) => f.name === name)
        assert.equal(field.default, value, `${source} ${name}`)
        assert.equal(field.value, undefined)
      }
      assert.equal(inspection.fields.find((f) => f.name === 'dynamic').defaultExpression, true)
    }
    await select('CodeBlock.svelte:5')
    let panel
    for (let i = 0; i < 100 && !panel; i++) {
      panel = app.windows().find((w) => w.url().includes('treziPanel'))
      if (!panel) await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(panel, 'floating inspector opened')
    await panel
      .locator('.proppanel__expand')
      .click({ timeout: 1000 })
      .catch(() => {})
    await panel.getByRole('tab', { name: 'Props', exact: true }).click()
    const row = (name) =>
      panel
        .locator('.proppanel__row')
        .filter({ has: panel.locator('.proppanel__name', { hasText: new RegExp(`^${name}$`) }) })
    const expectValue = async (name, value) => {
      const control =
        typeof value === 'number' ? row(name).getByRole('slider') : row(name).locator('input')
      await control.waitFor()
      for (let i = 0; i < 100; i++) {
        const actual =
          typeof value === 'number'
            ? await control.getAttribute('aria-valuenow')
            : typeof value === 'boolean'
              ? await row(name).locator('input').isChecked()
              : await row(name).locator('input').inputValue()
        if (actual === (typeof value === 'boolean' ? value : String(value))) return
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.fail(`${name} did not display ${value}`)
    }
    for (const [name, value] of Object.entries(defaults)) {
      await expectValue(name, value)
      assert.equal(await row(name).locator('.proppanel__reset').count(), 0)
    }
    assert.equal(await row('dynamic').getByText('edit via chat').count(), 1)
    assert.equal(await row('dynamic').locator('.proppanel__reset').count(), 0)
    assert.equal(await row('unused').count(), 0, 'absent optional props hidden by default')
    await panel.getByRole('button', { name: 'Show all props', exact: true }).click()
    await row('unused').waitFor()
    await panel.getByRole('button', { name: 'Show authored props', exact: true }).click()
    await row('copiedDurationMs').getByRole('slider').press('Enter')
    await row('copiedDurationMs').locator('input').press('Tab')
    assert.equal(readFileSync(file, 'utf8'), code, 'blur of unchanged default must not write')
    const routed = await win.evaluate(
      ({ root }) =>
        window.api.props.apply(root, {
          source: 'CodeBlock.svelte:5',
          name: 'copiedDurationMs',
          kind: 'number',
          value: 2000
        }),
      { root }
    )
    assert.equal(routed.needsAgent, true)
    assert.match(routed.agentPrompt, /default value/)
    assert.equal(readFileSync(file, 'utf8'), code, 'definition edits must not add DOM attributes')
    // Simulate the source change produced by that agent, then refresh selection.
    writeFileSync(file, code.replace('copiedDurationMs = 1400', 'copiedDurationMs = 2000'))
    const refreshed = await inspect('CodeBlock.svelte:5')
    await win.evaluate(
      (inspection) => window.__treziSelection.getState().setInspection(inspection),
      refreshed
    )
    await expectValue('copiedDurationMs', 2000)
    mkdirSync(artifacts, { recursive: true })
    await panel.screenshot({ path: join(artifacts, 'svelte-defaults.png') })

    const usage = join(root, 'Usage.svelte')
    writeFileSync(
      usage,
      `<script>import CodeBlock from './CodeBlock.svelte'; let amount = 7;</script>\n<CodeBlock copiedDurationMs={0} enabled={false} empty="" blurPx={amount} />`
    )
    const instance = await inspect('Usage.svelte:2')
    for (const [name, value] of Object.entries({
      copiedDurationMs: 0,
      enabled: false,
      empty: ''
    })) {
      assert.equal(instance.fields.find((f) => f.name === name).value, value)
    }
    assert.equal(instance.fields.find((f) => f.name === 'blurPx').expression, true)
    await select('Usage.svelte:2')
    await expectValue('copiedDurationMs', 0)
    await expectValue('enabled', false)
    await expectValue('empty', '')
    for (const name of ['copiedDurationMs', 'enabled', 'empty', 'blurPx']) {
      assert.equal(await row(name).locator('.proppanel__reset').count(), 1, `${name} is explicit`)
    }
    assert.equal(await row('blurPx').getByText('edit via chat').count(), 1)
    await row('copiedDurationMs').getByRole('slider').press('Enter')
    await row('copiedDurationMs').locator('input').fill('2500')
    await row('copiedDurationMs').locator('input').press('Tab')
    await expectValue('copiedDurationMs', 2500)
    await row('copiedDurationMs').locator('.proppanel__reset').click()
    await expectValue('copiedDurationMs', 2000)
    assert.equal(await row('copiedDurationMs').locator('.proppanel__reset').count(), 0)
    assert.ok(!readFileSync(usage, 'utf8').includes('copiedDurationMs='))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
