# garret Android preview

Open the APK on an arm64 Android phone and allow installation from the app used
to open it. Install later previews as updates to retain the local books.

The preview creates books and scenes, edits prose with basic formatting, and
saves locally. It includes light/dark appearances and English/German labels
selected from the device language. No account is needed.

Use sample writing. In a book, **Outline > Export book** saves a complete
encrypted desktop-compatible archive through the system picker. Save a new
recovery key first or choose an existing key, and keep it separately. In the
library, **Import archive** reads the archive and key, previews its title and
related copies, then adds a separate book after confirmation. Existing copies
are never replaced. There is no sync or desktop review/publishing toolset.
Only novel projects are editable; unsupported presets are refused before opening.
The phone accepts at most 1 GiB archives and 512 MiB contents, with extra free
space needed for verification and a separate owned copy.

Cancellation waits for the original native operation. Close an open system
picker to let cancellation finish. Provider write, close or readback failures
leave the destination unverified. The app attempts to delete documents it created
on failure. Terminal cleanup removes keys and plaintext; only ciphertext from an
uncertain provider write is retained. Startup sweeps disposable stages, and the
library offers **Discard leftover transfer files** without deleting books. A
blocked provider close requires restarting the app before another transfer.
Android transfer is not certified on physical devices.
See [compatibility and recovery](../../docs/COMPATIBILITY.md) for limits.

Uninstalling or clearing app data deletes local books;
platform backup is disabled. Installation requires API 24 or newer, but this
does not certify every such device. Book publication requires kernel support
for atomic no-replace rename; older unsupported kernels refuse creation.

The exact tested APK and emulator version are recorded in
`app/results/227-android-preview.json`. Physical-phone keyboard, composition,
Back navigation and lifecycle behavior still require testing. Try two scenes,
wait for "Saved on this device", then close and reopen the app.

## Updates

[Obtainium](https://github.com/ImranR98/Obtainium) can install each published
release as an update; the source URL, asset name and signing certificate
fingerprint are in the
[README update notes](../../README.md#android-updates-with-obtainium). An
installed copy updates in place only while the package name and the signing key
stay the same.

## Build

The development image supplies Rust Android targets, SDK, NDK and Tauri CLI
without changing the host toolchain. It contains no application, manuscripts
or signing keys.

```sh
docker build -t garret-android -f scripts/android/Dockerfile scripts/android
docker run --rm --cpus 8 garret-android tauri --version
```

The image targets an x86_64 Linux build host. Mount only the source and dedicated
build caches, use the source owner's numeric UID/GID, and cap builds at eight
jobs. Its default user is non-root. The Rust base is pinned by digest, the
command-line tools archive is checked against Google's published SHA-256, and
NDK, platform, build tools and CLI versions are explicit. The installer accepts
SDK licenses. Platform tools follow the stable SDK package; record the installed
revision with build evidence. Image creation alone verifies neither the app
build nor runtime behavior.

Build `garret-android` from `scripts/android/Dockerfile`, then run
`scripts/package-android` from a clean committed checkout. It rebuilds the UI,
builds both native architectures, signs with a retained private local key,
checks signature/alignment, and writes a source-bound directory under
`app/dist-android/`. The key and its password live in `$ANDROID_SIGNING_DIR`
(default `~/.config/garret/android-signing`), outside the checkout; a missing
key is generated on first local use. CI release builds refuse missing signing
material; build-only CI runs explicitly use a disposable key. Keep the signing key and password private and backed up;
losing them prevents in-place updates. Do not share generated signing material.
This source stays at 0.0.2/version code 2 with the existing `cc.local.app`
identifier. Release preparation must raise both to 0.0.3/code 3 for an in-place
update with the same signing key. Native update and file-provider round trips
require their own runtime checks.

## Isolated runtime check

Build `garret-android-emulator` from `scripts/android/Dockerfile.emulator` after
building `garret-android`. Run only in a fresh container with a fresh emulator;
the driver refuses execution outside Docker. Set `apk` to the exact APK path
and `evidence` to an empty output directory before running:

```sh
docker run --rm --init --network none --device /dev/kvm \
  --cpus 8 --memory 8g --pids-limit 1024 \
  -v "$PWD/scripts/android/smoke.py:/test/smoke.py:ro" \
  -v "$apk:/test/app.apk:ro" -v "$evidence:/evidence" \
  garret-android-emulator nice -n 10 python3 /test/smoke.py /test/app.apk /evidence
```

The driver records the APK hash, UI checkpoints and screenshots. It verifies
actual text after a scene switch and after force-stop/reopen. ASCII input is
not a composition test. Failure diagnostics use only the temporary emulator's
synthetic books. Run this serialized with other heavy checks.

Sources: [Android command-line tools](https://developer.android.com/studio#command-tools)
and [Tauri Android prerequisites](https://v2.tauri.app/start/prerequisites/#android).
