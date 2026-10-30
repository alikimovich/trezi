import assert from 'node:assert/strict'

/**
 * LKM-374: the project rows a `sidebar-<width>-<row>-<state>.json` capture records. Since
 * LKM-372 the fixture lists three: one with a stored favicon (shown in place of the folder),
 * one with no icon and one with an undecodable icon (both the template folder fallback).
 */
export function assertSidebarRows(rows, stem) {
  assert.equal(rows.length, 3, `${stem}.json rows`)
  const favicons = rows.filter((r) => r.favicon)
  assert.equal(favicons.length, 1, `${stem}.json favicon rows`)
  assert.ok(!favicons[0].folder && !favicons[0].template, `${stem}.json favicon row is no folder`)
  assert.ok(
    rows.filter((r) => !r.favicon).every((r) => r.folder && r.template),
    `${stem}.json folder rows`
  )
}
