#!/usr/bin/env bash
# ==============================================================================
# One Launcher — Checkpoint Restore Utility
# Restores the repository to a saved checkpoint tag or branch while preserving
# any current state in a timestamped safety branch.
#
# Usage:
#   ./scripts/restore-checkpoint.sh [checkpoint-tag-or-branch]
#
# Default target: checkpoint-2026-10-20
# ==============================================================================

set -euo pipefail

TARGET_REF="${1:-checkpoint-2026-10-20}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "========================================================"
echo "  One Launcher — Checkpoint Restore"
echo "  Target Checkpoint: ${TARGET_REF}"
echo "========================================================"

# Verify target ref exists locally or fetch from origin
if ! git rev-parse --verify "${TARGET_REF}^{commit}" >/dev/null 2>&1; then
  echo "Fetching tags and branches from origin..."
  git fetch origin --tags --prune
fi

if ! git rev-parse --verify "${TARGET_REF}^{commit}" >/dev/null 2>&1; then
  echo "Error: Checkpoint '${TARGET_REF}' was not found locally or on origin."
  echo "Available checkpoints:"
  git tag -l "checkpoint-*"
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SAFETY_BRANCH="safety-before-restore-${TIMESTAMP}"

# Save current state onto a safety branch before resetting
echo "Creating safety backup branch of current state: ${SAFETY_BRANCH}..."
git branch "${SAFETY_BRANCH}" HEAD >/dev/null 2>&1 || true

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Stashing uncommitted local changes..."
  git stash push -u -m "Auto-stash before restoring to ${TARGET_REF} (${TIMESTAMP})"
fi

git checkout main
git reset --hard "${TARGET_REF}"

TARGET_SHA="$(git rev-parse --short HEAD)"
echo ""
echo "Successfully restored 'main' to ${TARGET_REF} (${TARGET_SHA})!"
echo "Previous HEAD was saved to branch: ${SAFETY_BRANCH}"
echo ""
echo "To rebuild and launch the macOS app from this checkpoint, run:"
echo "  npm run build:mac && open \"release/mac-arm64/One Launcher.app\""
