#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tools/load-env.sh"
load_env_file "$ROOT_DIR"
PYTHON="${VOICE_CLONE_PYTHON:-$ROOT_DIR/vendor/voice_clone_module/.venv/bin/python}"
HOST="${VOICE_BRIDGE_TTS_HOST:-127.0.0.1}"
PORT="${VOICE_BRIDGE_TTS_PORT:-8090}"
TOKEN="${VOICE_BRIDGE_TTS_AUTH_TOKEN:-}"
REFERENCE="${VOICE_CLONE_REFERENCE:-$ROOT_DIR/assets/voices/appatalks-voice.wav}"
EVA_REFERENCE="${EVA_VOICE_REFERENCE:-$ROOT_DIR/assets/voices/eva-voice.wav}"
CACHE_DIR="${VOICE_BRIDGE_TTS_CACHE_DIR:-$HOME/.cache/atlas/greetings}"
SEED_AUDIO="${VOICE_BRIDGE_TTS_SEED_AUDIO:-$ROOT_DIR/assets/prewarmed/appatalks-standard-greeting.wav}"
SEED_REFERENCE_SHA256="92ad8a65c4237a1999a65ab775731088af46831fc94e6944ec92b1887c93fbf"
STANDARD_GREETING="Hi, I am AppaTalks, your AI support agent. I can help with support questions and next steps. If you would like a live representative, say Live Representative Please and I will notify one. How can I help today?"

[[ -x "$PYTHON" ]] || { echo "Voice clone Python runtime not found: $PYTHON" >&2; exit 1; }
[[ -n "$TOKEN" ]] || { echo "Set VOICE_BRIDGE_TTS_AUTH_TOKEN before starting the remote TTS server." >&2; exit 1; }
[[ -f "$REFERENCE" ]] || { echo "AppaTalks reference not found: $REFERENCE" >&2; exit 1; }
[[ -f "$EVA_REFERENCE" ]] || { echo "Eva reference not found: $EVA_REFERENCE" >&2; exit 1; }

exec "$PYTHON" "$ROOT_DIR/tools/local_voice_bridge.py" \
  --host "$HOST" \
  --port "$PORT" \
  --reference "$REFERENCE" \
  --eva-reference "$EVA_REFERENCE" \
  --cache-dir "$CACHE_DIR" \
  --seed-audio "$SEED_AUDIO" \
  --seed-reference-sha256 "$SEED_REFERENCE_SHA256" \
  --warm-text "$STANDARD_GREETING" \
  --warm-exaggeration 0.65 \
  --warm-cfg-weight 0.35