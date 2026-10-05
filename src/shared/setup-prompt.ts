import type { SetupResult } from './api'

export function setupPrompt(res: SetupResult): string | null {
  const file = res.files?.[0]
  const proof = res.helpers?.map((h) => `${h.path}: SHA-256 ${h.sha256}`).join('\n') ?? ''
  const copied = res.checkout
    ? `Trezi copied them into this chat workspace (${res.checkout}); the dev server uses the live project's copies. Never write .trezi/ yourself. `
    : ''
  const verify = `Before changing config, read the helpers in this checkout and verify these hashes:\n${proof}\n${copied}If a helper is absent or differs, stop and report it. `
  if (res.strategy === 'vite-plugin') {
    const vite = res.vite
    const plugin = vite?.reactPlugin
      ? `${vite.reactPlugin} ${vite.reactPluginVersion ?? '(version unknown)'}`
      : 'no React plugin'
    return (
      verify +
      `Trezi detected a React project on Vite ${vite?.version ?? `(not installed; declared ${vite?.declaredVersion ?? 'unknown'})`} with ${plugin}, ` +
      `and added a dev-only Vite plugin at \`.trezi/trezi-vite.mjs\` that runs \`${file}\` before Vite's own JSX transform ` +
      `(Vite 8 transforms with Oxc and @vitejs/plugin-react 6 has no babel option, so do NOT use \`react({ babel })\`). Please: ` +
      `(1) read the real vite.config.* and import the default export of ./.trezi/trezi-vite.mjs (relative to the config file); ` +
      `(2) put \`trezi()\` FIRST in \`plugins\`, keeping every existing plugin and option (the plugin is serve-only already; ` +
      `if the config is a function you may also gate it on \`command === 'serve'\`); ` +
      `(3) add @babel/core as a development dependency if it is missing, with the project's package manager. ` +
      `If the config shape differs, adapt to the real file or tell me what's blocking rather than guessing. ` +
      `Preserve existing component types; do not bulk-annotate components. ` +
      `Only change build integration. Trezi will restart the preview and check for stamps before declaring setup complete.`
    )
  }
  switch (res.framework) {
    case 'next':
      return (
        verify +
        `Trezi detected Next.js ${res.next?.version ?? `(not installed; declared ${res.next?.declaredVersion})`}, ` +
        `${res.next?.router} router, ${res.next?.bundler} bundler, script: ${res.next?.command}. ` +
        `Read the actual next.config.* and scripts. Use .trezi/trezi-next.cjs to wrap the FINAL config export ` +
        `(outside existing wrappers such as createMDX). Add @babel/core as a development dependency if missing. ` +
        `The adapter is a prototype for modern Next and chooses turbopack versus experimental.turbo from the installed version. ` +
        `For @next/mdx, append the ABSOLUTE string path of .trezi/trezi-mdx.mjs to createMDX's options.remarkPlugins only during phase-development-server (resolve relative to the config file, e.g. fileURLToPath(new URL(..., import.meta.url))). This preserves authored Markdown positions. ` +
        `Preserve custom rules and compose overlapping rules explicitly. Keep MDX compilation and source maps intact. ` +
        `Do not add a project-wide Babel config, use client directives, or rewrite component prop types. ` +
        `Use dependencies installed inside this checkout; never broaden Turbopack root to the home directory. ` +
        `Only change build integration. Trezi will wait for landing, restart the preview, and check for stamps before declaring setup complete.`
      )
    case 'react':
      return (
        verify +
        `Trezi detected a React project and added a dev-only Babel plugin at \`${file}\`. Please: ` +
        `(1) inspect package scripts and the real build config. For Vite React, wire ${file} into ` +
        `the React plugin (\`react({ babel: { plugins: [...] } })\`) FOR DEVELOPMENT ONLY — gate it on the serve/dev ` +
        `command; if the config shape differs, adapt to the real file or tell me what's blocking ` +
        `rather than guessing. Preserve existing component types; do not bulk-annotate components. Then I'll reload the preview.`
      )
    case 'react-native':
      return (
        `Trezi detected a React Native / Expo project and added a dev-only Babel plugin at ` +
        `\`${file}\` that stamps \`testID="trezi:path:line:col"\` on elements (the RN analog of ` +
        `data-trezi-source — iOS surfaces testID as the accessibility id, which Trezi reads from ` +
        `the simulator's view hierarchy). Please: (1) read babel.config.js (or .babelrc) and add ` +
        `${file} to the \`plugins\` array FOR DEVELOPMENT ONLY (gate on a dev env check; adapt to ` +
        `the real config, don't guess its shape). Preserve existing component types. Then I'll reload the preview.`
      )
    case 'solid':
      return (
        `Trezi detected a Solid project and added a dev-only Babel JSX plugin at \`${file}\`. Please ` +
        `wire ${file} into the Solid Vite plugin's Babel config for development only (adapt to the ` +
        `real config). Preserve existing component types. Then I'll ` +
        `reload the preview.`
      )
    case 'svelte': {
      return (
        `Trezi detected a Svelte project and added a dev-only markup preprocessor at \`${file}\`. ` +
        `Please: (1) read svelte.config.* and add ${file}'s default export to the \`preprocess\` ` +
        `array FOR DEVELOPMENT ONLY (gate on dev; adapt to the real config, don't guess its shape). ` +
        `Preserve existing component types; request a targeted annotation only if inspection cannot resolve a selected component. Then I'll reload the preview.`
      )
    }
    case 'vue':
      return (
        `Trezi detected a Vue project. Please add a DEV-ONLY way to map elements to their source as a ` +
        `\`data-trezi-source="path:line:col"\` attribute (e.g. vite-plugin-vue-inspector, or a small ` +
        `template transform), and preserve existing prop declarations. Then I'll reload the preview.`
      )
    default:
      return null
  }
}
