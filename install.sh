#!/usr/bin/env bash
# Trezi's one install command, the same for users and for development:
#
#   curl -fsSL https://raw.githubusercontent.com/alikimovich/trezi/main/install.sh | bash
#   curl -fsSL …/install.sh | bash -s -- --channel candidate   (testers)
#   ./install.sh   or   bun run setup                          (inside a checkout)
#
# Piped, it clones to ~/.trezi (TREZI_HOME) and updates that clone on every re-run.
# Run from a checkout, it uses that checkout as it is (no clone, branch switch or pull
# unless --update). Either way it installs missing Bun and command-line tools, installs,
# builds, links `trezi` and Trezi.app to the checkout and opens Trezi.
set -euo pipefail

REPO_URL="https://github.com/alikimovich/trezi.git"

usage() {
  cat <<'EOF'
Usage: install.sh [--channel main|candidate] [--update] [--no-open]

  --channel <name>  Branch to install: main (default) or candidate. Also TREZI_CHANNEL.
                    Ignored inside a checkout, which keeps its own branch.
  --update          Inside a checkout: pull it first (git pull --ff-only).
                    A piped install always updates ~/.trezi.
  --no-open         Do not open Trezi at the end.
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

# Asks on the terminal and stores the reply in $answer. stdin holds this script for
# curl ... | bash, so read /dev/tty; without one (CI/unattended) return 1, never hang.
ask() {
  answer=""
  if { exec 3<>/dev/tty; } 2>/dev/null; then
    printf "%s" "$1" >&3
    read -r answer <&3 || answer=""
    exec 3>&-
    return 0
  fi
  return 1
}

# The checkout this script lives in, if it was run from one (empty when piped).
own_checkout() {
  local script="${BASH_SOURCE[0]:-}" dir
  [ -n "$script" ] && [ -f "$script" ] || return 0
  dir=$(cd "$(dirname "$script")" && pwd -P)
  if [ -e "$dir/.git" ] && [ -f "$dir/bin/trezi" ] && [ -f "$dir/package.json" ]; then
    printf '%s\n' "$dir"
  fi
}

install_command_line_tools() {
  xcode-select -p >/dev/null 2>&1 && return 0
  echo "==> Installing the Xcode command-line tools"
  xcode-select --install >/dev/null 2>&1 ||
    die "could not start the command-line tools installer. Run 'xcode-select --install', then run this installer again."
  echo "A macOS window asks to install the command-line tools: click Install and wait until it"
  echo "finishes (this can take several minutes). This installer continues by itself afterwards;"
  echo "press Ctrl-C to stop waiting."
  until xcode-select -p >/dev/null 2>&1; do
    sleep 2
  done
  echo "Command-line tools installed."
}

install_bun() {
  command -v bun >/dev/null 2>&1 && return 0
  local bun_home="${BUN_INSTALL:-$HOME/.bun}"
  if [ ! -x "$bun_home/bin/bun" ]; then
    echo "==> Installing Bun with its official installer (https://bun.sh)"
    curl -fsSL https://bun.sh/install | bash ||
      die "Bun installation failed. Install it from https://bun.sh, then run this installer again."
  fi
  export BUN_INSTALL="$bun_home"
  export PATH="$bun_home/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "Bun is not runnable at $bun_home/bin/bun."
  echo "Using Bun at $bun_home/bin/bun"
}

# Clones the channel, or updates an existing clone (switching only when a channel was asked for).
update_user_install() {
  local home="$1" channel="$2"
  if [ ! -d "$home/.git" ]; then
    echo "==> Cloning Trezi (${channel:-main} channel) into $home"
    git clone --branch "${channel:-main}" "$REPO_URL" "$home"
    return 0
  fi
  echo "==> Updating existing install at $home"
  # bun install regenerates the lockfile; that drift must not block the pull.
  if ! git -C "$home" diff --quiet HEAD -- bun.lock 2>/dev/null; then
    echo "Discarding local bun.lock changes (regenerated on install)"
    git -C "$home" checkout -q HEAD -- bun.lock
  fi
  if [ -n "$channel" ] && [ "$(git -C "$home" branch --show-current)" != "$channel" ]; then
    echo "==> Switching to the $channel channel"
    git -C "$home" fetch -q origin
    if git -C "$home" show-ref --verify --quiet "refs/heads/$channel"; then
      git -C "$home" checkout -q "$channel"
    else
      git -C "$home" checkout -q -b "$channel" --track "origin/$channel"
    fi
  fi
  echo "Channel: $(git -C "$home" branch --show-current)"
  git -C "$home" pull --ff-only ||
    die "git pull --ff-only failed in $home. If you have local changes, commit or stash them and run this installer again."
}

main() {
  local channel="${TREZI_CHANNEL:-}" update=0 open_app=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --channel)
        [ $# -ge 2 ] || die "--channel needs main or candidate."
        channel="$2"
        shift 2 ;;
      --channel=*)
        channel="${1#--channel=}"
        shift ;;
      --update) update=1; shift ;;
      --no-open) open_app=0; shift ;;
      -h|--help) usage; return 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done
  case "$channel" in
    ""|main|candidate) ;;
    *) die "unknown channel '$channel' (use main or candidate)." ;;
  esac

  echo "==> Checking prerequisites"
  if [ "$(uname -s)" != "Darwin" ]; then
    die "Trezi requires macOS 13.3 or later."
  fi
  install_command_line_tools
  if ! xcrun --find swiftc >/dev/null 2>&1; then
    die "install Xcode command-line tools and the macOS 26 SDK first."
  fi
  if ! command -v git >/dev/null 2>&1; then
    die "git is required but was not found on PATH."
  fi
  install_bun
  local PM="bun"

  local checkout
  checkout=$(own_checkout)
  if [ -n "$checkout" ]; then
    TREZI_HOME="$checkout"
    echo "==> Using this checkout: $TREZI_HOME (branch $(git -C "$TREZI_HOME" branch --show-current))"
    if [ -n "$channel" ]; then
      echo "Channel '$channel' ignored: a checkout keeps its own branch."
    fi
    if [ "$update" = 1 ]; then
      echo "==> Updating this checkout"
      git -C "$TREZI_HOME" pull --ff-only ||
        die "git pull --ff-only failed in $TREZI_HOME. Commit or stash local changes and try again."
    fi
  else
    TREZI_HOME="${TREZI_HOME:-${PRAXIS_HOME:-$HOME/.trezi}}"
    # Keep an existing source installation in place for old launchers.
    if [ "$TREZI_HOME" = "$HOME/.trezi" ] && [ ! -e "$TREZI_HOME" ] && [ -d "$HOME/.praxis/.git" ]; then
      TREZI_HOME="$HOME/.praxis"
    fi
    update_user_install "$TREZI_HOME" "$channel"
  fi

  cd "$TREZI_HOME"
  echo "==> Checking macOS, SDK and Bun versions"
  bun scripts/requirements.mjs --build

  echo "==> Installing dependencies"
  "$PM" install

  # The build signs Trezi with one stable identity, creating the self-signed "Trezi Local"
  # identity in the login keychain once when there is no Apple Development one, so macOS
  # keeps Keychain and privacy approvals across rebuilds (README "Code signing").
  echo "==> Building Trezi"
  "$PM" run build

  echo "==> Linking the trezi command"
  local previous=""
  if [ -L "$HOME/.local/bin/trezi" ]; then
    previous=$(readlink "$HOME/.local/bin/trezi")
  fi
  mkdir -p "$HOME/.local/bin"
  chmod +x "$TREZI_HOME/bin/trezi"
  ln -sf "$TREZI_HOME/bin/trezi" "$HOME/.local/bin/trezi"
  # The pre-rename command alias is retired (LKM-132): remove it only when it is ours.
  if [ -L "$HOME/.local/bin/praxis" ] && [ "$(readlink "$HOME/.local/bin/praxis")" = "$TREZI_HOME/bin/trezi" ]; then
    rm "$HOME/.local/bin/praxis"
  fi

  # Trezi.app stays in the checkout (it runs the backend beside it); Applications gets a
  # link, so Finder, Spotlight and `open -a Trezi` find it. An existing app that is not
  # a link is never replaced.
  echo "==> Adding Trezi to Applications"
  local app="$TREZI_HOME/out/native/Trezi.app"
  local apps="${TREZI_APPLICATIONS:-/Applications}"
  if [ ! -w "$apps" ]; then
    apps="$HOME/Applications"
    mkdir -p "$apps"
  fi
  local app_linked=1
  if [ -L "$apps/Trezi.app" ] || [ ! -e "$apps/Trezi.app" ]; then
    ln -sfn "$app" "$apps/Trezi.app"
    echo "Linked $apps/Trezi.app"
  else
    app_linked=0
    echo "$apps/Trezi.app already exists and is not a link; left alone. Start Trezi with: trezi"
  fi
  local lsregister="${TREZI_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"
  if [ -x "$lsregister" ]; then
    "$lsregister" -f "$app" >/dev/null 2>&1 || true
  fi

  case ":${PATH}:" in
    *":$HOME/.local/bin:"*)
      ;;
    *)
      local rc_file="$HOME/.bashrc"
      case "${SHELL:-}" in
        */zsh)
          rc_file="$HOME/.zshrc"
          ;;
      esac
      echo "==> $HOME/.local/bin is not on your PATH"
      echo "    Add this line to $rc_file, then restart your shell:"
      echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac

  echo "==> Optional browser testing"
  if command -v agent-browser >/dev/null 2>&1; then
    echo "agent-browser is already installed."
  else
    echo "Recommended: agent-browser lets Trezi check pages at phone, tablet, and desktop sizes."
    echo "This installs the agent-browser CLI globally and downloads its browser."
    local browser_answer=""
    if ask "Install agent-browser now? [y/N] "; then
      browser_answer="$answer"
    fi
    case "$browser_answer" in
      y|Y|yes|Yes|YES)
        local browser_bin=""
        if "$PM" install --global agent-browser; then
          if command -v agent-browser >/dev/null 2>&1; then
            browser_bin="$(command -v agent-browser)"
          else
            # A fresh Bun global bin directory may not be on PATH yet.
            local browser_dir
            browser_dir="$(bun pm bin -g 2>/dev/null)" || browser_dir=""
            if [ -n "$browser_dir" ] && [ -x "$browser_dir/agent-browser" ]; then
              browser_bin="$browser_dir/agent-browser"
              echo "Add $browser_dir to your PATH so Trezi can find agent-browser."
            fi
          fi
          if [ -n "$browser_bin" ] && "$browser_bin" install; then
            echo "agent-browser and its browser are ready."
          else
            echo "Browser setup did not finish. Once agent-browser is on PATH, run: agent-browser install"
          fi
        else
          echo "Optional agent-browser installation failed; Trezi is still installed."
          echo "You can retry later: $PM install --global agent-browser && agent-browser install"
        fi
        ;;
      *)
        echo "Skipped. Install later with: $PM install --global agent-browser && agent-browser install"
        ;;
    esac
  fi

  # Claude Code authorization: offered only when the CLI can report that it is signed out.
  if command -v claude >/dev/null 2>&1; then
    local auth_help
    auth_help=$(claude auth --help </dev/null 2>/dev/null) || auth_help=""
    case "$auth_help" in
      *"Show authentication status"*)
        if ! claude auth status </dev/null >/dev/null 2>&1; then
          echo "==> Claude authorization"
          echo "Claude Code is not authorized yet."
          if ask "Run 'claude setup-token' now to authorize it with your subscription? [Y/n] "; then
            case "$answer" in
              n|N|no|No|NO)
                echo "Skipped. Authorize later with: claude setup-token" ;;
              *)
                claude setup-token </dev/tty || echo "claude setup-token did not finish. Run it again later: claude setup-token" ;;
            esac
          else
            echo "Skipped (no terminal). Authorize later with: claude setup-token"
          fi
        fi
        ;;
    esac
  fi

  echo "==> Trezi installed to $TREZI_HOME"
  if [ "$app_linked" = 1 ]; then
    echo "The trezi command and Trezi.app now point to this checkout: $TREZI_HOME"
  else
    echo "The trezi command now points to this checkout: $TREZI_HOME"
  fi
  if [ -n "$previous" ] && [ "$previous" != "$TREZI_HOME/bin/trezi" ]; then
    echo "(They pointed to $(dirname "$(dirname "$previous")") before; the last install wins.)"
  fi
  echo "Run:  trezi   (or open Trezi from Applications; trezi <folder> opens a project)"
  echo "(Run this installer again, or 'trezi --update', to update later.)"

  if [ "$open_app" = 1 ]; then
    echo "==> Opening Trezi"
    open -a "$app" || echo "Could not open Trezi; start it with: trezi"
  fi
}

# Everything runs from main, so a piped script is read completely before it starts.
main "$@"
