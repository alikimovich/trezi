export type PreferenceEntry = [key: string, value: string | null]
export type PreferenceBatch =
  | PreferenceEntry[]
  | ((values: Readonly<Record<string, string | null>>) => PreferenceEntry[])
/** Reads come from the last acknowledged state; writes resolve only once committed. */
export interface NativePreferences {
  snapshot(): Record<string, string | null>
  get(key: string): string | null
  /** One atomic batch: every entry is written, or none is. */
  apply(batch: PreferenceBatch): Promise<void>
  set(key: string, value: string | null): Promise<void>
  /** Called when the stored values change without a local write (e.g. an adopted external edit). */
  subscribe(listener: () => void): void
}

// Lengths are UTF-16 code units (JS `.length`); the Swift owner counts the same way.
export const validPreference = (key: unknown, value: unknown): key is string =>
  typeof key === 'string' &&
  /^(trezi|praxis)[:.]/.test(key) &&
  key.length < 200 &&
  (value === null || (typeof value === 'string' && value.length <= 2_000_000))
export const canonicalPreference = (key: string) => key.replace(/^praxis([:.])/, 'trezi$1')
export function resolveBatch(
  batch: PreferenceBatch,
  values: Readonly<Record<string, string | null>>
): PreferenceEntry[] {
  const entries = typeof batch === 'function' ? batch(values) : batch
  if (!entries.length) throw new Error('Empty preferences batch')
  for (const [key, value] of entries)
    if (!validPreference(key, value)) throw new Error('Invalid native preference')
  return entries
}
