#!/usr/bin/env python3
"""Keep alpha versions aligned and collect only intended release downloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parent.parent
HOST = ROOT / "app/shell-tauri/src-tauri"


def alpha_version(value: str) -> str:
    if not re.fullmatch(r"0\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})", value) or value == "0.0.0":
        raise ValueError("Use an alpha version from 0.0.1 through 0.999.999, without leading zeros.")
    return value


def version() -> str:
    return alpha_version(json.loads((HOST / "tauri.conf.json").read_text())["version"])


def android_code(value: str) -> int:
    _, minor, patch = map(int, value.split("."))
    return minor * 1000 + patch


def check(tag: str | None = None) -> str:
    value = version()
    if tag is not None and tag != f"v{value}":
        raise ValueError(f"Tag {tag!r} does not match the source version v{value}.")
    cargo = tomllib.loads((HOST / "Cargo.toml").read_text())
    lock = tomllib.loads((HOST / "Cargo.lock").read_text())
    locked = next(p["version"] for p in lock["package"] if p["name"] == "garret")
    config = json.loads((HOST / "tauri.android.conf.json").read_text())
    if cargo["package"]["version"] != value or locked != value:
        raise ValueError("Cargo and Tauri versions differ; run scripts/release.py set-version.")
    if config["bundle"]["android"]["versionCode"] != android_code(value):
        raise ValueError("Android versionCode does not match the release version.")
    return value


def set_version(value: str) -> None:
    value = alpha_version(value)
    current = json.loads((HOST / "tauri.conf.json").read_text())["version"]
    if tuple(map(int, value.split("."))) <= tuple(map(int, current.split("."))):
        raise ValueError("The new version must be higher than the current version.")
    path = HOST / "Cargo.toml"
    source, count = re.subn(r'(?m)^version = "[^"\n]+"$', f'version = "{value}"', path.read_text(), count=1)
    if count != 1:
        raise ValueError("Cargo package version is missing.")
    path.write_text(source)
    for name in ("tauri.conf.json", "tauri.android.conf.json"):
        path = HOST / name
        source = path.read_text()
        if name == "tauri.conf.json":
            source, count = re.subn(r'("version"\s*:\s*")[^"]+(")', lambda match: f'{match[1]}{value}{match[2]}', source, count=1)
        else:
            source, count = re.subn(r'("versionCode"\s*:\s*)[0-9]+', lambda match: f'{match[1]}{android_code(value)}', source, count=1)
        if count != 1:
            raise ValueError(f"Version field missing from {name}.")
        path.write_text(source)
    subprocess.run(["cargo", "update", "--offline", "--package", "garret"], cwd=HOST, check=True)
    check()


def file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def collect(platform: str) -> None:
    value = check()
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    sources = {
        "linux": ROOT / "app/dist-linux/garret-linux-x86_64.tar.gz",
        "windows": ROOT / "app/dist-windows/garret-windows-x86_64.zip",
        "windows-arm64": ROOT / "app/dist-windows/garret-windows-arm64.zip",
        "android": ROOT / f"app/dist-android/{revision}/garret-android.apk",
    }
    names = {
        "linux": f"garret-{value}-linux-x86_64.tar.gz",
        "windows": f"garret-{value}-windows-x86_64.zip",
        "windows-arm64": f"garret-{value}-windows-arm64.zip",
        "android": f"garret-{value}-android.apk",
    }
    if platform.startswith("macos-"):
        arch = platform.removeprefix("macos-")
        matches = list((ROOT / "app/dist-macos").glob(f"build-*/garret-macos-{arch}.zip"))
        if len(matches) != 1:
            raise ValueError(f"Expected one fresh macOS package for {arch}, found {len(matches)}.")
        sources[platform] = matches[0]
        names[platform] = f"garret-{value}-macos-{arch}.zip"
    out = ROOT / "app/dist-release" / platform
    out.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(sources[platform], out / names[platform])
    installers = {
        "linux": (".deb", ".rpm", ".AppImage"),
        "windows": ("-setup.exe",),
        "windows-arm64": ("-setup.exe",),
        "macos-arm64": (".dmg",),
        "macos-x86_64": (".dmg",),
    }
    for extension in installers.get(platform, ()):
        architecture = platform if platform.startswith(("macos-", "windows-")) else f"{platform}-x86_64"
        source = sources[platform].parent / f"garret-{architecture}{extension}"
        shutil.copyfile(source, out / f"garret-{value}-{architecture}{extension}")
    if platform == "android":
        with zipfile.ZipFile(out / f"garret-{value}-android-info.zip", "w", zipfile.ZIP_DEFLATED) as archive:
            for name in ("BUILD.txt", "README.md", "COPYING", "THIRD-PARTY-NOTICES.md"):
                archive.write(sources[platform].parent / name, name)
    for path in sorted(out.iterdir()):
        digest = file_sha256(path)
        (out / f"{path.name}.sha256").write_text(f"{digest}  {path.name}\n")
    print(out.relative_to(ROOT))


def download_names() -> set[str]:
    value = check()
    names = {
        f"garret-{value}-{suffix}"
        for suffix in ("linux-x86_64.tar.gz", "windows-x86_64.zip", "android.apk",
                       "android-info.zip", "macos-arm64.zip", "macos-x86_64.zip",
                       "linux-x86_64.deb", "linux-x86_64.rpm", "linux-x86_64.AppImage",
                       "windows-x86_64-setup.exe", "windows-arm64.zip", "windows-arm64-setup.exe",
                       "macos-arm64.dmg", "macos-x86_64.dmg")
    }
    return names | {f"{name}.sha256" for name in names}


def verify_downloads() -> None:
    folder = ROOT / "app/dist-release/downloads"
    expected = download_names()
    actual = {path.name for path in folder.iterdir()}
    if actual != expected:
        raise ValueError(f"Incomplete or unexpected downloads: missing={sorted(expected - actual)}, extra={sorted(actual - expected)}")
    for name in sorted(name for name in expected if not name.endswith(".sha256")):
        path = folder / name
        digest = file_sha256(path)
        if not path.stat().st_size or (folder / f"{name}.sha256").read_text() != f"{digest}  {name}\n":
            raise ValueError(f"Download checksum failed: {name}")


def write_manifest() -> None:
    verify_downloads()
    folder = ROOT / "app/dist-release/downloads"
    lines = []
    for name in sorted(download_names()):
        digest = file_sha256(folder / name)
        lines.append(f"{digest}  {name}\n")
    (folder / "SHA256SUMS").write_text("".join(lines))


def sign_manifest(allow_unsigned: bool = False) -> None:
    folder = ROOT / "app/dist-release/downloads"
    signature = folder / "SHA256SUMS.asc"
    signature.unlink(missing_ok=True)
    key = os.environ.get("RELEASE_GPG_PRIVATE_KEY", "")
    if not key:
        print("::warning::Release manifest signing skipped: RELEASE_GPG_PRIVATE_KEY is absent.")
        if not allow_unsigned:
            raise ValueError("Unsigned publication is blocked; configure release signing or explicitly set ALLOW_UNSIGNED_RELEASE=true.")
        print("::warning::Unsigned publication explicitly allowed by ALLOW_UNSIGNED_RELEASE=true.")
        return
    for name in ("SECURITY.md", "README.md"):
        if "Release signing key fingerprint: not yet published" in (ROOT / name).read_text():
            raise ValueError(f"Publish the release signing key fingerprint in {name} before signed publication.")
    with tempfile.TemporaryDirectory(prefix="release-gnupg-") as home:
        env = {name: value for name, value in os.environ.items()
               if name not in {"RELEASE_GPG_PRIVATE_KEY", "RELEASE_GPG_PASSPHRASE"}}
        env["GNUPGHOME"] = home
        command = ["gpg", "--batch", "--no-tty", "--no-options"]
        def gpg(args: list[str], data: str | None = None) -> None:
            try:
                subprocess.run(command + args, input=data, text=True, env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
            except subprocess.CalledProcessError as error:
                diagnostics = error.stderr or ""
                for secret in (key, *key.splitlines(), os.environ.get("RELEASE_GPG_PASSPHRASE", "")):
                    if secret:
                        diagnostics = diagnostics.replace(secret, "[redacted]")
                if diagnostics:
                    print(diagnostics, file=sys.stderr)
                raise
        try:
            gpg(["--import"], key)
            gpg(["--pinentry-mode", "loopback", "--passphrase-fd", "0", "--armor",
                 "--detach-sign", "--output", str(signature), str(folder / "SHA256SUMS")],
                os.environ.get("RELEASE_GPG_PASSPHRASE", "") + "\n")
            gpg(["--verify", str(signature), str(folder / "SHA256SUMS")])
        finally:
            try:
                subprocess.run(["gpgconf", "--kill", "gpg-agent"], env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            except OSError:
                print("::warning::Could not stop the temporary GPG agent.", file=sys.stderr)


def verify_remote_assets(names: set[str], complete: bool = False, allow_unsigned: bool = False) -> None:
    folder = ROOT / "app/dist-release/downloads"
    expected = download_names() | {"SHA256SUMS", "SHA256SUMS.asc"}
    if allow_unsigned and not (folder / "SHA256SUMS.asc").exists():
        expected.remove("SHA256SUMS.asc")
    if not names <= expected or (complete and names != expected):
        raise ValueError("The draft release has missing or unexpected assets; inspect it before publishing.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check").add_argument("--tag")
    commands.add_parser("verify-downloads")
    commands.add_parser("manifest")
    commands.add_parser("sign-manifest").add_argument("--allow-unsigned", action="store_true")
    remote = commands.add_parser("verify-remote-assets")
    remote.add_argument("--complete", action="store_true")
    remote.add_argument("--allow-unsigned", action="store_true")
    commands.add_parser("set-version").add_argument("version")
    commands.add_parser("collect").add_argument("platform", choices=["linux", "windows", "windows-arm64", "android", "macos-arm64", "macos-x86_64"])
    args = parser.parse_args()
    try:
        if args.command == "check":
            print(check(args.tag))
        elif args.command == "verify-remote-assets":
            assets = json.load(sys.stdin)["assets"]
            verify_remote_assets({asset["name"] for asset in assets}, args.complete, args.allow_unsigned)
        elif args.command == "verify-downloads":
            verify_downloads()
        elif args.command == "manifest":
            write_manifest()
        elif args.command == "sign-manifest":
            sign_manifest(args.allow_unsigned)
        elif args.command == "set-version":
            set_version(args.version)
        else:
            collect(args.platform)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Release preparation failed: {error}\n")


if __name__ == "__main__":
    main()
