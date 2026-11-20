import unittest

from tools.release_r3 import bump, version_parts


class ReleaseVersionTest(unittest.TestCase):
    def test_bump_and_reset_lower_components(self):
        self.assertEqual(bump("0.1.10", "patch"), "0.1.11")
        self.assertEqual(bump("0.1.10", "minor"), "0.2.0")
        self.assertEqual(bump("0.1.10", "major"), "1.0.0")

    def test_reject_nonstable_or_malformed_versions(self):
        for version in ("v0.1.10", "0.01.10", "0.1", "0.1.10-rc.1"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                version_parts(version)
