"""
test_server.py — Automated tests for Horizon's atomic JSON server & portable bundle.
Run with: py test_server.py
"""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import build_portable
import server


class TestTaskStore(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.data_file = Path(self.tmp_dir.name) / "tasks.json"
        self.store = server.TaskStore(self.data_file)

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def test_missing_file_reports_is_new_and_saves_atomically(self) -> None:
        doc, etag, is_new = self.store.load_document()
        self.assertTrue(is_new)
        self.assertEqual(doc["schema"], 2)
        self.assertEqual(doc["tasks"], [])

        saved_doc, etag2 = self.store.save_document(
            {"schema": 2, "savedBy": "test", "tasks": [{"id": "t1", "title": "First"}]},
            expected_etag=etag,
        )
        self.assertTrue(self.data_file.exists())
        self.assertNotEqual(etag, etag2)
        self.assertEqual(len(saved_doc["tasks"]), 1)

        # Second save creates .bak
        _, etag3 = self.store.save_document(
            {"schema": 2, "savedBy": "test", "tasks": [{"id": "t1", "title": "Updated"}]},
            expected_etag=etag2,
        )
        self.assertNotEqual(etag2, etag3)
        self.assertTrue(self.data_file.with_suffix(".json.bak").exists())

    def test_handles_utf8_bom_and_backs_up_v1_file(self) -> None:
        v1_tasks = [{"id": "bom-1", "title": "Notepad task", "status": "inbox", "dueDate": ""}]
        self.data_file.write_bytes(("\ufeff" + json.dumps(v1_tasks)).encode("utf-8"))

        doc, etag, is_new = self.store.load_document()
        self.assertFalse(is_new)
        self.assertEqual(len(doc["tasks"]), 1)

        self.store.save_document({"schema": 2, "tasks": doc["tasks"]}, expected_etag=etag)
        v1_backups = list(self.data_file.parent.glob("tasks.v1-backup-*.json"))
        self.assertEqual(len(v1_backups), 1)
        self.assertTrue(self.data_file.with_suffix(".json.bak").exists())

    def test_corrupt_json_and_nan_refuse_reads_and_writes(self) -> None:
        self.data_file.write_text("{broken json", encoding="utf-8")
        with self.assertRaises(server.CorruptDataError):
            self.store.load_document()
        with self.assertRaises(server.CorruptDataError):
            self.store.save_document({"tasks": []}, expected_etag="*")
        self.assertEqual(self.data_file.read_text(encoding="utf-8"), "{broken json")

        # NaN on disk must also be rejected as corrupt
        self.data_file.write_text('{"schema": 2, "tasks": [{"id": "x", "updatedAt": NaN}]}', encoding="utf-8")
        with self.assertRaises(server.CorruptDataError):
            self.store.load_document()

    def test_replace_permission_error_retries_cleans_tmp_and_raises_disk_busy(self) -> None:
        _, etag, _ = self.store.load_document()
        with mock.patch("server.os.replace", side_effect=PermissionError("OneDrive lock")), mock.patch(
            "server.time.sleep"
        ):
            with self.assertRaises(server.DiskBusyError):
                self.store.save_document({"tasks": [{"id": "t1", "title": "Locked"}]}, expected_etag=etag)
        leftover_tmps = list(self.data_file.parent.glob("*.tmp"))
        self.assertEqual(leftover_tmps, [], "Temp file must be cleaned up after failed replace")


class TestHttpApi(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.store = server.TaskStore(Path(self.tmp_dir.name) / "tasks.json")
        self.token = "test-session-token"
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(self.store, api_token=self.token))
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp_dir.cleanup()

    def _raw_req(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        hdrs = {
            "Content-Type": "application/json",
            "X-Horizon-Token": self.token,
        }
        if headers:
            hdrs.update(headers)
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=body,
            method=method,
            headers=hdrs,
        )
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as err:
            try:
                return err.code, dict(err.headers), err.read()
            finally:
                err.close()

    def _json_req(self, method: str, path: str, payload: object | None = None, extra_headers: dict[str, str] | None = None):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        status, hdrs, raw = self._raw_req(method, path, data, extra_headers)
        return status, hdrs, json.loads(raw.decode("utf-8"))

    def test_document_etag_428_and_409_conflict(self) -> None:
        status, hdrs, data = self._json_req("GET", "/api/data")
        self.assertEqual(status, 200)
        self.assertTrue(data["isNew"])
        self.assertNotIn("dataFile", data, "Must not leak full OS path")
        etag1 = hdrs.get("ETag")
        self.assertTrue(etag1)

        # Missing If-Match must return 428 Precondition Required
        status, _, _ = self._json_req("PUT", "/api/data", {"tasks": []})
        self.assertEqual(status, 428)

        # Valid If-Match succeeds and advances ETag
        doc = data["document"]
        doc["tasks"].append({"id": "new-1", "title": "Via PUT", "list": "later"})
        status, hdrs2, _ = self._json_req("PUT", "/api/data", doc, {"If-Match": etag1})
        self.assertEqual(status, 200)
        self.assertNotEqual(etag1, hdrs2.get("ETag"))

        # Stale ETag returns 409 with latest document
        status, _, conflict = self._json_req("PUT", "/api/data", doc, {"If-Match": etag1})
        self.assertEqual(status, 409)
        self.assertIn("document", conflict)

    def test_security_guards_csp_and_bad_payloads(self) -> None:
        _, hdrs, _ = self._json_req("GET", "/api/data")
        etag = hdrs["ETag"]

        # 1. text/plain PUT rejected (415)
        status, _, _ = self._raw_req("PUT", "/api/data", b'{"tasks":[]}', {"Content-Type": "text/plain", "If-Match": etag})
        self.assertEqual(status, 415)

        # 2. Cross-origin Origin rejected (403)
        status, _, _ = self._raw_req("PUT", "/api/data", b'{"tasks":[]}', {"Origin": "https://evil.example", "If-Match": etag})
        self.assertEqual(status, 403)

        # 3. Wrong session token rejected (403)
        status, _, _ = self._raw_req("PUT", "/api/data", b'{"tasks":[]}', {"X-Horizon-Token": "wrong", "If-Match": etag})
        self.assertEqual(status, 403)

        # 4. NaN / Infinity in JSON rejected as 400 (not 413 or 500)
        status, _, _ = self._raw_req("PUT", "/api/data", b'{"tasks":[{"id":"a","updatedAt":NaN}]}', {"If-Match": etag})
        self.assertEqual(status, 400)

        # 5. Locked file during replace returns clean 503 JSON
        with mock.patch("server.os.replace", side_effect=PermissionError("locked")), mock.patch("server.time.sleep"):
            status, _, err_body = self._json_req("PUT", "/api/data", {"tasks": []}, {"If-Match": etag})
            self.assertEqual(status, 503)
            self.assertIn("error", err_body)

        # 6. index.html injects token and sets strict CSP (no unsafe-inline scripts, no framing)
        status, page_hdrs, html = self._raw_req("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(f'content="{self.token}"'.encode("utf-8"), html)
        csp = page_hdrs.get("Content-Security-Policy", "")
        self.assertIn("script-src 'self'", csp)
        self.assertNotIn("script-src 'self' 'unsafe-inline'", csp)
        self.assertIn("frame-ancestors 'none'", csp)


class TestPortableBuilder(unittest.TestCase):
    def test_builds_self_contained_html_and_matches_committed_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = build_portable.build_portable(output_file=Path(tmp) / "horizon-portable.html")
            self.assertTrue(out.exists())
            content = out.read_text(encoding="utf-8")
            self.assertNotIn('href="styles.css"', content)
            self.assertNotIn('src="logic.js"', content)
            self.assertNotIn('src="app.js"', content)
            self.assertIn("<style>", content)
            self.assertIn("function getGradientStyle", content)
            self.assertIn("function mergeTaskLists", content)

            committed = build_portable.OUTPUT_FILE.read_text(encoding="utf-8")
            self.assertEqual(
                committed,
                content,
                "horizon-portable.html is out of date — run `py build_portable.py`.",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
