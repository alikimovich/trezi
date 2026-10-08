# Answer components in chat (`chat_ui`, LKM-208)

Agents can show a small native component inside their chat message and get a
structured answer back. The design follows OpenUI's generative-UI pattern without
its runtime:

- one catalog with schemas;
- model rules generated from that catalog;
- components that render while the turn streams;
- interaction state saved with the message and summarized on the next turn;
- forms whose values go back to the agent as data.

## Components

| Kind | What the user sees | What the agent gets |
| --- | --- | --- |
| `options` | 2–4 variant tiles, each with a title, a note, optional tags and a preview image (a skeleton until captured). Pick one and Apply, or "None of these" plus what to change. | A user turn such as `Picked option B: Stacked hero. Keep the headline short`. The next prompt starts with `"Hero direction" (chat_ui options ui-…): User picked option B: Stacked hero (id "stacked") … Apply this variant.` |
| `form` | Typed fields and one Submit button. Field types: choice (single or multiple), text, number (unit, min/max), slider, color (token swatches, typed value or picker) and toggle. Fields are required unless `required:false`. | A user turn listing `- Label: value` for each field. The next prompt carries `… the user submitted {json}.` |

`compare` and `changes` are out of scope for now.

## Tool

`chat_ui` is a Trezi tool for both Claude (in-process) and Codex (MCP bridge).

- `catalog` returns the components, when to use each, and their limits.
- `show {component}` validates the component, renders it at once (option images as
  skeletons) and returns its `id`.
- `update {id, component}` replaces the component with one of the same kind. Images
  of option ids that remain are kept.
- `update {id, option, capture}` captures the user's preview as that option's image:
  `true` for the visible page, `{selector}` for one element.

The call returns at once. The agent ends its turn, and the pick or the form values
arrive as the user's next message, the same way `ask_user` works.

Background agents get an error. They have no chat to answer in, so they pick the
reasonable default and name it.

## Validation

There is one source of truth: `bin/chat-ui-schema.mjs` (zod), used for:

- the Claude and Codex input schemas;
- Bun's checks in `src/main/chat-ui.ts`;
- the catalog;
- the rules (`src/main/chat-ui-rules.ts`).

A bad payload is rejected as a whole. The response has `code: invalid_component` and
one `path: message` per problem, for example `options: show 2–4 options`. The UI
never shows half a component.

Swift decodes the same shapes again in `src/native/ChatUiModel.swift` and applies
the same limits. A frame carrying an invalid component shows its problems in place
of the component and never fails the frame.

Answers are checked twice:

- Swift checks before Submit is enabled (`ChatUiFormState.problems`).
- Bun checks again (`chatUiAnswerProblems` in `src/shared/chat-ui.ts`).

A component accepts one answer.

## State and the next turn

- The component lives in the assistant message as a `ui` segment
  (`src/native/chat-state.ts`), and in the transcript as a status entry carrying
  `ui`. The conversation owner persists it with the chat, so a reopened chat shows
  it, answered or not.
- `chatUiContext` (`src/main/chat-ui.ts`) adds each answer's summary once, at the
  head of the next turn's prompt.
- Images are JPEG data URIs: 360 px wide, at most 120 KB
  (`src/main/chat-ui-capture.ts`). They are small because chat frames re-send a
  message whenever it changes. Swift caches the decoded images.

## Files

- `bin/chat-ui-schema.mjs`: catalog, schemas, tool shape and description.
- `src/shared/chat-ui.ts`: shared types, answer checks, answer text and summary.
- `src/main/chat-ui.ts`: the tool, the answer path, and the context for the next turn.
- `src/main/chat-ui-capture.ts`: option images from the preview.
- `src/main/chat-ui-rules.ts`: the rules section generated from the catalog.
- `src/native/ChatUiModel.swift` and `src/native/ChatUi.swift`: the native model and
  the SwiftUI views (light and dark, VoiceOver labels and the selected trait).

## Tests

- Unit `chat-ui`: validation, catalog, show/update with skeletons then images, the
  pick and submit through `NativeChatController` with a mocked provider, the
  summary in the next prompt, hydrate, and the generated rules.
- Unit `chat-ui-model`: Swift decode and path errors for bad payloads, plus form
  defaults, validation and answer encoding.
- Native smoke `chat-ui` (group `chat`, `src/native/smoke-chat-ui.ts`):
  - options appear mid-turn with skeletons, then preview images;
  - options and form are captured in light and dark (`chat-ui-*.png`);
  - the pick and submit reach a stubbed provider with their summaries.
