"""
test_server.py — Automated unit tests for Horizon's Python backend (server.py).
Run with: py test_server.py
"""

import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import date, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path

import server
import build_portable


class TestRecurrenceDates(unittest.TestCase):
    TODAY = date(2026, 11, 23)

    def nxt(self, base: str, rec: str, today: date | None = None) -> str:
        return server.get_next_recurrence_date(base, rec, today or self.TODAY)

    def test_each_interval(self) -> None:
        self.assertEqual(self.nxt("2026-11-30", "weekly"), "2026-12-07")
        self.assertEqual(self.nxt("2026-11-25", "monthly"), "2026-12-25")
        self.assertEqual(self.nxt("2026-11-30", "quarterly"), "2027-02-28")
        self.assertEqual(self.nxt("2026-12-01", "yearly"), "2027-12-01")

    def test_month_end_clamping_without_drift(self) -> None:
        self.assertEqual(self.nxt("2026-01-31", "monthly", date(2026, 1, 15)), "2026-02-28")
        self.assertEqual(self.nxt("2028-01-31", "monthly", date(2028, 1, 15)), "2028-02-29")
        self.assertEqual(self.nxt("2026-01-31", "monthly", date(2026, 2, 28)), "2026-03-31")
        self.assertEqual(self.nxt("2028-02-29", "yearly", date(2028, 6, 1)), "2029-02-28")

    def test_overdue_catch_up_lands_after_today(self) -> None:
        self.assertEqual(self.nxt("2026-10-01", "weekly"), "2026-11-26")
        self.assertEqual(self.nxt("2026-08-15", "monthly"), "2026-12-15")
        self.assertEqual(self.nxt("2026-01-10", "quarterly"), "2027-01-10")
        self.assertEqual(self.nxt("2020-03-05", "yearly"), "2027-03-05")
        self.assertEqual(self.nxt("2026-11-23", "monthly"), "2026-12-23")

    def test_invalid_inputs(self) -> None:
        self.assertEqual(self.nxt("2026-11-30", ""), "")
        self.assertEqual(self.nxt("2026-11-30", "daily"), "")
        self.assertEqual(self.nxt("", "weekly"), "")
        self.assertEqual(self.nxt("2026-13-45", "weekly"), "")


class TestNormalizeTask(unittest.TestCase):
    def test_non_dicts_are_dropped(self) -> None:
        self.assertIsNone(server.normalize_task("x"))
        self.assertIsNone(server.normalize_task(None))
        self.assertIsNone(server.normalize_task([1, 2]))
        self.assertEqual(server.normalize_task_list([1, "a", None, {"title": "ok", "id": "a"}])[0]["id"], "a")

    def test_legacy_task_gets_full_schema(self) -> None:
        task = server.normalize_task(
            {"id": "t-1", "title": "  Old  ", "dueDate": "2026-12-01", "status": "inbox", "createdAt": 1000, "completedAt": None}
        )
        self.assertEqual(
            task,
            {
                "id": "t-1",
                "title": "Old",
                "dueDate": "2026-12-01",
                "status": "inbox",
                "previousStatus": "inbox",
                "notes": "",
                "subtasks": [],
                "recurrence": "",
                "recurrenceSpawnedId": None,
                "createdAt": 1000,
                "updatedAt": 1000,
                "completedAt": None,
            },
        )

    def test_garbage_is_sanitized(self) -> None:
        task = server.normalize_task(
            {
                "title": "   ",
                "dueDate": "tomorrow",
                "status": "weird",
                "previousStatus": "done",
                "recurrence": "daily",
                "recurrenceSpawnedId": 7,
                "notes": 5,
                "subtasks": [{"text": " a ", "done": True}, {"text": ""}, "str", {"id": "st-x", "text": "b", "done": "yes"}],
                "createdAt": "bad",
                "completedAt": "2026-11-01",
                "isSample": "yes",
            }
        )
        self.assertTrue(task["id"].startswith("t-"))
        self.assertEqual(task["title"], "Untitled task")
        self.assertEqual(task["dueDate"], "")
        self.assertEqual(task["status"], "inbox")
        self.assertEqual(task["previousStatus"], "inbox")
        self.assertEqual(task["recurrence"], "")
        self.assertIsNone(task["recurrenceSpawnedId"])
        self.assertEqual(task["notes"], "")
        self.assertIsNone(task["completedAt"])
        self.assertNotIn("isSample", task)
        self.assertEqual([s["text"] for s in task["subtasks"]], ["a", "b"])
        self.assertTrue(task["subtasks"][0]["done"])
        self.assertFalse(task["subtasks"][1]["done"])
        self.assertEqual(task["subtasks"][1]["id"], "st-x")
        self.assertIsInstance(task["createdAt"], int)

    def test_invalid_calendar_date_is_rejected(self) -> None:
        self.assertEqual(server.normalize_task({"title": "x", "dueDate": "2026-02-30"})["dueDate"], "")

    def test_samples_showcase_new_features(self) -> None:
        samples = server.create_sample_tasks()
        self.assertEqual({s["recurrence"] for s in samples} - {""}, {"monthly", "quarterly", "yearly"})
        self.assertTrue(any("#home" in s["title"] for s in samples))
        self.assertTrue(any("#health" in s["title"] for s in samples))
        self.assertTrue(any(s["notes"] for s in samples))
        self.assertTrue(any(s["subtasks"] for s in samples))
        for s in samples:
            self.assertEqual(server.normalize_task(s)["id"], s["id"])
            self.assertEqual({k for k in s} - {"isSample"}, {k for k in server.normalize_task(s)} - {"isSample"})

    def test_cross_language_shared_normalize_fixture(self) -> None:
        fixture_path = Path(__file__).resolve().parent / "test_normalize_fixture.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        for raw in fixture["nullCases"]:
            self.assertIsNone(server.normalize_task(raw))
        for case in fixture["cases"]:
            self.assertEqual(server.normalize_task(case["input"]), case["expected"], case["name"])


class StoreTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.data_file = Path(self.tmp_dir.name) / "tasks.json"
        self.store = server.TaskStore(self.data_file)

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()


class TestTaskStore(StoreTestCase):
    def test_creates_starter_file(self) -> None:
        self.assertTrue(self.data_file.exists())
        tasks = self.store.load()
        self.assertGreaterEqual(len(tasks), 4)

    def test_today_task_without_date_stays_undated(self) -> None:
        task = self.store.add_task("Call bank", due_date="", put_in_today=True)
        self.assertEqual(task["status"], "today")
        self.assertEqual(task["dueDate"], "")
        self.assertEqual(task["previousStatus"], "today")

    def test_moving_undated_inbox_task_to_today_keeps_dueDate_empty(self) -> None:
        task = self.store.add_task("Sort desk", due_date="", put_in_today=False)
        self.assertEqual(task["dueDate"], "")
        updated = self.store.update_task(task["id"], {"status": "today"})
        self.assertIsNotNone(updated)
        self.assertEqual(updated["status"], "today")
        self.assertEqual(updated["dueDate"], "", "No phantom deadline when moving to Today")

        back = self.store.update_task(task["id"], {"status": "inbox"})
        self.assertEqual(back["dueDate"], "")
        saved = next(t for t in self.store.load() if t["id"] == task["id"])
        self.assertEqual(saved["dueDate"], "")

    def test_dated_task_keeps_its_date_in_today(self) -> None:
        task = self.store.add_task("Dated", due_date="2027-01-15", put_in_today=True)
        self.assertEqual(task["dueDate"], "2027-01-15")

    def test_invalid_due_date_is_ignored(self) -> None:
        task = self.store.add_task("Bad date", due_date="next friday")
        self.assertEqual(task["dueDate"], "")
        updated = self.store.update_task(task["id"], {"dueDate": "2026-99-99"})
        self.assertEqual(updated["dueDate"], "")
        updated = self.store.update_task(task["id"], {"dueDate": "2027-03-04"})
        self.assertEqual(updated["dueDate"], "2027-03-04")
        updated = self.store.update_task(task["id"], {"dueDate": ""})
        self.assertEqual(updated["dueDate"], "")

    def test_add_task_stores_new_fields(self) -> None:
        task = self.store.add_task(
            "Full",
            due_date="2027-02-01",
            notes="remember",
            subtasks=[{"text": "step 1"}, {"text": "  "}],
            recurrence="weekly",
        )
        self.assertEqual(task["notes"], "remember")
        self.assertEqual(task["recurrence"], "weekly")
        self.assertEqual(len(task["subtasks"]), 1)
        self.assertEqual(task["subtasks"][0]["text"], "step 1")
        self.assertFalse(task["subtasks"][0]["done"])
        self.assertIsNone(task["recurrenceSpawnedId"])
        self.assertEqual(task["createdAt"], task["updatedAt"])
        with self.assertRaises(ValueError):
            self.store.add_task("   ")

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
        self.assertFalse(self.store.delete_task(task["id"]))

    def test_previous_status_tracking(self) -> None:
        inbox_task = self.store.add_task("From inbox")
        done, _ = self.store.update_task_with_spawn(inbox_task["id"], {"status": "done"})
        self.assertEqual(done["previousStatus"], "inbox")

        today_task = self.store.add_task("From today", put_in_today=True)
        done, _ = self.store.update_task_with_spawn(today_task["id"], {"status": "done"})
        self.assertEqual(done["previousStatus"], "today")
        self.assertEqual(done["completedAt"], server.today_key())

        # Completing again does not overwrite previousStatus; reopening clears completion
        again, _ = self.store.update_task_with_spawn(today_task["id"], {"status": "done"})
        self.assertEqual(again["previousStatus"], "today")
        reopened, _ = self.store.update_task_with_spawn(today_task["id"], {"status": "inbox"})
        self.assertEqual(reopened["status"], "inbox")
        self.assertIsNone(reopened["completedAt"])
        self.assertEqual(reopened["previousStatus"], "inbox")

    def test_update_notes_subtasks_recurrence_and_updated_at(self) -> None:
        task = self.store.add_task("Edit me")
        time.sleep(0.01)
        updated = self.store.update_task(
            task["id"],
            {"notes": "hello", "subtasks": [{"id": "st-1", "text": "a", "done": True}], "recurrence": "monthly", "title": " New "},
        )
        self.assertEqual(updated["notes"], "hello")
        self.assertEqual(updated["subtasks"], [{"id": "st-1", "text": "a", "done": True}])
        self.assertEqual(updated["recurrence"], "monthly")
        self.assertEqual(updated["title"], "New")
        self.assertGreater(updated["updatedAt"], task["updatedAt"])
        bad = self.store.update_task(task["id"], {"recurrence": "daily"})
        self.assertEqual(bad["recurrence"], "monthly", "invalid recurrence is ignored")

    def test_unknown_task_update_returns_none(self) -> None:
        self.assertIsNone(self.store.update_task("nope", {"title": "x"}))
        self.assertEqual(self.store.update_task_with_spawn("nope", {}), (None, None))

    def test_clear_completed_and_samples(self) -> None:
        task = self.store.add_task("Finish me")
        self.store.update_task(task["id"], {"status": "done"})
        remaining = self.store.clear_completed()
        self.assertFalse(any(t["status"] == "done" for t in remaining))
        after_samples = self.store.clear_samples()
        self.assertFalse(any(t.get("isSample") for t in after_samples))


class TestRecurrenceSpawning(StoreTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.today = date.today()

    def _make(self, rec: str, due: str, **kwargs) -> dict:
        return self.store.add_task("Repeat me", due_date=due, recurrence=rec, **kwargs)

    def test_each_recurrence_spawns_inbox_copy_at_top(self) -> None:
        cases = {"weekly": 7, "monthly": None, "quarterly": None, "yearly": None}
        for rec in cases:
            due = (self.today + timedelta(days=1)).isoformat()
            task = self._make(rec, due, notes="n")
            done, spawned = self.store.update_task_with_spawn(task["id"], {"status": "done"})
            self.assertIsNotNone(spawned, rec)
            self.assertEqual(spawned["status"], "inbox")
            self.assertEqual(spawned["previousStatus"], "inbox")
            self.assertEqual(spawned["title"], "Repeat me")
            self.assertEqual(spawned["notes"], "n")
            self.assertEqual(spawned["recurrence"], rec)
            self.assertEqual(spawned["dueDate"], server.get_next_recurrence_date(due, rec, self.today))
            self.assertGreater(spawned["dueDate"], self.today.isoformat())
            self.assertIsNone(spawned["recurrenceSpawnedId"])
            self.assertIsNone(spawned["completedAt"])
            self.assertNotEqual(spawned["id"], task["id"])
            self.assertEqual(done["recurrenceSpawnedId"], spawned["id"])
            self.assertEqual(self.store.load()[0]["id"], spawned["id"], "spawned task sits at the top")

    def test_weekly_spawn_date_is_exact(self) -> None:
        due = (self.today + timedelta(days=3)).isoformat()
        task = self._make("weekly", due)
        _, spawned = self.store.update_task_with_spawn(task["id"], {"status": "done"})
        self.assertEqual(spawned["dueDate"], (self.today + timedelta(days=10)).isoformat())

    def test_overdue_task_catches_up_past_today(self) -> None:
        due = (self.today - timedelta(days=40)).isoformat()
        task = self._make("weekly", due)
        _, spawned = self.store.update_task_with_spawn(task["id"], {"status": "done"})
        spawned_due = date.fromisoformat(spawned["dueDate"])
        self.assertGreater(spawned_due, self.today)
        self.assertLessEqual(spawned_due, self.today + timedelta(days=7))
        self.assertEqual((spawned_due - date.fromisoformat(due)).days % 7, 0)

    def test_undated_recurring_task_spawns_from_today(self) -> None:
        task = self._make("weekly", "")
        _, spawned = self.store.update_task_with_spawn(task["id"], {"status": "done"})
        self.assertEqual(spawned["dueDate"], (self.today + timedelta(days=7)).isoformat())

    def test_subtasks_are_cloned_unchecked_with_new_ids(self) -> None:
        task = self._make(
            "monthly",
            (self.today + timedelta(days=2)).isoformat(),
            subtasks=[{"id": "st-a", "text": "one", "done": True}, {"id": "st-b", "text": "two", "done": True}],
        )
        done, spawned = self.store.update_task_with_spawn(task["id"], {"status": "done"})
        self.assertEqual([s["text"] for s in spawned["subtasks"]], ["one", "two"])
        self.assertTrue(all(s["done"] is False for s in spawned["subtasks"]))
        self.assertTrue(all(s["id"] not in ("st-a", "st-b") for s in spawned["subtasks"]))
        self.assertTrue(all(s["done"] for s in done["subtasks"]), "completed task keeps its checks")

    def test_no_duplicate_spawn_on_recheck(self) -> None:
        task = self._make("weekly", (self.today + timedelta(days=1)).isoformat())
        _, first = self.store.update_task_with_spawn(task["id"], {"status": "done"})
        self.store.update_task_with_spawn(task["id"], {"status": "inbox"})
        done, second = self.store.update_task_with_spawn(task["id"], {"status": "done"})
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        self.assertEqual(done["recurrenceSpawnedId"], first["id"])
        self.assertEqual(sum(1 for t in self.store.load() if t["title"] == "Repeat me" and t["status"] != "done"), 1)

    def test_done_to_done_does_not_spawn(self) -> None:
        task = self._make("weekly", (self.today + timedelta(days=1)).isoformat())
        _, first = self.store.update_task_with_spawn(task["id"], {"status": "done"})
        self.store.delete_task(first["id"])
        # Spawned task is gone, but done -> done is not a transition
        _, again = self.store.update_task_with_spawn(task["id"], {"status": "done"})
        self.assertIsNone(again)

    def test_respawns_if_spawned_task_was_deleted(self) -> None:
        task = self._make("weekly", (self.today + timedelta(days=1)).isoformat())
        _, first = self.store.update_task_with_spawn(task["id"], {"status": "done"})
        self.store.delete_task(first["id"])
        self.store.update_task_with_spawn(task["id"], {"status": "inbox"})
        done, second = self.store.update_task_with_spawn(task["id"], {"status": "done"})
        self.assertIsNotNone(second)
        self.assertNotEqual(second["id"], first["id"])
        self.assertEqual(done["recurrenceSpawnedId"], second["id"])

    def test_non_recurring_task_does_not_spawn(self) -> None:
        task = self.store.add_task("One-off", due_date="2027-01-01")
        _, spawned = self.store.update_task_with_spawn(task["id"], {"status": "done"})
        self.assertIsNone(spawned)

    def test_recurrence_set_in_same_patch_as_completion_counts(self) -> None:
        task = self.store.add_task("Late recurrence", due_date=(self.today + timedelta(days=1)).isoformat())
        _, spawned = self.store.update_task_with_spawn(task["id"], {"recurrence": "weekly", "status": "done"})
        self.assertIsNotNone(spawned)


class TestPersistenceSafety(StoreTestCase):
    def test_save_is_atomic_and_leaves_no_temp_files(self) -> None:
        self.store.add_task("one")
        self.store.add_task("two")
        leftovers = [p.name for p in Path(self.tmp_dir.name).iterdir() if p.name != "tasks.json"]
        self.assertEqual(leftovers, [])
        # The real file is always complete, valid JSON
        self.assertIsInstance(json.loads(self.data_file.read_text(encoding="utf-8")), list)

    def test_failed_write_keeps_old_file_and_cleans_temp(self) -> None:
        before = self.data_file.read_text(encoding="utf-8")

        class Boom:  # json.dumps cannot serialize this
            pass

        with self.assertRaises(TypeError):
            self.store.save([{"id": "x", "boom": Boom()}])
        self.assertEqual(self.data_file.read_text(encoding="utf-8"), before)
        self.assertEqual([p.name for p in Path(self.tmp_dir.name).iterdir()], ["tasks.json"])

    def test_save_uses_os_replace_from_same_directory(self) -> None:
        calls = []
        real_replace = os.replace

        def spy(src, dst):
            calls.append((Path(src).parent, Path(dst)))
            return real_replace(src, dst)

        os.replace = spy
        try:
            self.store.save([])
        finally:
            os.replace = real_replace
        self.assertEqual(calls, [(self.data_file.parent, self.data_file)])

    def test_corrupt_json_is_backed_up_not_lost(self) -> None:
        self.data_file.write_text("{ this is not json", encoding="utf-8")
        self.assertEqual(self.store.load(), [])
        backups = list(Path(self.tmp_dir.name).glob("tasks.json.corrupt.*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(encoding="utf-8"), "{ this is not json")
        # Loading again must not pile up identical backups
        self.store.load()
        self.assertEqual(len(list(Path(self.tmp_dir.name).glob("tasks.json.corrupt.*"))), 1)

    def test_non_list_json_is_also_backed_up(self) -> None:
        self.data_file.write_text('{"oops": true}', encoding="utf-8")
        self.assertEqual(self.store.load(), [])
        self.assertEqual(len(list(Path(self.tmp_dir.name).glob("tasks.json.corrupt.*"))), 1)

    def test_load_upgrades_legacy_tasks(self) -> None:
        self.data_file.write_text(
            json.dumps([{"id": "old", "title": "Legacy", "dueDate": "", "status": "today", "createdAt": 5, "completedAt": None}]),
            encoding="utf-8",
        )
        task = self.store.load()[0]
        self.assertEqual(task["dueDate"], "")
        self.assertEqual(task["subtasks"], [])
        self.assertEqual(task["recurrence"], "")
        self.assertEqual(task["previousStatus"], "today")

    def test_get_mtime_ms(self) -> None:
        mtime = self.store.get_mtime_ms()
        self.assertIsInstance(mtime, int)
        self.assertEqual(mtime, int(self.data_file.stat().st_mtime * 1000))
        missing = server.TaskStore.__new__(server.TaskStore)
        missing.file_path = Path(self.tmp_dir.name) / "nope.json"
        self.assertEqual(missing.get_mtime_ms(), 0)

    def test_concurrent_adds_are_not_lost(self) -> None:
        before = len(self.store.load())

        def worker(n: int) -> None:
            for i in range(10):
                self.store.add_task(f"t{n}-{i}")

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(self.store.load()), before + 50)

    def test_store_conflict_check(self) -> None:
        stale = self.store.get_mtime_ms() - 5000
        with self.assertRaises(server.ConflictError):
            self.store.add_task("nope", expected_mtime_ms=stale)
        task = self.store.add_task("forced", expected_mtime_ms=stale, force=True)
        self.assertEqual(task["title"], "forced")
        # Matching mtime (within tolerance) is fine
        self.store.add_task("fine", expected_mtime_ms=self.store.get_mtime_ms() + 30)


class TestImportAndRestore(StoreTestCase):
    def test_replace_sanitizes_and_drops_junk(self) -> None:
        result = self.store.import_tasks(
            [
                {"id": "a", "title": "  Keep  ", "status": "bogus", "dueDate": "nonsense", "recurrence": "daily"},
                "junk",
                None,
                42,
                {"id": "a", "title": "Duplicate id"},
                {"id": "b", "title": "Second", "subtasks": [{"text": "s"}]},
            ],
            mode="replace",
        )
        self.assertEqual([t["id"] for t in result], ["a", "b"])
        self.assertEqual(result[0]["title"], "Keep")
        self.assertEqual(result[0]["status"], "inbox")
        self.assertEqual(result[0]["dueDate"], "")
        self.assertEqual(result[0]["recurrence"], "")
        self.assertEqual(json.loads(self.data_file.read_text(encoding="utf-8")), result)

    def test_merge_keeps_newer_and_appends_new(self) -> None:
        self.store.import_tasks(
            [
                {"id": "a", "title": "A old", "createdAt": 1, "updatedAt": 100},
                {"id": "b", "title": "B new", "createdAt": 1, "updatedAt": 500},
                {"id": "c", "title": "C same", "createdAt": 1, "updatedAt": 300},
            ]
        )
        merged = self.store.import_tasks(
            [
                {"id": "a", "title": "A updated", "createdAt": 1, "updatedAt": 200},
                {"id": "b", "title": "B stale", "createdAt": 1, "updatedAt": 400},
                {"id": "c", "title": "C tie", "createdAt": 1, "updatedAt": 300},
                {"id": "d", "title": "D brand new", "createdAt": 1, "updatedAt": 50},
            ],
            mode="merge",
        )
        titles = {t["id"]: t["title"] for t in merged}
        self.assertEqual(titles, {"a": "A updated", "b": "B new", "c": "C same", "d": "D brand new"})
        self.assertEqual([t["id"] for t in merged], ["a", "b", "c", "d"], "order kept, new tasks appended")

    def test_merge_with_existing_samples_does_not_wipe_data(self) -> None:
        before = {t["id"] for t in self.store.load()}
        merged = self.store.import_tasks([{"id": "zzz", "title": "Extra"}], mode="merge")
        self.assertTrue(before.issubset({t["id"] for t in merged}))
        self.assertIn("zzz", {t["id"] for t in merged})

    def test_bad_import_input(self) -> None:
        with self.assertRaises(ValueError):
            self.store.import_tasks({"not": "a list"})  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            self.store.import_tasks([], mode="explode")

    def test_restore_snapshot_roundtrip(self) -> None:
        snapshot = self.store.load()
        task = self.store.add_task("Oops added")
        self.store.update_task(snapshot[0]["id"], {"status": "done"})
        self.store.delete_task(snapshot[1]["id"])
        restored = self.store.restore_snapshot(snapshot)
        self.assertEqual(restored, snapshot)
        self.assertEqual(self.store.load(), snapshot)
        self.assertFalse(any(t["id"] == task["id"] for t in self.store.load()))
        with self.assertRaises(ValueError):
            self.store.restore_snapshot("nope")  # type: ignore[arg-type]


class TestHttpApi(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.data_file = Path(self.tmp_dir.name) / "tasks.json"
        self.store = server.TaskStore(self.data_file)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(self.store))
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(
            target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        )
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp_dir.cleanup()

    def _raw(self, method: str, path: str, payload=None, headers: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req_headers = {"Content-Type": "application/json"}
        req_headers.update(headers or {})
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=req_headers
        )
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            with err:
                return err.code, json.loads(err.read().decode("utf-8"))

    def _req(self, method: str, path: str, payload=None) -> dict:
        status, body = self._raw(method, path, payload)
        self.assertLess(status, 400, body)
        return body

    def test_get_post_patch_delete_roundtrip(self) -> None:
        initial = self._req("GET", "/api/tasks")
        self.assertIn("tasks", initial)
        self.assertIn("dataFile", initial)
        self.assertIsInstance(initial["mtimeMs"], int)
        self.assertEqual(initial["mtimeMs"], self.store.get_mtime_ms())

        status, created = self._raw("POST", "/api/tasks", {"title": "API test", "dueDate": "", "today": True})
        self.assertEqual(status, 201)
        task_id = created["task"]["id"]
        self.assertEqual(created["task"]["dueDate"], "", "Today does not invent a deadline")
        self.assertEqual(created["task"]["status"], "today")
        self.assertEqual(created["mtimeMs"], self.store.get_mtime_ms())
        self.assertTrue(any(t["id"] == task_id for t in created["tasks"]))

        patched = self._req("PATCH", f"/api/tasks/{task_id}", {"status": "done"})
        self.assertEqual(patched["task"]["status"], "done")
        self.assertEqual(patched["task"]["previousStatus"], "today")
        self.assertIsNone(patched["spawnedTask"])
        self.assertIn("mtimeMs", patched)

        deleted = self._req("DELETE", f"/api/tasks/{task_id}")
        self.assertFalse(any(t["id"] == task_id for t in deleted["tasks"]))
        self.assertIn("mtimeMs", deleted)

    def test_post_with_all_new_fields(self) -> None:
        _, created = self._raw(
            "POST",
            "/api/tasks",
            {"title": "Rich", "dueDate": "2027-05-01", "notes": "n", "subtasks": [{"text": "x"}], "recurrence": "yearly"},
        )
        task = created["task"]
        self.assertEqual((task["notes"], task["recurrence"], task["dueDate"]), ("n", "yearly", "2027-05-01"))
        self.assertEqual(task["subtasks"][0]["text"], "x")

    def test_post_empty_title_is_400(self) -> None:
        status, body = self._raw("POST", "/api/tasks", {"title": "  "})
        self.assertEqual(status, 400)
        self.assertIn("error", body)

    def test_patch_spawns_recurring_task(self) -> None:
        due = (date.today() + timedelta(days=1)).isoformat()
        _, created = self._raw("POST", "/api/tasks", {"title": "Weekly chore", "dueDate": due, "recurrence": "weekly"})
        task_id = created["task"]["id"]
        patched = self._req("PATCH", f"/api/tasks/{task_id}", {"status": "done"})
        spawned = patched["spawnedTask"]
        self.assertIsNotNone(spawned)
        self.assertEqual(spawned["status"], "inbox")
        self.assertEqual(spawned["dueDate"], (date.today() + timedelta(days=8)).isoformat())
        self.assertEqual(patched["task"]["recurrenceSpawnedId"], spawned["id"])
        self.assertEqual(patched["tasks"][0]["id"], spawned["id"])

        again = self._req("PATCH", f"/api/tasks/{task_id}", {"status": "today"})
        again = self._req("PATCH", f"/api/tasks/{task_id}", {"status": "done"})
        self.assertIsNone(again["spawnedTask"])

    def test_patch_unknown_task_is_404(self) -> None:
        status, _ = self._raw("PATCH", "/api/tasks/nope", {"title": "x"})
        self.assertEqual(status, 404)
        status, _ = self._raw("DELETE", "/api/tasks/nope")
        self.assertEqual(status, 404)

    def test_conflict_409_on_stale_mtime(self) -> None:
        _, created = self._raw("POST", "/api/tasks", {"title": "Conflict me"})
        task_id = created["task"]["id"]
        stale = created["mtimeMs"] - 5000  # as if someone else edited tasks.json since

        status, body = self._raw("PATCH", f"/api/tasks/{task_id}", {"title": "Mine", "expectedMtimeMs": stale})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"], "File modified externally")
        self.assertIs(body["conflict"], True)
        self.assertEqual(body["mtimeMs"], self.store.get_mtime_ms())
        self.assertEqual(next(t for t in body["tasks"] if t["id"] == task_id)["title"], "Conflict me")
        self.assertEqual(next(t for t in self.store.load() if t["id"] == task_id)["title"], "Conflict me")

        status, body = self._raw("POST", "/api/tasks", {"title": "Blocked", "expectedMtimeMs": stale})
        self.assertEqual(status, 409)
        self.assertFalse(any(t["title"] == "Blocked" for t in self.store.load()))

        status, body = self._raw("DELETE", f"/api/tasks/{task_id}?expectedMtimeMs={stale}")
        self.assertEqual(status, 409)
        self.assertTrue(any(t["id"] == task_id for t in self.store.load()))

        status, body = self._raw("DELETE", f"/api/tasks/{task_id}", {"expectedMtimeMs": stale})
        self.assertEqual(status, 409)

        # Bulk / import / restore endpoints also enforce expectedMtimeMs
        status, _ = self._raw("POST", "/api/tasks/clear-done", {"expectedMtimeMs": stale})
        self.assertEqual(status, 409)
        status, _ = self._raw("POST", "/api/tasks/clear-samples", {"expectedMtimeMs": stale})
        self.assertEqual(status, 409)
        status, _ = self._raw("POST", "/api/tasks/import", {"tasks": [], "expectedMtimeMs": stale})
        self.assertEqual(status, 409)
        status, _ = self._raw("POST", "/api/tasks/restore", {"tasks": [], "expectedMtimeMs": stale})
        self.assertEqual(status, 409)

    def test_force_overrides_conflict(self) -> None:
        _, created = self._raw("POST", "/api/tasks", {"title": "Force me"})
        task_id = created["task"]["id"]
        stale = created["mtimeMs"] - 5000

        status, body = self._raw(
            "PATCH", f"/api/tasks/{task_id}", {"title": "Forced", "expectedMtimeMs": stale, "force": True}
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["task"]["title"], "Forced")

        status, _ = self._raw("POST", "/api/tasks", {"title": "Forced add", "expectedMtimeMs": stale, "force": True})
        self.assertEqual(status, 201)

        status, _ = self._raw("DELETE", f"/api/tasks/{task_id}?expectedMtimeMs={stale}&force=true")
        self.assertEqual(status, 200)

    def test_matching_mtime_is_accepted(self) -> None:
        current = self._req("GET", "/api/tasks")["mtimeMs"]
        status, body = self._raw("POST", "/api/tasks", {"title": "Fresh", "expectedMtimeMs": current})
        self.assertEqual(status, 201)
        status, _ = self._raw(
            "PATCH", f"/api/tasks/{body['task']['id']}", {"title": "Fresh 2", "expectedMtimeMs": body["mtimeMs"]}
        )
        self.assertEqual(status, 200)

    def test_external_edit_triggers_conflict(self) -> None:
        loaded = self._req("GET", "/api/tasks")
        tasks = json.loads(self.data_file.read_text(encoding="utf-8"))
        tasks.append({"id": "external", "title": "Added in Notepad", "status": "inbox"})
        self.data_file.write_text(json.dumps(tasks), encoding="utf-8")
        future = time.time() + 5
        os.utime(self.data_file, (future, future))

        status, body = self._raw("POST", "/api/tasks", {"title": "Mine", "expectedMtimeMs": loaded["mtimeMs"]})
        self.assertEqual(status, 409)
        self.assertTrue(any(t["id"] == "external" for t in body["tasks"]))

    def test_clear_done_and_clear_samples(self) -> None:
        _, created = self._raw("POST", "/api/tasks", {"title": "Clear me"})
        self._req("PATCH", f"/api/tasks/{created['task']['id']}", {"status": "done"})
        cleared = self._req("POST", "/api/tasks/clear-done", {})
        self.assertFalse(any(t["status"] == "done" for t in cleared["tasks"]))
        self.assertIn("mtimeMs", cleared)
        no_samples = self._req("POST", "/api/tasks/clear-samples", {})
        self.assertFalse(any(t.get("isSample") for t in no_samples["tasks"]))
        self.assertIn("mtimeMs", no_samples)

    def test_import_replace_and_merge(self) -> None:
        replaced = self._req(
            "POST",
            "/api/tasks/import",
            {"tasks": [{"id": "a", "title": "Only", "updatedAt": 10, "createdAt": 1}, "junk"], "mode": "replace"},
        )
        self.assertEqual([t["id"] for t in replaced["tasks"]], ["a"])
        self.assertIn("mtimeMs", replaced)

        merged = self._req(
            "POST",
            "/api/tasks/import",
            {
                "tasks": [
                    {"id": "a", "title": "Newer", "updatedAt": 20, "createdAt": 1},
                    {"id": "b", "title": "Added", "updatedAt": 5, "createdAt": 1},
                ],
                "mode": "merge",
            },
        )
        self.assertEqual({t["id"]: t["title"] for t in merged["tasks"]}, {"a": "Newer", "b": "Added"})

        # Default mode is replace; a bare list is accepted too
        default = self._req("POST", "/api/tasks/import", {"tasks": [{"id": "z", "title": "Z"}]})
        self.assertEqual([t["id"] for t in default["tasks"]], ["z"])
        bare = self._req("POST", "/api/tasks/import", [{"id": "y", "title": "Y"}])
        self.assertEqual([t["id"] for t in bare["tasks"]], ["y"])

    def test_import_rejects_bad_payloads(self) -> None:
        status, _ = self._raw("POST", "/api/tasks/import", {"tasks": "nope"})
        self.assertEqual(status, 400)
        status, _ = self._raw("POST", "/api/tasks/import", {"tasks": [], "mode": "boom"})
        self.assertEqual(status, 400)
        status, _ = self._raw("POST", "/api/tasks/import", {"other": 1})
        self.assertEqual(status, 400)
        self.assertGreaterEqual(len(self.store.load()), 4, "a rejected import changes nothing")

    def test_restore_snapshot_endpoint(self) -> None:
        snapshot = self._req("GET", "/api/tasks")["tasks"]
        self._req("POST", "/api/tasks", {"title": "Mistake"})
        self._req("POST", "/api/tasks/clear-samples", {})
        restored = self._req("POST", "/api/tasks/restore", {"tasks": snapshot})
        self.assertEqual(restored["tasks"], snapshot)
        self.assertEqual(self.store.load(), snapshot)
        self.assertIn("mtimeMs", restored)
        status, _ = self._raw("POST", "/api/tasks/restore", {"tasks": "nope"})
        self.assertEqual(status, 400)

    def test_forbidden_origin_is_403(self) -> None:
        bad = {"Origin": "http://evil.example.com"}
        before = self.store.load()

        status, body = self._raw("POST", "/api/tasks", {"title": "Attack"}, bad)
        self.assertEqual(status, 403)
        self.assertEqual(body, {"error": "Forbidden origin"})
        status, _ = self._raw("PATCH", f"/api/tasks/{before[0]['id']}", {"title": "Hacked"}, bad)
        self.assertEqual(status, 403)
        status, _ = self._raw("DELETE", f"/api/tasks/{before[0]['id']}", None, bad)
        self.assertEqual(status, 403)
        status, _ = self._raw("POST", "/api/tasks/import", {"tasks": []}, bad)
        self.assertEqual(status, 403)
        status, _ = self._raw("POST", "/api/tasks/clear-done", {}, bad)
        self.assertEqual(status, 403)
        # Look-alike hostnames are blocked too
        status, _ = self._raw("POST", "/api/tasks", {"title": "x"}, {"Origin": "http://localhost.evil.com"})
        self.assertEqual(status, 403)
        status, _ = self._raw("POST", "/api/tasks", {"title": "x"}, {"Origin": "null"})
        self.assertEqual(status, 403)
        status, _ = self._raw("POST", "/api/tasks", {"title": "x"}, {"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)
        self.assertEqual(self.store.load(), before, "nothing changed")

    def test_editing_sample_clears_sample_flag(self) -> None:
        sample = next(t for t in self.store.load() if t.get("isSample"))
        updated = self._req("PATCH", f"/api/tasks/{sample['id']}", {"title": "My customized task"})
        self.assertNotIn("isSample", updated["task"])
        after_clear = self._req("POST", "/api/tasks/clear-samples", {})
        self.assertTrue(any(t["id"] == sample["id"] for t in after_clear["tasks"]))

    def test_local_origins_are_allowed(self) -> None:
        for origin in (f"http://127.0.0.1:{self.port}", "http://localhost:4173", "http://localhost"):
            status, _ = self._raw("POST", "/api/tasks", {"title": f"from {origin}"}, {"Origin": origin})
            self.assertEqual(status, 201, origin)
        # GET is read-only and never origin-blocked
        status, _ = self._raw("GET", "/api/tasks", None, {"Origin": "http://evil.example.com"})
        self.assertEqual(status, 200)

    def test_forbidden_host_is_403(self) -> None:
        for bad_host in ("evil.example.com", "localhost.evil.com:4173", "192.168.1.5:4173"):
            status, body = self._raw("GET", "/api/tasks", None, {"Host": bad_host})
            self.assertEqual(status, 403, bad_host)
            self.assertEqual(body, {"error": "Forbidden host"})
            status, _ = self._raw("POST", "/api/tasks", {"title": "x"}, {"Host": bad_host})
            self.assertEqual(status, 403, bad_host)
        for good_host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}", "localhost"):
            status, _ = self._raw("GET", "/api/tasks", None, {"Host": good_host})
            self.assertEqual(status, 200, good_host)

    def test_invalid_json_is_400(self) -> None:
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/tasks",
            data=b"{not json",
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        with ctx.exception:
            self.assertEqual(ctx.exception.code, 400)


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
            self.assertEqual(content.count("</script>"), 2)

            committed = build_portable.OUTPUT_FILE
            if committed.exists():
                self.assertEqual(
                    committed.read_text(encoding="utf-8"),
                    content,
                    "horizon-portable.html is stale — run py build_portable.py",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
