---
name: accessible-colors
description: Check and fix color contrast for accessibility using APCA (the perceptual model WCAG 3 is built around). Use whenever you pick, change, or review text or UI colors — hex codes, design tokens, Tailwind color classes, a button/label/background pairing — or the user asks whether a color combination is accessible, readable, or legible. Also use to derive an accessible variant of a brand/aesthetic color that still matches.
---

# Accessible colors in Trezi

Whenever you choose or change a text/UI color, verify it with the `check_contrast`
tool instead of eyeballing readability or relying on the old WCAG 2 `4.5:1` ratio.
It uses **APCA (Lc)** — the perceptual contrast model WCAG 3 is built around, which
accounts for the fact that readability depends on font **size and weight**, not just
the color pair.

## Using `check_contrast`

Pass the pair plus the text context:

- `foreground` + `background` — hex, `rgb()`, `hsl()`, or CSS color name.
- `fontSizePx` (default 16) and `fontWeight` (default 400) — **matter**: the same
  colors can pass for a bold heading and fail for 14px body text. Pass the real values.
- `wcag2: true` — also report the legacy WCAG 2 ratio (AA/AAA) when a project must
  still satisfy WCAG 2.
- `suggest` — `auto` (default: suggest a fixed foreground only when the pair fails),
  `foreground` / `background` (force a suggestion for that color), or `none`.

## Coming up with matching accessible colors

This is the important part: when a pair fails, the tool returns the **nearest
accessible color, preserving hue** (it only shifts lightness). So the user keeps
their palette's character and gets a readable version.

- Default flow: try the user's/your intended colors; if it fails, **use the suggested
  hex** rather than picking a random darker/lighter value.
- To keep a specific brand text color and adjust the surface instead, pass
  `suggest: "background"`.
- If the result says `best-effort` (no hue-preserving lightness fully passes at that
  size), the honest fixes are: increase font size/weight, or adjust the *other* color
  too — tell the user that, don't silently ship failing contrast.

## Guidance

- Check **both** normal text and any small/secondary text (captions, placeholders,
  disabled states) — those fail most often.
- For non-text UI (icons, borders, focus rings), contrast still matters; APCA reports
  `non-text-only` / `spot-text-only` verdicts for low-Lc pairs.
- Respect the design system: prefer adjusting to an existing token that passes over
  inventing a one-off hex, when the project has design tokens.
- APCA and WCAG 2 disagree sometimes (APCA is stricter about light-on-dark, more
  lenient elsewhere). If a project formally requires WCAG 2, check with `wcag2: true`
  and satisfy both.
