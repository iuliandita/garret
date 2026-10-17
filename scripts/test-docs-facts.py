#!/usr/bin/env python3
"""Small failure fixtures for the documentation facts checker."""
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("facts", Path(__file__).with_name("check-docs-facts.py"))
facts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(facts)


class DocumentationFacts(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        cli = self.root / "app/shell-tauri/src-tauri/src/cli.rs"
        cli.parent.mkdir(parents=True)
        cli.write_text('pub const SUBCOMMANDS: [&str; 1] = ["inspect"];')
        (self.root / "package.json").write_text(json.dumps({"scripts": {"check:docs": "example"}}))

    def check(self, text: str) -> None:
        (self.root / "README.md").write_text(text)
        facts.check_documents(self.root, ["README.md", "package.json"])

    def test_valid_links_anchors_and_canonical_command(self) -> None:
        self.check('# Overview\n[Here](#overview)\n```sh\ngarret inspect book.db\nbun run check:docs\n```\n')

    def test_missing_local_link_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing local link"):
            self.check('[Missing](absent.md)')

    def test_missing_anchor_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing local anchor"):
            self.check('# Overview\n[Missing](#absent)')

    def test_removed_cli_command_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "absent from source"):
            self.check('```sh\ngarret disappeared book.db\n```')

    def test_directory_and_binary_arguments_are_not_cli_calls(self) -> None:
        (self.root / 'scripts/android').mkdir(parents=True)
        self.check('```sh\ncd garret\nbun install\ncargo test --bin garret\n```')
        self.check('`docker build scripts/android`')

    def test_removed_repository_command_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "repository command is missing"):
            self.check('`python3 scripts/absent.py`')

    def test_missing_package_script_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing package script"):
            self.check('`bun run disappeared`')

    def test_gallery_hash_changes_are_rejected(self) -> None:
        folder = self.root / "docs/screenshots"
        folder.mkdir(parents=True)
        (folder / "editor.png").write_bytes(b"changed bytes")
        (folder / "manifest.json").write_text(json.dumps({"version": 1, "images": {"editor.png": {"sha256": "0" * 64}}}))
        with self.assertRaisesRegex(ValueError, "bytes changed without provenance"):
            facts.check_screenshots(self.root)

    def test_unrecorded_gallery_image_is_rejected(self) -> None:
        folder = self.root / "docs/screenshots"
        folder.mkdir(parents=True)
        (folder / "editor.png").write_bytes(b"image")
        (folder / "manifest.json").write_text('{"version": 1, "images": {}}')
        with self.assertRaisesRegex(ValueError, "exactly one provenance"):
            facts.check_screenshots(self.root)

    def release_fixture(self) -> dict:
        def run(*args: str) -> str:
            return subprocess.check_output(["git", "-C", str(self.root), *args], text=True).strip()
        config = self.root / "app/shell-tauri/src-tauri/tauri.conf.json"
        config.write_text('{"version": "0.0.2"}')
        store = self.root / "app/shell-tauri/src-tauri/src/store/mod.rs"
        store.parent.mkdir()
        store.write_text('pub const SCHEMA_VERSION: i64 = 17;')
        docs = self.root / "docs"
        docs.mkdir()
        (docs / "COMPATIBILITY.md").write_text('SQLite schema: 17.')
        run("init", "-q")
        run("config", "user.name", "Test Writer")
        run("config", "user.email", "test@example.invalid")
        run("add", ".")
        run("commit", "-qm", "Fixture release")
        run("tag", "v0.0.2")
        data = {"version": 1, "published": {"tag": "v0.0.2", "source_revision": run("rev-parse", "HEAD"),
                "downloads": ["linux-x86_64", "windows-x86_64", "android", "macos-arm64", "macos-x86_64"],
                "android_scope": "library-and-scene-editor-manual-transfer"}, "develop_only": []}
        (docs / "releases.json").write_text(json.dumps(data))
        return data

    def test_recorded_release_matches_local_tag(self) -> None:
        self.release_fixture()
        facts.check_releases(self.root)

    def test_stale_schema_documentation_is_rejected(self) -> None:
        self.release_fixture()
        (self.root / "docs/COMPATIBILITY.md").write_text('SQLite schema: 16.')
        with self.assertRaisesRegex(ValueError, "canonical SQLite schema"):
            facts.check_releases(self.root)

    def test_published_source_cannot_be_relabelled(self) -> None:
        data = self.release_fixture()
        data["published"]["source_revision"] = "0" * 40
        (self.root / "docs/releases.json").write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "source differs from its tag"):
            facts.check_releases(self.root)


if __name__ == "__main__":
    unittest.main()
