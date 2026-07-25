#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS="$(uname -s)"
VOICE_MODULE_DIR="${VOICE_CLONE_MODULE_PATH:-$ROOT_DIR/vendor/voice_clone_module}"
INSTALL_VOICE="${VOICE_BRIDGE_INSTALL_VOICE:-true}"
INSTALL_WHISPER="${VOICE_BRIDGE_INSTALL_WHISPER:-true}"
INSTALL_LAUNCHER="${VOICE_BRIDGE_INSTALL_LAUNCHER:-true}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    return 1
  }
}

install_macos_prerequisites() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required on macOS. Install it from https://brew.sh, then rerun tools/install.sh." >&2
    exit 1
  fi
  brew install node python@3.11 ffmpeg jq cmake
  if ! system_profiler SPAudioDataType 2>/dev/null | grep -qi 'BlackHole'; then
    cat <<'EOF'
Install BlackHole and create a Multi-Output Device in Audio MIDI Setup that includes your speakers and BlackHole. Configure your communication application to use the BlackHole device for Agent microphone turns.
EOF
  fi
}

check_linux_prerequisites() {
  for command in node npm python3 ffmpeg jq cmake pactl pw-cat; do
    if ! command -v "$command" >/dev/null 2>&1; then
      echo "Missing $command. Install Node.js 24+, Python 3.11+, FFmpeg, jq, CMake, and PipeWire/PulseAudio compatibility packages, then rerun." >&2
      exit 1
    fi
  done
}

check_node_runtime() {
  local node_major
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 24 )); then
    echo "ATSLA requires Node.js 24 or newer for its built-in SQLite knowledge store. Found: $(node --version)" >&2
    exit 1
  fi
  node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:"); const enabled = db.prepare("SELECT sqlite_compileoption_used(\"ENABLE_FTS5\") AS enabled").get().enabled; db.close(); if (!enabled) process.exit(1)' || {
    echo "This Node.js build does not provide the required node:sqlite FTS5 support." >&2
    exit 1
  }
}

setup_voice_module() {
  [[ "$INSTALL_VOICE" == "true" ]] || return 0
  [[ -f "$VOICE_MODULE_DIR/install.sh" ]] || { echo "voice_clone_module source is missing at $VOICE_MODULE_DIR." >&2; exit 1; }
  need uv || {
    echo "Install uv from https://docs.astral.sh/uv/, then rerun." >&2
    exit 1
  }
  bash "$VOICE_MODULE_DIR/install.sh"
}

install_electron_runtime() {
  local electron_dir="$ROOT_DIR/node_modules/electron"
  [[ -x "$electron_dir/dist/electron" ]] && return 0
  [[ -f "$electron_dir/install.js" ]] || {
    echo "Electron was not installed. Run npm install with development dependencies enabled, then rerun tools/install.sh." >&2
    exit 1
  }
  echo "Electron runtime is missing; downloading it now."
  node "$electron_dir/install.js"
  [[ -x "$electron_dir/dist/electron" ]] || {
    echo "Electron runtime download did not produce $electron_dir/dist/electron." >&2
    exit 1
  }
}

install_launcher() {
  [[ "$INSTALL_LAUNCHER" == "true" ]] || return
  local bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  local app_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  local launcher="$bin_dir/atsla"
  local quoted_root
  quoted_root="$(printf '%q' "$ROOT_DIR")"
  mkdir -p "$bin_dir"
  cat > "$launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR=$quoted_root
case "\${1:-start}" in
  start) exec npm --prefix "\$ROOT_DIR" run app:start ;;
  stop) exec npm --prefix "\$ROOT_DIR" run app:stop ;;
  status) exec npm --prefix "\$ROOT_DIR" run app:status ;;
  update)
    git -C "\$ROOT_DIR" pull --ff-only
    npm --prefix "\$ROOT_DIR" install
    echo "ATSLA updated. Run: atsla start"
    ;;
  path) printf '%s\\n' "\$ROOT_DIR" ;;
  help|--help|-h)
    cat <<'USAGE'
Usage: atsla [start|stop|status|update|path]
USAGE
    ;;
  *) echo "Unknown ATSLA command: \$1" >&2; exit 2 ;;
esac
EOF
  chmod +x "$launcher"
  if [[ "$OS" == "Linux" ]]; then
    mkdir -p "$app_dir"
    cat > "$app_dir/atsla-support-live-agent.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=ATSLA | Support Live Agent
Comment=Local operator-controlled AI support agent
Exec=$launcher start
Terminal=false
Categories=Utility;Network;
StartupNotify=true
EOF
  fi
  echo "Installed launcher: $launcher"
  [[ "$OS" == "Linux" ]] && echo "Installed desktop entry: $app_dir/atsla-support-live-agent.desktop"
}

main() {
  case "$OS" in
    Linux) check_linux_prerequisites ;;
    Darwin) install_macos_prerequisites ;;
    *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
  esac
  need node
  check_node_runtime
  need npm
  need git
  need curl
  cd "$ROOT_DIR"
  npm install --include=dev
  install_electron_runtime
  setup_voice_module
  if [[ "$INSTALL_WHISPER" == "true" ]]; then
    bash "$ROOT_DIR/tools/bootstrap-whisper.sh"
  fi
  install_launcher
  cat <<'EOF'
Installation complete.

Start: atsla
Status: atsla status
Stop: atsla stop

If atsla is not found, add ~/.local/bin to your PATH or run npm run app:start from this checkout.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: ./tools/install.sh [--skip-voice] [--skip-whisper] [--no-launcher]

Environment options:
  VOICE_CLONE_MODULE_PATH     Alternate voice_clone_module source directory.
  VOICE_BRIDGE_INSTALL_VOICE  Set false to skip voice module setup.
  VOICE_BRIDGE_INSTALL_WHISPER Set false to skip local Whisper bootstrap.
  VOICE_BRIDGE_INSTALL_LAUNCHER Set false to skip atsla launcher and desktop entry.
EOF
  exit 0
fi

for argument in "$@"; do
  case "$argument" in
    --skip-voice) INSTALL_VOICE=false ;;
    --skip-whisper) INSTALL_WHISPER=false ;;
    --no-launcher) INSTALL_LAUNCHER=false ;;
    *) echo "Unknown option: $argument (try --help)" >&2; exit 2 ;;
  esac
done

main "$@"
