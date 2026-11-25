"""
server.py — Horizon's Python Backend ("The Kitchen & Pantry")

Uses only Python's built-in standard library (no extra packages needed).
- Serves the web page files (index.html, styles.css, logic.js, app.js).
- Reads and writes your tasks directly to a real tasks.json file on disk.
- Writes atomically, backs up corrupt files, and detects outside edits (mtime conflicts).
"""

from __future__ import annotations

import argparse
import calendar
import json
import mimetypes
import os
import re
import shutil
import tempfile
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

VALID_STATUSES = ("inbox", "today", "done")
VALID_RECURRENCES = ("", "weekly", "monthly", "quarterly", "yearly")
MTIME_TOLERANCE_MS = 50
MAX_BODY_BYTES = 5 * 1024 * 1024  # 5 MB request cap
DATE_KEY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ConflictError(Exception):
    """tasks.json was changed on disk since the client last loaded it."""


def today_key() -> str:
    return date.today().isoformat()


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# Pure helpers (dates, recurrence, normalization)
# ---------------------------------------------------------------------------

def is_valid_date_key(value) -> bool:
    if not isinstance(value, str) or not DATE_KEY_RE.match(value):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _add_months_clamped(year: int, month_index: int, anchor_day: int, months: int) -> date:
    total = year * 12 + month_index + months
    new_year, new_month_index = divmod(total, 12)
    last_day = calendar.monthrange(new_year, new_month_index + 1)[1]
    return date(new_year, new_month_index + 1, min(anchor_day, last_day))


def get_next_recurrence_date(base_date_key: str, recurrence: str, today: date | None = None) -> str:
    """Next due date strictly after `today`, stepping from base by the recurrence interval.

    Month/year steps always count from the original day-of-month (Jan 31 -> Feb 28 -> Mar 31).
    Returns "" when the inputs are invalid.
    """
    if recurrence not in VALID_RECURRENCES or not recurrence:
        return ""
    if not is_valid_date_key(base_date_key):
        return ""
    base = date.fromisoformat(base_date_key)
    today = today or date.today()
    months_per_step = {"monthly": 1, "quarterly": 3, "yearly": 12}.get(recurrence, 0)

    def step(n: int) -> date:
        if recurrence == "weekly":
            return base + timedelta(days=7 * n)
        return _add_months_clamped(base.year, base.month - 1, base.day, months_per_step * n)

    try:
        n = 1
        nxt = step(n)
        while nxt <= today and n < 200000:
            n += 1
            nxt = step(n)
        return nxt.isoformat()
    except (ValueError, OverflowError):
        return ""


def _normalize_subtasks(raw_subtasks) -> list[dict]:
    result: list[dict] = []
    if not isinstance(raw_subtasks, list):
        return result
    for st in raw_subtasks:
        if not isinstance(st, dict):
            continue
        text = st.get("text")
        text = text.strip() if isinstance(text, str) else ""
        if not text:
            continue
        st_id = st.get("id")
        result.append(
            {
                "id": st_id if isinstance(st_id, str) and st_id else f"st-{uuid.uuid4().hex[:8]}",
                "text": text,
                "done": st.get("done") is True,
            }
        )
    return result


def _positive_int(value) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float("inf"), float("-inf")) or value <= 0:
        return None
    return int(value)


def normalize_task(raw, now: int | None = None) -> dict | None:
    """Turn any loosely-shaped saved/imported task into the full, safe task shape.

    Returns None for anything that is not a JSON object.
    """
    if not isinstance(raw, dict):
        return None
    now = now if now is not None else now_ms()

    title = raw.get("title")
    title = title.strip() if isinstance(title, str) else ""
    if not title:
        title = "Untitled task"

    status = raw.get("status") if raw.get("status") in VALID_STATUSES else "inbox"
    due_date = raw.get("dueDate") if is_valid_date_key(raw.get("dueDate")) else ""

    previous_status = raw.get("previousStatus")
    if previous_status not in ("inbox", "today"):
        previous_status = "today" if status == "today" else "inbox"

    created_at = _positive_int(raw.get("createdAt")) or now
    updated_at = _positive_int(raw.get("updatedAt")) or created_at

    task_id = raw.get("id")
    spawned_id = raw.get("recurrenceSpawnedId")
    notes = raw.get("notes")

    task = {
        "id": task_id if isinstance(task_id, str) and task_id else f"t-{uuid.uuid4().hex[:8]}",
        "title": title,
        "dueDate": due_date,
        "status": status,
        "previousStatus": previous_status,
        "notes": notes if isinstance(notes, str) else "",
        "subtasks": _normalize_subtasks(raw.get("subtasks")),
        "recurrence": raw.get("recurrence") if raw.get("recurrence") in VALID_RECURRENCES else "",
        "recurrenceSpawnedId": spawned_id if isinstance(spawned_id, str) and spawned_id else None,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "completedAt": raw.get("completedAt") if status == "done" and is_valid_date_key(raw.get("completedAt")) else None,
    }
    if raw.get("isSample") is True:
        task["isSample"] = True
    return task


def normalize_task_list(raw_tasks, now: int | None = None) -> list[dict]:
    """Normalize a list, dropping non-dict entries and duplicate ids (first one wins)."""
    seen: set[str] = set()
    result: list[dict] = []
    for raw in raw_tasks:
        task = normalize_task(raw, now)
        if task is None or task["id"] in seen:
            continue
        seen.add(task["id"])
        result.append(task)
    return result


def create_sample_tasks() -> list[dict]:
    """Starter tasks shown on first launch so the timeline gradient is immediately visible."""
    today = date.today()
    ms = now_ms()

    def sample(n: int, title: str, days: int | None, status: str, age_ms: int, **extra) -> dict:
        return {
            "id": f"sample-{n}",
            "title": title,
            "dueDate": (today + timedelta(days=days)).isoformat() if days is not None else "",
            "status": status,
            "previousStatus": "today" if status == "today" else "inbox",
            "notes": extra.get("notes", ""),
            "subtasks": extra.get("subtasks", []),
            "recurrence": extra.get("recurrence", ""),
            "recurrenceSpawnedId": None,
            "createdAt": ms - age_ms,
            "updatedAt": ms - age_ms,
            "completedAt": None,
            "isSample": True,
        }

    return [
        sample(
            1,
            "Pay electricity bill #home",
            2,
            "today",
            4000,
            recurrence="monthly",
            notes="Autopay is off. Account number is on the paper statement.",
        ),
        sample(
            2,
            "Book dentist checkup #health",
            11,
            "inbox",
            3000,
            recurrence="quarterly",
            notes="Ask about the cleaning slot after 3pm. Bring insurance card.",
            subtasks=[
                {"id": "st-sample-2a", "text": "Check insurance coverage", "done": True},
                {"id": "st-sample-2b", "text": "Call the clinic", "done": False},
                {"id": "st-sample-2c", "text": "Add appointment to calendar", "done": False},
            ],
        ),
        sample(
            3,
            "Renew car insurance #home",
            34,
            "inbox",
            2000,
            recurrence="yearly",
            notes="Compare at least two quotes before renewing.",
            subtasks=[
                {"id": "st-sample-3a", "text": "Get two competing quotes", "done": False},
                {"id": "st-sample-3b", "text": "Renew online", "done": False},
            ],
        ),
        sample(4, "Plan spring trip & flights", 74, "inbox", 1000),
        sample(5, "Clean up Downloads folder", None, "inbox", 500),
    ]


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

class TaskStore:
    """Manages reading and writing tasks to a JSON file safely.

    One re-entrant lock covers every whole read-modify-write cycle, writes are
    atomic (temp file + os.replace), and unreadable files are backed up, never lost.
    """

    def __init__(self, file_path: Path = DATA_FILE):
        self.file_path = Path(file_path)
        self._lock = threading.RLock()
        self._backed_up_mtime: int | None = None
        with self._lock:
            if not self.file_path.exists():
                self.save(create_sample_tasks())

    # -- low-level helpers -------------------------------------------------

    def get_mtime_ms(self) -> int:
        try:
            return int(self.file_path.stat().st_mtime * 1000)
        except OSError:
            return 0

    def _backup_corrupt_file(self) -> None:
        mtime = self.get_mtime_ms()
        if self._backed_up_mtime == mtime:
            return  # Already backed this exact file up; don't pile up copies
        backup = self.file_path.with_name(f"{self.file_path.name}.corrupt.{now_ms()}")
        try:
            shutil.copy2(self.file_path, backup)
            self._backed_up_mtime = mtime
        except OSError:
            pass

    def _check_conflict(self, expected_mtime_ms, force: bool) -> None:
        if force or expected_mtime_ms is None:
            return
        if isinstance(expected_mtime_ms, bool) or not isinstance(expected_mtime_ms, (int, float)):
            return
        if abs(self.get_mtime_ms() - int(expected_mtime_ms)) > MTIME_TOLERANCE_MS:
            raise ConflictError("File modified externally")

    # -- load / save -------------------------------------------------------

    def load(self) -> list[dict]:
        with self._lock:
            if not self.file_path.exists():
                return []
            try:
                data = json.loads(self.file_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._backup_corrupt_file()
                return []
            if not isinstance(data, list):
                self._backup_corrupt_file()
                return []
            return normalize_task_list(data)

    def save(self, tasks: list[dict]) -> None:
        with self._lock:
            self.file_path.parent.mkdir(parents=True, exist_ok=True)
            # Write cleanly formatted JSON so you can open tasks.json in Notepad anytime
            payload = json.dumps(tasks, indent=2, ensure_ascii=False) + "\n"
            fd, tmp_name = tempfile.mkstemp(
                dir=str(self.file_path.parent), prefix=f".{self.file_path.name}.", suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as tmp:
                    tmp.write(payload)
                    tmp.flush()
                    try:
                        os.fsync(tmp.fileno())
                    except OSError:
                        pass
                for attempt in range(4):
                    try:
                        os.replace(tmp_name, self.file_path)
                        break
                    except PermissionError:
                        if attempt == 3:
                            raise
                        time.sleep(0.025)
            except BaseException:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass
                raise

    # -- task operations ---------------------------------------------------

    def add_task(
        self,
        title: str,
        due_date: str = "",
        put_in_today: bool = False,
        notes: str = "",
        subtasks: list | None = None,
        recurrence: str = "",
        expected_mtime_ms=None,
        force: bool = False,
    ) -> dict:
        clean_title = title.strip() if isinstance(title, str) else ""
        if not clean_title:
            raise ValueError("Task title cannot be empty")

        clean_date = due_date.strip() if isinstance(due_date, str) else ""
        if not is_valid_date_key(clean_date):
            clean_date = ""  # NOTE: Today does NOT invent a deadline; undated stays undated

        stamp = now_ms()
        new_task = {
            "id": f"t-{uuid.uuid4().hex[:8]}",
            "title": clean_title,
            "dueDate": clean_date,
            "status": "today" if put_in_today else "inbox",
            "previousStatus": "today" if put_in_today else "inbox",
            "notes": notes if isinstance(notes, str) else "",
            "subtasks": _normalize_subtasks(subtasks),
            "recurrence": recurrence if recurrence in VALID_RECURRENCES else "",
            "recurrenceSpawnedId": None,
            "createdAt": stamp,
            "updatedAt": stamp,
            "completedAt": None,
        }
        with self._lock:
            self._check_conflict(expected_mtime_ms, force)
            tasks = self.load()
            tasks.insert(0, new_task)
            self.save(tasks)
        return new_task

    def update_task_with_spawn(
        self,
        task_id: str,
        updates: dict,
        expected_mtime_ms=None,
        force: bool = False,
        today: date | None = None,
    ) -> tuple[dict | None, dict | None]:
        """Apply an update. Returns (task, spawned_task); task is None when the id is unknown."""
        today = today or date.today()
        today_str = today.isoformat()
        with self._lock:
            self._check_conflict(expected_mtime_ms, force)
            tasks = self.load()
            target = next((t for t in tasks if t.get("id") == task_id), None)
            if not target:
                return None, None

            if isinstance(updates.get("title"), str):
                clean = updates["title"].strip()
                if clean:
                    target["title"] = clean

            if isinstance(updates.get("dueDate"), str):
                clean_date = updates["dueDate"].strip()
                if clean_date == "" or is_valid_date_key(clean_date):
                    target["dueDate"] = clean_date

            if isinstance(updates.get("notes"), str):
                target["notes"] = updates["notes"]

            if isinstance(updates.get("subtasks"), list):
                target["subtasks"] = _normalize_subtasks(updates["subtasks"])

            if updates.get("recurrence") in VALID_RECURRENCES:
                target["recurrence"] = updates["recurrence"]

            spawned: dict | None = None
            new_status = updates.get("status")
            if new_status in VALID_STATUSES:
                old_status = target["status"]
                target["status"] = new_status
                if new_status == "done":
                    if old_status != "done":
                        target["previousStatus"] = old_status
                        target["completedAt"] = today_str
                        spawned = self._spawn_recurrence(tasks, target, today)
                else:
                    target["completedAt"] = None
                    target["previousStatus"] = new_status
                    # NOTE: dueDate is intentionally left alone. An undated task in Today
                    # stays undated so moving it back never creates a phantom overdue date.

            target.pop("isSample", None)
            target["updatedAt"] = now_ms()
            self.save(tasks)
            return target, spawned

    def _spawn_recurrence(self, tasks: list[dict], completed: dict, today: date) -> dict | None:
        """Create the next copy of a repeating task (once). Mutates `tasks`."""
        recurrence = completed.get("recurrence")
        if not recurrence or recurrence not in VALID_RECURRENCES:
            return None
        existing_id = completed.get("recurrenceSpawnedId")
        if existing_id and any(t.get("id") == existing_id for t in tasks):
            return None  # Already spawned and still around: never duplicate

        next_due = get_next_recurrence_date(completed.get("dueDate") or today.isoformat(), recurrence, today)
        if not next_due:
            return None

        stamp = now_ms()
        spawned = {
            "id": f"t-{uuid.uuid4().hex[:8]}",
            "title": completed["title"],
            "dueDate": next_due,
            "status": "inbox",
            "previousStatus": "inbox",
            "notes": completed.get("notes", ""),
            "subtasks": [
                {"id": f"st-{uuid.uuid4().hex[:8]}", "text": st["text"], "done": False}
                for st in completed.get("subtasks", [])
            ],
            "recurrence": recurrence,
            "recurrenceSpawnedId": None,
            "createdAt": stamp,
            "updatedAt": stamp,
            "completedAt": None,
        }
        tasks.insert(0, spawned)
        completed["recurrenceSpawnedId"] = spawned["id"]
        return spawned

    def update_task(self, task_id: str, updates: dict, expected_mtime_ms=None, force: bool = False) -> dict | None:
        task, _spawned = self.update_task_with_spawn(task_id, updates, expected_mtime_ms, force)
        return task

    def delete_task(self, task_id: str, expected_mtime_ms=None, force: bool = False) -> bool:
        with self._lock:
            self._check_conflict(expected_mtime_ms, force)
            tasks = self.load()
            remaining = [t for t in tasks if t.get("id") != task_id]
            if len(remaining) == len(tasks):
                return False
            self.save(remaining)
            return True

    def clear_completed(self, expected_mtime_ms=None, force: bool = False) -> list[dict]:
        with self._lock:
            self._check_conflict(expected_mtime_ms, force)
            remaining = [t for t in self.load() if t.get("status") != "done"]
            self.save(remaining)
            return remaining

    def clear_samples(self, expected_mtime_ms=None, force: bool = False) -> list[dict]:
        with self._lock:
            self._check_conflict(expected_mtime_ms, force)
            remaining = [t for t in self.load() if not t.get("isSample")]
            self.save(remaining)
            return remaining

    def replace_all(self, new_tasks: list) -> list[dict]:
        if not isinstance(new_tasks, list):
            raise ValueError("Expected a JSON list of tasks")
        with self._lock:
            cleaned = normalize_task_list(new_tasks)
            self.save(cleaned)
            return cleaned

    def import_tasks(
        self, new_tasks: list, mode: str = "replace", expected_mtime_ms=None, force: bool = False
    ) -> list[dict]:
        if not isinstance(new_tasks, list):
            raise ValueError("Expected a JSON list of tasks")
        if mode not in ("replace", "merge"):
            raise ValueError("mode must be 'replace' or 'merge'")
        with self._lock:
            self._check_conflict(expected_mtime_ms, force)
            incoming = normalize_task_list(new_tasks)
            if mode == "replace":
                self.save(incoming)
                return incoming

            merged = self.load()
            index = {t["id"]: i for i, t in enumerate(merged)}
            for task in incoming:
                i = index.get(task["id"])
                if i is None:
                    index[task["id"]] = len(merged)
                    merged.append(task)
                elif task["updatedAt"] > merged[i]["updatedAt"]:
                    merged[i] = task
            self.save(merged)
            return merged

    def restore_snapshot(
        self, snapshot: list, expected_mtime_ms=None, force: bool = False
    ) -> list[dict]:
        """Put a full earlier list of tasks back (used by Undo in server mode)."""
        if not isinstance(snapshot, list):
            raise ValueError("Expected a JSON list of tasks")
        with self._lock:
            self._check_conflict(expected_mtime_ms, force)
            cleaned = normalize_task_list(snapshot)
            self.save(cleaned)
            return cleaned


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

def _origin_allowed(origin: str | None) -> bool:
    """Only local pages may change data. No Origin header (curl, same-origin GET) is fine."""
    if origin is None:
        return True
    try:
        parsed = urllib.parse.urlparse(origin)
    except ValueError:
        return False
    return parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")


def _host_allowed(host: str | None) -> bool:
    """Guard against DNS rebinding: only 127.0.0.1 or localhost Host headers are allowed."""
    if not host:
        return True
    try:
        parsed = urllib.parse.urlparse(f"http://{host}")
    except ValueError:
        return False
    return parsed.hostname in ("127.0.0.1", "localhost")


def _as_number(value):
    """Accept ints/floats (or numeric strings from a query string) as an mtime; else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _as_bool(value) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes")
    return bool(value)


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

        def _send_conflict(self) -> None:
            self._send_json(
                {
                    "error": "File modified externally",
                    "conflict": True,
                    "tasks": store.load(),
                    "mtimeMs": store.get_mtime_ms(),
                },
                status=409,
            )

        def _read_raw_body(self) -> bytes | None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length > MAX_BODY_BYTES:
                self._send_json({"error": "Request body too large"}, status=413)
                return None
            return self.rfile.read(length) if length > 0 else b""

        @staticmethod
        def _parse_body(raw: bytes):
            return json.loads(raw.decode("utf-8")) if raw.strip() else {}

        def _guard_host(self) -> bool:
            """Return True if blocked (and the 403 was already sent)."""
            if _host_allowed(self.headers.get("Host")):
                return False
            self._send_json({"error": "Forbidden host"}, status=403)
            return True

        def _guard_origin(self) -> bool:
            """Return True if blocked (and the 403 was already sent)."""
            if self._guard_host():
                return True
            sec_fetch_site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
            if sec_fetch_site == "cross-site" or not _origin_allowed(self.headers.get("Origin")):
                self._send_json({"error": "Forbidden origin"}, status=403)
                return True
            return False

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

        def _tasks_response(self, **extra) -> dict:
            payload = {"tasks": store.load()}
            payload.update(extra)
            payload["mtimeMs"] = store.get_mtime_ms()
            return payload

        def do_GET(self) -> None:
            if self._guard_host():
                return
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/tasks":
                self._send_json(
                    {
                        "tasks": store.load(),
                        "dataFile": str(store.file_path),
                        "mtimeMs": store.get_mtime_ms(),
                    }
                )
                return
            if path == "/":
                self._serve_static("index.html")
                return
            self._serve_static(path.lstrip("/"))

        def do_POST(self) -> None:
            if self._guard_origin():
                return
            raw = self._read_raw_body()
            if raw is None:
                return
            path = urllib.parse.urlparse(self.path).path
            try:
                body = self._parse_body(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send_json({"error": "Invalid JSON body"}, status=400)
                return

            if path == "/api/tasks":
                if not isinstance(body, dict):
                    self._send_json({"error": "Expected a JSON object"}, status=400)
                    return
                try:
                    task = store.add_task(
                        title=body.get("title", ""),
                        due_date=body.get("dueDate", ""),
                        put_in_today=bool(body.get("today", False)),
                        notes=body.get("notes", ""),
                        subtasks=body.get("subtasks"),
                        recurrence=body.get("recurrence", ""),
                        expected_mtime_ms=_as_number(body.get("expectedMtimeMs")),
                        force=_as_bool(body.get("force", False)),
                    )
                except ConflictError:
                    self._send_conflict()
                    return
                except ValueError as err:
                    self._send_json({"error": str(err)}, status=400)
                    return
                self._send_json(self._tasks_response(task=task), status=201)
                return

            if path == "/api/tasks/clear-done":
                expected = _as_number(body.get("expectedMtimeMs")) if isinstance(body, dict) else None
                force = _as_bool(body.get("force", False)) if isinstance(body, dict) else False
                try:
                    store.clear_completed(expected_mtime_ms=expected, force=force)
                except ConflictError:
                    self._send_conflict()
                    return
                self._send_json(self._tasks_response())
                return

            if path == "/api/tasks/clear-samples":
                expected = _as_number(body.get("expectedMtimeMs")) if isinstance(body, dict) else None
                force = _as_bool(body.get("force", False)) if isinstance(body, dict) else False
                try:
                    store.clear_samples(expected_mtime_ms=expected, force=force)
                except ConflictError:
                    self._send_conflict()
                    return
                self._send_json(self._tasks_response())
                return

            if path in ("/api/tasks/import", "/api/tasks/restore"):
                expected = None
                force = False
                if isinstance(body, list):
                    incoming, mode = body, "replace"
                elif isinstance(body, dict) and "tasks" in body:
                    incoming, mode = body["tasks"], body.get("mode", "replace")
                    expected = _as_number(body.get("expectedMtimeMs"))
                    force = _as_bool(body.get("force", False))
                else:
                    self._send_json({"error": "Expected a 'tasks' list"}, status=400)
                    return
                try:
                    if path.endswith("/restore"):
                        store.restore_snapshot(incoming, expected_mtime_ms=expected, force=force)
                    else:
                        store.import_tasks(incoming, mode, expected_mtime_ms=expected, force=force)
                except ConflictError:
                    self._send_conflict()
                    return
                except ValueError as err:
                    self._send_json({"error": str(err)}, status=400)
                    return
                self._send_json(self._tasks_response())
                return

            self._send_json({"error": "Not found"}, status=404)

        def do_PATCH(self) -> None:
            if self._guard_origin():
                return
            raw = self._read_raw_body()
            if raw is None:
                return
            path = urllib.parse.urlparse(self.path).path
            if not path.startswith("/api/tasks/"):
                self._send_json({"error": "Not found"}, status=404)
                return
            task_id = urllib.parse.unquote(path.removeprefix("/api/tasks/"))
            try:
                body = self._parse_body(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send_json({"error": "Invalid JSON body"}, status=400)
                return
            if not isinstance(body, dict):
                body = {}

            try:
                updated, spawned = store.update_task_with_spawn(
                    task_id,
                    body,
                    expected_mtime_ms=_as_number(body.get("expectedMtimeMs")),
                    force=_as_bool(body.get("force", False)),
                )
            except ConflictError:
                self._send_conflict()
                return
            if not updated:
                self._send_json({"error": "Task not found"}, status=404)
                return
            self._send_json(self._tasks_response(task=updated, spawnedTask=spawned))

        def do_DELETE(self) -> None:
            if self._guard_origin():
                return
            raw = self._read_raw_body()
            if raw is None:
                return
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            if not path.startswith("/api/tasks/"):
                self._send_json({"error": "Not found"}, status=404)
                return
            task_id = urllib.parse.unquote(path.removeprefix("/api/tasks/"))

            query = urllib.parse.parse_qs(parsed.query)
            expected = _as_number(query.get("expectedMtimeMs", [None])[0])
            force = _as_bool(query.get("force", ["false"])[0])
            try:
                body = self._parse_body(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                body = {}
            if isinstance(body, dict):
                if expected is None:
                    expected = _as_number(body.get("expectedMtimeMs"))
                force = force or _as_bool(body.get("force", False))

            try:
                deleted = store.delete_task(task_id, expected_mtime_ms=expected, force=force)
            except ConflictError:
                self._send_conflict()
                return
            if not deleted:
                self._send_json({"error": "Task not found"}, status=404)
                return
            self._send_json(self._tasks_response())

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
