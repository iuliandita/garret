#!/usr/bin/env python3
"""Select exactly one installer per format and give it a stable staging name."""
from pathlib import Path
import shutil
import sys

platform, source, destination = sys.argv[1:]
source, destination = Path(source), Path(destination)
formats = {"linux": ("deb", "rpm", "AppImage"), "windows": ("exe",), "windows-arm64": ("exe",)}.get(platform, ("dmg",))
for extension in formats:
    matches = list(source.glob(f"**/*.{extension}"))
    if extension == "exe":
        matches = [path for path in matches if path.name.endswith("-setup.exe")]
    if len(matches) != 1:
        raise SystemExit(f"Expected one fresh {extension} installer, found {len(matches)}")
    suffix = "-setup.exe" if extension == "exe" else f".{extension}"
    architecture = platform if platform.startswith(("macos-", "windows-")) else f"{platform}-x86_64"
    shutil.copy(matches[0], destination / f"garret-{architecture}{suffix}")
