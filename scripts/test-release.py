#!/usr/bin/env python3
"""Exercise release refusal and download selection without compiling the app."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.host = self.root / "app/shell-tauri/src-tauri"
        self.host.mkdir(parents=True)
        (self.host / "tauri.conf.json").write_text(json.dumps({"version": "0.0.1"}))
        (self.host / "tauri.android.conf.json").write_text(json.dumps({"bundle": {"android": {"versionCode": 1}}}))
        (self.host / "Cargo.toml").write_text('[package]\nversion = "0.0.1"\n')
        (self.host / "Cargo.lock").write_text('[[package]]\nname = "garret"\nversion = "0.0.1"\n')
        self.paths = patch.multiple(release, ROOT=self.root, HOST=self.host)
        self.paths.start()
        self.addCleanup(self.paths.stop)
        self.addCleanup(self.temp.cleanup)

    def test_tag_and_versions_must_agree(self):
        self.assertEqual(release.check("v0.0.1"), "0.0.1")
        for tag in ("v0.0.2", "v1.0.0", "v0.0.1-alpha.1", "v0.00.1"):
            with self.assertRaises(ValueError):
                release.check(tag)
        (self.host / "Cargo.lock").write_text('[[package]]\nname = "garret"\nversion = "0.0.0"\n')
        with self.assertRaises(ValueError):
            release.check("v0.0.1")

    def test_android_updates_need_increasing_version_codes(self):
        with self.assertRaises(ValueError):
            release.set_version("0.0.1")
        (self.host / "tauri.conf.json").write_text(json.dumps({"version": "0.1.0"}))
        for name in ("Cargo.toml", "Cargo.lock"):
            path = self.host / name
            path.write_text(path.read_text().replace('"0.0.1"', '"0.1.0"'))
        with self.assertRaises(ValueError):
            release.check("v0.1.0")
        (self.host / "tauri.android.conf.json").write_text(json.dumps({"bundle": {"android": {"versionCode": 1000}}}))
        self.assertEqual(release.check("v0.1.0"), "0.1.0")

    def test_version_bump_updates_source_and_regenerates_the_lock(self):
        def update_lock(*args, **kwargs):
            self.assertEqual(args[0], ["cargo", "update", "--offline", "--package", "garret"])
            path = self.host / "Cargo.lock"
            path.write_text(path.read_text().replace('"0.0.1"', '"0.0.2"'))
        with patch.object(release.subprocess, "run", side_effect=update_lock):
            release.set_version("0.0.2")
        self.assertEqual(release.check("v0.0.2"), "0.0.2")

    def test_android_collection_excludes_unsigned_apks_and_signing_material(self):
        source = self.root / "app/dist-android/revision"
        source.mkdir(parents=True)
        for name in ("garret-android.apk", "unsigned.apk", "aligned.apk", "preview.jks", "password",
                     "BUILD.txt", "README.md", "COPYING", "THIRD-PARTY-NOTICES.md"):
            (source / name).write_bytes(name.encode())
        with patch.object(release.subprocess, "check_output", return_value="revision\n"):
            release.collect("android")
        out = self.root / "app/dist-release/android"
        self.assertEqual({p.name for p in out.iterdir()}, {
            "garret-0.0.1-android.apk", "garret-0.0.1-android.apk.sha256",
            "garret-0.0.1-android-info.zip", "garret-0.0.1-android-info.zip.sha256"})
        with zipfile.ZipFile(out / "garret-0.0.1-android-info.zip") as archive:
            self.assertEqual(set(archive.namelist()), {"BUILD.txt", "README.md", "COPYING", "THIRD-PARTY-NOTICES.md"})
        self.assertEqual((out / "garret-0.0.1-android.apk").read_bytes(), b"garret-android.apk")

    def test_publication_refuses_missing_extra_empty_or_tampered_downloads(self):
        out = self.root / "app/dist-release/downloads"
        out.mkdir(parents=True)
        for suffix in ("linux-x86_64.tar.gz", "windows-x86_64.zip", "android.apk", "android-info.zip",
                       "macos-arm64.zip", "macos-x86_64.zip"):
            name = f"garret-0.0.1-{suffix}"
            (out / name).write_bytes(b"package")
            (out / f"{name}.sha256").write_text(f"{hashlib.sha256(b'package').hexdigest()}  {name}\n")
        release.verify_downloads()
        apk = out / "garret-0.0.1-android.apk"
        apk.unlink()
        with self.assertRaises(ValueError):
            release.verify_downloads()
        for data in (b"", b"tampered"):
            apk.write_bytes(data)
            with self.assertRaises(ValueError):
                release.verify_downloads()
        apk.write_bytes(b"package")
        (out / "password").write_text("private")
        with self.assertRaises(ValueError):
            release.verify_downloads()


if __name__ == "__main__":
    unittest.main()
