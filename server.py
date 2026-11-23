"""
server.py — Horizon's Python Backend ("The Kitchen & Pantry")

Uses only Python's built-in standard library (no extra packages needed).
- Serves the web page files (index.html, styles.css, logic.js, app.js).
- Reads and writes your tasks directly to a real tasks.json file on disk.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import threading
import time
import urllib.parse
import uuid
import webbrowser
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "tasks.json"
STATIC_FILES = {"index.html", "styles.css", "logic.js", "app.js"}


def today_key() -> str:
    return date.today().isoformat()


def create_sample_tasks() -> list[dict]:
    """Starter tasks shown on first launch so the 3-month gradient is immediately visible."""
    today = date.today()
    now_ms = int(time.time() * 1000)
    return [
        {
            "id": "sample-1",
            "title": "Pay electricity bill",
            "dueDate": (today + timedelta(days=2)).isoformat(),
            "status": "today",
            "createdAt": now_ms - 4000,
            "completedAt": None,
            "isSample": True,
        },
        {
            "id": "sample-2",
            "title": "Book dentist checkup",
            "dueDate": (today + timedelta(days=11)).isoformat(),
            "status": "inbox",
            "createdAt": now_ms - 3000,
            "completedAt": None,
            "isSample": True,
        },
        {
            "id": "sample-3",
            "title": "Renew car insurance",
            "dueDate": (today + timedelta(days=34)).isoformat(),
            "status": "inbox",
            "createdAt": now_ms - 2000,
            "completedAt": None,
            "isSample": True,
        },
        {
            "id": "sample-4",
            "title": "Plan spring trip & flights",
            "dueDate": (today + timedelta(days=74)).isoformat(),
            "status": "inbox",
            "createdAt": now_ms - 1000,
            "completedAt": None,
            "isSample": True,
        },
        {
            "id": "sample-5",
            "title": "Clean up Downloads folder",
            "dueDate": "",
            "status": "inbox",
            "createdAt": now_ms - 500,
            "completedAt": None,
            "isSample": True,
        },
    ]


class TaskStore:
    """Manages reading and writing tasks to a JSON file safely."""

    def __init__(self, file_path: Path = DATA_FILE):
        self.file_path = file_path
        self._lock = threading.Lock()
        if not self.file_path.exists():
            self.save(create_sample_tasks())

    def load(self) -> list[dict]:
        with self._lock:
            if not self.file_path.exists():
                return []
            try:
                data = json.loads(self.file_path.read_text(encoding="utf-8"))
                return data if isinstance(data, list) else []
            except json.JSONDecodeError:
                return []

    def save(self, tasks: list[dict]) -> None:
        with self._lock:
            # Write cleanly formatted JSON so you can open tasks.json in Notepad anytime
            self.file_path.write_text(
                json.dumps(tasks, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )

    def add_task(self, title: str, due_date: str = "", put_in_today: bool = False) -> dict:
        clean_title = title.strip()
        if not clean_title:
            raise ValueError("Task title cannot be empty")

        clean_date = (due_date or "").strip()
        # If marked for Today with no explicit deadline, anchor it to today's date
        # so it immediately appears on the 3-month timeline.
        if put_in_today and not clean_date:
            clean_date = today_key()

        new_task = {
            "id": f"t-{uuid.uuid4().hex[:8]}",
            "title": clean_title,
            "dueDate": clean_date,
            "status": "today" if put_in_today else "inbox",
            "createdAt": int(time.time() * 1000),
            "completedAt": None,
        }
        tasks = self.load()
        tasks.insert(0, new_task)
        self.save(tasks)
        return new_task

    def update_task(self, task_id: str, updates: dict) -> dict | None:
        tasks = self.load()
        target = next((t for t in tasks if t.get("id") == task_id), None)
        if not target:
            return None

        if "title" in updates and isinstance(updates["title"], str):
            clean = updates["title"].strip()
            if clean:
                target["title"] = clean

        if "dueDate" in updates and isinstance(updates["dueDate"], str):
            target["dueDate"] = updates["dueDate"].strip()

        if "status" in updates and updates["status"] in {"inbox", "today", "done"}:
            new_status = updates["status"]
            target["status"] = new_status
            if new_status == "done":
                target["completedAt"] = today_key()
            else:
                target["completedAt"] = None
                # Moving a no-deadline task into Today anchors it to today on the timeline
                if new_status == "today" and not target.get("dueDate"):
                    target["dueDate"] = today_key()

        self.save(tasks)
        return target

    def delete_task(self, task_id: str) -> bool:
        tasks = self.load()
        remaining = [t for t in tasks if t.get("id") != task_id]
        if len(remaining) == len(tasks):
            return False
        self.save(remaining)
        return True

    def clear_completed(self) -> list[dict]:
        remaining = [t for t in self.load() if t.get("status") != "done"]
        self.save(remaining)
        return remaining

    def clear_samples(self) -> list[dict]:
        remaining = [t for t in self.load() if not t.get("isSample")]
        self.save(remaining)
        return remaining

    def replace_all(self, new_tasks: list[dict]) -> list[dict]:
        if not isinstance(new_tasks, list):
            raise ValueError("Expected a JSON list of tasks")
        self.save(new_tasks)
        return new_tasks


def make_handler(store: TaskStore):
    class HorizonHandler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args) -> None:
            # Keep terminal output quiet and readable
            return

        def _send_json(self, payload, status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _read_json_body(self) -> dict | list:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            return json.loads(raw.decode("utf-8"))

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
            self.send_response(200)
            self.send_header("Content-Type", f"{content_type or 'text/plain'}; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/tasks":
                self._send_json({"tasks": store.load(), "dataFile": str(store.file_path)})
                return
            if path == "/":
                self._serve_static("index.html")
                return
            self._serve_static(path.lstrip("/"))

        def do_POST(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"error": "Invalid JSON body"}, status=400)
                return

            if path == "/api/tasks":
                try:
                    task = store.add_task(
                        title=body.get("title", ""),
                        due_date=body.get("dueDate", ""),
                        put_in_today=bool(body.get("today", False)),
                    )
                    self._send_json({"task": task, "tasks": store.load()}, status=201)
                except ValueError as err:
                    self._send_json({"error": str(err)}, status=400)
                return

            if path == "/api/tasks/clear-done":
                self._send_json({"tasks": store.clear_completed()})
                return

            if path == "/api/tasks/clear-samples":
                self._send_json({"tasks": store.clear_samples()})
                return

            if path == "/api/tasks/import":
                try:
                    tasks = store.replace_all(body.get("tasks", body))
                    self._send_json({"tasks": tasks})
                except ValueError as err:
                    self._send_json({"error": str(err)}, status=400)
                return

            self._send_json({"error": "Not found"}, status=404)

        def do_PATCH(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            if not path.startswith("/api/tasks/"):
                self._send_json({"error": "Not found"}, status=404)
                return
            task_id = urllib.parse.unquote(path.removeprefix("/api/tasks/"))
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"error": "Invalid JSON body"}, status=400)
                return

            updated = store.update_task(task_id, body if isinstance(body, dict) else {})
            if not updated:
                self._send_json({"error": "Task not found"}, status=404)
                return
            self._send_json({"task": updated, "tasks": store.load()})

        def do_DELETE(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            if not path.startswith("/api/tasks/"):
                self._send_json({"error": "Not found"}, status=404)
                return
            task_id = urllib.parse.unquote(path.removeprefix("/api/tasks/"))
            if not store.delete_task(task_id):
                self._send_json({"error": "Task not found"}, status=404)
                return
            self._send_json({"tasks": store.load()})

    return HorizonHandler


def run_server(port: int = 4173, open_browser: bool = True, data_file: Path = DATA_FILE) -> None:
    store = TaskStore(data_file)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(store))
    url = f"http://127.0.0.1:{port}"
    print(f"Horizon is running at {url}")
    print(f"Tasks file: {store.file_path}")
    print("Press Ctrl+C to stop.")

    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped Horizon.")
    finally:
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the Horizon task organizer local server.")
    parser.add_argument("--port", type=int, default=4173, help="Local port (default: 4173)")
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open the browser")
    args = parser.parse_args()
    run_server(port=args.port, open_browser=not args.no_browser)
