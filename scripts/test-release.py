#!/usr/bin/env python3
"""Exercise release refusal and download selection without compiling the app."""
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
from pathlib import Path
import tempfile
import sys
import unittest
import zipfile
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.host = self.root / "app/shell-tauri/src-tauri"
        self.host.mkdir(parents=True)
        for name in ("README.md", "SECURITY.md"):
            (self.root / name).write_text("Release signing key fingerprint: test fingerprint\n")
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

    def test_desktop_collection_includes_installers_and_portable_archives(self):
        for platform, suffixes in {
            "linux": ("-linux-x86_64.tar.gz", "-linux-x86_64.deb", "-linux-x86_64.rpm", "-linux-x86_64.AppImage"),
            "windows": ("-windows-x86_64.zip", "-windows-x86_64-setup.exe"),
            "windows-arm64": ("-windows-arm64.zip", "-windows-arm64-setup.exe"),
            "macos-arm64": ("-macos-arm64.zip", "-macos-arm64.dmg"),
            "macos-x86_64": ("-macos-x86_64.zip", "-macos-x86_64.dmg"),
        }.items():
            folder = self.root / "app" / ("dist-macos/build-fresh" if platform.startswith("macos-")
                                         else "dist-windows" if platform.startswith("windows") else f"dist-{platform}")
            folder.mkdir(parents=True, exist_ok=True)
            for suffix in suffixes:
                (folder / f"garret{suffix}").write_bytes(suffix.encode())
            with patch.object(release.subprocess, "check_output", return_value="revision\n"):
                release.collect(platform)
            out = self.root / "app/dist-release" / platform
            names = {f"garret-0.0.1{suffix}" for suffix in suffixes}
            self.assertEqual({p.name for p in out.iterdir()}, names | {f"{name}.sha256" for name in names})
            for suffix in suffixes:
                name = f"garret-0.0.1{suffix}"
                self.assertEqual((out / name).read_bytes(), suffix.encode())
                self.assertEqual((out / f"{name}.sha256").read_text(), f"{hashlib.sha256(suffix.encode()).hexdigest()}  {name}\n")
            shutil.rmtree(out)
            (folder / f"garret{suffixes[-1]}").unlink()
            with patch.object(release.subprocess, "check_output", return_value="revision\n"):
                with self.assertRaises(FileNotFoundError):
                    release.collect(platform)

    def test_draft_resume_refuses_unchecked_remote_assets(self):
        out = self.root / "app/dist-release/downloads"
        out.mkdir(parents=True)
        names = release.download_names() | {"SHA256SUMS", "SHA256SUMS.asc"}
        for name in names:
            (out / name).write_text("checked locally")
        release.verify_remote_assets(set())
        release.verify_remote_assets(names, complete=True)
        for remote in (names | {"password"}, names | {"garret-0.0.0-android.apk"}):
            with self.assertRaises(ValueError):
                release.verify_remote_assets(remote)
        with self.assertRaises(ValueError):
            release.verify_remote_assets(set(), complete=True)
        with self.assertRaises(ValueError):
            release.verify_remote_assets(names - {"SHA256SUMS.asc"}, complete=True)
        (out / "SHA256SUMS.asc").unlink()
        release.verify_remote_assets(names - {"SHA256SUMS.asc"}, complete=True, allow_unsigned=True)
        with self.assertRaises(ValueError):
            release.verify_remote_assets(names, complete=True, allow_unsigned=True)

    def downloads(self):
        out = self.root / "app/dist-release/downloads"
        out.mkdir(parents=True)
        for name in release.download_names():
            if name.endswith(".sha256"):
                continue
            (out / name).write_bytes(b"package")
            (out / f"{name}.sha256").write_text(f"{hashlib.sha256(b'package').hexdigest()}  {name}\n")
        return out

    def test_publication_refuses_missing_extra_empty_or_tampered_downloads(self):
        out = self.downloads()
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

    def test_manifest_covers_every_payload_and_sidecar(self):
        out = self.downloads()
        release.write_manifest()
        lines = (out / "SHA256SUMS").read_text().splitlines()
        names = set()
        for line in lines:
            digest, name = line.split("  ")
            names.add(name)
            self.assertEqual(digest, hashlib.sha256((out / name).read_bytes()).hexdigest())
        self.assertEqual(names, release.download_names())
        self.assertEqual(lines, sorted(lines, key=lambda line: line.split("  ")[1]))
        result = subprocess.run(["sha256sum", "-c", "SHA256SUMS"], cwd=out, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        (out / "garret-0.0.1-android.apk.sha256").write_text("tampered")
        result = subprocess.run(["sha256sum", "-c", "SHA256SUMS"], cwd=out, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        (out / "SHA256SUMS").unlink()
        with self.assertRaises(ValueError):
            release.write_manifest()
        self.assertFalse((out / "SHA256SUMS").exists())

    def test_missing_signing_key_requires_explicit_unsigned_override(self):
        out = self.downloads()
        release.write_manifest()
        signature = out / "SHA256SUMS.asc"
        signature.write_text("stale signature")
        with patch.dict(os.environ, {"RELEASE_GPG_PRIVATE_KEY": ""}), patch.object(release.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "Unsigned publication is blocked"):
                release.sign_manifest()
            release.sign_manifest(allow_unsigned=True)
            run.assert_not_called()
        self.assertFalse(signature.exists())

    def test_signing_is_isolated_and_failures_never_fall_back_to_unsigned(self):
        out = self.downloads()
        release.write_manifest()
        for failure in (None, "--import", "--detach-sign", "--verify"):
            calls = []
            def run(command, **kwargs):
                calls.append((command, kwargs))
                home = Path(kwargs["env"]["GNUPGHOME"])
                self.assertEqual(home.stat().st_mode & 0o777, 0o700)
                for secret in ("RELEASE_GPG_PRIVATE_KEY", "RELEASE_GPG_PASSPHRASE"):
                    self.assertNotIn(secret, kwargs["env"])
                if failure in command:
                    raise subprocess.CalledProcessError(2, command, stderr="gpg: failure test-input test-passphrase")
                return subprocess.CompletedProcess(command, 2 if command[0] == "gpgconf" else 0)
            diagnostics = io.StringIO()
            with patch.dict(os.environ, {"RELEASE_GPG_PRIVATE_KEY": "test-input", "RELEASE_GPG_PASSPHRASE": "test-passphrase"}), patch.object(release.subprocess, "run", side_effect=run), patch("sys.stderr", diagnostics):
                if failure:
                    with self.assertRaises(subprocess.CalledProcessError):
                        release.sign_manifest(allow_unsigned=True)
                else:
                    release.sign_manifest()
            self.assertEqual(calls[0][1]["input"], "test-input")
            self.assertEqual(calls[-1][0], ["gpgconf", "--kill", "gpg-agent"])
            self.assertFalse(calls[-1][1]["check"])
            self.assertFalse(Path(calls[0][1]["env"]["GNUPGHOME"]).exists())
            self.assertNotIn("test-input", diagnostics.getvalue())
            self.assertNotIn("test-passphrase", diagnostics.getvalue())
            self.assertEqual(bool(diagnostics.getvalue()), bool(failure))
            if failure:
                self.assertIn("gpg: failure", diagnostics.getvalue())
            if not failure:
                self.assertIn("--detach-sign", calls[1][0])
                self.assertIn("--passphrase-fd", calls[1][0])
                self.assertEqual(calls[1][1]["input"], "test-passphrase\n")
                self.assertIn("--verify", calls[2][0])

    def test_signed_publication_refuses_unpublished_fingerprint_in_either_guide(self):
        self.downloads()
        release.write_manifest()
        for name in ("README.md", "SECURITY.md"):
            guide = self.root / name
            published = guide.read_text()
            guide.write_text("Release signing key fingerprint: not yet published\n")
            asc = self.root / "app/dist-release/downloads/SHA256SUMS.asc"
            asc.write_text("stale signature\n")
            with patch.dict(os.environ, {"RELEASE_GPG_PRIVATE_KEY": "test-input"}), patch.object(release.subprocess, "run") as run:
                with self.assertRaisesRegex(ValueError, f"fingerprint in {name}"):
                    release.sign_manifest(allow_unsigned=True)
                run.assert_not_called()
                self.assertFalse(asc.exists())
            guide.write_text(published)

    @unittest.skipUnless(shutil.which("gpg"), "GPG is not installed")
    def test_passphrase_protected_test_key_round_trips_manifest_signing(self):
        out = self.downloads()
        release.write_manifest()
        home = self.root / "test-gnupg"
        home.mkdir(mode=0o700)
        env = {name: value for name, value in os.environ.items()
               if name not in {"RELEASE_GPG_PRIVATE_KEY", "RELEASE_GPG_PASSPHRASE"}}
        env["GNUPGHOME"] = str(home)
        command = ["gpg", "--batch", "--no-tty", "--no-options"]
        passphrase = "disposable-test-passphrase"
        try:
            subprocess.run(command + ["--pinentry-mode", "loopback", "--passphrase-fd", "0",
                           "--quick-generate-key", "garret release test", "ed25519", "sign", "1d"],
                           input=passphrase + "\n", text=True, env=env, capture_output=True, check=True)
            key = subprocess.run(command + ["--pinentry-mode", "loopback", "--passphrase-fd", "0",
                                 "--armor", "--export-secret-keys"], input=passphrase + "\n",
                                 text=True, env=env, capture_output=True, check=True).stdout
            with patch.dict(os.environ, {"RELEASE_GPG_PRIVATE_KEY": key, "RELEASE_GPG_PASSPHRASE": passphrase}):
                release.sign_manifest()
            verify = command + ["--verify", str(out / "SHA256SUMS.asc"), str(out / "SHA256SUMS")]
            subprocess.run(verify, env=env, capture_output=True, check=True)
            (out / "SHA256SUMS").write_text("tampered manifest\n")
            self.assertNotEqual(subprocess.run(verify, env=env, capture_output=True).returncode, 0)
        finally:
            subprocess.run(["gpgconf", "--kill", "gpg-agent"], env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


if __name__ == "__main__":
    unittest.main()
