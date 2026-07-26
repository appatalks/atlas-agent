#!/usr/bin/env bash
set -euo pipefail

# Public curl bootstrap for ATLAS. It creates a durable local checkout, then
# delegates dependency setup to the versioned installer in that checkout.
REPOSITORY="https://github.com/appatalks/atlas-live-agentic-support.git"
INSTALL_DIR="${ATLAS_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/atlas-live-agentic-support}"
LEGACY_INSTALL_DIR="${ATSLA_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/atsla-support-live-agent}"

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://raw.githubusercontent.com/appatalks/atlas-live-agentic-support/main/get-atlas.sh | bash

Environment options:
  ATLAS_INSTALL_DIR  Install or update ATLAS in this directory.
EOF
}

for argument in "$@"; do
  case "$argument" in
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "ATLAS needs git. Install git, then retry." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ATLAS needs curl. Install curl, then retry." >&2; exit 1; }

if [[ ! -e "$INSTALL_DIR" && -d "$LEGACY_INSTALL_DIR/.git" ]]; then
  echo "Migrating ATSLA installation to ATLAS: $INSTALL_DIR"
  mv "$LEGACY_INSTALL_DIR" "$INSTALL_DIR"
  git -C "$INSTALL_DIR" remote set-url origin "$REPOSITORY"
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating ATLAS in $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e "$INSTALL_DIR" ]]; then
  echo "Install directory exists but is not an ATLAS checkout: $INSTALL_DIR" >&2
  exit 1
else
  echo "Cloning ATLAS into $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPOSITORY" "$INSTALL_DIR"
fi

exec bash "$INSTALL_DIR/tools/install.sh"