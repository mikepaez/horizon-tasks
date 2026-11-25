"""
server.py — Horizon Local HTTP Server & Atomic JSON Document Store (stdlib only)

Design:
  All task rules live in logic.js (single source of truth). This server is a
  compact, hardened localhost file store exposing GET/PUT /api/data with:
    - Atomic writes (unique temp file -> fsync -> os.replace with Windows retry)
    - Rolling .bak + one-time v1 backup on automatic v1->v2 migration
    - UTF-8 BOM tolerant reads; refuses overwrites on corrupt JSON (500)
    - Strict ETag / If-Match concurrency control (428 if missing, 409 on conflict)
    - Localhost security: Host allow-list, same-origin Origin check, JSON
      Content-Type check, per-launch CSRF token injected into index.html,
      strict CSP (no inline scripts, frame-ancestors 'none'), 2 MiB body cap.

Usage:
  py server.py [--port 4173] [--data-file "C:\\path\\to\\OneDrive\\tasks.json"] [--no-browser]
  Or set environment variable HORIZON_DATA to point to your synced tasks.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import secrets
import shutil
import tempfile
import threading
import time
import urllib.parse
import webbrowser
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "tasks.json"
STATIC_FILES = {"index.html", "styles.css", "logic.js", "app.js"}
SCHEMA_VERSION = 2
MAX_BODY_BYTES = 2 * 1024 * 1024  # 2 MiB safety cap
REPLACE_RETRIES = 5


class CorruptDataError(RuntimeError):
    """Raised when tasks.json cannot be parsed; blocks overwrites to prevent data loss."""


class ConflictError(RuntimeError):
    """Raised when PUT /api/data If-Match ETag does not match current disk state."""


class DiskBusyError(RuntimeError):
    """Raised when Windows/OneDrive locks prevent os.replace after retries."""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _reject_json_constant(val: str) -> None:
    raise ValueError(f"Invalid JSON constant: {val}")


def loads_strict(text: str) -> object:
    return json.loads(text, parse_constant=_reject_json_constant)


class TaskStore:
    """Thread-safe, atomic JSON document store with v1->v2 migration and backups."""

    def __init__(self, file_path: Path = DATA_FILE):
        self.file_path = Path(file_path)
        self._lock = threading.RLock()

    def _etag(self, raw_bytes: bytes) -> str:
        return f'"{hashlib.sha256(raw_bytes).hexdigest()[:16]}"'

    def _read_raw(self) -> tuple[dict, str, bool, bool]:
        """Returns (document, etag, was_v1, is_new). Raises CorruptDataError on bad files."""
        if not self.file_path.exists():
            empty_doc = {"schema": SCHEMA_VERSION, "savedAt": None, "savedBy": "server", "tasks": []}
            return empty_doc, self._etag(b"__horizon_new__"), False, True

        try:
            raw_bytes = self.file_path.read_bytes()
            parsed = loads_strict(raw_bytes.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as err:
            raise CorruptDataError(
                f"{self.file_path.name} is corrupted or unreadable ({err}). Refusing to overwrite."
            ) from err

        etag = self._etag(raw_bytes)
        if isinstance(parsed, list):
            tasks = [t for t in parsed if isinstance(t, dict)]
            return {"schema": SCHEMA_VERSION, "savedAt": None, "savedBy": "v1-migrated", "tasks": tasks}, etag, True, False

        if isinstance(parsed, dict) and isinstance(parsed.get("tasks"), list):
            tasks = [t for t in parsed["tasks"] if isinstance(t, dict)]
            doc = {
                "schema": SCHEMA_VERSION,
                "savedAt": parsed.get("savedAt"),
                "savedBy": parsed.get("savedBy") or "server",
                "tasks": tasks,
            }
            return doc, etag, int(parsed.get("schema") or 1) < SCHEMA_VERSION, False

        raise CorruptDataError(f"{self.file_path.name} does not contain a valid Horizon task document.")

    def _write_atomic(self, doc: dict, was_v1: bool = False) -> str:
        payload = (json.dumps(doc, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
        self.file_path.parent.mkdir(parents=True, exist_ok=True)

        if self.file_path.exists():
            if was_v1:
                v1_bak = self.file_path.with_name(
                    f"{self.file_path.stem}.v1-backup-{date.today().strftime('%Y%m%d')}.json"
                )
                if not v1_bak.exists():
                    shutil.copy2(self.file_path, v1_bak)
            try:
                shutil.copy2(self.file_path, self.file_path.with_suffix(self.file_path.suffix + ".bak"))
            except OSError:
                pass

        fd, tmp_name = tempfile.mkstemp(
            dir=str(self.file_path.parent),
            prefix=f".{self.file_path.name}.",
            suffix=".tmp",
        )
        tmp_path = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())

            last_err: OSError | None = None
            for attempt in range(REPLACE_RETRIES):
                try:
                    os.replace(tmp_path, self.file_path)
                    return self._etag(payload)
                except OSError as err:
                    last_err = err
                    time.sleep(0.05 * (attempt + 1))
            raise DiskBusyError(f"Could not replace {self.file_path.name} (file locked): {last_err}") from last_err
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

    def load_document(self) -> tuple[dict, str, bool]:
        with self._lock:
            doc, etag, _, is_new = self._read_raw()
            return doc, etag, is_new

    def save_document(self, incoming: object, expected_etag: str) -> tuple[dict, str]:
        if not expected_etag:
            raise ValueError("Missing If-Match header")
        with self._lock:
            _, current_etag, was_v1, _ = self._read_raw()
            if expected_etag != "*" and expected_etag != current_etag:
                raise ConflictError("File changed on disk since last read")

            if isinstance(incoming, list):
                raw_tasks = incoming
                saved_by = "client"
            elif isinstance(incoming, dict) and isinstance(incoming.get("tasks"), list):
                raw_tasks = incoming["tasks"]
                saved_by = str(incoming.get("savedBy") or "client")
            else:
                raise ValueError("Expected a tasks array or schema-2 document")

            tasks = [item for item in raw_tasks if isinstance(item, dict)]
            doc = {
                "schema": SCHEMA_VERSION,
                "savedAt": utc_now_iso(),
                "savedBy": saved_by,
                "tasks": tasks,
            }
            new_etag = self._write_atomic(doc, was_v1=was_v1)
            return doc, new_etag


def make_handler(store: TaskStore, api_token: str | None = None):
    """Build an HTTP handler bound to store with localhost Host/Origin/CSRF protection."""
    token = api_token if api_token is not None else secrets.token_hex(16)

    class HorizonHandler(BaseHTTPRequestHandler):
        session_token = token

        def log_message(self, format: str, *args) -> None:
            return

        def _check_host(self) -> bool:
            port = self.server.server_address[1]
            allowed = {f"127.0.0.1:{port}", f"localhost:{port}", "127.0.0.1", "localhost"}
            if (self.headers.get("Host") or "").strip().lower() not in allowed:
                self._send_json({"error": "Forbidden host"}, status=403)
                return False
            return True

        def _check_write_security(self) -> bool:
            if not self._check_host():
                return False

            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                self._send_json({"error": "Content-Type must be application/json"}, status=415)
                return False

            origin = (self.headers.get("Origin") or "").strip().lower()
            if origin:
                port = self.server.server_address[1]
                if origin not in {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}:
                    self._send_json({"error": "Cross-origin request blocked"}, status=403)
                    return False

            if self.session_token:
                provided = (self.headers.get("X-Horizon-Token") or "").strip()
                if not secrets.compare_digest(provided, self.session_token):
                    self._send_json({"error": "Missing or invalid session token"}, status=403)
                    return False

            return True

        def _send_json(self, payload: object, status: int = 200, extra_headers: dict[str, str] | None = None) -> None:
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if extra_headers:
                for k, v in extra_headers.items():
                    self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _read_json_body(self) -> object:
            raw_len = self.headers.get("Content-Length", "0").strip()
            try:
                length = int(raw_len)
            except ValueError as err:
                raise ValueError("Invalid Content-Length") from err
            if length < 0:
                raise ValueError("Invalid Content-Length")
            if length > MAX_BODY_BYTES:
                raise OverflowError("Request body too large")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            return loads_strict(raw.decode("utf-8"))

        def _serve_static(self, filename: str) -> None:
            if filename not in STATIC_FILES:
                self.send_error(404, "File not found")
                return
            file_path = BASE_DIR / filename
            if not file_path.exists():
                self.send_error(404, "File not found")
                return

            content_type, _ = mimetypes.guess_type(str(file_path))
            body = file_path.read_bytes()
            if filename == "index.html" and self.session_token:
                meta = f'<meta name="horizon-token" content="{self.session_token}" />'
                body = body.decode("utf-8").replace("</head>", f"  {meta}\n</head>", 1).encode("utf-8")

            self.send_response(200)
            self.send_header("Content-Type", f"{content_type or 'text/plain'}; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; "
                "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
            )
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if not self._check_host():
                return
            path = urllib.parse.urlparse(self.path).path
            if path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            if path == "/api/data":
                try:
                    doc, etag, is_new = store.load_document()
                    self._send_json(
                        {"document": doc, "isNew": is_new, "fileName": store.file_path.name},
                        extra_headers={"ETag": etag},
                    )
                except CorruptDataError as err:
                    self._send_json({"error": str(err)}, status=500)
                return
            if path == "/":
                self._serve_static("index.html")
                return
            self._serve_static(path.lstrip("/"))

        def do_PUT(self) -> None:
            if not self._check_write_security():
                return
            if urllib.parse.urlparse(self.path).path != "/api/data":
                self._send_json({"error": "Not found"}, status=404)
                return

            if_match = (self.headers.get("If-Match") or "").strip()
            if not if_match:
                self._send_json({"error": "If-Match header is required"}, status=428)
                return

            try:
                body = self._read_json_body()
                doc, etag = store.save_document(body, expected_etag=if_match)
                self._send_json(
                    {"document": doc, "fileName": store.file_path.name},
                    extra_headers={"ETag": etag},
                )
            except OverflowError as err:
                self._send_json({"error": str(err)}, status=413)
            except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as err:
                self._send_json({"error": str(err)}, status=400)
            except ConflictError:
                doc, etag, _ = store.load_document()
                self._send_json(
                    {"error": "Conflict: file modified on disk", "document": doc},
                    status=409,
                    extra_headers={"ETag": etag},
                )
            except DiskBusyError as err:
                self._send_json({"error": str(err)}, status=503)
            except CorruptDataError as err:
                self._send_json({"error": str(err)}, status=500)

    return HorizonHandler


def run_server(port: int = 4173, open_browser: bool = True, data_file: Path = DATA_FILE) -> None:
    store = TaskStore(data_file)
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(store))
    except OSError as err:
        print(f"Could not start Horizon on http://127.0.0.1:{port}: {err}")
        print("Try another port with: py server.py --port 4174")
        raise SystemExit(1) from err

    url = f"http://127.0.0.1:{port}"
    print(f"Horizon is running at {url}")
    print(f"Tasks file: {store.file_path}")
    print("Press Ctrl+C to stop.")

    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped Horizon.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    default_data = os.environ.get("HORIZON_DATA")
    parser = argparse.ArgumentParser(description="Run the Horizon task organizer local server.")
    parser.add_argument("--port", type=int, default=4173, help="Local port (default: 4173)")
    parser.add_argument(
        "--data-file",
        type=Path,
        default=Path(default_data) if default_data else DATA_FILE,
        help="Path to tasks.json (or set HORIZON_DATA env var)",
    )
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open the browser")
    args = parser.parse_args()
    run_server(port=args.port, open_browser=not args.no_browser, data_file=args.data_file)
