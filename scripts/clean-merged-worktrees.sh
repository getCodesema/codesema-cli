#!/usr/bin/env bash
#
# Remove the worktrees and local branches this repo no longer needs: those
# whose branch is already contained in the integration branch.
#
# Dry run by default — it prints what it would remove and changes nothing.
# Pass --yes to actually do it.
#
#   scripts/clean-merged-worktrees.sh            # show
#   scripts/clean-merged-worktrees.sh --yes      # do
#   scripts/clean-merged-worktrees.sh --yes main # against another base
#
# Three things are never touched, whatever the flags: the main worktree, the
# worktree you are standing in, and anything with uncommitted work. `git
# worktree remove` and `git branch -d` both refuse unsafe cases on their own —
# the checks here are so the script SAYS why it skipped, instead of failing.
set -euo pipefail

APPLY=false
[ "${1:-}" = "--yes" ] && { APPLY=true; shift; }
BASE="${1:-develop}"

git rev-parse --verify --quiet "$BASE" >/dev/null || {
  echo "unknown base branch: $BASE" >&2; exit 1
}

MAIN="$(git rev-parse --path-format=absolute --git-common-dir)"
MAIN="$(dirname "$MAIN")"
HERE="$(git rev-parse --show-toplevel)"

merged() { git branch --merged "$BASE" --format='%(refname:short)' | grep -qx "$1"; }

removed=0
kept=0
while read -r path branch; do
  short="${branch#refs/heads/}"
  case "$path" in
    "$MAIN"|"$HERE") echo "skip  $short — current or main worktree"; kept=$((kept+1)); continue ;;
  esac
  if [ ! -d "$path" ]; then
    # The directory is gone but the registration survives (a /tmp worktree the
    # OS cleared, a folder deleted by hand). `git worktree prune` at the end is
    # what actually drops it; the branch is ours to delete here.
    echo "stale $short — directory is gone, will be pruned"
    $APPLY && git branch -d "$short" >/dev/null 2>&1 || true
    removed=$((removed+1)); continue
  fi
  if [ -n "$(git -C "$path" status --porcelain)" ]; then
    echo "skip  $short — uncommitted work in $path"; kept=$((kept+1)); continue
  fi
  if ! merged "$short"; then
    echo "skip  $short — not contained in $BASE"; kept=$((kept+1)); continue
  fi
  if $APPLY; then
    git worktree remove "$path"
    git branch -d "$short" >/dev/null
    echo "gone  $short"
  else
    echo "would remove  $short  ($path)"
  fi
  removed=$((removed+1))
done < <(git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch /{print p" "$2}')

# Branches with no worktree of their own, already in the base.
while read -r short; do
  [ "$short" = "$BASE" ] && continue
  if $APPLY; then
    git branch -d "$short" >/dev/null && echo "gone  $short (branch only)"
  else
    echo "would remove  $short (branch only)"
  fi
  removed=$((removed+1))
done < <(git branch --merged "$BASE" --format='%(refname:short)' \
         | grep -vxF -f <(git worktree list --porcelain | awk '/^branch /{sub("refs/heads/","",$2); print $2}') || true)

$APPLY && git worktree prune
echo
echo "$( $APPLY && echo removed || echo removable ): $removed   kept: $kept"
