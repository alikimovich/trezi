# Local Apple Intelligence opportunities

Exploration: 2026-09-28. Proposal only; no runtime integration or model benchmark.

## Recommendation

Add an optional native intelligence service for bounded language tasks. Start
with chat naming, then content rewrites and selecting prepared controls. Keep
coding, source binding, conflict resolution and complex diagnosis with the
existing providers and deterministic services.

This should reduce auxiliary provider requests and allow useful offline features.
Latency, quality and energy improvements are hypotheses to measure, not promises.
The main coding conversation would still use the user's configured provider.

## Verified platform boundary

- Trezi targets macOS 13.3 in `scripts/build-native.mjs`. This machine and its
  command-line SDK report 26.4.1. The installed FoundationModels Swift interface
  marks the base APIs available from macOS 26.0.
- Gate the feature at runtime and keep older Macs functional. Check
  `SystemLanguageModel.default.availability`; OS version alone does not establish
  device eligibility, enabled Apple Intelligence, or downloaded model readiness.
  This exploration did not check actual model readiness or run inference.
- The 26-era on-device model has a documented 4,096-token session budget, including
  schemas, tools, instructions and output. Use the 26.4 context-size/token-count
  APIs where available instead of assuming a constant for all OS/model versions.
- Apple's current documentation includes newer image-input and model-provider
  APIs. Treat those as a separate newer-SDK feature, not something the checked
  26.4.1 build can immediately consume.
- Explicitly select the on-device system model. Private Cloud Compute and other
  server providers are outside a local-only feature. Do not silently escalate
  failed local requests to a network model.

Sources: [generation and availability](https://developer.apple.com/documentation/foundationmodels/generating-content-and-performing-tasks-with-foundation-models),
[context budgeting](https://developer.apple.com/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window),
[API updates](https://developer.apple.com/documentation/updates/foundationmodels),
[newer vision and model APIs](https://developer.apple.com/videos/play/wwdc2026/241/).

## Ranked opportunities

| Priority | Feature and user benefit | Existing seam | Scope and caveat |
| --- | --- | --- | --- |
| 1 | Automatic useful chat titles across providers | `src/main/agent.ts`, `src/main/backends/title.ts`, `src/main/backends/claude.ts` | Title generation currently depends on an optional provider method, implemented by Claude. Use the existing bounded digest and sanitizer; preserve the first-message fallback and stale-session/manual-title guards. Smallest useful experiment. |
| 2 | Shorten, clarify or change the tone of selected website copy | None since LKM-114 removed content editors (was `content-controller.ts`/`ContentWindow.swift`) | Needs a new text-editing surface first. Preserve Save to source, revision checks and Undo; limit changes to supported text fields. Preserve URLs, placeholders, names and factual claims. |
| 3 | Select relevant tuning controls from prepared candidates | `src/main/control-selection.ts`, `src/main/controls-jev.ts` | Return ordered candidate IDs through guided generation. Existing Jev selection already chooses immutable bindings. Pass compact labels/descriptions, not the full 28 KB candidate allowance. Reject unknown/duplicate IDs. Never invent a binding, source path or control implementation. |
| 4 | Recaps and history tags: “What happened in this chat?” | `src/main/backends/title.ts`, `src/main/backends/memory.ts` | New read-only metadata from bounded completed turns. Keep original history; cite the turns behind decisions. A recap must distinguish attempted work from successful landing. Search can start with ordinary text indexing plus generated tags. |
| 5 | Explain errors and group repeated failures | `src/main/diagnose.ts`, `src/main/diag-rules.ts`, `src/main/diag-cache.ts` | Keep cache and exact rules first. Locally extract error facts or explain a known diagnosis. Novel root-cause analysis and executable fix commands still need stronger evidence/provider reasoning. |
| 6 | Suggest durable project-memory additions | `src/main/backends/memory.ts`, `src/main/project-memory.ts` | Extract small evidence-backed candidate decisions. Do not initially replace the full automatic memory merger: it handles authoritative memory, corrections and concurrent saves, and its 12,000-character digest plus existing memory can exceed local context. |
| 7 | Draft descriptions for small changes | `src/main/publish-description.ts` | Current publishing uses Luna on the committed merge-base diff, capped at 100,000 characters. Only evaluate a local path for diffs that fit intact. Large diffs and code semantics make this a weaker first candidate; do not summarize filenames and claim to understand behavior. |

These rankings are engineering judgments based on the inspected code and Apple's
documented suitability for summarization, extraction, classification and text
refinement. Apple cautions against relying on the 26-era model for code generation
and logical reasoning. Structured output constrains shape, not factual correctness.
[Capability guidance](https://developer.apple.com/documentation/foundationmodels/generating-content-and-performing-tasks-with-foundation-models).

## Adjacent Apple features

- **Writing Tools in the composer and memory editor:** standard AppKit text views
  already support this by default. Trezi's composer subclasses NSTextView, and no
  explicit Writing Tools integration was found. First verify existing behavior,
  draft synchronization and Undo; suppress interfering updates while a rewrite is
  active and protect code/paths from rewriting. System Writing Tools is a separate
  user-driven feature; do not advertise it as a guaranteed local-only inference
  path. [AppKit guidance](https://developer.apple.com/documentation/appkit/customizing-writing-tools-behavior-for-system-views).
- **Voice-to-edit drafts:** SpeechAnalyzer can transcribe on device; a bounded
  language pass can turn speech into a readable composer draft with selected-element
  context. Keep send explicit. Locale/model downloads and microphone access need
  handling. Speech is a separate framework, not Foundation Models audio input.
  [Apple's overview](https://developer.apple.com/videos/play/meet-with-apple/201/).
- **Screenshot descriptions and suggested alt text:** newer on-device image input
  is worth a later spike. On the current baseline, Vision OCR can supply text, but
  OCR alone does not establish visual meaning. Review generated alt text. Use DOM
  geometry, computed styles and the existing APCA implementation for measurements
  and contrast; a language model is not a pixel/layout verifier.
  [Image understanding](https://developer.apple.com/documentation/foundationmodels/analyzing-images-with-multimodal-prompting).

## Integration proposal

Add a small Swift service behind the existing JSON pipe in
`src/native/bridge.ts` and `src/native/Host.swift`. Proposed operations are
`localAI.availability`, `localAI.title`, `localAI.rewrite` and
`localAI.selectControls`; these names are proposals, not existing routes.

Bun continues to own persistence, source changes and lifecycle. Swift runs short
asynchronous inference tasks and returns typed data, using `@Generable` for small
schemas. Revalidate in Bun before applying anything. No general shell/filesystem
tools are needed, and the WebKit preview gets no new application-command access.

Use a fresh bounded session per job, a small concurrency limit, cancellation and
deadlines. Carry chat/project identity and revision with every request; discard
late responses after edits, navigation, deletion or manual renaming. Treat model
input as untrusted data and avoid logging private content. Handle refusal,
unavailable models and context overflow as normal outcomes. Keep local-only
fallbacks deterministic or leave the action unavailable with a clear reason.

## First experiment and acceptance

Implement only availability reporting and automatic titles first. Preserve
existing provider behavior when the optional feature is disabled; in local-only
mode, use the existing heuristic if local generation fails.

Use a curated fixture set of design conversations, code-heavy prompts, long and
multilingual text, misleading embedded instructions and cancelled/stale requests.
Measure title relevance, validation failures, cold/warm latency, memory and
energy, and count avoided auxiliary provider calls. Require no network-model
calls in local-only mode, no overwritten manual titles, no UI blocking and a
working fallback on unavailable/older systems. Do not report unexecuted cases as
passed. Repeat quality checks after OS model updates.

If this meets the product latency/quality bar, extend the same service to copy
drafts, then prepared-control selection. Benchmark those independently before
changing their default behavior. No provider calls, native GUI tests or model
benchmarks were run for this documentation-only exploration.
