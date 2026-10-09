/** Legacy environment names remain accepted; an explicitly supplied Trezi value wins. */
export function compatibleEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('PRAXIS_')) env[key.replace(/^PRAXIS_/, 'TREZI_')] ??= value
  }
}
compatibleEnvironment()
