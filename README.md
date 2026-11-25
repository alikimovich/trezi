# Trezi

Trezi is a Mac app for designing and prototyping in your own code. Open a repository and
Trezi runs its dev server in a live preview on the right. An AI chat on the left edits the
running app: the real code, not a sandbox. When you're done, Trezi hands the result off
as a branch and a GitHub pull request.

## See it in action

Click a clip to download its full-size MP4.

<table>
<tr>
<td width="50%" valign="top">
<a href="https://raw.githubusercontent.com/alikimovich/trezi/main/docs/media/visual-editing.mp4"><img src="docs/media/visual-editing.gif" alt="Selecting a headline in Trezi and changing its font size and colour in the Styles inspector"></a>
<br>
<b>Visual editing.</b> Select an element on the page and change its font size and colour.
</td>
<td width="50%" valign="top">
<a href="https://raw.githubusercontent.com/alikimovich/trezi/main/docs/media/inline-text-editing.mp4"><img src="docs/media/inline-text-editing.gif" alt="Double-clicking the headline on the page and retyping it from &quot;Make room for good ideas.&quot; to &quot;Make time to create&quot;"></a>
<br>
<b>Inline text editing.</b> Double-click a headline and retype it on the page.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://raw.githubusercontent.com/alikimovich/trezi/main/docs/media/spacing-handles.mp4"><img src="docs/media/spacing-handles.gif" alt="Dragging a card's padding handles on the page while the inspector updates"></a>
<br>
<b>Spacing handles.</b> Drag padding straight on the page; the inspector follows along.
</td>
<td width="50%" valign="top">
<a href="https://raw.githubusercontent.com/alikimovich/trezi/main/docs/media/3d-inspection.mp4"><img src="docs/media/3d-inspection.gif" alt="Selecting a card and opening the 3D view, which tilts the card and spreads its layers apart"></a>
<br>
<b>3D inspection.</b> Tilt a component and spread its layers apart to see how it is built.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://raw.githubusercontent.com/alikimovich/trezi/main/docs/media/visual-feedback.mp4"><img src="docs/media/visual-feedback.gif" alt="Drawing a red box around the headline with the markup tools, then clicking Add to chat"></a>
<br>
<b>Markup.</b> Draw on the page and send the marked-up snapshot to the chat.
</td>
<td width="50%" valign="top">
<a href="https://raw.githubusercontent.com/alikimovich/trezi/main/docs/media/canvas-to-code.mp4"><img src="docs/media/canvas-to-code.gif" alt="Selecting the headline on the page and opening index.html in the code editor below the preview"></a>
<br>
<b>Canvas to code.</b> Select an element and open its source in the code editor.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://raw.githubusercontent.com/alikimovich/trezi/main/docs/media/layer-selection.mp4"><img src="docs/media/layer-selection.gif" alt="Opening the Layers panel and selecting the card, the headline and the button from the tree, each highlighted on the page"></a>
<br>
<b>Layers.</b> Pick elements from the layer tree; the page highlights each one.
</td>
<td width="50%" valign="top">
<a href="https://raw.githubusercontent.com/alikimovich/trezi/main/docs/media/layout-and-mobile.mp4"><img src="docs/media/layout-and-mobile.gif" alt="Turning on a 12-column layout grid over the page, then switching the preview to a phone-sized frame"></a>
<br>
<b>Layout grid and phone preview.</b> Lay a column grid over the page, then check it at phone size.
</td>
</tr>
</table>

## Install

Open a coding agent that can run commands on your Mac (Claude Code, Codex or similar)
and paste this prompt:

```text
Install Trezi on this Mac. Follow https://raw.githubusercontent.com/alikimovich/trezi/main/docs/INSTALL.md
step by step: inspect what is already installed, run the official installer, verify the
result, and tell me when I need to approve something on screen or sign in. Keep my
existing projects, settings and uncommitted changes. Don't use sudo, and never print
tokens or passwords.
```

1. **Open** your coding agent.
2. **Paste** the prompt.
3. **Approve** what macOS asks for (installing the command-line tools, Keychain access)
   and sign in to your AI provider when the agent says so.
4. **Open a project** in Trezi.

Trezi is built from source on your Mac; there is no signed download. You need macOS 13.3
or later to run it. To build it you need the Xcode command-line tools with the macOS 26
SDK. You also need your own AI provider account (Claude, Codex, Gemini or an API key).
The installer adds Bun if it's missing.

**Install by hand** in Terminal instead:

```sh
curl -fsSL https://raw.githubusercontent.com/alikimovich/trezi/main/install.sh | bash
```

Options, updates, signing and troubleshooting: [docs/INSTALL.md](docs/INSTALL.md).

## First steps

1. In Trezi, click **Open project…** and pick a repository with a `dev` or `start`
   script. Trezi starts its dev server for you, so don't run it yourself.
2. Ask the chat for a change and watch the preview update.
3. Click **Select** to pick an element on the page, then chat about it or edit its
   props and styles directly.
4. When it looks right, **Publish** a branch and pull request.

Later, start Trezi from Applications or with `trezi` (`trezi .` opens the current
folder). `trezi --update` updates it.

## More

- [What Trezi does](docs/FEATURES.md)
- [AI providers](docs/PROVIDERS.md)
- [Changelog](CHANGELOG.md)
- Working on Trezi itself: [AGENTS.md](AGENTS.md) and [native architecture](docs/NATIVE.md)
