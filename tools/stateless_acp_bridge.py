#!/usr/bin/env python3
"""Stateless local OpenAI-compatible bridge for the GitHub Copilot CLI ACP mode."""

from __future__ import annotations

import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import threading
import time
from typing import Any

MAX_MESSAGES = 20
MAX_MESSAGE_CHARS = 60_000
REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh", "max"}


class AcpSession:
    def __init__(self, copilot_path: str, cwd: Path, model: str, reasoning_effort: str) -> None:
        self.copilot_path = copilot_path
        self.cwd = cwd
        self.model = model
        self.reasoning_effort = reasoning_effort
        self.process: subprocess.Popen[bytes] | None = None
        self.next_id = 0
        self.chunks: list[str] = []

    def complete(self, prompt: str) -> str:
        command = [self.copilot_path, "--acp", "--stdio"]
        if self.model and self.model != "auto":
            command.extend(["--model", self.model])
        if self.reasoning_effort:
            command.extend(["--reasoning-effort", self.reasoning_effort])
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.cwd,
        )
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        self.request("initialize", {
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": {"name": "atlas-live-agentic-support", "title": "ATLAS Live Agentic Support", "version": "1.0.0"},
        }, timeout=30)
        session = self.request("session/new", {"cwd": str(self.cwd), "mcpServers": []}, timeout=30)
        session_id = session.get("sessionId") if isinstance(session, dict) else None
        if not session_id:
            raise RuntimeError("Copilot did not create an isolated ACP session.")
        self.chunks = []
        self.request("session/prompt", {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": prompt}],
        }, timeout=120)
        text = "".join(self.chunks).strip()
        if not text:
            raise RuntimeError("Copilot returned no assistant text.")
        return text

    def close(self) -> None:
        if not self.process:
            return
        try:
            if self.process.stdin:
                self.process.stdin.close()
            self.process.terminate()
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()

    def request(self, method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]:
        if not self.process or not self.process.stdin or not self.process.stdout:
            raise RuntimeError("Copilot ACP process is unavailable.")
        self.next_id += 1
        request_id = self.next_id
        self.process.stdin.write((json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n").encode())
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("Copilot ACP process exited unexpectedly.")
            message = json.loads(line.decode("utf-8", errors="replace"))
            if message.get("method") == "session/update":
                update = message.get("params", {}).get("update", {})
                if update.get("sessionUpdate") == "agent_message_chunk":
                    content = update.get("content", {})
                    if content.get("type") == "text":
                        self.chunks.append(str(content.get("text", "")))
                continue
            if "id" in message and "method" in message:
                self.respond_to_server_request(message)
                continue
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RuntimeError(str(message["error"]))
            return message.get("result", {})
        raise TimeoutError(f"Copilot ACP {method} timed out.")

    def respond_to_server_request(self, message: dict[str, Any]) -> None:
        if not self.process or not self.process.stdin:
            return
        method = message.get("method", "")
        if method == "session/request_permission":
            result: dict[str, Any] = {"outcome": {"outcome": "denied"}}
        else:
            result = {"error": {"code": -32601, "message": "ATLAS's stateless bridge does not support tools."}}
        self.process.stdin.write((json.dumps({"jsonrpc": "2.0", "id": message["id"], **result}) + "\n").encode())
        self.process.stdin.flush()

    def _drain_stderr(self) -> None:
        if not self.process or not self.process.stderr:
            return
        for line in self.process.stderr:
            print(f"[Copilot] {line.decode('utf-8', errors='replace').rstrip()}", flush=True)


class BridgeService:
    def __init__(self, copilot_path: str, cwd: Path) -> None:
        self.copilot_path = copilot_path
        self.cwd = cwd
        self.lock = threading.Lock()

    def complete(self, payload: dict[str, Any]) -> dict[str, Any]:
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages or len(messages) > MAX_MESSAGES:
            raise ValueError("messages must contain between 1 and 20 entries")
        rendered: list[str] = []
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant"} or not isinstance(message.get("content"), str):
                raise ValueError("messages must contain role and string content")
            if not message["content"].strip() or len(message["content"]) > MAX_MESSAGE_CHARS:
                raise ValueError(f"message content must contain 1 to {MAX_MESSAGE_CHARS} characters")
            rendered.append(f"{message['role'].capitalize()}:\n{message['content']}")
        model = payload.get("acp_model") if isinstance(payload.get("acp_model"), str) else "auto"
        reasoning_effort = payload.get("acp_reasoning_effort") if isinstance(payload.get("acp_reasoning_effort"), str) else ""
        if reasoning_effort and reasoning_effort not in REASONING_EFFORTS:
            raise ValueError("acp_reasoning_effort is unsupported")
        session = AcpSession(self.copilot_path, self.cwd, model, reasoning_effort)
        try:
            with self.lock:
                text = session.complete("\n\n".join(rendered))
        finally:
            session.close()
        return {"choices": [{"message": {"role": "assistant", "content": text}}], "model": f"copilot-acp:{model}"}


class Handler(BaseHTTPRequestHandler):
    service: BridgeService

    def send_json(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/health":
            self.send_json(HTTPStatus.OK, {"ok": True, "stateless": True})
        elif self.path.rstrip("/") == "/v1/models":
            self.send_json(HTTPStatus.OK, {"models": ["auto", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "claude-sonnet-4.6", "gpt-4.1"]})
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/v1/chat/completions":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            self.send_json(HTTPStatus.OK, self.service.complete(payload))
        except ValueError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except Exception as error:
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8888)
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--copilot-path", default="copilot")
    args = parser.parse_args()
    handler = type("AtlasAcpHandler", (Handler,), {})
    handler.service = BridgeService(args.copilot_path, args.cwd.resolve())
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"ATLAS stateless Copilot ACP bridge listening on http://{args.bind}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
