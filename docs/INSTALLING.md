# Installing garret

These installers are prepared for the next release. Published 0.0.2 downloads
remain portable archives. Download the format matching your system from
[Releases](https://github.com/iuliandita/garret/releases) and check its SHA-256
against the release checksums before installing.

## Linux

The x86_64 packages require glibc 2.39 or newer (Ubuntu 24.04 / Mint 22 baseline).
The deb and rpm packages install a menu entry, icons, AppStream metadata and
license notices. The package manager installs WebKitGTK 4.1 and GTK 3 dependencies.

- Ubuntu / Mint: `sudo apt install ./garret-VERSION-linux-x86_64.deb`
- Fedora: `sudo dnf install ./garret-VERSION-linux-x86_64.rpm`
- AppImage: `chmod +x garret-VERSION-linux-x86_64.AppImage`, then run that file.
  FUSE 2 support may be needed (`libfuse2t64` on Ubuntu 24.04). If FUSE is
  unavailable, run it with `--appimage-extract-and-run` instead. AppImage does
  not install a desktop menu entry automatically. It uses the system graphics
  drivers; minimal Ubuntu installations may need `libegl1` and `libgl1`.
- Portable tar.gz: extract the whole archive, install `libwebkit2gtk-4.1-0`
  on Ubuntu / Mint, and run `app/garret`. Keep its `dist` folder beside it.

## Windows

Run `garret-VERSION-windows-x86_64-setup.exe`. It installs for the current user
and adds menu shortcuts. The embedded WebView2 bootstrapper installs the runtime
if missing; that first runtime installation needs internet. Once installed,
garret works offline. The portable zip remains available; extract the entire
archive and keep `dist` beside `garret.exe`.

## macOS

Open the dmg for Apple Silicon (`arm64`) or Intel (`x86_64`) and drag garret into
Applications. Close an existing copy before replacing it. The application zip
remains available. These builds have no purchased signing identity or Apple
notarization; native functionality still needs platform testing.

## Upgrade, remove, or return to an older version

Close garret before upgrading. Install the newer package over the existing
version, or replace the AppImage / application bundle. For Linux removal use
`sudo apt remove garret` or `sudo dnf remove garret`; on Windows use Installed
apps, and on macOS remove the application bundle. Delete the AppImage or portable
folder to remove that copy. These actions leave user manuscripts, preferences
and recovery copies in place. Keep a separate backup before upgrading and read
[compatibility and recovery](COMPATIBILITY.md) before rolling back: uninstalling
the app does not downgrade a book's database.
