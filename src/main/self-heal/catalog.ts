/** Stable incident classes. Keep raw provider output out of user-facing labels. */
export type IncidentClass =
  | 'provider-network'
  | 'provider-auth'
  | 'provider-limit'
  | 'model-unavailable'
  | 'helper-crash'
  | 'dev-server'
  | 'dependency-install'
  | 'conflict'
  | 'landing'
  | 'git-lock'
  | 'disk-full'
  | 'stale-preview'
  | 'unknown'

export interface Incident {
  class: IncidentClass
  line: string
  action: string
}

const entries: { class: IncidentClass; pattern: RegExp; line: string; action: string }[] = [
  {
    class: 'provider-network',
    pattern:
      /workspace routing discovery failed|connection failed|error sending request|\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b|dns|tls handshake/i,
    line: 'Provider could not connect',
    action: 'retry'
  },
  {
    class: 'provider-auth',
    pattern:
      /authentication expired|not logged in|sign in with chatgpt|run `?codex login|unauthorized|invalid api key|401\b/i,
    line: 'Sign in to continue',
    action: 'login'
  },
  {
    class: 'provider-limit',
    pattern: /rate limit|usage limit|quota exceeded|too many requests|429\b/i,
    line: 'Provider limit reached',
    action: 'wait-or-fallback'
  },
  {
    class: 'model-unavailable',
    pattern: /model .*not (?:available|supported)|isn't available|model_not_found|unknown model/i,
    line: 'Model unavailable',
    action: 'switch-model'
  },
  {
    class: 'helper-crash',
    pattern: /helper (?:exited|crashed|stopped|is not running)|provider helper did not start/i,
    line: 'Restarting provider…',
    action: 'restart-helper'
  },
  {
    class: 'dev-server',
    pattern: /dev server.*(?:down|stopped|failed)|(?:EADDRINUSE|port .*busy)/i,
    line: 'Restarting preview server…',
    action: 'restart-server'
  },
  {
    class: 'dependency-install',
    pattern: /(?:npm|bun|pnpm|yarn) install.*fail|dependency install.*fail/i,
    line: 'Dependency install failed',
    action: 'diagnose-install'
  },
  {
    class: 'conflict',
    pattern: /conflict markers|merge conflict|unmerged paths/i,
    line: 'Resolving changes…',
    action: 'resolve'
  },
  {
    class: 'landing',
    pattern: /(?:landing|parking|parked).*(?:fail|error)|failed to land/i,
    line: 'Could not apply changes',
    action: 'reconcile'
  },
  {
    class: 'git-lock',
    pattern: /index\.lock|another git process seems to be running/i,
    line: 'Checking Git lock…',
    action: 'check-lock'
  },
  {
    class: 'disk-full',
    pattern: /ENOSPC|no space left on device|disk full/i,
    line: 'Disk is full',
    action: 'free-space'
  },
  {
    class: 'stale-preview',
    pattern: /stale preview|preview.*stale|serving another revision/i,
    line: 'Refreshing preview…',
    action: 'refresh-preview'
  }
]

export function classifyError(raw: string): Incident {
  // A retry storm can mention a connection while its actual HTTP cause is a
  // 401 or 429. Those are actionable auth/usage failures, not transient network.
  const entry =
    entries.find((item) => item.class === 'provider-auth' && item.pattern.test(raw)) ??
    entries.find((item) => item.class === 'provider-limit' && item.pattern.test(raw)) ??
    entries.find((item) => item.pattern.test(raw))
  return entry
    ? { class: entry.class, line: entry.line, action: entry.action }
    : { class: 'unknown', line: summarizeError(raw), action: 'doctor' }
}

/** One short, redacted line of an unclassified message: it often names the action the user
 *  needs ("re-add it in Settings", "codex login"), so the compact row keeps it visible. */
export function summarizeError(raw: string, max = 140): string {
  const first =
    incidentDetail(raw)
      .split('\n')
      .map((line) =>
        line
          .replace(/^(?:\s|⚠️?)+/u, '')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .find(Boolean) ?? ''
  if (!first) return 'Something went wrong'
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

/** Details stay useful for support, but never expose credential-looking values. */
export function incidentDetail(raw: string): string {
  return raw
    .slice(0, 12_000)
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[redacted key]'
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[redacted]')
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(
      /(\b(?:bearer|authorization|api[_-]?key|token|password)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[redacted]'
    )
}
