import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, stamp } from './builder'
import type { ToolchainSelection } from './toolchain'

/**
 * The preview scanner (LKM-276): `PreviewScanner.swift` compiled against the selected
 * Xcode's own SwiftSyntax and run on a module's files. It only parses: what it prints
 * is the input of `catalog.ts`. The binary is built once per toolchain and scanner
 * source into Trezi's derived data; each file's result is kept until its size or
 * mtime changes. Command Line Tools ship no SwiftSyntax modules, so scanning needs a
 * full Xcode (as `#Preview` itself does).
 */
export interface ScannedParam {
  label: string
  name: string
  type: string
  hasDefault: boolean
}

export interface ScannedInit {
  access: string
  failable: boolean
  /** `throws`, `async`, … as written. */
  effects: string
  params: ScannedParam[]
  line: number
}

export interface ScannedProperty {
  name: string
  type: string
  /** The first attribute (a property wrapper such as `State`), '' when none. */
  wrapper: string
  wrapperArgs: string
  hasDefault: boolean
  isLet: boolean
  isStatic: boolean
  computed: boolean
  access: string
}

export interface ScannedType {
  kind: 'struct' | 'class' | 'enum' | 'actor' | 'extension'
  name: string
  /** `Outer.Inner`; an extension's extended type. */
  qualified: string
  /** Effective access: the narrowest along the nesting chain. */
  access: string
  ownAccess: string
  line: number
  endLine: number
  inherits: string[]
  generic: boolean
  /** `#if` conditions true exactly where it compiles. */
  conditions: string[]
  attributes: string[]
  inits: ScannedInit[]
  properties: ScannedProperty[]
  methods: string[]
  cases: { name: string; associated: boolean }[]
  nested: boolean
  /** Declared inside a `private` type. */
  parentPrivate: boolean
}

export interface ScannedPreview {
  /** 1-based, in source order. */
  index: number
  line: number
  endLine: number
  name?: string
  /** A name that is not a plain string literal. */
  nameExpr?: string
  traits: string[]
  attributes: string[]
  conditions: string[]
  context: 'file' | 'type'
  bodyLine: number
  body: string
  /** `@Previewable` declarations, the attribute removed. */
  previewable: { text: string; line: number }[]
  /** The statements after them. */
  rest: { text: string; line: number } | null
  previewableAfter: boolean
  identifiers: string[]
  problems: string[]
}

export interface ScannedFile {
  path: string
  error?: string
  imports: { text: string; conditions: string[] }[]
  privateNames: string[]
  previews: ScannedPreview[]
  types: ScannedType[]
}

const SCANNER_SOURCE = join(__dirname, 'PreviewScanner.swift')

/** The folder with the toolchain's SwiftSyntax modules and libraries, '' when it has none. */
export function syntaxLibraries(developerDir: string): string {
  for (const dir of [
    join(developerDir, 'Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host'),
    join(developerDir, 'usr/lib/swift/host')
  ])
    if (
      existsSync(join(dir, 'SwiftSyntax.swiftmodule')) &&
      existsSync(join(dir, 'libSwiftParser.dylib'))
    )
      return dir
  return ''
}

export class PreviewScanner {
  private binary: Promise<string> | null = null
  private binaryKey = ''
  private readonly results = new Map<string, { stamp: string; file: ScannedFile }>()

  constructor(
    private readonly options: {
      /** Trezi's derived data for tools (shared by projects). */
      toolsDir: string
      moduleCache: string
      source?: string
      log: (line: string) => void
    }
  ) {}

  /** The scanner binary for this toolchain, compiled on first use. */
  private build(toolchain: ToolchainSelection): Promise<string> {
    const source = this.options.source ?? SCANNER_SOURCE
    const key = createHash('sha256')
      .update(`${toolchain.key}\n${readFileSync(source, 'utf8')}`)
      .digest('hex')
      .slice(0, 16)
    if (this.binary && this.binaryKey === key) return this.binary
    this.binaryKey = key
    this.binary = (async () => {
      const developerDir = toolchain.toolchain?.developerDir ?? ''
      const libraries = developerDir ? syntaxLibraries(developerDir) : ''
      if (!libraries)
        throw new Error(
          `Reading #Preview blocks and components needs SwiftSyntax from a full Xcode; ${developerDir || 'the selected toolchain'} has none.`
        )
      const dir = join(this.options.toolsDir, `scanner-${key}`)
      const binary = join(dir, 'PreviewScanner')
      if (existsSync(join(dir, '.complete'))) return binary
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      this.options.log('Swift previews: compiling the preview scanner…')
      const result = await run(
        '/usr/bin/xcrun',
        [
          '--sdk',
          'macosx',
          'swiftc',
          '-Onone',
          '-module-cache-path',
          this.options.moduleCache,
          '-I',
          libraries,
          '-L',
          libraries,
          '-lSwiftSyntax',
          '-lSwiftParser',
          '-Xlinker',
          '-rpath',
          '-Xlinker',
          libraries,
          source,
          '-o',
          binary
        ],
        dir,
        toolchain.env
      )
      if (result.code !== 0) {
        const tail = result.output.trim().split('\n').slice(-6).join('\n')
        throw new Error(`The preview scanner did not compile: ${tail || 'no output'}`)
      }
      writeFileSync(join(dir, '.complete'), '')
      return binary
    })()
    this.binary.catch(() => {
      this.binary = null
    })
    return this.binary
  }

  /** Every file's declarations; files unchanged since the last scan are not read again. */
  async scan(files: string[], toolchain: ToolchainSelection): Promise<Map<string, ScannedFile>> {
    const found = new Map<string, ScannedFile>()
    const missing: string[] = []
    for (const file of files) {
      const cached = this.results.get(file)
      if (cached && cached.stamp === stamp(file)) found.set(file, cached.file)
      else missing.push(file)
    }
    if (missing.length) {
      const binary = await this.build(toolchain)
      const stamps = new Map(missing.map((file) => [file, stamp(file)]))
      const output = await runScanner(binary, missing, toolchain.env)
      for (const file of output.files) {
        found.set(file.path, file)
        this.results.set(file.path, { stamp: stamps.get(file.path) ?? '', file })
      }
    }
    return found
  }
}

function runScanner(
  binary: string,
  files: string[],
  env: Record<string, string>
): Promise<{ files: ScannedFile[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    let errors = ''
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      errors = (errors + chunk.toString('utf8')).slice(-4_000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0)
        return reject(
          new Error(`The preview scanner exited (${code}): ${errors.trim().slice(-400)}`)
        )
      try {
        resolve(JSON.parse(Buffer.concat(out).toString('utf8')))
      } catch {
        reject(new Error('The preview scanner printed no valid JSON.'))
      }
    })
    child.stdin.end(`${files.join('\n')}\n`)
  })
}
