"""
test_server.py — Automated unit tests for Horizon's Python backend (server.py).
Run with: py test_server.py
"""

import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import server
import build_portable


class TestTaskStore(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.data_file = Path(self.tmp_dir.name) / "tasks.json"
        self.store = server.TaskStore(self.data_file)

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def test_creates_starter_file(self) -> None:
        self.assertTrue(self.data_file.exists())
        tasks = self.store.load()
        self.assertGreaterEqual(len(tasks), 4)

    def test_today_task_without_date_anchors_to_today(self) -> None:
        task = self.store.add_task("Call bank", due_date="", put_in_today=True)
        self.assertEqual(task["status"], "today")
        self.assertEqual(task["dueDate"], server.today_key())

    def test_moving_undated_inbox_task_to_today_anchors_to_today(self) -> None:
        task = self.store.add_task("Sort desk", due_date="", put_in_today=False)
        self.assertEqual(task["dueDate"], "")
        updated = self.store.update_task(task["id"], {"status": "today"})
        self.assertIsNotNone(updated)
        self.assertEqual(updated["dueDate"], server.today_key())

    def test_complete_and_delete_persist_to_disk(self) -> None:
        task = self.store.add_task("Buy milk", due_date="", put_in_today=False)
        self.store.update_task(task["id"], {"status": "done"})
        reloaded = json.loads(self.data_file.read_text(encoding="utf-8"))
        saved = next(t for t in reloaded if t["id"] == task["id"])
        self.assertEqual(saved["status"], "done")
        self.assertEqual(saved["completedAt"], server.today_key())

        self.assertTrue(self.store.delete_task(task["id"]))
        reloaded_after = json.loads(self.data_file.read_text(encoding="utf-8"))
        self.assertFalse(any(t["id"] == task["id"] for t in reloaded_after))


class TestHttpApi(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.store = server.TaskStore(Path(self.tmp_dir.name) / "tasks.json")
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(self.store))
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp_dir.cleanup()

    def _req(self, method: str, path: str, payload: dict | None = None) -> dict:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def test_get_post_patch_delete_roundtrip(self) -> None:
        initial = self._req("GET", "/api/tasks")
        self.assertIn("tasks", initial)

        created = self._req("POST", "/api/tasks", {"title": "API test", "dueDate": "", "today": True})
        task_id = created["task"]["id"]
        self.assertEqual(created["task"]["dueDate"], server.today_key())

        patched = self._req("PATCH", f"/api/tasks/{task_id}", {"status": "done"})
        self.assertEqual(patched["task"]["status"], "done")

        deleted = self._req("DELETE", f"/api/tasks/{task_id}")
        self.assertFalse(any(t["id"] == task_id for t in deleted["tasks"]))


class TestPortableBuilder(unittest.TestCase):
    def test_builds_self_contained_html(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = build_portable.build_portable(output_file=Path(tmp) / "horizon-portable.html")
            self.assertTrue(out.exists())
            content = out.read_text(encoding="utf-8")
            self.assertNotIn('href="styles.css"', content)
            self.assertNotIn('src="logic.js"', content)
            self.assertNotIn('src="app.js"', content)
            self.assertIn("<style>", content)
            self.assertIn("function getGradientStyle", content)
            self.assertIn("function linkExistingFile", content)


if __name__ == "__main__":
    unittest.main(verbosity=2)
