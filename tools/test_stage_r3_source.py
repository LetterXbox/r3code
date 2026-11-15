from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.stage_r3_source import source_files, source_tree_digest, verify_candidate_sources


class SourceSnapshotTest(unittest.TestCase):
    def test_candidate_digest_detects_changes_to_content_mode_and_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.rs"
            source.write_text("before")
            (root / "other.rs").write_text("other")
            link = root / "link"
            link.symlink_to("source.rs")
            with patch("tools.stage_r3_source.git", return_value=b"source.rs\0other.rs\0link\0"):
                original = source_tree_digest(root)
                verify_candidate_sources({"r3SourceTreeSha256": original}, root, root)
                source.write_text("after")
                with self.assertRaisesRegex(RuntimeError, "r3SourceTreeSha256"):
                    verify_candidate_sources({"r3SourceTreeSha256": original}, root, root)
                source.write_text("before")
                source.chmod(0o755)
                self.assertNotEqual(original, source_tree_digest(root))
                source.chmod(0o644)
                link.unlink()
                link.symlink_to("other.rs")
                self.assertNotEqual(original, source_tree_digest(root))

    def test_skips_patch_backups_and_missing_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "source.rs").write_text("source")
            (root / "source.rs.orig").write_text("backup")
            with patch("tools.stage_r3_source.git", return_value=b"source.rs\0source.rs.orig\0deleted.rs\0"):
                self.assertEqual(source_files(root), ["source.rs"])

    def test_rejects_secrets_and_links_outside_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            with patch("tools.stage_r3_source.git", return_value=b".env.local\0"):
                with self.assertRaisesRegex(ValueError, "sensitive"):
                    source_files(root)
            (root / "external").symlink_to(Path(temporary))
            with patch("tools.stage_r3_source.git", return_value=b"external\0"):
                with self.assertRaisesRegex(ValueError, "leaves"):
                    source_files(root)


if __name__ == "__main__":
    unittest.main()
