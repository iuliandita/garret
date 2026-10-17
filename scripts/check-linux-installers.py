#!/usr/bin/env python3
"""Check the contents of every staged Linux installer before publication."""
from pathlib import Path
import subprocess
import sys
import tempfile

folder = Path(sys.argv[1]).resolve()
required = (
    'usr/lib/garret/dist/index.html',
    'usr/lib/garret/COPYING',
    'usr/lib/garret/THIRD-PARTY-NOTICES.md',
    'usr/share/applications/com.usegarret.app.desktop',
    'usr/share/icons/hicolor/128x128/apps/com.usegarret.app.png',
    'usr/share/metainfo/com.usegarret.app.metainfo.xml',
)
for extension, command in [('deb', ['dpkg', '-c']), ('rpm', ['rpm', '-qlp']), ('AppImage', None)]:
    package = folder / f'garret-linux-x86_64.{extension}'
    if command:
        listing = subprocess.run([*command, str(package)], check=True, text=True, capture_output=True).stdout
        paths = {line.split()[-1].removeprefix('./').lstrip('/') for line in listing.splitlines() if line.strip()}
    else:
        with tempfile.TemporaryDirectory() as temporary:
            subprocess.run([str(package), '--appimage-extract'], cwd=temporary, check=True, stdout=subprocess.DEVNULL)
            root = Path(temporary) / 'squashfs-root'
            paths = {str(path.relative_to(root)) for path in root.rglob('*') if path.is_file()}
    missing = set(required) - paths
    if missing:
        raise SystemExit(f'{package.name}: missing {", ".join(sorted(missing))}')
    print(f'{package.name}: required contents present')
