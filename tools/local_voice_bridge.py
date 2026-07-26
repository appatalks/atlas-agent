#!/usr/bin/env python3
"""Loopback-only AppaTalks voice bridge with persistent greeting prewarming."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from typing import Any

MAX_INPUT_CHARS = 12_000


class VoiceService:
    def __init__(self, reference: Path, eva_reference: Path | None, cache_dir: Path, warm_texts: set[str], seed_audio: Path | None, seed_reference_sha256: str, auth_token: str = "") -> None:
        self.reference = reference
        self.references = {"appatalks": reference}
        if eva_reference:
            self.references["eva"] = eva_reference
        self.cache_dir = cache_dir
        self.warm_texts = warm_texts
        self.seed_audio = seed_audio
        self.seed_reference_sha256 = seed_reference_sha256
        self.auth_token = auth_token
        self.engines: dict[str, Any] = {}
        self.load_error: str | None = None
        self.lock = Lock()

    def health(self) -> dict[str, object]:
        try:
            from voice_clone_module import VoiceCloner  # noqa: F401
            backend_available = True
        except Exception as error:
            backend_available = False
            self.load_error = str(error)
        reference_readable = self.reference.is_file()
        return {
            "ok": backend_available and reference_readable,
            "engine_loaded": bool(self.engines),
            "backend_available": backend_available,
            "reference_readable": reference_readable,
            "reference_path": str(self.reference),
            "voice_profiles": {profile: reference.is_file() for profile, reference in self.references.items()},
            "loaded_voice_profiles": sorted(self.engines),
            "load_error": self.load_error,
            "expression_controls": ["exaggeration", "cfg_weight"],
            "greeting_cache_entries": len(list(self.cache_dir.glob("*.wav"))),
        }

    def warm(self, text: str, exaggeration: float, cfg_weight: float) -> None:
        self.warm_texts.add(text)
        self.synthesize(text, exaggeration, cfg_weight)

    def synthesize(self, text: str, exaggeration: float, cfg_weight: float, profile_id: str = "appatalks") -> bytes:
        if not text.strip():
            raise ValueError("input must not be empty")
        if len(text) > MAX_INPUT_CHARS:
            raise ValueError(f"input must be {MAX_INPUT_CHARS} characters or fewer")
        reference = self.references.get(profile_id)
        if not reference:
            raise ValueError(f"unknown voice profile: {profile_id}")
        if not reference.is_file():
            raise RuntimeError(f"the configured {profile_id} voice reference is unavailable")
        with self.lock:
            cache_path = self.cache_path(text, exaggeration, cfg_weight, profile_id, reference) if text in self.warm_texts else None
            if cache_path and cache_path.is_file():
                return cache_path.read_bytes()
            if cache_path and self.seed_matches(reference, profile_id):
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                cache_path.write_bytes(self.seed_audio.read_bytes())
                return cache_path.read_bytes()
            engine = self.engines.get(profile_id)
            if engine is None:
                from voice_clone_module import VoiceCloner
                engine = VoiceCloner(
                    reference_audio=reference,
                    device=os.getenv("VOICE_CLONE_DEVICE", "auto"),
                    exaggeration=exaggeration,
                    cfg_weight=cfg_weight,
                )
                self.engines[profile_id] = engine
            with NamedTemporaryFile(suffix=".wav", delete=False) as output:
                output_path = Path(output.name)
            try:
                engine.save(text, output_path, exaggeration=exaggeration, cfg_weight=cfg_weight)
                audio = output_path.read_bytes()
                if cache_path:
                    self.cache_dir.mkdir(parents=True, exist_ok=True)
                    cache_path.write_bytes(audio)
                return audio
            finally:
                output_path.unlink(missing_ok=True)

    def cache_path(self, text: str, exaggeration: float, cfg_weight: float, profile_id: str, reference: Path) -> Path:
        reference_state = reference.stat()
        key = json.dumps({
            "text": text,
            "exaggeration": exaggeration,
            "cfg_weight": cfg_weight,
            "profile": profile_id,
            "reference": str(reference),
            "reference_size": reference_state.st_size,
            "reference_mtime_ns": reference_state.st_mtime_ns,
        }, sort_keys=True).encode()
        return self.cache_dir / f"{hashlib.sha256(key).hexdigest()}.wav"

    def seed_matches(self, reference: Path, profile_id: str) -> bool:
        if not (self.seed_audio and self.seed_audio.is_file() and profile_id == "appatalks" and self.seed_reference_sha256):
            return False
        with reference.open("rb") as stream:
            reference_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
        return bool(
            reference_sha256 == self.seed_reference_sha256
        )


class Handler(BaseHTTPRequestHandler):
    service: VoiceService

    def require_auth(self) -> bool:
        expected = self.service.auth_token
        if not expected:
            return True
        supplied = self.headers.get("Authorization", "")
        valid = hmac.compare_digest(supplied, f"Bearer {expected}")
        if not valid:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "authorization required"})
        return valid

    def send_json(self, status: HTTPStatus, body: dict[str, object]) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/health":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        if not self.require_auth():
            return
        health = self.service.health()
        self.send_json(HTTPStatus.OK if health["ok"] else HTTPStatus.SERVICE_UNAVAILABLE, health)

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/v1/speech":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        if not self.require_auth():
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            text = payload.get("input")
            if not isinstance(text, str):
                raise ValueError("request must contain string input")
            exaggeration = max(0.0, min(1.0, float(payload.get("exaggeration", 0.5))))
            cfg_weight = max(0.0, min(1.0, float(payload.get("cfg_weight", 0.5))))
            profile_id = payload.get("voice_profile", "appatalks")
            if not isinstance(profile_id, str):
                raise ValueError("voice_profile must be a string")
            audio = self.service.synthesize(text, exaggeration, cfg_weight, profile_id)
        except ValueError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        except Exception as error:
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--eva-reference", type=Path)
    parser.add_argument("--cache-dir", type=Path, default=Path.home() / ".cache" / "atlas" / "greetings")
    parser.add_argument("--seed-audio", type=Path)
    parser.add_argument("--seed-reference-sha256", default="")
    parser.add_argument("--warm-text", default="")
    parser.add_argument("--warm-exaggeration", type=float, default=0.65)
    parser.add_argument("--warm-cfg-weight", type=float, default=0.35)
    args = parser.parse_args()
    handler = type("VoiceHandler", (Handler,), {})
    handler.service = VoiceService(
        args.reference.expanduser().resolve(),
        args.eva_reference.expanduser().resolve() if args.eva_reference else None,
        args.cache_dir.expanduser().resolve(),
        set(),
        args.seed_audio.expanduser().resolve() if args.seed_audio else None,
        args.seed_reference_sha256,
        os.getenv("VOICE_BRIDGE_TTS_AUTH_TOKEN", "").strip(),
    )
    if args.warm_text:
        try:
            handler.service.warm(args.warm_text, args.warm_exaggeration, args.warm_cfg_weight)
            print("AppaTalks Standard Greeting cache ready", flush=True)
        except Exception as error:
            print(f"AppaTalks Standard Greeting cache unavailable: {error}", flush=True)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"AppaTalks TTS listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
