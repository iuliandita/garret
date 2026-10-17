#!/usr/bin/env python3
"""Compare unsigned APKs exactly and report differing ZIP entry contents."""
import hashlib
import json
from pathlib import Path
import sys
from zipfile import ZipFile


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def entries(path: Path) -> dict[str, str]:
    with ZipFile(path) as apk:
        names = apk.namelist()
        if len(names) != len(set(names)):
            raise ValueError(f"duplicate ZIP entries in {path}")
        return {name: hashlib.sha256(apk.read(name)).hexdigest() for name in names}


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: compare-apks.py FIRST_UNSIGNED.apk SECOND_UNSIGNED.apk")
    first, second = map(Path, sys.argv[1:])
    a, b = entries(first), entries(second)
    hashes = [digest(first), digest(second)]
    identical = hashes[0] == hashes[1]
    print(json.dumps({
        "identical": identical,
        "sha256": hashes,
        "entries": [len(a), len(b)],
        "content_differences": [name for name in sorted(a.keys() | b.keys()) if a.get(name) != b.get(name)],
        "zip_metadata_only": not identical and a == b,
    }, indent=2))
    return 0 if identical else 1


if __name__ == "__main__":
    sys.exit(main())
