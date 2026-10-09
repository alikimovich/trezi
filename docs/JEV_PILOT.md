# Advisory Jev failure-triage pilot

This opt-in experiment classifies test-failure evidence. It never changes test
outcomes, retries product tests, skips tests, or gates CI. Ordinary `test` and
`verify` run only its offline unit checks and do not call TypeSafe.

## Credentials and execution

Store `TYPESAFE_API_KEY` in the repository's **ignored `.env.local`**, with file
permissions `0600`. The pilot also accepts the environment variable. Do not put
keys in command arguments, committed examples, report files, or shell history.
The local file is created with an empty slot during initial setup; no real key
is included in this implementation. The live CLI refuses to read that file if
it is tracked, not ignored, or readable by other local users.

```sh
bun run pilot:jev --dry-run
bun run pilot:jev --live --split=development
bun run pilot:jev --live --split=holdout --max-usd=0.01
```

The default is a no-network dry run of the holdout. It writes inspectable,
redacted requests without labels, rationales, ids, or provenance. Live mode sends
only the curated evidence strings in `test/fixtures/jev/failure-cases.json`.
It does not scan repository files or automatically upload raw test artifacts.

Requests go directly to the fixed TypeSafe HTTPS endpoint, with redirects
rejected, a 20-second timeout, sequential execution, and no automatic retries.
The runner stops at the first request error or when observed spend reaches the
configured ceiling. The preflight byte-based cost estimate is conservative but
not a billing guarantee; a request already in flight can cross the ceiling.
Failed requests may have unreported usage, so reports mark their cost incomplete.

The model is pinned to `jev-1.13.0`. Pricing checked on 2026-09-18 is $0.042 per
million input tokens with free output tokens. Reports retain the price source,
model id, and dataset/rubric hashes. Price estimates are not invoices.

## Dataset and interpretation

There are ten development cases (two per class) and twenty holdout cases (four
per class). The classes are product regression, timing, provider limit,
environment, and unknown. A generic timeout is unknown without more evidence;
an application-level running-chat error is not proof of remote provider limits.

**Labels were authored by the coding agent, not independently reviewed by a
human.** The complete dataset contains 28 synthetic cases and two sanitized
observed errors: a sandbox socket denial and the existing `agent-multi` error.
Only one observed error is in the holdout. This is a small integration/feasibility
pilot, not an estimate of accuracy on the real production failure distribution.
The log-instruction injection example is synthetic and intentionally ambiguous.

Freeze the rubric and labels before querying the holdout. Use development cases
for prompt changes. Once holdout results have informed changes, that set becomes
development data: create a fresh holdout for further claims. This initial pilot
has no few-shot examples and no fine-tuning.

The deterministic keyword baseline is intentionally simple and frozen in
`scripts/jev/core.mjs`; it is scored on exactly the same completed cases as Jev.
A second useful baseline is always choosing the most common real-world class;
this balanced synthetic dataset is not suitable for estimating that frequency.

## Reports

Each invocation creates `test/artifacts/jev/{dry,live}-*/report.json` (gitignored).
A dry run contains **no model predictions or accuracy claims**. Live reports
include only whitelisted response fields; raw provider response/error bodies and
request headers are never printed or persisted. Known keys and common token,
credential, URL, email, home-directory, and private-key patterns are redacted
from evidence. This is defense in depth, not a universal secret detector: manually
review any new cases before adding them to the curated dataset.

Live reports include accuracy, per-class confusion, balanced accuracy, a
multiclass Brier score (sum across classes), five calibration bins/ECE, p50/p95
latency, token usage, and estimated cost. Results are also broken out by synthetic
versus observed origin. Failures and unattempted cases are counted explicitly;
accuracy is over completed calls only, and partial runs remain incomplete.

The advisory threshold is fixed at **0.8 selected-class probability**, with
`unknown` always routed to review. Coverage includes errored attempts in its
denominator; advisory accuracy uses accepted predictions only. TypeSafe's
`confidence` field is retained separately: it describes distribution shape and
must not be interpreted as the probability that the selected answer is correct.
Twenty cases cannot establish calibration; the bins are descriptive only.

Before any integration into daily triage, independently label a larger set of
real failures, review per-class errors and high-confidence mistakes, and compare
against the baseline on a fresh holdout. Keep every label advisory.

## Sources

- [HTTP API contract](https://docs.typesafe.ai/api)
- [Current models and pricing](https://docs.typesafe.ai/models)
- [Choice responses](https://docs.typesafe.ai/primitives/choice)
- [Confidence versus probability](https://docs.typesafe.ai/confidence)
