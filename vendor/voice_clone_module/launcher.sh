#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ATLAS_ROOT="$(cd "${ROOT_DIR}/../.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"
REFERENCE_AUDIO="${1:-${VOICE_CLONE_REFERENCE:-}}"
REFERENCE_AUDIO="${REFERENCE_AUDIO:-${ATLAS_ROOT}/assets/voices/appatalks-voice.wav}"
HOST="${VOICE_DEMO_HOST:-127.0.0.1}"
PORT="${VOICE_DEMO_PORT:-8000}"
URL="http://${HOST}:${PORT}"

if [[ ! -x "${VENV_DIR}/bin/voice-demo" ]]; then
  echo "The environment is not installed. Run ./install.sh first." >&2
  exit 1
fi

if [[ -z "${REFERENCE_AUDIO}" || ! -f "${REFERENCE_AUDIO}" ]]; then
  echo "Default voice not found at ${ATLAS_ROOT}/assets/voices/appatalks-voice.wav." >&2
  echo "Usage: ./launcher.sh /absolute/path/to/reference.wav" >&2
  echo "Or set VOICE_CLONE_REFERENCE to an existing audio file." >&2
  exit 1
fi

export VOICE_CLONE_REFERENCE="${REFERENCE_AUDIO}"
export VOICE_CLONE_DEVICE="${VOICE_CLONE_DEVICE:-auto}"

source "${VENV_DIR}/bin/activate"
voice-demo &
SERVER_PID=$!
cleanup() {
  kill "${SERVER_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _attempt in {1..50}; do
  if curl --silent --fail "${URL}/api/health" >/dev/null 2>&1; then
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "${URL}" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then
      open "${URL}" >/dev/null 2>&1 &
    else
      echo "Open ${URL} in your browser."
    fi
    echo "Voice Clone Agent running at ${URL}"
    wait "${SERVER_PID}"
    exit $?
  fi
  printf '.'
  sleep 0.2
done

echo >&2
echo "The demo server did not become ready. Check the output above." >&2
exit 1