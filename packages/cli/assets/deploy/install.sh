#!/usr/bin/env bash
# Idempotent codesema arm installer for an EXISTING Ubuntu/Debian server (the
# "bring your own compute" path; cloud-init.yaml.example is the equivalent
# for a fresh VM provisioned from scratch: see docs/deploy-vm-arm.md for
# both). Runner-style split, same shape as gitlab-runner's install +
# config.sh/svc.sh: this script only gets the OS ready (Node.js, gh, a
# container runtime) and codesema/claude-code onto PATH; the systemd --user
# unit itself is written by `codesema runner install-service`, never by this
# script, so there is exactly one place that knows the unit's shape.
#
# Safe to re-run: every step checks before it acts. Reads its configuration
# from the environment and falls back to an interactive prompt for whichever
# required variable is missing and stdin is a terminal:
#
#   CODESEMA_HUB_URL            hub to connect to (default: https://codesema.com)
#   CODESEMA_HUB_TOKEN          csk_<workspaceId>.<secret>, from `codesema link`,
#                               required in both modes below
#   REPO_URL                    HTTPS clone URL of the repo this arm works
#   GH_TOKEN                    GitHub token, "repo" scope
#   CLAUDE_CODE_OAUTH_TOKEN     from `claude setup-token`
#
# REPO_URL, GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are optional. Set all three
# and this runs in direct mode, exactly as below. Leave any of them unset and
# the script switches to autoconfig mode: it registers this machine with the
# hub through `codesema runner connect` (which prints a fingerprint), then
# blocks in `codesema runner await-secrets` until a human runs `codesema
# runner autoconfig` on their own workstation and delivers the three values
# over the sealed-secrets channel. A fresh VM can therefore boot with only
# CODESEMA_HUB_TOKEN set; see docs/deploy-vm-arm.md.
#
# Usage (direct mode):
#   REPO_URL=https://github.com/org/repo.git GH_TOKEN=... \
#   CLAUDE_CODE_OAUTH_TOKEN=... CODESEMA_HUB_TOKEN=csk_... \
#     bash install.sh
#
# Usage (autoconfig mode):
#   CODESEMA_HUB_TOKEN=csk_... bash install.sh
#
# Minting each value: docs/deploy-vm-arm.md.

set -euo pipefail

log() {
  echo "[codesema-install] $*"
}

fail() {
  echo "[codesema-install] $*" >&2
  exit 1
}

# OS package steps only: root if we already are, sudo otherwise. Never used
# for the npm install below — see the prefix check next to it — since
# blanket sudo there is a known way to install into root's npm prefix
# instead of a user-managed one (nvm/volta/fnm), silently leaving the
# freshly "installed" binary off the invoking user's PATH.
as_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 \
      || fail "not root and sudo not found: run this script as root, or install sudo first"
    sudo "$@"
  fi
}

# $1: var name, $2: prompt text, $3 (optional): "secret" to hide input.
# Leaves the variable untouched if already set, and never blocks a
# non-interactive run (piped install, CI, cloud-init): it silently does
# nothing when stdin is not a terminal, leaving require_var below to fail
# loud instead of this hanging on a read nobody can answer.
prompt_var() {
  local name="$1" text="$2" mode="${3:-}" value=""
  if [ -n "${!name:-}" ] || [ ! -t 0 ]; then
    return
  fi
  if [ "$mode" = "secret" ]; then
    read -r -s -p "$text: " value
    echo
  else
    read -r -p "$text: " value
  fi
  printf -v "$name" '%s' "$value"
}

require_var() {
  local name="$1"
  [ -n "${!name:-}" ] \
    || fail "$name is required (set it in the environment, or run this script from an interactive terminal)"
}

: "${CODESEMA_HUB_URL:=https://codesema.com}"

prompt_var CODESEMA_HUB_TOKEN "Hub token (csk_<workspaceId>.<secret>, from 'codesema link')" secret
prompt_var REPO_URL "Repository to clone (HTTPS URL)"
prompt_var GH_TOKEN "GitHub token (repo scope)" secret
prompt_var CLAUDE_CODE_OAUTH_TOKEN "Claude Code OAuth token (from 'claude setup-token')" secret

require_var CODESEMA_HUB_TOKEN

# --- REPO_URL/GH_TOKEN/CLAUDE_CODE_OAUTH_TOKEN all present: direct mode,
# unchanged from here on. Any one missing (the common case on a fresh VM's
# non-interactive boot, where prompt_var above had no terminal to ask on)
# switches to autoconfig mode instead, resolved further down once `runner
# connect` has this machine's identity registered with the hub.
if [ -n "${REPO_URL:-}" ] && [ -n "${GH_TOKEN:-}" ] && [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  direct_mode=1
  export GH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
else
  direct_mode=0
fi

log "starting at $(date -u +%FT%TZ)"

# --- Node.js >= 20 (nodesource, only if missing or too old).
node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]'
}

if [ "$(node_major)" -lt 20 ]; then
  log "installing Node.js 22 (nodesource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | as_root bash -
  as_root apt-get install -y nodejs
else
  log "node $(node -v) already >= 20, skipping"
fi

# --- GitHub CLI (official repo, only if missing).
if command -v gh >/dev/null 2>&1; then
  log "gh already present, skipping"
else
  log "installing gh (official apt repo)"
  as_root install -d -m 0755 /usr/share/keyrings
  # tee, not curl -o: this script is not guaranteed to run as root, unlike
  # cloud-init's own runcmd, so writing into /usr/share/keyrings needs the
  # same curl-as-yourself/write-as-root split apt.gpg installs always use.
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | as_root tee /usr/share/keyrings/githubcli-archive-keyring.gpg >/dev/null
  as_root chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | as_root tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  as_root apt-get update
  as_root apt-get install -y gh
fi

# --- A container runtime: docker OR rootless podman: only install podman
# (the default this project documents) when NEITHER is already present.
if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then
  log "container runtime already present ($(command -v docker || command -v podman)), skipping"
else
  log "installing rootless podman"
  as_root apt-get install -y podman uidmap slirp4netns
  if ! grep -q "^$(id -un):" /etc/subuid 2>/dev/null; then
    as_root usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$(id -un)"
    log "subuid/subgid ranges added for $(id -un): log out and back in (or 'loginctl terminate-user \$(whoami)') before the first container run"
  fi
fi

# --- Docker specifically needs a group membership rootless podman does not:
# a freshly added user cannot run it until they are in the docker group and
# have logged back in, and this script has no relogin to wait for, so a
# docker that cannot actually run fails loud here instead of at the first
# ticket's container run.
if command -v docker >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1; then
    fail "docker is installed but not usable by $(id -un): add this user to the docker group and log back in ('sudo usermod -aG docker $(id -un)', then relogin), or install rootless podman instead"
  fi
fi

# --- codesema + claude-code on PATH. Presence-gated, not version-gated: a
# locked-down service account (no sudo, by design — see
# cloud-init.yaml.example's `codesema` user) can reach this script with
# both already installed by root moments earlier, and must be able to
# finish the install without ever touching npm's root-owned prefix.
# A human re-running this by hand to pick up a new codesema release should
# just `npm install -g codesema@latest` themselves first; this script's job
# is "make sure it's here", not "keep it current".
if command -v codesema >/dev/null 2>&1 && command -v claude >/dev/null 2>&1; then
  log "codesema and claude already on PATH, skipping npm install"
else
  log "installing codesema and @anthropic-ai/claude-code (npm -g)"
  npm_prefix="$(npm config get prefix 2>/dev/null || echo /usr/local)"
  if [ -w "$npm_prefix" ]; then
    npm install -g codesema@latest @anthropic-ai/claude-code
  else
    as_root npm install -g codesema@latest @anthropic-ai/claude-code
  fi
  command -v codesema >/dev/null 2>&1 \
    || fail "codesema not on PATH after npm install -g — check npm's global bin dir is in PATH"
  command -v claude >/dev/null 2>&1 \
    || fail "claude not on PATH after npm install -g — check npm's global bin dir is in PATH"
fi

# --- Base config: written only if absent, so a re-run never clobbers a
# configuration already customized by hand (`codesema config`). Written
# FIRST: `codesema runner connect` below loads this same file and merges its
# own three keys into it, it does not overwrite what is already there.
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codesema"
config_file="$config_dir/config.json"
if [ -f "$config_file" ]; then
  log "$config_file already exists, leaving it alone"
else
  mkdir -p "$config_dir"
  cat > "$config_file" <<'JSON'
{
  "agent": "claude -p",
  "isolation": "container"
}
JSON
  chmod 0600 "$config_file"
fi

codesema runner connect --url "$CODESEMA_HUB_URL" --token "$CODESEMA_HUB_TOKEN"

# --- Runtime secrets for the systemd unit: only the two the DAEMON reads on
# every ticket (CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN). CODESEMA_HUB_TOKEN is
# install-time only: `runner connect` above already turned it into
# config.json's stored credentials, so it has no reason to also live here.
# REPO_URL is not written here either: direct mode already has it in the
# environment, and autoconfig mode resolves it below, from whichever of
# await-secrets or an existing clone actually knows it.
env_file="$config_dir/runner.env"

if [ "$direct_mode" = 1 ]; then
  umask 077
  cat > "$env_file" <<EOF
CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN
GH_TOKEN=$GH_TOKEN
EOF
  chmod 0600 "$env_file"
else
  # --- Autoconfig: this machine now has an identity and a fingerprint
  # (printed above by `runner connect`) but neither the repository nor the
  # two runtime secrets yet. A re-run that already has both secrets on disk
  # skips straight past the wait instead of blocking on the hub again.
  if [ -f "$env_file" ] && grep -q '^GH_TOKEN=.' "$env_file" && grep -q '^CLAUDE_CODE_OAUTH_TOKEN=.' "$env_file"; then
    log "$env_file already holds both runtime secrets, skipping await-secrets"
  else
    log "waiting for secrets: on your workstation, run 'codesema runner autoconfig' and compare its fingerprint against the one printed above"
    REPO_URL="$(codesema runner await-secrets --secrets-file "$env_file")"
  fi

  if [ -z "${REPO_URL:-}" ]; then
    # await-secrets was skipped or came back empty: REPO_URL itself is never
    # written to runner.env, but a machine that already has a clone still
    # has its remote, which is exactly the same URL.
    unit_path="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/codesema-runner.service"
    existing_repo_dir=""
    if [ -f "$unit_path" ]; then
      existing_repo_dir="$(sed -n 's/^WorkingDirectory=//p' "$unit_path" | head -n1)"
    fi
    if [ -n "$existing_repo_dir" ] && [ -d "$existing_repo_dir/.git" ]; then
      REPO_URL="$(git -C "$existing_repo_dir" remote get-url origin 2>/dev/null || true)"
    fi
  fi
  require_var REPO_URL

  set -a
  . "$env_file"
  set +a
fi

# --- Clone the repository. gh's own credential helper authenticates the
# clone from GH_TOKEN (exported above, one way or another by this point), so
# the token never lands in this repo's .git/config: only ~/.gitconfig gets a
# credential.helper line naming gh, which reads GH_TOKEN again at call time.
repo_name="$(basename "$REPO_URL" .git)"
repo_dir="$HOME/$repo_name"

gh auth setup-git

if [ -d "$repo_dir/.git" ]; then
  log "$repo_dir already cloned, skipping"
else
  log "cloning $REPO_URL into $repo_dir"
  git clone "$REPO_URL" "$repo_dir"
fi

( cd "$repo_dir" && codesema runner install-service --secrets-file "$env_file" )

log "done at $(date -u +%FT%TZ)"
log "check it with: systemctl --user status codesema-runner.service"
log "watch it with: journalctl --user -u codesema-runner.service -f"
