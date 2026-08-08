import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing, redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
STATISTICS_DIR = ROOT / "rfi-proxy" / "statistics"
sys.path.insert(0, str(STATISTICS_DIR))

from snapshot_statistics import main as snapshot_main  # noqa: E402
from statistics_snapshot import (  # noqa: E402
    SnapshotPolicy,
    assert_prepared_snapshot_unchanged,
    create_prepared_snapshot,
    list_prepared_snapshots,
    load_prepared_snapshot,
    release_prepared_snapshot,
    snapshot_lock,
)


class InjectedFailure(RuntimeError):
    pass


class StatisticsSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "statistics.db"
        self.handoff = self.root / "handoff"
        self.created_at = datetime(2026, 8, 6, 14, 5, tzinfo=timezone.utc)
        self.policy = SnapshotPolicy.from_environment(
            created_at=self.created_at,
            environment={},
        )
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("CREATE TABLE events(id INTEGER PRIMARY KEY, value TEXT)")
            connection.execute("INSERT INTO events(value) VALUES ('before-wal')")
            connection.commit()

    def tearDown(self):
        self.temporary.cleanup()

    def create(self, **kwargs):
        return create_prepared_snapshot(
            self.database,
            self.handoff,
            self.policy,
            created_at=self.created_at,
            **kwargs,
        )

    def test_list_accepts_a_fresh_empty_handoff_root(self):
        self.handoff.mkdir()

        self.assertEqual(
            list_prepared_snapshots(self.handoff, now=self.created_at),
            [],
        )
        self.assertFalse((self.handoff / "snapshots").exists())
        self.assertFalse((self.handoff / "receipts").exists())

    def test_list_rejects_an_uninitialized_root_with_unexpected_artifacts(self):
        self.handoff.mkdir()
        (self.handoff / "unexpected.txt").write_text("unexpected", encoding="utf-8")

        with self.assertRaisesRegex(RuntimeError, "unexpected artifacts"):
            list_prepared_snapshots(self.handoff, now=self.created_at)

    def test_pinned_wal_view_excludes_later_commit_without_blocking_writer(self):
        writer = sqlite3.connect(self.database, timeout=1)
        try:
            self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("INSERT INTO events(value) VALUES ('committed-in-wal')")
            writer.commit()
            self.assertTrue(Path(f"{self.database}-wal").exists())

            stages = []

            def after_pin(stage):
                stages.append(stage)
                if stage == "source_pinned":
                    writer.execute("INSERT INTO events(value) VALUES ('after-pin')")
                    writer.commit()
                    self.assertEqual(
                        writer.execute("SELECT COUNT(*) FROM events").fetchone()[0],
                        3,
                    )

            snapshot = self.create(stage_hook=after_pin)
            self.assertIn("source_pinned", stages)
            with closing(
                sqlite3.connect(
                    f"file:{snapshot.database_path.as_posix()}?mode=ro&immutable=1",
                    uri=True,
                )
            ) as copied:
                self.assertEqual(
                    copied.execute("SELECT value FROM events ORDER BY id").fetchall(),
                    [("before-wal",), ("committed-in-wal",)],
                )
        finally:
            writer.close()

    def test_receipt_is_published_only_after_database_validation(self):
        snapshot = self.create()
        receipt = json.loads(snapshot.receipt_path.read_text(encoding="utf-8"))

        self.assertEqual(receipt["formatVersion"], 1)
        self.assertEqual(receipt["snapshotId"], snapshot.snapshot_id)
        self.assertEqual(
            receipt["database"]["path"],
            f"snapshots/{snapshot.snapshot_id}.db",
        )
        self.assertEqual(receipt["database"]["bytes"], snapshot.database_bytes)
        self.assertEqual(receipt["database"]["pageCount"], snapshot.page_count)
        self.assertEqual(receipt["policy"]["asOfDate"], "2026-08-06")
        self.assertEqual(receipt["policy"]["timezoneName"], "Europe/Rome")
        self.assertEqual(
            list_prepared_snapshots(
                self.handoff,
                now=self.created_at,
            ),
            [snapshot],
        )
        assert_prepared_snapshot_unchanged(snapshot)
        with closing(
            sqlite3.connect(
                f"file:{snapshot.database_path.as_posix()}?mode=ro&immutable=1",
                uri=True,
            )
        ) as copied:
            self.assertEqual(copied.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        self.assertFalse(Path(f"{snapshot.database_path}-wal").exists())
        self.assertFalse(Path(f"{snapshot.database_path}-shm").exists())

    def test_failure_before_receipt_publish_leaves_no_visible_or_partial_snapshot(self):
        def fail(stage):
            if stage == "before_receipt_publish":
                raise InjectedFailure("stop before receipt publication")

        with self.assertRaisesRegex(InjectedFailure, "before receipt"):
            self.create(stage_hook=fail)

        self.assertEqual(list((self.handoff / "receipts").iterdir()), [])
        self.assertEqual(list((self.handoff / "snapshots").iterdir()), [])
        self.assertEqual(
            list_prepared_snapshots(self.handoff, now=self.created_at),
            [],
        )

    def test_nonblocking_lock_rejects_a_second_snapshot_producer(self):
        with snapshot_lock(self.handoff):
            with self.assertRaisesRegex(
                RuntimeError, "another statistics snapshot is active"
            ):
                self.create()

    def test_create_rejects_existing_or_interrupted_handoff_artifacts(self):
        snapshot = self.create()
        with self.assertRaisesRegex(RuntimeError, "handoff is not empty"):
            self.create()

        release_prepared_snapshot(self.handoff, snapshot.snapshot_id)
        orphan = self.handoff / "snapshots" / ".interrupted.db.partial"
        orphan.write_bytes(b"partial")
        with self.assertRaisesRegex(RuntimeError, "interrupted artifacts"):
            self.create()

    def test_create_checks_capacity_before_writing_partial_file(self):
        with self.assertRaisesRegex(RuntimeError, "insufficient free space"):
            self.create(minimum_free_bytes=2**63)
        self.assertEqual(list((self.handoff / "snapshots").iterdir()), [])

    def test_capacity_uses_pinned_logical_pages_including_uncheckpointed_wal(self):
        writer = sqlite3.connect(self.database)
        try:
            self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("CREATE TABLE wal_growth(payload BLOB)")
            writer.execute("INSERT INTO wal_growth VALUES (zeroblob(16777216))")
            writer.commit()

            main_file_bytes = self.database.stat().st_size
            logical_bytes = (
                int(writer.execute("PRAGMA page_size").fetchone()[0])
                * int(writer.execute("PRAGMA page_count").fetchone()[0])
            )
            self.assertGreater(logical_bytes, main_file_bytes)
            simulated_free = (main_file_bytes + logical_bytes) // 2
            self.assertGreater(simulated_free, main_file_bytes)
            self.assertLess(simulated_free, logical_bytes)

            with patch(
                "statistics_snapshot.shutil.disk_usage",
                return_value=SimpleNamespace(free=simulated_free),
            ):
                with self.assertRaisesRegex(RuntimeError, "insufficient free space"):
                    self.create(minimum_free_bytes=0)
            self.assertEqual(list((self.handoff / "snapshots").iterdir()), [])
        finally:
            writer.close()

    def test_load_rejects_traversal_sidecars_stale_and_future_receipts(self):
        snapshot = self.create()
        receipt = json.loads(snapshot.receipt_path.read_text(encoding="utf-8"))
        receipt["database"]["path"] = "../statistics.db"
        snapshot.receipt_path.write_text(
            json.dumps(receipt), encoding="utf-8"
        )
        with self.assertRaisesRegex(RuntimeError, "canonical relative path"):
            load_prepared_snapshot(
                self.handoff,
                snapshot.snapshot_id,
                now=self.created_at,
            )

        snapshot.receipt_path.unlink()
        snapshot.database_path.unlink()
        replacement = self.create()
        sidecar = Path(f"{replacement.database_path}-wal")
        sidecar.write_bytes(b"")
        with self.assertRaisesRegex(RuntimeError, "forbidden sidecar"):
            load_prepared_snapshot(
                self.handoff,
                replacement.snapshot_id,
                now=self.created_at,
            )
        sidecar.unlink()

        with self.assertRaisesRegex(RuntimeError, "stale"):
            load_prepared_snapshot(
                self.handoff,
                replacement.snapshot_id,
                max_age_hours=1,
                now=self.created_at + timedelta(hours=2),
            )
        with self.assertRaisesRegex(RuntimeError, "future"):
            load_prepared_snapshot(
                self.handoff,
                replacement.snapshot_id,
                now=self.created_at - timedelta(seconds=1),
            )

    def test_load_rejects_symlinked_database(self):
        snapshot = self.create()
        original = self.root / "original-snapshot.db"
        snapshot.database_path.replace(original)
        try:
            os.symlink(original, snapshot.database_path)
        except (OSError, NotImplementedError):
            self.skipTest("creating a file symlink is not available")
        with self.assertRaisesRegex(RuntimeError, "not a regular file"):
            load_prepared_snapshot(
                self.handoff,
                snapshot.snapshot_id,
                now=self.created_at,
            )

    def test_unchanged_guard_detects_receipt_and_database_replacement(self):
        snapshot = self.create()
        snapshot.receipt_path.write_bytes(snapshot.receipt_path.read_bytes() + b" ")
        with self.assertRaisesRegex(RuntimeError, "receipt changed"):
            assert_prepared_snapshot_unchanged(snapshot)

        snapshot.receipt_path.write_bytes(
            snapshot.receipt_path.read_bytes().rstrip() + b"\n"
        )
        loaded = load_prepared_snapshot(
            self.handoff,
            snapshot.snapshot_id,
            now=self.created_at,
        )
        with snapshot.database_path.open("ab") as handle:
            handle.write(b"changed")
        with self.assertRaisesRegex(RuntimeError, "database changed"):
            assert_prepared_snapshot_unchanged(loaded)

    def test_release_revokes_receipt_and_then_removes_exact_database(self):
        snapshot = self.create()
        released = release_prepared_snapshot(self.handoff, snapshot.snapshot_id)

        self.assertEqual(released.snapshot_id, snapshot.snapshot_id)
        self.assertFalse(snapshot.receipt_path.exists())
        self.assertFalse(snapshot.database_path.exists())
        self.assertEqual(
            list_prepared_snapshots(self.handoff, now=self.created_at),
            [],
        )
        with self.assertRaises(ValueError):
            release_prepared_snapshot(self.handoff, "../wrong")

    def test_cli_keeps_progress_on_stderr_and_emits_only_json_on_stdout(self):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            exit_code = snapshot_main(
                [
                    "--source-db",
                    str(self.database),
                    "--handoff-root",
                    str(self.handoff),
                    "prepare",
                ]
            )

        self.assertEqual(exit_code, 0)
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["mode"], "prepare")
        self.assertIn("[statistics-snapshot] snapshot 100%", stderr.getvalue())
        self.assertNotIn("[statistics-snapshot]", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
