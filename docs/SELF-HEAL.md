# Self-healing incidents

Trezi classifies errors in `src/main/self-heal/catalog.ts`. The native chat shows a compact incident row with collapsed, copyable Details instead of placing CLI output in the response. Errors of the same class in a turn share one row. The product log records class, intended recovery and outcome for Dreamer.

| Class | Recovery |
| --- | --- |
| Provider network | Codex retries the prompt up to three times after a helper-side reachability probe, with bounded backoff. |
| Provider auth | Existing sign-in card. |
| Provider limit | Wait or choose another provider. |
| Model unavailable | Existing Codex model fallback. |
| Helper crash | Existing supervised helper reopens on the next send. |
| Dev server, stale preview | Use Trezi's restart or reload tools. |
| Dependency install | Diagnose and retry through the dependency owner. |
| Conflict, landing/parking | Use the existing Resolve workflow. |
| Git lock | Check age and active Git processes; only the Swift repository owner may remove a stale lock. |
| Disk full, unknown | Read safe diagnostics and give one exact next step. |

The bundled `trezi-doctor` skill instructs agents to diagnose repeated or unknown failures with redacted logs and read-only checks, then apply only the safe actions above. Network probes and provider retries run inside the supervised helper; they inherit the same allowlisted proxy and certificate variables as the bundled Codex CLI (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `ALL_PROXY`, lower-case variants, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`). Values available to Trezi's launch environment are passed through; a GUI launch does not read arbitrary interactive shell startup files.
