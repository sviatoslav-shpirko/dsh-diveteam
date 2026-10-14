#!/usr/bin/env python3
"""
Локальный HTTP-мост (n8n -> Hermes Agent) на порту 8765.
Позволяет воркфлоу n8n вызывать Hermes Agent через обычный узел HTTP Request:
  POST http://host.docker.internal:8765/run
  Body: {"prompt": "Проанализируй текст...", "timeout": 300}
"""
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERMES_BIN = os.path.expanduser("~/.local/bin/hermes")
RAM_CREDS_DIR = "/dev/shm/hermes-creds"
LISTEN_HOST = os.environ.get("HERMES_BRIDGE_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("HERMES_BRIDGE_PORT", "8765"))


def build_hermes_env() -> dict:
    env = os.environ.copy()
    env["PATH"] = (
        f"{os.path.expanduser('~/.hermes/tools/node-26.7.0-linux-arm64/bin')}:"
        f"{os.path.expanduser('~/.hermes/tools/npm-12.0.2-linux-arm64/bin')}:"
        f"{os.path.expanduser('~/.local/bin')}:"
        f"{os.path.expanduser('~/.hermes/bin')}:"
        f"{env.get('PATH', '')}"
    )
    env["OPENCODE_GO_BASE_URL"] = "https://opencode.ai/zen/go/v1"

    vertex_path = os.path.join(RAM_CREDS_DIR, "VERTEX_SA.json")
    if os.path.isfile(vertex_path) and os.path.getsize(vertex_path) > 0:
        env["VERTEX_CREDENTIALS_PATH"] = vertex_path
        env["GOOGLE_APPLICATION_CREDENTIALS"] = vertex_path

    gemini_path = os.path.join(RAM_CREDS_DIR, "GEMINI_API_KEY")
    if os.path.isfile(gemini_path) and os.path.getsize(gemini_path) > 0:
        with open(gemini_path, "r", encoding="utf-8") as f:
            key = f.read().strip()
        env["GEMINI_API_KEY"] = key
        env["GOOGLE_API_KEY"] = key

    opencode_path = os.path.join(RAM_CREDS_DIR, "OPENCODE_GO_API_KEY")
    if os.path.isfile(opencode_path) and os.path.getsize(opencode_path) > 0:
        with open(opencode_path, "r", encoding="utf-8") as f:
            key = f.read().strip()
        env["OPENCODE_GO_API_KEY"] = key
        env["OPENCODE_ZEN_API_KEY"] = key

    return env


class HermesBridgeHandler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "hermes_installed": os.path.exists(HERMES_BIN),
                    "ram_creds_present": os.listdir(RAM_CREDS_DIR) if os.path.isdir(RAM_CREDS_DIR) else [],
                },
            )
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/run":
            self._send_json(404, {"error": "Use POST /run"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._send_json(400, {"error": f"Invalid JSON: {e}"})
            return

        prompt = body.get("prompt") or body.get("query") or body.get("message")
        timeout = int(body.get("timeout", 300))
        cwd = body.get("cwd", os.path.expanduser("~/shared"))

        if not prompt:
            self._send_json(400, {"error": "Missing 'prompt' field in JSON body"})
            return

        env = build_hermes_env()
        cmd = [HERMES_BIN if os.path.exists(HERMES_BIN) else "hermes", "chat", "-q", prompt]
        try:
            proc = subprocess.run(
                cmd,
                cwd=cwd if os.path.isdir(cwd) else os.path.expanduser("~"),
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            self._send_json(
                200 if proc.returncode == 0 else 500,
                {
                    "ok": proc.returncode == 0,
                    "returncode": proc.returncode,
                    "output": proc.stdout.strip(),
                    "stderr": proc.stderr.strip(),
                },
            )
        except subprocess.TimeoutExpired:
            self._send_json(504, {"ok": False, "error": f"Timed out after {timeout}s"})
        except Exception as e:
            self._send_json(500, {"ok": False, "error": str(e)})


if __name__ == "__main__":
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), HermesBridgeHandler)
    print(f"Hermes HTTP Bridge listening on {LISTEN_HOST}:{LISTEN_PORT}")
    server.serve_forever()
