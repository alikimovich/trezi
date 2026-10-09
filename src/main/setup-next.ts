import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { NextSetupInfo } from '../shared/api'

/** Installed version is authoritative; a manifest range is only a fallback. */
export async function detectNext(root: string): Promise<NextSetupInfo> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  let version: string | undefined
  try {
    version = JSON.parse(
      await readFile(createRequire(join(root, 'package.json')).resolve('next/package.json'), 'utf8')
    ).version
  } catch {
    /* Dependencies may not yet be installed. */
  }
  const command = pkg.scripts?.dev ?? pkg.scripts?.start ?? ''
  const major = version ? Number(version.split('.')[0]) : undefined
  const nextDev = /(?:^|\s|&&|;)next\s+dev(?:\s|$)/.test(command)
  const bundler = !nextDev
    ? 'unknown'
    : /(?:^|\s)--webpack(?:\s|$)/.test(command)
      ? 'webpack'
      : /(?:^|\s)--(?:turbo|turbopack)(?:\s|$)/.test(command)
        ? 'turbopack'
        : major
          ? major >= 16
            ? 'turbopack'
            : 'webpack'
          : 'unknown'
  const exists = (p: string) =>
    access(join(root, p)).then(
      () => true,
      () => false
    )
  const app = (await exists('app')) || (await exists('src/app'))
  const pages = (await exists('pages')) || (await exists('src/pages'))
  return {
    version,
    declaredVersion:
      pkg.dependencies?.next ?? pkg.devDependencies?.next ?? pkg.peerDependencies?.next,
    command,
    bundler,
    router: app && pages ? 'mixed' : app ? 'app' : pages ? 'pages' : 'unknown'
  }
}

export const NEXT_LOADER = '.trezi/trezi-next-loader.cjs'
export const NEXT_ADAPTER = '.trezi/trezi-next.cjs'

// A local Babel transform, not a project Babel config. Next keeps its normal
// SWC pipeline. The loader uses only APIs implemented by Turbopack.
export const NEXT_LOADER_CONTENT = `// Trezi development source mapping. No project-wide Babel config required.
const path = require('node:path')
// Carry the authored instance into host output even when a component destructures
// props and does not spread them. This is a compile-time-only signature extension.
function instanceSource({ types: t }) {
  return { visitor: { Function(p) {
    const name = p.node.id?.name || (p.parent.type === 'VariableDeclarator' && p.parent.id.name) || (p.parent.type === 'ExportDefaultDeclaration' && 'Default')
    if (!name || !/^[A-Z]/.test(name)) return
    let renders = false
    p.traverse({ JSXElement(q) { if (q.getFunctionParent() === p) renders = true } })
    if (!renders) return
    let param = p.node.params[0]
    if (param?.type === 'AssignmentPattern') param = param.left
    let value
    if (param?.type === 'Identifier') {
      const read = key => t.optionalMemberExpression(t.identifier(param.name), t.stringLiteral(key), true, true)
      value = t.logicalExpression('??', read('data-trezi-component-source'), read('data-praxis-component-source'))
    } else if (!param || param.type === 'ObjectPattern') {
      const pattern = param || t.objectPattern([])
      const bind = key => {
        const existing = pattern.properties.find(prop => prop.key?.value === key)
        if (existing) {
          const value = existing.value?.type === 'AssignmentPattern' ? existing.value.left : existing.value
          return value?.type === 'Identifier' ? t.cloneNode(value) : null
        }
        const id = p.scope.generateUidIdentifier('treziInstance')
        // Keep any rest binding last.
        pattern.properties.unshift(t.objectProperty(t.stringLiteral(key), id))
        return id
      }
      const canonical = bind('data-trezi-component-source')
      const legacy = bind('data-praxis-component-source')
      if (!canonical || !legacy) return
      if (!param) p.node.params.unshift(t.assignmentPattern(pattern, t.objectExpression([])))
      value = t.logicalExpression('??', canonical, legacy)
    } else return
    p.traverse({ JSXOpeningElement(q) {
      if (q.getFunctionParent() !== p) return
      const name = q.node.name
      if (name.type !== 'JSXIdentifier' || !/^[a-z]/.test(name.name)) return
      if (q.node.attributes.some((a) => ['data-trezi-component-source', 'data-praxis-component-source'].includes(a.name?.name))) return
      q.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('data-trezi-component-source'), t.jsxExpressionContainer(t.cloneNode(value))))
    } })
  } } }
}
module.exports = function(source, inputMap) {
  if (process.env.NODE_ENV !== 'development') return this.callback(null, source, inputMap)
  const options = this.getOptions() || {}
  const root = options.root || path.dirname(__dirname)
  const file = path.relative(root, this.resourcePath)
  if (file.startsWith('..') || path.isAbsolute(file) || file.split(path.sep).includes('node_modules')) {
    return this.callback(null, source, inputMap)
  }
  const babel = require('@babel/core')
  try {
    const result = babel.transformSync(source, {
      filename: this.resourcePath, root, configFile: false, babelrc: false,
      sourceMaps: true, inputSourceMap: inputMap || undefined,
      parserOpts: { plugins: ['jsx', 'typescript'] },
      plugins: [require('./trezi-source.cjs'), instanceSource],
      generatorOpts: { retainLines: true }
    })
    this.callback(null, result.code, result.map)
  } catch (error) { this.callback(error) }
}
`

export const NEXT_ADAPTER_CONTENT = `// Wrap the FINAL Next config (including createMDX and other wrappers).
// Supports object, function and async configuration exports. Production is unchanged.
const path = require('node:path')
module.exports = function withTrezi(config) {
  return function(phase, context) {
    const value = typeof config === 'function' ? config.call(this, phase, context) : config
    const apply = (original) => {
      if (phase !== 'phase-development-server') return original
      const current = original || {}
      const root = path.dirname(__dirname)
      const loader = require.resolve('./trezi-next-loader.cjs')
      const version = require('next/package.json').version.split('.').map(Number)
      const modern = version[0] > 15 || (version[0] === 15 && version[1] >= 3)
      const turbo = modern ? current.turbopack : current.experimental?.turbo
      const rules = { ...(turbo?.rules || {}) }
      for (const ext of ['js', 'jsx', 'ts', 'tsx']) {
        const key = '*.' + ext
        if (rules[key]) throw new Error('Trezi: existing ' + key + ' Turbopack rule needs manual loader composition.')
        rules[key] = { loaders: [{ loader, options: { root } }] }
      }
      const result = { ...current,
        webpack(config, options) {
          const customized = current.webpack ? current.webpack.call(this, config, options) : config
          if (options.dev) {
            customized.module ||= {}
            customized.module.rules ||= []
            customized.module.rules.push({ test: /\\.[jt]sx?$/, exclude: /node_modules/,
              enforce: 'pre', use: [{ loader, options: { root } }] })
          }
          return customized
        }
      }
      if (modern) result.turbopack = { ...turbo, rules }
      else result.experimental = { ...current.experimental, turbo: { ...turbo, rules } }
      return result
    }
    return value && typeof value.then === 'function' ? value.then(apply) : apply(value)
  }
}
`
