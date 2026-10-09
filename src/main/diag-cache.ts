/**
 * The key of the per-machine diagnosis memory: project path + error signature. The
 * memory itself (`diagnostics.json` in the profile) belongs to the service's workflow
 * owner (`recallDiagnosis`/`rememberDiagnosis`/`diagnosisStatus`); Bun only computes
 * the signature it is looked up by.
 */

/** Stable key for an error, with the volatile bits (paths, ids, numbers) normalized out. */
export function signatureFor(error: string): string {
  const norm = error
    .toLowerCase()
    .replace(/[a-f0-9]{8,}(-[a-f0-9]{4,})+/g, '<id>') // uuids
    .replace(/[a-f0-9]{12,}/g, '<id>') // long hex
    .replace(/\/(?:[\w.@-]+\/)+[\w.@-]+/g, '<path>') // multi-segment fs paths (not a module's single slash)
    .replace(/\d+/g, 'N') // ports / line numbers / versions
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0
  return h.toString(16)
}
