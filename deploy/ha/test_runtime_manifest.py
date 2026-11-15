from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "runtime-files.txt"


class RuntimeManifestTests(unittest.TestCase):
    def files(self) -> list[str]:
        result = []
        for line in MANIFEST.read_text(encoding="utf-8").splitlines():
            value = line.split("#", 1)[0].strip()
            if value:
                result.append(value)
        return result

    def test_every_runtime_file_exists_and_is_file(self) -> None:
        files = self.files()
        self.assertTrue(files)
        for name in files:
            self.assertTrue((ROOT / name).is_file(), name)

    def test_both_installers_use_the_manifest(self) -> None:
        for installer in ("install-node1.sh", "install-node2.sh"):
            self.assertIn("runtime-files.txt", (ROOT / installer).read_text(encoding="utf-8"))

    def test_deploy_sync_uses_the_manifest(self) -> None:
        script = (ROOT.parent / "scripts" / "node2-sync.sh").read_text(encoding="utf-8")
        self.assertIn("runtime-files.txt", script)
        self.assertIn("install_ha_node2", script)


if __name__ == "__main__":
    unittest.main()
