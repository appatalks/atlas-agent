#!/usr/bin/env bash
set -euo pipefail

SOURCE="${VOICE_BRIDGE_CONFERENCE_SOURCE:-voice_bridge_conference.monitor}"
API_URL="${VOICE_BRIDGE_API_URL:-http://127.0.0.1:4173}"
WHISPER_BIN="${WHISPER_BIN:-whisper-cli}"
WHISPER_MODEL="${WHISPER_MODEL:-}"
SEGMENT_SECONDS="${VOICE_BRIDGE_SEGMENT_SECONDS:-4}"
WORK_DIR="${XDG_RUNTIME_DIR:-/tmp}/voice-bridge-transcription"
SILENCE_DB="${VOICE_BRIDGE_SILENCE_DB:--45}"

usage() {
  cat <<'EOF'
Usage: tools/transcribe-stream.sh [--check|--dry-run]

Captures only the Conference Capture monitor source in short 16 kHz mono WAV segments, transcribes
each segment with whisper.cpp's whisper-cli, and combines consecutive speech segments into one
remote transcript event after a below-threshold segment marks the end of the speaker's turn.
Set WHISPER_MODEL to a local ggml model path. This is a low-latency scaffold, not speaker diarization.
EOF
}

check() {
  command -v ffmpeg >/dev/null || { echo "Missing ffmpeg." >&2; return 1; }
  command -v curl >/dev/null || { echo "Missing curl." >&2; return 1; }
  command -v jq >/dev/null || { echo "Missing jq." >&2; return 1; }
  command -v "$WHISPER_BIN" >/dev/null || { echo "Missing $WHISPER_BIN. Run tools/bootstrap-whisper.sh or set WHISPER_BIN." >&2; return 1; }
  [[ -n "$WHISPER_MODEL" && -f "$WHISPER_MODEL" ]] || { echo "WHISPER_MODEL must name an existing ggml Whisper model." >&2; return 1; }
  echo "Whisper capture prerequisites are available."
}

has_speech_level() {
  local chunk="$1"
  local max_volume
  max_volume="$(ffmpeg -hide_banner -i "$chunk" -af volumedetect -f null - 2>&1 | awk '/max_volume:/ { value=$(NF-1) } END { print value }')"
  [[ -n "$max_volume" && "$max_volume" != "-inf" ]] || return 1
  awk -v max_volume="$max_volume" -v threshold="$SILENCE_DB" 'BEGIN { exit !(max_volume >= threshold) }'
}

if [[ "${1:-}" == "--help" ]]; then usage; exit 0; fi
if [[ "${1:-}" == "--check" ]]; then check; exit $?; fi
if [[ "${1:-}" == "--dry-run" ]]; then
  printf 'ffmpeg -nostdin -f pulse -i %q -ar 16000 -ac 1 -f segment -segment_time %q ...\n' "$SOURCE" "$SEGMENT_SECONDS"
  printf '%q -m %q -f chunk.wav -nt\n' "$WHISPER_BIN" "$WHISPER_MODEL"
  printf 'curl POST %s/v1/transcripts with speaker=remote\n' "$API_URL"
  exit 0
fi
check
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
touch "$WORK_DIR/processed.txt"
pending_text=""

deliver_pending() {
  [[ -n "${pending_text// }" ]] || return 0
  local payload
  payload="$(printf '%s' "$pending_text" | jq -Rs '{speaker:"remote", text:.}')"
  curl --fail --silent --show-error -X POST "$API_URL/v1/transcripts" -H 'content-type: application/json' -d "$payload" >/dev/null || \
    echo "Could not deliver transcript to Voice Bridge." >&2
  pending_text=""
}

CAPTURE_PID=""
capture_generation=0
segment_list=""

start_capture() {
  ((capture_generation += 1))
  segment_list="$WORK_DIR/segments-$capture_generation.csv"
  ffmpeg -nostdin -hide_banner -loglevel error -f pulse -i "$SOURCE" -ar 16000 -ac 1 -f segment \
    -segment_time "$SEGMENT_SECONDS" -reset_timestamps 1 -segment_list "$segment_list" \
    -segment_list_type csv "$WORK_DIR/chunk-$capture_generation-%08d.wav" &
  CAPTURE_PID=$!
  echo "Capturing $SOURCE (generation $capture_generation, PID $CAPTURE_PID)."
}

process_segments() {
  if [[ -f "$segment_list" ]]; then
    while IFS=, read -r chunk _; do
      chunk="${chunk#\"}"
      chunk="${chunk%\"}"
      [[ "$chunk" = /* ]] || chunk="$WORK_DIR/$chunk"
      [[ -n "$chunk" && -f "$chunk" ]] || continue
      grep -qxF "$chunk" "$WORK_DIR/processed.txt" && continue
      if ! has_speech_level "$chunk"; then
        printf '%s\n' "$chunk" >> "$WORK_DIR/processed.txt"
        deliver_pending
        continue
      fi
      if ! text="$($WHISPER_BIN -m "$WHISPER_MODEL" -f "$chunk" -nt 2>/dev/null | sed '/^$/d' | tr '\n' ' ')"; then
        echo "Whisper failed for $chunk; continuing capture." >&2
        printf '%s\n' "$chunk" >> "$WORK_DIR/processed.txt"
        continue
      fi
      printf '%s\n' "$chunk" >> "$WORK_DIR/processed.txt"
      text="$(printf '%s' "$text" | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//')"
      [[ -n "$text" ]] || continue
      pending_text="${pending_text:+$pending_text }$text"
    done < "$segment_list"
  fi
}

trap 'deliver_pending; kill "${CAPTURE_PID:-}" >/dev/null 2>&1 || true' EXIT INT TERM

while true; do
  start_capture
  while kill -0 "$CAPTURE_PID" >/dev/null 2>&1; do
    process_segments
    read -r -t 0.25 _ || true
  done
  process_segments
  if wait "$CAPTURE_PID"; then capture_status=0; else capture_status=$?; fi
  deliver_pending
  echo "Conference capture exited with status $capture_status; restarting." >&2
  read -r -t 1 _ || true
done