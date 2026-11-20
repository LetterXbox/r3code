from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools.backup_r3_databases import backup_databases, offline_database_digest


class BackupDatabaseTest(unittest.TestCase):
    def make_database(self, home):
        root = home / ".t3codegpui"
        source = root / "server/userdata"
        source.mkdir(mode=0o700, parents=True)
        root.chmod(0o700)
        database = source / "statev2.sqlite"
        with sqlite3.connect(database) as connection:
            connection.execute("create table example (value text)")
            connection.execute("insert into example values ('kept')")
        return database

    def test_creates_private_consistent_backup(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            self.make_database(home)
            target = backup_databases(home)
            self.assertIsNotNone(target)
            with sqlite3.connect(target / "statev2.sqlite") as connection:
                self.assertEqual(connection.execute("select value from example").fetchone(), ("kept",))
            self.assertEqual((target / "statev2.sqlite").stat().st_mode & 0o777, 0o600)

    def test_keeps_t3_and_r3_backups_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            database = self.make_database(home)
            native = home / ".r3/server/userdata"
            native.mkdir(parents=True)
            with sqlite3.connect(database) as legacy, sqlite3.connect(native / "statev2.sqlite") as current:
                legacy.backup(current)
                current.execute("update example set value = 'native'")
            t3 = home / ".t3/userdata"
            t3.mkdir(parents=True)
            with sqlite3.connect(t3 / "statev2.sqlite") as connection:
                connection.execute("create table example (value text)")
                connection.execute("insert into example values ('t3')")
            target = backup_databases(home, include_t3=True)
            self.assertTrue((target / "statev2.sqlite").is_file())
            with sqlite3.connect(target / "r3-native/statev2.sqlite") as connection:
                self.assertEqual(connection.execute("select value from example").fetchone(), ("native",))
            with sqlite3.connect(target / "t3/statev2.sqlite") as connection:
                self.assertEqual(connection.execute("select value from example").fetchone(), ("t3",))

    def test_offline_snapshot_refuses_a_journal_or_open_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = self.make_database(Path(temporary))
            journal = Path(str(database) + "-wal")
            journal.touch()
            with self.assertRaisesRegex(RuntimeError, "journal"):
                offline_database_digest(database)
            journal.unlink()
            with patch("tools.backup_r3_databases.subprocess.run", return_value=subprocess.CompletedProcess([], 0, b"123", b"")):
                with self.assertRaisesRegex(RuntimeError, "in use"):
                    offline_database_digest(database)

    def test_immutable_fallback_detects_database_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            self.make_database(home)
            actual_connect = sqlite3.connect

            class UnavailableReadOnly:
                def execute(self, _statement):
                    raise sqlite3.OperationalError("unavailable")

                def close(self):
                    pass

            def connect(path, *args, **kwargs):
                if isinstance(path, str) and path.endswith("?mode=ro"):
                    return UnavailableReadOnly()
                return actual_connect(path, *args, **kwargs)

            with patch("tools.backup_r3_databases.sqlite3.connect", side_effect=connect), patch("tools.backup_r3_databases.offline_database_digest", side_effect=["before", "after"]):
                with self.assertRaisesRegex(RuntimeError, "changed"):
                    backup_databases(home)

    def test_immutable_fallback_closes_source_before_checking_for_writers(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            self.make_database(home)
            actual_connect = sqlite3.connect

            class UnavailableReadOnly:
                def execute(self, _statement):
                    raise sqlite3.OperationalError("unavailable")

                def close(self):
                    pass

            def connect(path, *args, **kwargs):
                if isinstance(path, str) and path.endswith("?mode=ro"):
                    return UnavailableReadOnly()
                return actual_connect(path, *args, **kwargs)

            with patch("tools.backup_r3_databases.sqlite3.connect", side_effect=connect):
                target = backup_databases(home)
            self.assertIsNotNone(target)


if __name__ == "__main__":
    unittest.main()
