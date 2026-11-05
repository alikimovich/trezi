import { islandSource } from '../main/chat-island-source'
import { previewServers } from '../main/preview-evidence'
import { previewPage } from '../main/preview-page'
import { previewAgentHost } from '../main/preview-state'
import type { IslandRecord, IslandValue } from '../shared/chat-islands'
import { projectKey } from '../shared/projectKey'

/** Read only a declared, source-stamped computed value from the actual preview frame. */
export async function confirmIslandRendered(
  root: string,
  record: IslandRecord,
  values: Record<string, IslandValue>,
  revision: string
): Promise<boolean> {
  const bindings = Object.entries(values).map(([id, value]) => ({
    param: record.manifest.params.find((param) => param.id === id),
    value
  }))
  if (
    !bindings.length ||
    bindings.some(
      ({ param, value }) =>
        !param?.rendered ||
        param.rendered.property !== 'opacity' ||
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
    )
  )
    return false
  const before = await previewPage(root)
  const host = previewAgentHost()
  const server = previewServers.get(projectKey(root))
  if (
    !host ||
    !server ||
    before.refusal ||
    !before.page ||
    before.page.origin !== new URL(server.url).origin ||
    !before.identity.session ||
    !before.identity.documentStartedAt ||
    before.identity.stale
  )
    return false
  const spec = bindings.map(({ param, value }) => ({
    selector: param!.rendered!.selector,
    property: param!.rendered!.property,
    value
  }))
  // Only serialized validated data enters this fixed read-only script. No manifest code runs.
  const observed = (await host.evaluate(
    `(() => {
    const spec = ${JSON.stringify(spec)};
    return {href: location.href, startedAt: performance.timeOrigin, values: spec.map(item => {
      const matches = document.querySelectorAll(item.selector);
      if (matches.length !== 1) return null;
      const node = matches[0];
      return {stamp: node.getAttribute('data-trezi-source'), value: getComputedStyle(node).getPropertyValue(item.property).trim()};
    })};
  })()`,
    'preview',
    1000
  )) as {
    href?: unknown
    startedAt?: unknown
    values?: unknown
  } | null
  const after = await previewPage(root)
  const sameFrame =
    !after.refusal &&
    after.page?.url === before.page.url &&
    after.identity.session === before.identity.session &&
    after.identity.navigation === before.identity.navigation &&
    after.identity.documentStartedAt === before.identity.documentStartedAt &&
    !after.identity.stale &&
    observed?.href === before.page.url &&
    typeof observed?.startedAt === 'number' &&
    new Date(Math.round(observed.startedAt)).toISOString() === before.identity.documentStartedAt
  if (!sameFrame || !Array.isArray(observed?.values) || observed.values.length !== spec.length)
    return false
  const matches = observed.values.every((entry: unknown, index: number) => {
    const item = entry as { stamp?: unknown; value?: unknown } | null
    return (
      item &&
      typeof item.stamp === 'string' &&
      item.stamp.startsWith(`${record.manifest.file}:`) &&
      /^\d+(?::\d+)?$/.test(item.stamp.slice(record.manifest.file.length + 1)) &&
      typeof item.value === 'string' &&
      Number(item.value) === spec[index].value
    )
  })
  if (!matches) return false
  // The file may change while the WebKit read is in flight. Never accept that frame.
  const source = await islandSource(root, record).catch(() => null)
  return (
    source?.revision === revision &&
    Object.entries(values).every(([id, value]) => source.values[id] === value)
  )
}
