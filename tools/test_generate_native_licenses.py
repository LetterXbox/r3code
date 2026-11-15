import unittest

from tools.generate_native_licenses import convert


class NativeLicenseTest(unittest.TestCase):
    def test_keeps_texts_and_drops_build_machine_paths(self):
        package = {"name": "dep", "version": "1.0.0", "id": "dep-id", "repository": "https://example.org/dep", "manifest_path": "/private/build/Cargo.toml"}
        report = {"crates": [{"package": package, "license": "MIT"}], "licenses": [{"text": "copyright and license", "used_by": [{"crate": package}]}]}
        data = convert(report)
        self.assertEqual(data["packages"][0]["texts"], [0])
        self.assertEqual(data["texts"], ["copyright and license"])
        self.assertNotIn("/private/build", str(data))

    def test_rejects_unmatched_crates_and_empty_text(self):
        package = {"name": "dep", "version": "1.0.0", "id": "dep-id"}
        report = {"crates": [{"package": package, "license": "MIT"}], "licenses": []}
        with self.assertRaisesRegex(ValueError, "No license text"):
            convert(report)
        report["licenses"] = [{"text": "", "used_by": [{"crate": package}]}]
        with self.assertRaisesRegex(ValueError, "no text"):
            convert(report)


if __name__ == "__main__":
    unittest.main()
