import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SmokeResultFile } from './smoke-report'

/** The `--test` launch's disposable directory: the launcher's, or a scratch one with its profile. */
export function smokeDirectory(): string {
  if (process.env.TREZI_NATIVE_TEST_DIR) return process.env.TREZI_NATIVE_TEST_DIR
  const directory = mkdtempSync(join(tmpdir(), 'trezi-native-'))
  mkdirSync(join(directory, 'profile'))
  return directory
}

/** The static project the core smoke opens, inside the disposable test directory. */
export function writeSmokeProject(testDir: string): string {
  const fixture = join(testDir, 'Folder Alpha')
  mkdirSync(fixture)
  // A decodable raster icon exercises stored artwork in native sidebar verification.
  writeFileSync(
    join(fixture, 'favicon.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64'
    )
  )
  writeFileSync(
    join(fixture, 'index.html'),
    '<!doctype html>\n<html><body>\n<h1 id="native-title" data-trezi-source="index.html:3:1">Native Trezi fixture</h1>\n<p>Bun owns this server.</p><script>window.previewInputs=[];for(const type of ["keydown","keyup","keypress","pointerdown","mousedown","click","dblclick","wheel","input"])window.addEventListener(type,event=>window.previewInputs.push(event.type),true)</script>' +
      // Stands in for HMR: this static page never renders native-style.tsx, but every write
      // under the root live-reloads it, so it re-reads that file's padding-top on load.
      '<script>fetch("native-style.tsx").then(r=>r.text()).then(t=>{const m=/padding(?:Top|-top)["\']?\\s*:\\s*["\']?(\\d+)(?:px)?/.exec(t);if(m)document.querySelector("#native-title").style.paddingTop=m[1]+"px"}).catch(()=>{})</script></body></html>'
  )
  // Prepare the reload route before the managed server starts watching files.
  writeFileSync(join(fixture, 'about.html'), readFileSync(join(fixture, 'index.html')))
  // LKM-230: the agent browser's interaction fixture and a file the page cannot show.
  writeFileSync(join(fixture, 'filter.html'), FILTER_PAGE)
  writeFileSync(join(fixture, 'report.bin'), Buffer.from([0, 1, 2, 3]))
  return fixture
}

const FILTER_PAGE = `<!doctype html>
<html><head><title>Filter fixture</title><style>
body{font:16px system-ui;margin:16px}.card{border:1px solid #ccc;padding:12px;margin:8px 0}[hidden]{display:none!important}
#scroller{height:80px;overflow:auto;border:1px solid #999}#scroller div{height:400px}
</style></head><body>
<h1>Filter fixture</h1>
<div role="toolbar">
<button class="filter" id="filter-all" data-filter="all" data-trezi-source="filter.html:8:1">All</button>
<button class="filter" id="filter-design" data-filter="design" data-trezi-source="filter.html:9:1">Design</button>
<button class="filter" id="filter-code" data-filter="code" data-trezi-source="filter.html:10:1">Code</button>
</div>
<p id="status">Showing code</p><p id="loaded"></p>
<div class="card" data-kind="code">Card: Compiler notes</div>
<div class="card" id="design-card" data-kind="design" hidden>Card: Design tokens</div>
<input id="search" placeholder="Search"><p id="echo"></p>
<select id="sort"><option value="new">Newest</option><option value="old">Oldest</option></select><p id="sort-status">new</p>
<div id="hover-target">Hover me</div><p id="hover-status"></p>
<div id="scroller"><div>Tall content</div></div>
<form id="local-form" action="filter.html"><input id="q" name="q"></form>
<a id="external-link" href="https://example.invalid/">External</a>
<a id="download-link" href="report.bin" download>Download</a>
<a id="binary-link" href="report.bin">Report</a>
<input id="upload" type="file">
<form id="external-form" action="https://example.invalid/submit" method="post"><button id="external-submit">Send</button></form>
<button id="js-leave" onclick="location.href='https://example.invalid/away'">Leave</button>
<button id="js-post" onclick="document.getElementById('external-form').submit()">Post</button>
<script>
let fetched = 0
for (const button of document.querySelectorAll('.filter')) button.addEventListener('click', () => {
  const filter = button.dataset.filter
  for (const card of document.querySelectorAll('.card')) card.hidden = !(filter === 'all' || card.dataset.kind === filter)
  document.getElementById('status').textContent = 'Showing ' + filter
  fetch('index.html').then(() => { document.getElementById('loaded').textContent = 'loaded ' + ++fetched })
})
for (const card of document.querySelectorAll('.card')) if (card.dataset.kind !== 'code') card.hidden = true
document.getElementById('search').addEventListener('input', (e) => { document.getElementById('echo').textContent = e.target.value })
document.getElementById('sort').addEventListener('change', (e) => { document.getElementById('sort-status').textContent = e.target.value })
document.getElementById('hover-target').addEventListener('mouseenter', () => { document.getElementById('hover-status').textContent = 'hovered' })
</script></body></html>
`

/** A scratch test directory (no launcher) is removed with the run. */
export function removeSmokeDirectory(testDir: string): void {
  if (!process.env.TREZI_NATIVE_TEST_DIR) rmSync(testDir, { recursive: true, force: true })
}

/** The run's failure lines and exit code for the launcher, which prints them last (LKM-176). */
export function writeSmokeResult(testDir: string, result: SmokeResultFile): void {
  writeFileSync(join(testDir, 'smoke-result.json'), JSON.stringify(result))
}

export function saveSmokeFailure(root: string, png: string): void {
  writeFileSync(join(root, 'test/artifacts/native/failure.png'), Buffer.from(png, 'base64'))
}
