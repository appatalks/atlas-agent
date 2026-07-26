#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tools/load-env.sh"
load_env_file "$ROOT_DIR"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}/voice-bridge-supervisor"
LOG_DIR="${VOICE_BRIDGE_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/voice-bridge}"
PID_DIR="$RUNTIME_DIR/pids"
OS="$(uname -s)"
SUPERVISOR_PID_FILE="$RUNTIME_DIR/supervisor.pid"

mkdir -p "$LOG_DIR"

is_running() {
  [[ -f "$1" ]] && kill -0 "$(<"$1")" >/dev/null 2>&1
}

stop_tree() {
  local pid="$1"
  local child
  while IFS= read -r child; do
    [[ -n "$child" ]] && stop_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill -TERM "$pid" >/dev/null 2>&1 || true
  local attempts=0
  while kill -0 "$pid" >/dev/null 2>&1 && (( attempts < 20 )); do
    read -r -t 0.1 _ || true
    (( attempts += 1 ))
  done
  kill -KILL "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  trap - EXIT INT TERM HUP
  if [[ -d "$PID_DIR" ]]; then
    for file in "$PID_DIR"/*.pid; do
      [[ -f "$file" ]] || continue
      stop_tree "$(<"$file")"
    done
  fi
  if [[ "$OS" == "Linux" ]]; then
    bash "$ROOT_DIR/tools/audio-bridge.sh" stop >/dev/null 2>&1 || true
  fi
  rm -rf "$RUNTIME_DIR"
}

launch() {
  local name="$1"
  shift
    if [[ "$OS" == "Linux" ]]; then
      setsid "$@" >>"$LOG_DIR/$name.log" 2>&1 &
    else
      "$@" >>"$LOG_DIR/$name.log" 2>&1 &
    fi
  printf '%s' "$!" > "$PID_DIR/$name.pid"
}

start() {
  if is_running "$SUPERVISOR_PID_FILE"; then
    echo "Voice Bridge is already running (PID $(<"$SUPERVISOR_PID_FILE"))."
    return
  fi
  rm -rf "$RUNTIME_DIR"
  mkdir -p "$PID_DIR"
  for log_name in api audio copilot desktop qwen transcription voice; do
    : > "$LOG_DIR/$log_name.log"
  done
  printf '%s' "$$" > "$SUPERVISOR_PID_FILE"
  trap cleanup EXIT INT TERM HUP

  if [[ "$OS" == "Linux" ]]; then
    bash "$ROOT_DIR/tools/audio-bridge.sh" stop >/dev/null 2>&1 || true
    bash "$ROOT_DIR/tools/audio-bridge.sh" start >>"$LOG_DIR/audio.log" 2>&1
  else
    [[ -n "${VOICE_BRIDGE_MAC_AGENT_DEVICE:-}" ]] || echo "macOS: configure BlackHole and set VOICE_BRIDGE_MAC_AGENT_DEVICE before live call output." >>"$LOG_DIR/audio.log"
  fi

  local python="$ROOT_DIR/vendor/voice_clone_module/.venv/bin/python"
  local voice_module_source="$ROOT_DIR/vendor/voice_clone_module/src"
  local tts_mode="${VOICE_BRIDGE_TTS_MODE:-}"
  if [[ -z "$tts_mode" || "$tts_mode" == "auto" ]]; then
    [[ -n "${VOICE_BRIDGE_REMOTE_TTS_URL:-}" ]] && tts_mode="remote" || tts_mode="local"
  fi
  local voice_url
  local voice_reference="${VOICE_CLONE_REFERENCE:-$ROOT_DIR/assets/voices/appatalks-voice.wav}"
  local eva_reference="${EVA_VOICE_REFERENCE:-$ROOT_DIR/assets/voices/eva-voice.wav}"
  local greeting_seed="$ROOT_DIR/assets/prewarmed/appatalks-standard-greeting.wav"
  local greeting_seed_reference_sha256="92ad8aa65c4237a1999a65ab775731088af46831fc94e6944ec92b1887c93fbf"
  local standard_greeting="Hi, I am AppaTalks, your AI support agent. I can help with support questions and next steps. If you would like a live representative, say Live Representative Please and I will notify one. How can I help today?"
  launch qwen env VOICE_BRIDGE_QWEN_MODEL="${VOICE_BRIDGE_QWEN_MODEL:-qwen3-8b}" VOICE_CLONE_DEVICE="${VOICE_CLONE_DEVICE:-auto}" "$python" "$ROOT_DIR/tools/qwen_bridge.py"
  case "$tts_mode" in
    local)
      voice_url="http://127.0.0.1:8090/"
      launch voice env PYTHONPATH="$voice_module_source${PYTHONPATH:+:$PYTHONPATH}" VOICE_BRIDGE_TTS_AUTH_TOKEN="${VOICE_BRIDGE_TTS_AUTH_TOKEN:-}" "$python" "$ROOT_DIR/tools/local_voice_bridge.py" --host 127.0.0.1 --port 8090 --reference "$voice_reference" --eva-reference "$eva_reference" --seed-audio "$greeting_seed" --seed-reference-sha256 "$greeting_seed_reference_sha256" --warm-text "$standard_greeting" --warm-exaggeration 0.65 --warm-cfg-weight 0.35
      ;;
    remote)
      voice_url="${VOICE_BRIDGE_REMOTE_TTS_URL:-}"
      [[ -n "$voice_url" ]] || { echo "VOICE_BRIDGE_REMOTE_TTS_URL is required when VOICE_BRIDGE_TTS_MODE=remote." >&2; return 1; }
      [[ -n "${VOICE_BRIDGE_TTS_AUTH_TOKEN:-}" ]] || { echo "VOICE_BRIDGE_TTS_AUTH_TOKEN is required when VOICE_BRIDGE_TTS_MODE=remote." >&2; return 1; }
      ;;
    *)
      echo "VOICE_BRIDGE_TTS_MODE must be local or remote." >&2
      return 1
      ;;
  esac

  if command -v copilot >/dev/null 2>&1; then
    launch copilot env \
      python3 "$ROOT_DIR/tools/stateless_acp_bridge.py" --bind 127.0.0.1 --port 8888 --cwd "$ROOT_DIR" --copilot-path "$ROOT_DIR/tools/copilot-no-memory.sh"
  else
    echo "Copilot ACP bridge is unavailable because the Copilot CLI is not installed or not on PATH." >>"$LOG_DIR/copilot.log"
  fi

  local audio_output="pipewire"
  [[ "$OS" == "Darwin" ]] && audio_output="coreaudio"
  launch api env \
    VOICE_BRIDGE_ENABLE_AUDIO_CONTROL="$([[ "$OS" == "Linux" ]] && echo true || echo false)" \
    VOICE_BRIDGE_PROVIDER=local-qwen \
    LOCAL_QWEN_URL=http://127.0.0.1:8001/ \
    COPILOT_ACP_URL=http://127.0.0.1:8888/ \
    LOCAL_VOICE_BRIDGE_URL="$voice_url" \
    VOICE_BRIDGE_TTS_AUTH_TOKEN="${VOICE_BRIDGE_TTS_AUTH_TOKEN:-}" \
    VOICE_BRIDGE_VOICE_PROFILE=AppaTalks \
    VOICE_BRIDGE_TRANSCRIPTION_MODEL="whisper.cpp base.en" \
    VOICE_BRIDGE_AUDIO_OUTPUT="$audio_output" \
    VOICE_BRIDGE_AGENT_SINK=voice_bridge_agent \
    VOICE_BRIDGE_MAC_AGENT_DEVICE="${VOICE_BRIDGE_MAC_AGENT_DEVICE:-}" \
    node --import tsx "$ROOT_DIR/src/index.ts"

  if [[ "$OS" == "Linux" ]]; then
    launch transcription env \
      WHISPER_BIN="$ROOT_DIR/vendor/whisper.cpp/build/bin/whisper-cli" \
      WHISPER_MODEL="$ROOT_DIR/vendor/whisper.cpp/models/ggml-base.en.bin" \
      VOICE_BRIDGE_API_URL=http://127.0.0.1:4173 \
      bash "$ROOT_DIR/tools/transcribe-stream.sh"
    bash "$ROOT_DIR/tools/route-client-audio.sh" wire agent >/dev/null 2>&1 || true
  fi

    if [[ "$OS" == "Linux" ]]; then
      setsid "$ROOT_DIR/node_modules/electron/dist/electron" "$ROOT_DIR" >>"$LOG_DIR/desktop.log" 2>&1 &
    else
      "$ROOT_DIR/node_modules/electron/dist/electron" "$ROOT_DIR" >>"$LOG_DIR/desktop.log" 2>&1 &
    fi
  local desktop_pid="$!"
  printf '%s' "$desktop_pid" > "$PID_DIR/desktop.pid"
  wait "$desktop_pid" || true
  cleanup
}

stop() {
  if is_running "$SUPERVISOR_PID_FILE"; then
    local supervisor_pid="$(<"$SUPERVISOR_PID_FILE")"
    kill -TERM "$supervisor_pid" >/dev/null 2>&1 || true
    local attempts=0
    while kill -0 "$supervisor_pid" >/dev/null 2>&1 && (( attempts < 30 )); do
      read -r -t 0.1 _ || true
      (( attempts += 1 ))
    done
    if kill -0 "$supervisor_pid" >/dev/null 2>&1; then
      kill -KILL "$supervisor_pid" >/dev/null 2>&1 || true
      cleanup
    fi
    echo "Voice Bridge shutdown requested."
  else
    cleanup
    echo "Voice Bridge was not running; stale state was cleaned."
  fi
}

status() {
  if is_running "$SUPERVISOR_PID_FILE"; then
    echo "running (supervisor PID $(<"$SUPERVISOR_PID_FILE"))"
    for file in "$PID_DIR"/*.pid; do [[ -f "$file" ]] && printf '%s: %s\n' "$(basename "$file" .pid)" "$(<"$file")"; done
  else
    echo "stopped"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "Usage: tools/voice-bridge.sh [start|stop|restart|status]" >&2; exit 2 ;;
esac