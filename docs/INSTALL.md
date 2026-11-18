# Installing Trezi

Trezi is a native Mac app built from source on your Mac. There is no signed download:
the installer clones this repository, builds `Trezi.app` and links it into Applications.
This page is the full setup reference. The first section is written for a coding agent
that has been asked to do the install; people can follow it too.

- [For coding agents](#for-coding-agents)
- [Requirements](#requirements)
- [Install by hand](#install-by-hand)
- [Start Trezi and first steps](#start-trezi-and-first-steps)
- [Sign in to an AI provider](#sign-in-to-an-ai-provider)
- [Updating](#updating)
- [Optional: agent-browser](#optional-agent-browser)
- [Code signing](#code-signing)
- [Troubleshooting](#troubleshooting)
- [Projects and data from earlier versions](#projects-and-data-from-earlier-versions)
- [Working on Trezi itself](#working-on-trezi-itself)

## For coding agents

You were asked to install Trezi on this Mac. Run the steps yourself, verify the result
and report back. Don't just describe the commands.

**Rules**

- Use only the installer and commands on this page. Don't install anything else, change
  another project's settings or package policy, or use a different source.
- Never use `sudo`. Never change Gatekeeper, trust settings or system preferences.
- Never print, ask for or store a token or password. Don't run `claude setup-token`:
  it prints a token into your transcript.
- Keep the owner's work: projects, Trezi's settings and history, and any uncommitted
  file in a Trezi checkout. Never run `git reset`, `checkout`, `stash`, `clean` or a
  delete in a Trezi checkout. Keep its branch (main or candidate) unless the owner asks
  to switch.
- Only the owner can approve macOS windows (installing the command-line tools,
  Keychain access) and sign in to an AI provider. When one is needed, stop. Tell them
  exactly what to click or run. Continue after they say it is done.

### 1. Inspect (read-only)

```sh
sw_vers -productVersion
xcode-select -p; xcrun --sdk macosx --show-sdk-version
command -v git; command -v bun && bun --version
command -v trezi && trezi --version
ls -ld ~/.local/bin/trezi /Applications/Trezi.app ~/Applications/Trezi.app 2>/dev/null
readlink ~/.local/bin/trezi
```

Some of these fail on a fresh Mac. That only means the tool is missing. Then decide:

- **macOS older than 13.3:** stop. Trezi does not run there.
- **No existing install** (no `~/.local/bin/trezi` link): use the
  [fresh install](#2-install-or-update) command.
- **An existing install:** `readlink ~/.local/bin/trezi` prints `<checkout>/bin/trezi`,
  so the checkout is the folder two levels up. Run
  `git -C <checkout> status --short` and `git -C <checkout> branch --show-current`.
  If anything other than `bun.lock` shows as changed, list those files to the owner and
  ask before you update. The installer keeps them, but a conflicting update stops.
- **`/Applications/Trezi.app` is a real folder, not a link:** the installer leaves it
  alone. Tell the owner, and use `trezi` to start the source build.

### 2. Install or update

Fresh install (main channel):

```sh
curl -fsSL https://raw.githubusercontent.com/alikimovich/trezi/main/install.sh | bash -s -- --non-interactive
```

Update an existing install in place, keeping its checkout and branch:

```sh
curl -fsSL https://raw.githubusercontent.com/alikimovich/trezi/main/install.sh | TREZI_HOME="<checkout>" bash -s -- --non-interactive
```

Add `--channel candidate` only if the owner asks for the tester channel. The first build
takes several minutes, so give the command a long timeout or run it in the background.
Don't stop it early. `--non-interactive` never reads the terminal or waits for macOS:

| Exit | Meaning | What to do |
| --- | --- | --- |
| `0` | Installed and built | Verify (step 3) |
| `3` | `Action needed:` the owner must approve something (the command-line tools window) | Relay the message, wait for the owner, run the same command again |
| other | A step failed | Report the failed step and the `Recent output` lines, plus the log path it prints. Don't edit Trezi's source or system settings to work around it |

The installer installs Bun (from bun.sh) and starts Apple's command-line tools installer
when they are missing. It skips the optional agent-browser and never signs in for you.

### 3. Verify

Check each boundary on its own. A printed "installed successfully" is not proof of a
working app.

1. **Build and command:** `~/.local/bin/trezi --version` prints
   `Trezi X.Y.Z (build N, <sha>)`. If `trezi` alone is not found, the installer printed
   a PATH line for the owner's shell profile. Pass it on.
2. **Links:** `readlink ~/.local/bin/trezi` is `<checkout>/bin/trezi`, and
   `readlink /Applications/Trezi.app` (or `~/Applications/Trezi.app` when
   `/Applications` is not writable) is `<checkout>/out/native/Trezi.app`.
3. **Signature:** `codesign --verify --strict <checkout>/out/native/Trezi.app` exits 0.
4. **Launch:** `open -a Trezi`, then `pgrep -x TreziHost` prints a process id. Ask the
   owner to confirm the Trezi window is showing. The first launch may show a Keychain
   prompt. They should choose **Always Allow** (see [Code signing](#code-signing)).
5. **Provider sign-in (state only):** run `claude auth status >/dev/null 2>&1; echo $?`
   and, if Codex is installed, `codex login status >/dev/null 2>&1; echo $?`. `0` means
   signed in. Report signed in or not. Don't show the output. Being signed out is a
   step for the owner, not a failed install.

### 4. Report

Tell the owner, briefly:

- the version line, the checkout path and its branch, and where Applications links;
- what is left for them: provider sign-in
  ([how](#sign-in-to-an-ai-provider)), the PATH line, optional agent-browser;
- the next step: in Trezi, click **Open project…** and pick a repository with a
  `dev` or `start` script.

Don't paste compiler warnings or the whole log. The log path is enough.

## Requirements

What the installer and the build actually check (`scripts/requirements.mjs`,
`package.json`):

| | Needed for | Requirement |
| --- | --- | --- |
| macOS | running | 13.3 or later. Liquid Glass needs macOS 26; older releases use native fallback materials |
| Xcode command-line tools with the **macOS 26 SDK** or later | building | The installer starts Apple's installer when the tools are missing. An older SDK stops the build: update the command-line tools or Xcode. The 26 SDK ships with Xcode 26 tools, which need a recent macOS to install |
| Bun 1.3.0 or later | building | Installed by the installer when missing. The built app carries its own Bun, so starting Trezi needs none |
| git | install and update | Comes with the command-line tools |
| An AI provider account | chatting | Your own Claude or Codex subscription, Gemini, or your own API key for an OpenAI-compatible endpoint. There is no shared key |

Node is not needed to build or run Trezi. Only Trezi's test runner uses it
(`package.json` engines, `.nvmrc`).

## Install by hand

One command, the same for users and for development:

```sh
curl -fsSL https://raw.githubusercontent.com/alikimovich/trezi/main/install.sh | bash
```

Testers install the `candidate` branch with the same command:

```sh
curl -fsSL https://raw.githubusercontent.com/alikimovich/trezi/main/install.sh | bash -s -- --channel candidate
```

The installer installs Bun (official installer) and the Xcode command-line tools when they
are missing. It clones Trezi to `~/.trezi` (override with `TREZI_HOME`). Then it installs,
builds, links **Trezi** into Applications and puts a `trezi` command on your `PATH`
(`~/.local/bin`). If the `claude` CLI is present but signed out, it offers to run
`claude setup-token`. Then it opens Trezi. The `trezi` command and Trezi.app point to
whichever checkout was installed last, and the installer says which. An existing
`Trezi.app` in Applications that is not a link is never replaced.

Run the same command again to update and rebuild.

| Option | Effect |
| --- | --- |
| `--channel main\|candidate` | Branch to install (also `TREZI_CHANNEL`). Default `main`; a re-run keeps the installed channel |
| `--update` | Inside a clone: `git pull --ff-only` first. A piped install always updates its checkout |
| `--no-open` | Don't open Trezi at the end |
| `--verbose` | Show the full dependency, build and signing output as it runs |
| `--non-interactive` | Never read the terminal or wait for macOS (also `TREZI_NONINTERACTIVE=1`). Every question is skipped. Missing command-line tools start Apple's installer and exit `3` with `Action needed:` instead of waiting |

By default, dependency and build steps show short phase progress. Each run saves the full
output, including compiler warnings and signing details, under `~/Library/Logs/Trezi/`.
The installer prints that path. On failure it shows the failed phase and recent output,
and exits with that step's status. Without a terminal (CI, `curl … | bash` from a script)
every question is skipped too.

Updating `~/.trezi` discards a changed `bun.lock` before pulling, because `bun install`
rewrites it every time. It keeps a copy beside the install log and prints its path. Any
other local change stays. If it conflicts with the update, `git pull --ff-only` stops
and nothing is installed.

## Start Trezi and first steps

```sh
trezi                # open Trezi (builds it first if needed)
trezi .              # open the current folder as a project
trezi ~/code/my-app  # open that folder as a project
```

Or open it like any app (Finder, the Dock, Spotlight, `open -a Trezi`). `trezi --help`
lists the options. `trezi --version` prints "Trezi X.Y.Z (build N, short sha)", the same
text as Settings › General and About Trezi. Changes are listed in `CHANGELOG.md`.

In the app, click **Open project…**, pick a repository with a `dev`/`start` script, and
chat on the left. Trezi **owns the dev server**. Quitting or pressing Ctrl-C stops its
managed process groups, and survivors are force-stopped after a short grace period.
Don't also run `dev` yourself for a project you open here, or you'll hit a port or lock
conflict. The error banner offers a custom-command retry for monorepos and unusual setups.
What Trezi can do is listed in [features](FEATURES.md).

## Sign in to an AI provider

Each user signs in with their own account. Nothing is shared.

- **Claude:** run `claude auth login` in Terminal. Or run `claude setup-token` and paste
  the token in **Settings → AI providers → Claude…**. Its **Check login** button shows
  what Trezi's Claude sees.
- **Codex:** `codex login`. **Gemini** is off until you turn it on in
  Settings → AI Providers.
- **Your own endpoint:** Settings → AI Providers connects any OpenAI-compatible
  `/responses` endpoint with your API key. The key is encrypted with the Keychain and
  never leaves Trezi's backend. See [providers](PROVIDERS.md).

## Updating

```sh
trezi --update            # git pull + bun install + rebuild
trezi --update --verbose  # the same, showing the full install and build output
```

`trezi --update` shows Git's pull summary, then one line each for installing dependencies
and building. Their full output goes to an `update-*.log` file under
`~/Library/Logs/Trezi/`, and its path is printed at the end. A changed lockfile is copied
there before it is discarded. If a step fails, the update stops with that step's exit
status. It names the step and shows its recent output and the log path. The native
Settings update workflow checks the remote and guards unsaved work, then pulls, installs,
rebuilds and restarts. There is no signed app or auto-download. Updates are always a git
pull of your checkout. Running the installer again works too.

## Optional: agent-browser

The installer recommends **agent-browser** for automated browser checks at different
screen sizes, and asks whether to install its global CLI and browser. It uses Bun, skips
the offer when the CLI is already on PATH, and defaults to **No**. Unattended and
`--non-interactive` installs skip it. A failed optional install does not stop the Trezi
install. To install it later:
`bun install --global agent-browser && agent-browser install`. Trezi's built-in agent
instructions use agent-browser for browser verification during UI changes. Provider
helpers put Trezi's managed wrapper on PATH, which pins an isolated headless Chromium
shell, profile and session. Agents must report missing browser support, or a preview
that cannot show edits.

## Code signing

Every build signs Trezi.app, its XPC service, its helpers and the bundled Bun (unless it
keeps Bun's own Developer ID signature) with one identity that stays the same across
rebuilds, so macOS keeps your Keychain and privacy approvals:

1. `TREZI_SIGN_IDENTITY`, when set: an identity's name or SHA-1, or `-` for ad hoc;
2. otherwise a valid **Apple Development** identity, when you have one;
3. otherwise **Trezi Local**, a self-signed code-signing identity the first build (or
   `install.sh`) creates once in your login keychain. Only codesign may use its private
   key, and it is not added to any trust settings.

When none can be used or created, or the identity cannot sign (a locked login keychain
over SSH, a denied key-access prompt), the build signs every piece ad hoc. It prints one
line starting `warning: signing Trezi ad hoc`, and macOS then asks again after every
rebuild. Check the designated requirement with `codesign -d -r- out/native/Trezi.app`.
With Trezi Local it is `identifier "<bundle ID>" and certificate leaf = H"…"`, the same
after every rebuild.

The master key that encrypts saved connection keys and the Claude token lives in the
Keychain item `dev.trezi.native.secrets`. Only `Trezi.app/Contents/Helpers/TreziSecrets`
reads it. That helper is built from one small file (`src/native/Secrets.swift`) whose
binary does not change between rebuilds, so an **Always Allow** survives them. With a
self-signed or ad hoc signature, the login keychain ties the approval to that exact
binary, so a change to that file or a new Swift compiler costs one more approval. An
Apple Development identity avoids even that. A key under the earlier name moves to the
new item once. The old item is deleted only after the new one is written.

**After updating to a version with stable signing, macOS asks once more** for the
Keychain (choose **Always Allow**). It may also ask again for privacy access Trezi had
before. Both stay approved after that.

Deleting the earlier item can ask once more as well. If you deny it, the old item stays
unused (`security delete-generic-password -s dev.praxis.native.secrets -a master-key`
removes it). The first Claude chat may also bring a macOS prompt about files on a network
volume, because Claude Code checks one as it starts. Trezi explains this once in that
chat. Allow it only if your project is on a network drive. Rebuild-loop results and
exact verification steps are in
[providers](PROVIDERS.md#keychain-and-network-volume-prompts-after-stable-signing-lkm-144).

## Troubleshooting

- **`Action needed: the Xcode command-line tools are missing`** (exit 3): click Install
  in the macOS window and wait for it to finish, then run the installer again.
- **SDK too old:** "Building Trezi requires the macOS 26 SDK": update the command-line
  tools in System Settings → General → Software Update, or install Xcode 26.
- **`git pull --ff-only failed`:** the checkout has commits or changes that conflict with
  the update. Nothing was installed. Commit or move your changes yourself, then run again.
- **`trezi: command not found`:** add `export PATH="$HOME/.local/bin:$PATH"` to your
  shell profile (the installer prints the exact line), or use `~/.local/bin/trezi`.
- **Claude chats say you are not logged in:** see
  [Sign in to an AI provider](#sign-in-to-an-ai-provider).
- **A build failed:** the error names the step and the log. `--verbose` shows everything
  as it runs. Trezi's runtime logs: `trezi logs` (also see [logs](agent-guide/logs.md)).

## Projects and data from earlier versions

Trezi had earlier names. Profiles, conversations, settings, environment variables,
installs and project setup files from those versions keep working. The compatibility
rules are listed in [legacy names](agent-guide/legacy-names.md). When you open a project
that still uses the earlier setup file names, Trezi renames them. It does this
automatically when the Git tree is clean. When the tree has uncommitted changes, it asks
first. It never commits.

## Working on Trezi itself

Run the installer inside your clone (`./install.sh` or `bun run setup`). It uses that
checkout as it is, with no clone, branch switch or pull unless you pass `--update`.
Then use `bun run dev` to build and launch from the checkout. Swift changes need a
rebuild and restart; there is no application HMR server. Commands, tests and
architecture: [AGENTS.md](../AGENTS.md), [verification](agent-guide/verification.md),
[testing](TESTING.md) and [native architecture](NATIVE.md).
