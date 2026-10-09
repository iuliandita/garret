#!/usr/bin/env python3
"""Check public documentation facts without running its examples or using the network."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def public_docs(paths: list[str]) -> list[str]:
    return [p for p in paths if (p.endswith(".md") or p.endswith("README.txt"))
            and not p.startswith(("lab/", "app/results/"))
            and ("/fixtures/" not in p or p.endswith("README.md"))]


def anchors(text: str) -> set[str]:
    result = set(re.findall(r'\bid=["\']([^"\']+)["\']', text))
    counts: dict[str, int] = {}
    for heading in re.findall(r"^#{1,6}\s+(.+?)\s*#*\s*$", text, re.M):
        slug = re.sub(r"[^\w\s-]", "", heading.lower()).replace(" ", "-")
        n = counts.get(slug, 0)
        counts[slug] = n + 1
        result.add(slug if not n else f"{slug}-{n}")
    return result


def check_documents(root: Path, paths: list[str]) -> None:
    cli = (root / "app/shell-tauri/src-tauri/src/cli.rs").read_text()
    inventory = re.search(r"pub const SUBCOMMANDS:.*?=\s*\[(.*?)\];", cli, re.S)
    if not inventory:
        raise ValueError("Cannot read the canonical CLI subcommand inventory.")
    commands = set(re.findall(r'"([a-z-]+)"', inventory[1]))
    scripts = set()
    for path in paths:
        if path.endswith("package.json"):
            scripts.update(json.loads((root / path).read_text()).get("scripts", {}))
    for name in public_docs(paths):
        file = root / name
        if not file.is_file():
            continue
        text = file.read_text()
        links = re.findall(r"!?\[[^\]\n]*\]\(([^)\n]+)\)", text)
        links += re.findall(r'\b(?:src|href)=["\']([^"\']+)["\']', text)
        for raw in links:
            target = raw.strip().split(' "', 1)[0].strip("<>")
            url = urlsplit(target)
            if url.scheme or url.netloc:
                continue
            path = (root / unquote(url.path).lstrip("/") if url.path.startswith("/")
                    else file.parent / unquote(url.path)) if url.path else file
            path = path.resolve()
            if not path.is_relative_to(root.resolve()) or not path.exists():
                raise ValueError(f"{name}: missing local link {target}")
            if url.fragment and path.suffix == ".md" and unquote(url.fragment) not in anchors(path.read_text()):
                raise ValueError(f"{name}: missing local anchor {target}")
        examples = re.findall(r"```[^\n]*\n(.*?)```", text, re.S)
        examples += re.findall(r"`([^`\n]+)`", text)
        examples += re.findall(r"^    (.+)$", text, re.M)
        for example in examples:
            for command in re.findall(r"(?:^|[;&|])[ \t]*(?:\./)?garret[ \t]+([a-z][a-z0-9-]*)", example, re.M):
                if command not in commands:
                    raise ValueError(f"{name}: undocumented CLI command is absent from source: {command}")
            for path in re.findall(r"(?<![\w/])(scripts/[\w./-]+|app/harness/src/[\w./-]+\.ts)", example):
                if not (root / path).exists():
                    raise ValueError(f"{name}: documented repository command is missing: {path}")
            for command in re.findall(r"\bbun run ([\w:-]+)", example):
                if command not in scripts:
                    raise ValueError(f"{name}: missing package script {command}")


def check_screenshots(root: Path) -> None:
    folder = root / "docs/screenshots"
    manifest = json.loads((folder / "manifest.json").read_text())
    if manifest.get("version") != 1:
        raise ValueError("Unknown screenshot manifest format.")
    images = manifest["images"]
    if set(images) != {p.name for p in folder.glob("*.png")}:
        raise ValueError("Every gallery PNG must have exactly one provenance record.")
    for name, row in images.items():
        if not re.fullmatch(r"[\w-]+\.png", name):
            raise ValueError(f"Invalid gallery filename: {name}")
        if hashlib.sha256((folder / name).read_bytes()).hexdigest() != row["sha256"]:
            raise ValueError(f"Screenshot bytes changed without provenance: {name}")
        if not re.fullmatch(r"\d+\.\d+\.\d+", row["app_version"]):
            raise ValueError(f"Screenshot needs its actual application version: {name}")
        if row["platform"] not in ("linux", "android"):
            raise ValueError(f"Unknown screenshot platform: {name}")
        revision = row["source_revision"]
        if not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise ValueError(f"Screenshot needs a complete source revision: {name}")
        config = json.loads(git(root, "show", f"{revision}:app/shell-tauri/src-tauri/tauri.conf.json"))
        if config["version"] != row["app_version"]:
            raise ValueError(f"Screenshot version differs from its source: {name}")
        if not row.get("capture_note", "").strip():
            raise ValueError(f"Screenshot needs a capture disclosure: {name}")


def check_releases(root: Path) -> None:
    data = json.loads((root / "docs/releases.json").read_text())
    if data.get("version") != 1:
        raise ValueError("Unknown release documentation format.")
    released = data["published"]
    if not re.fullmatch(r"v0\.\d+\.\d+", released["tag"]):
        raise ValueError("Published alpha needs an explicit version tag.")
    revision = git(root, "rev-parse", f"{released['tag']}^{{commit}}")
    if revision != released["source_revision"]:
        raise ValueError("Published documentation source differs from its tag.")
    config = json.loads(git(root, "show", f"{revision}:app/shell-tauri/src-tauri/tauri.conf.json"))
    if released["tag"] != "v" + config["version"]:
        raise ValueError("Published tag differs from its source version.")
    if set(released["downloads"]) != {"linux-x86_64", "windows-x86_64", "android", "macos-arm64", "macos-x86_64"}:
        raise ValueError("Published platform inventory is incomplete.")
    if released["android_scope"] != "library-and-scene-editor-manual-transfer":
        raise ValueError("Android support must remain distinct from desktop support.")
    if not isinstance(data["develop_only"], list):
        raise ValueError("Develop-only capabilities need a separate list.")
    current = json.loads((root / "app/shell-tauri/src-tauri/tauri.conf.json").read_text())["version"]
    if tuple(map(int, config["version"].split("."))) > tuple(map(int, current.split("."))):
        raise ValueError("Published documentation cannot claim a future source version.")
    store = (root / "app/shell-tauri/src-tauri/src/store/mod.rs").read_text()
    schema = re.search(r"pub const SCHEMA_VERSION: i64 = (\d+);", store)
    if not schema or f"SQLite schema: {schema[1]}." not in (root / "docs/COMPATIBILITY.md").read_text():
        raise ValueError("Compatibility documentation differs from the canonical SQLite schema version.")


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    paths = git(root, "ls-files").splitlines()
    check_documents(root, paths)
    check_screenshots(root)
    check_releases(root)
    print("Documentation links, command references, screenshot provenance and release records pass.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Documentation fact check failed: {error}", file=sys.stderr)
        sys.exit(1)
