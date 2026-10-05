import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  return fixture
}

/** A scratch test directory (no launcher) is removed with the run. */
export function removeSmokeDirectory(testDir: string): void {
  if (!process.env.TREZI_NATIVE_TEST_DIR) rmSync(testDir, { recursive: true, force: true })
}

export function saveSmokeFailure(root: string, png: string): void {
  writeFileSync(join(root, 'test/artifacts/native/failure.png'), Buffer.from(png, 'base64'))
}
