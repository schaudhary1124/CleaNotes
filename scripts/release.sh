#!/usr/bin/env bash
# Cuts a new CleaNotes release end to end:
#   bump version -> commit -> push main -> tag -> wait for the 3-platform
#   build in GitHub Actions -> publish the release.
#
# Usage: scripts/release.sh [version]
#   version is optional (e.g. 0.3.0 or v0.3.0); you'll be prompted if omitted.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PACKAGE_LOCK="package-lock.json"
TAURI_CONF="src-tauri/tauri.conf.json"
CARGO_TOML="src-tauri/Cargo.toml"
CARGO_LOCK="src-tauri/Cargo.lock"
REPO="schaudhary1124/CleaNotes"

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# --- prerequisites ----------------------------------------------------
for bin in git node npm cargo jq gh perl; do
  command -v "$bin" >/dev/null 2>&1 || fail "'$bin' is required but not installed."
done
gh auth status >/dev/null 2>&1 || fail "gh isn't authenticated. Run 'gh auth login' first."

# --- repo state checks --------------------------------------------------
[ -z "$(git status --porcelain)" ] || fail "Working tree isn't clean. Commit or stash your changes first."

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$CURRENT_BRANCH" = "main" ] || fail "You're on '$CURRENT_BRANCH', not 'main'. Switch to main first."

info "Fetching origin/main..."
git fetch origin main
BEHIND="$(git rev-list --count HEAD..origin/main)"
[ "$BEHIND" -eq 0 ] || fail "main is $BEHIND commit(s) behind origin/main. Pull/rebase first."

# --- pick the version ----------------------------------------------------
CURRENT_VERSION="$(jq -r .version "$TAURI_CONF")"
info "Current released version: v$CURRENT_VERSION"

NEW_VERSION="${1:-}"
if [ -z "$NEW_VERSION" ]; then
  read -rp "New version (e.g. 0.3.0): " NEW_VERSION
fi
NEW_VERSION="${NEW_VERSION#v}"

[[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "'$NEW_VERSION' isn't a plain semver like 1.2.3."

TAG="v$NEW_VERSION"
TAG_USED=false
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1 && TAG_USED=true
git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1 && TAG_USED=true

if [ "$TAG_USED" = true ]; then
  fail "Version $TAG is already in use. Pick a new version - reusing one won't reach
anyone whose app already updated to it (the updater only offers an update when the
version string increases). If $TAG was never actually published to users, remove it
manually first, then re-run: git push --delete origin $TAG && git tag -d $TAG
(and 'gh release delete $TAG --cleanup-tag' if a release was created for it)."
fi

# --- bump version files ---------------------------------------------------
info "Bumping version to $NEW_VERSION in package.json, tauri.conf.json, Cargo.toml..."
npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version >/dev/null
perl -pi -e 's/"version": "[0-9]+\.[0-9]+\.[0-9]+"/"version": "'"$NEW_VERSION"'"/' "$TAURI_CONF"
perl -pi -e 's/^version = "[0-9]+\.[0-9]+\.[0-9]+"/version = "'"$NEW_VERSION"'"/' "$CARGO_TOML"

info "Syncing Cargo.lock..."
cargo metadata --manifest-path "$CARGO_TOML" --format-version 1 >/dev/null

echo
git diff --stat -- package.json "$PACKAGE_LOCK" "$TAURI_CONF" "$CARGO_TOML" "$CARGO_LOCK"
echo
read -rp "Commit, push main, tag $TAG, and publish once the build succeeds? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  git checkout -- package.json "$PACKAGE_LOCK" "$TAURI_CONF" "$CARGO_TOML" "$CARGO_LOCK"
  fail "Aborted. Version bump reverted."
fi

# --- commit, push, tag -----------------------------------------------------
git add package.json "$PACKAGE_LOCK" "$TAURI_CONF" "$CARGO_TOML" "$CARGO_LOCK"
if git diff --cached --quiet; then
  info "Version files already at $NEW_VERSION - nothing to commit (retrying a previous build?)."
else
  git commit -m "chore(release): bump version to $NEW_VERSION"
fi

info "Pushing main..."
git push origin main

# Captured before the push so a run that GitHub timestamps slightly earlier than our
# local clock (network latency) is never mistakenly filtered out below.
TAG_PUSH_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git tag -a "$TAG" -m "CleaNotes $TAG"
info "Pushing tag $TAG (this triggers the build)..."
git push origin "$TAG"

# --- find and watch the triggered workflow run ------------------------------
# A retagged/retried version reuses the same tag name, so old runs for it stick around
# in the history - filter to runs created at or after this push, and take the newest
# match (highest databaseId), so a stale completed run is never picked up by mistake.
info "Waiting for GitHub Actions to register the build..."
RUN_ID=""
for _ in $(seq 1 20); do
  RUN_ID="$(gh run list --repo "$REPO" --workflow=release.yml \
    --json databaseId,headBranch,event,createdAt -q \
    ".[] | select(.headBranch == \"$TAG\" and .event == \"push\" and .createdAt >= \"$TAG_PUSH_TIME\") | .databaseId" \
    | sort -rn | head -n1)"
  [ -n "$RUN_ID" ] && break
  sleep 3
done
[ -n "$RUN_ID" ] || fail "Couldn't find the triggered run. Check https://github.com/$REPO/actions"

info "Build running: https://github.com/$REPO/actions/runs/$RUN_ID"
info "Watching macOS + Linux + Windows builds (they run one at a time, this can take 15-20 min)..."
if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  fail "Build failed - release was NOT published. Logs: https://github.com/$REPO/actions/runs/$RUN_ID
To retry the same version after fixing the issue:
  git push --delete origin $TAG && git tag -d $TAG"
fi

# --- publish -----------------------------------------------------------------
info "Build succeeded. Publishing $TAG..."
gh release edit "$TAG" --repo "$REPO" --draft=false

echo
info "Done. $TAG is live:"
echo "  Release:  https://github.com/$REPO/releases/tag/$TAG"
echo "  Download: https://schaudhary1124.github.io/CleaNotes/"
echo "Installed apps pick this up automatically (checked on launch and every 4h)."
