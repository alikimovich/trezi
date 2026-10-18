# Dependency advisory triage (LKM-282)

Reachability classification of every critical and high advisory that `bun audit`
reported against `bun.lock` at the security-review base, plus the decision taken for each.
A package being in the lockfile does not make it exploitable in Trezi. This page records
what actually loads, the input it sees, and the conditions an attacker would need.

## Baseline

`bun scripts/dependency-audit.mjs` on the main lockfile: 320 resolved packages,
39 advisories (1 critical, 15 high, 21 moderate, 2 low). The raw output is the
release audit's `dependency-audit.txt`, which is kept outside the repository and not
modified. The 16 critical/high advisories affect six packages, and all six are transitive
except `@modelcontextprotocol/sdk`.

## How the JS ships and what loads

- `scripts/build-native.mjs` bundles `src/native/index.ts` (backend) and
  `src/main/backends/provider-helper-entry.ts` (provider helper) with
  `packages: 'external'`. No npm package code is inlined, except Shiki's own syntax
  bundle. At runtime both resolve packages from the checkout's `node_modules`, which
  `bun install` fills from this lockfile. The preview bundles (`src/preview/`) import no
  npm package.
- External package imports of both bundles (esbuild metafile, LKM-282):
  `@anthropic-ai/claude-agent-sdk`, `@babel/parser`, `@json-render/*`,
  `@modelcontextprotocol/sdk/client/index.js`, `@modelcontextprotocol/sdk/client/stdio.js`,
  `@openai/codex-sdk`, `apca-w3`, `colorparsley`, `parse5`, `react-docgen`,
  `svelte/compiler`, `typescript`, `zod`. The backend adds no other package.
- Trezi's MCP use is stdio only: `verifyTreziMcp` (`src/main/backends/codex-mcp.ts`), the
  agent tool server `bin/trezi-agent-mcp.mjs` (`McpServer` + `StdioServerTransport`), and
  the Claude preview server through the Agent SDK's in-process `createSdkMcpServer`
  (`src/main/backends/claude.ts`), which imports `server/mcp.js`. The tool bridge behind
  them is `node:http` on a 0600 Unix socket with a per-session token
  (`src/main/trezi-agent-tools.ts`), not Express. Trezi sets no `trust proxy`.
- Runtime probe (LKM-282, not committed): the SDK's stdio client spawned the real
  `bin/trezi-agent-mcp.mjs` with a dummy socket and token, listed its 29 tools, compiled
  all 29 schemas with the SDK's Ajv validator and made one call, which failed closed.
  A module-resolution hook recorded every package that loaded in both processes:
  `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`, `fast-uri`, `fast-deep-equal`,
  `json-schema-traverse`, `cross-spawn` (+ `which`, `isexe`, `path-key`,
  `shebang-*`), `zod`, `zod-to-json-schema`. No `express`, `proxy-addr`,
  `express-rate-limit`, `ip-address`, `hono`, `@hono/node-server`, and no SDK
  `client/auth`, `server/auth`, `server/express`, SSE or Streamable HTTP module. The
  result was identical with the old and the new `fast-uri`/`proxy-addr`.
- The Claude Code and Codex CLIs carry their own MCP clients, which this lockfile does
  not resolve. Their MCP and OAuth behaviour is out of scope here.

## Classification

| Package (locked) | Advisory | Severity | Dependency path | Role in Trezi | Loaded at runtime / input | Attack prerequisites | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `proxy-addr` 2.0.7 | GHSA-jqcg-44mw-7w3h | critical | MCP SDK › `express` (also via `express-rate-limit`) | Installed runtime dependency; used only by the SDK's Express/HTTP server helpers | Not loaded (probe). Trezi has no Express app and no `trust proxy` setting | An Express app with a relevant trust-proxy configuration reachable over HTTP. Trezi has neither | **Updated to 2.0.8** (in range of `express` `^2.0.7`; its HISTORY names this GHSA; lockfile only). Not reachable before the update either |
| `@modelcontextprotocol/sdk` 1.29.0 | GHSA-6qxp-vccf-f47h | high | Direct dependency; peer of `@anthropic-ai/claude-agent-sdk` | Runtime: stdio client and stdio/in-process server | The advisory concerns the OAuth client (`client/auth.js`). Trezi passes no `authProvider` and uses no HTTP/SSE client transport; no auth module loads (probe) | Trezi acting as an MCP OAuth client against a hostile authorization server. Trezi never does | **Deferred, not reachable.** Fixed version not verifiable offline (the cached 1.29.0→1.30.1 `client/auth.js` diff only changes RFC 8707 resource-indicator handling). Bump when an audit with registry access names a fixed release |
| `browserslist` 4.28.4 | GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g | high ×2 | `react-docgen` › `@babel/core` › `@babel/helper-compilation-targets` › `browserslist` | Runtime: `react-docgen` parses React components in the backend (`src/main/props.ts`) and the provider helper (`src/main/project-ui-catalog.ts`) | **Was reachable.** `loadPartialConfig` resolves targets and searches the cwd for a browserslist config. The provider helper runs in the session root (`src/service/ProviderLaunch.swift`), so project UI discovery parsed the project's `browserslist` query and required its `extends` package (a dummy marker package ran; an invalid query made discovery find no components) | A user opens a hostile repository and a chat uses project UI discovery. Opening a project already runs its dev script, so the added impact is code execution where discovery promises none, plus parser bugs in the query | **Fixed in code:** both react-docgen calls pass `browserslistConfigFile: false`. Parsing needs no targets, so Babel never calls browserslist. Regression `test/docgen-browserslist.mjs` (fails before: no components found, marker module ran). The package update (4.29.3 carries an anchored scoped-config pattern, prototype-safe stats and a linear query parse) is **deferred**: it needs newer `caniuse-lite`, `electron-to-chromium`, `baseline-browser-mapping` and `update-browserslist-db`, which cannot be resolved offline |
| `devalue` 5.8.1 | GHSA-r9w8-h9r3-54w4, GHSA-j22f-vq7h-c4qm, GHSA-mcm9-63f2-9j32, GHSA-x5rw-q4pp-hg5g | high ×4 | `svelte` › `devalue` | Runtime package, but only `svelte/compiler` is used; `devalue` is test-only | Not loaded by product code. The compiler's import closure has no `devalue`; Trezi discards the compiled output and never runs it (`src/main/project-ui.ts`, `src/main/project-ui-svelte.ts`). Only `test/project-ui-svelte.mjs` imports `svelte/server`. Previewed Svelte apps use the project's own `node_modules` | Serialising or parsing attacker data with `devalue`. Trezi does neither | **Deferred, not reachable.** The offline cache has no newer `devalue` than 5.8.1 |
| `fast-uri` 3.1.2 | GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp, GHSA-7p8r-x3mc-p8w7, GHSA-v2hh-gcrm-f6hx, GHSA-4c8g-83qw-93j6, GHSA-qw65-cvwx-89v3 | high ×7 | MCP SDK › `ajv` / `ajv-formats` › `fast-uri` | Runtime: Ajv compiles MCP tool schemas in the stdio client and server | Loaded (probe). Input is the tool schemas of Trezi's own server over stdio (token-gated bridge) or in-process | Attacker-controlled schema `$id`/`$ref` or URI values. Trezi's schemas are its own | **Updated to 3.1.8** (in range of `ajv` `^3.0.1`; the diff adds fail-closed handling of malformed URIs, scheme validation and case-sensitive `equal`). Defence in depth for a runtime-loaded parser; probe output unchanged |
| `ip-address` 10.2.0 | GHSA-mwp4-54f8-5fhr | high | MCP SDK › `express-rate-limit` › `ip-address` | Installed runtime dependency; used only by the SDK's OAuth authorization-server router | Not loaded (probe) | Trezi serving the SDK's HTTP auth router. It does not | **Deferred, not reachable** |

## Lockfile changes

- `proxy-addr` 2.0.7 → 2.0.8 and `fast-uri` 3.1.2 → 3.1.8. Two `bun.lock` lines; no
  `package.json` change; no other package moved. Resolved from Bun's registry manifest
  cache (`bun install --lockfile-only --prefer-offline` with a temporary override in a
  scratch copy). `bun install --frozen-lockfile` accepts the result.
- Before and after, measured by the manager with registry access (the worker sandbox
  could not reach `registry.npmjs.org`, so it could not run `bun audit` itself):

  | | Packages | Advisories | Critical | High | Moderate | Low |
  | --- | --- | --- | --- | --- | --- | --- |
  | Before (base `1721c95e`) | 320 | 39 | 1 | 15 | 21 | 2 |
  | After (this change) | 320 | 30 | 0 | 8 | 20 | 2 |

  Command: `TREZI_AUDIT_BASE_SHA=1721c95e… bun scripts/dependency-audit.mjs`, exit 0, zero
  new advisories. Raw output: `registry-audit.txt` (kept outside the repository, not
  modified). The two-line update cleared the proxy-addr critical and the seven high plus
  one moderate `fast-uri` advisories (nine in all).
- Integrity: the manager fetched the official npm registry metadata for `fast-uri` 3.1.8 and
  `proxy-addr` 2.0.8 read-only (`registry-integrity.json`, kept outside the repository).
  Its `dist.integrity` values are identical to the two new `bun.lock` hashes. This replaces
  the worker's earlier limitation that the hashes came from Bun's manifest cache.
- The 8 remaining highs are the MCP SDK (1), `browserslist` (2), `devalue` (4) and
  `ip-address` (1). They stay classified and deferred as in the table above. The tree is
  not vulnerability-free: 30 advisories remain open, and none of the remaining highs is
  reachable in Trezi (the `browserslist` one is mitigated in code).

## Deferred follow-ups

- With registry access: update `browserslist` and its data packages, and
  `@modelcontextprotocol/sdk`, `devalue` and `ip-address` once the audit names compatible
  fixed versions. None of them is reachable after this change.
- Moderates and lows were not triaged here (the ticket covers critical/high).
