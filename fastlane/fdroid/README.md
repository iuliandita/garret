# F-Droid submission draft

This is preparation, not an accepted listing. GitHub releases and Obtainium
remain the available update channels. The owner submits from their own GitLab
account; no submission or GitLab authentication is part of the build.

The recipe follows the native Rust/NDK build and generated Android project in
[Gitlalchemy's Tauri 2 recipe](https://gitlab.com/fdroid/fdroiddata/-/blob/7a9b76e699384cd6cd0136cfd18a894a31df9499/metadata/com.thomas.pedot.gitlalchemy.yml).
It uses the same universal arm64/x86_64 APK as GitHub, rather than introducing
ABI version codes. Rust 1.98.1, NDK 30.0.16248370, Bun 1.4.2, Node 26.11.1 and
Tauri CLI 2.11.5 match the release builder. Tauri invokes Cargo directly;
there is no cargo-ndk dependency to pin. The generated Gradle wrapper, Android
plugin and Kotlin versions come from that exact CLI. JDK 17 and Android API 36
are required. Tool upgrades must be made in the recipe and builder together
and followed by a fresh comparison. System JDK/Gradle environment differences
still require validation on F-Droid's builder.

## Select a release and submit

1. Publish a new release after these changes with package `com.usegarret.app`,
   a higher version code, and the retained signing key. Do not replace v0.0.3:
   that APK is `cc.local.app`, although its certificate has the same SHA-256.
   The disabled 0.0.4 entry is only a placeholder, not a reserved version.
2. Fork [fdroiddata](https://gitlab.com/fdroid/fdroiddata) in your own account
   and clone your fork. Copy `com.usegarret.app.yml` into its `metadata/`
   directory. Set `versionName`, `versionCode`, `commit` and `CurrentVersion`
   fields to that release, then remove the build's `disable` line. Confirm
   that `Binaries` expands to the actual published asset URL and that the
   release includes the English/German fastlane metadata.
3. From fdroiddata, run `fdroid lint com.usegarret.app`,
   `fdroid rewritemeta com.usegarret.app`, then
   `fdroid build --verbose com.usegarret.app`. Use the
   [official buildserver container procedure](https://f-droid.org/en/docs/Submitting_to_F-Droid_Quick_Start_Guide/)
   and keep its logs. Resolve scanner, SDK/tool provisioning and lint findings;
   the draft grants no blanket scanner exclusions. Review availability of the
   exact NDK/SDK versions in that buildserver before enabling the recipe.
4. Download the release APK and run `apksigner verify --print-certs` on it.
   Require certificate SHA-256
   `bddd339d8832a6378dbd0471e41a3d2148f4411fa8b004c6b5524c93f6684a92`.
   Run `apksigcopier compare release.apk rebuilt-unsigned.apk` using the
   exact unsigned output from the F-Droid build. It must succeed before
   claiming developer-signed reproducibility. A payload-only hash match
   is insufficient for v2/v3 signatures, which also cover ZIP layout.
5. On a disposable device/profile, install the GitHub build, create sample
   writing, then install the F-Droid candidate as an update without uninstalling
   or clearing data. Verify the sample and saved preferences. This cannot test
   migration from `cc.local.app`; follow the separate archive-transfer guide
   for that package move.
6. Commit the metadata in your fork and open an fdroiddata merge request.
   Include build logs, comparison results, the certificate fingerprint, the
   Tauri precedent and the explicit AI-assistance disclosure. Follow the
   [submission guide](https://f-droid.org/en/docs/Submitting_to_F-Droid_Quick_Start_Guide/).
   F-Droid maintainers decide inclusion and any AntiFeatures classification;
   this draft uses plain disclosure rather than inventing an AI flag.

## Reproducibility checks

Build the Android image first as described in the
[Android build guide](../../scripts/android/README.md#build). In two fresh,
clean checkouts at the same commit, run the following with different
`ANDROID_BUILD_ROOT` values (for example `/build-one` and `/build-two`):

```sh
ANDROID_UNSIGNED=1 ANDROID_BUILD_ROOT=/build-one scripts/package-android
```

Use your heavy-job serializer for each build, including image creation.
Unsigned mode never opens or mounts signing material. The two checkouts must
not share native target or generated Gradle build directories; dependency
download caches may be reused. Preserve both unsigned APKs and compare them:

```sh
python3 scripts/android/compare-apks.py first/unsigned.apk second/unsigned.apk
```

Exit zero means byte-identical unsigned APKs, including ZIP metadata. A
nonzero result reports differing entry hashes or metadata-only differences.
The shared build uses locked Cargo and Bun dependencies, path remapping for
Rust/C/C++, UTC/C.UTF-8, a commit-derived `SOURCE_DATE_EPOCH`, and deterministic
Gradle archives. APK timestamps are normalized by the Android Gradle plugin.
Build receipts outside the APK may include wall-clock time.

Two local builds establish only local determinism. F-Droid must independently
rebuild the tagged source and successfully copy/verify the published APK's
signature. With `Binaries` and `AllowedAPKSigningKeys`, F-Droid publishes the
developer's APK only on a successful match, and does not silently substitute
its own signing key. See [F-Droid reproducible builds](https://f-droid.org/docs/Reproducible_Builds/).
