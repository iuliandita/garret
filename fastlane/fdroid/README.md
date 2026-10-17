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
plugin and Kotlin versions come from that exact CLI. The release image uses
JDK 17; the F-Droid recipe uses Debian Trixie's OpenJDK 21 with Gradle 8.14.3
and AGP 8.11.0. Gradle supports running on Java 21 since 8.5
([compatibility matrix](https://docs.gradle.org/8.14.3/userguide/compatibility.html));
[AGP 8.11 requires at least JDK 17](https://developer.android.com/build/releases/agp-8-11-0-release-notes).
Android API 36 is required. Tool upgrades must be made in the recipe and
builder together and followed by a fresh comparison. See the verification
result below before submitting.

## Select a release and submit

1. Use the published v0.0.4 tag (`440929f5`) with package
   `com.usegarret.app`, version name `0.0.4` and version code `4`.
   The recipe's `Binaries` URL expands to
   [garret-0.0.4-android.apk](https://github.com/iuliandita/garret/releases/download/v0.0.4/garret-0.0.4-android.apk).
   Do not replace an existing release to accommodate a source fix; any source
   fix needs a new version and a new reproducibility comparison.
2. Fork [fdroiddata](https://gitlab.com/fdroid/fdroiddata) in your own account
   and clone your fork. Copy `com.usegarret.app.yml` into its `metadata/`
   directory and confirm the English/German fastlane metadata is included.
3. From fdroiddata, run `fdroid lint com.usegarret.app`,
   `fdroid rewritemeta com.usegarret.app`, then
   `fdroid build --verbose --test --on-server com.usegarret.app` inside a
   disposable [official buildserver container](https://f-droid.org/en/docs/Submitting_to_F-Droid_Quick_Start_Guide/).
   Pre-clone the source into `build/com.usegarret.app` and check out the
   selected release tag before invoking `--on-server`; production build hosts
   normally prepare this checkout before entering the builder. A direct
   invocation with no checkout can fail while reading `SOURCE_DATE_EPOCH`.
   The checkout's `origin` must be the public GitHub repository, reachable
   from inside the container. Use a fresh container for each attempt:
   `--on-server` removes `sudo` after provisioning, even if a later step fails.
   Also pre-populate `build/srclib/reproducible-apk-tools` at the recipe's
   pinned commit; `--on-server` assumes the outer build host has fetched
   srclibs. The existing fdroiddata srclib definition points to F-Droid's
   mirror, and the pinned commit is also available from
   [the upstream GitHub repository](https://github.com/obfusk/reproducible-apk-tools/tree/9401d827a2404827ec3de6cb90a879d9fbd3f60d).
   The `--on-server` option executes the recipe's tool-installation commands;
   plain local builds skip its `sudo` section. Keep the logs. Resolve scanner,
   SDK/tool provisioning and lint findings;
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
The generated Tauri configuration is sorted before asset merging: its embedded
desktop packaging maps otherwise serialize in random key order.
Build receipts outside the APK may include wall-clock time.

Two local builds establish only local determinism. F-Droid must independently
rebuild the tagged source and successfully copy/verify the published APK's
signature. With `Binaries` and `AllowedAPKSigningKeys`, F-Droid publishes the
developer's APK only on a successful match, and does not silently substitute
its own signing key. See [F-Droid reproducible builds](https://f-droid.org/docs/Reproducible_Builds/).

## Local verification

The [2026-10-17 comparison receipt](../../app/results/292-fdroid-reproducibility.json)
records two unsigned builds of commit `83ce734d` at different source paths,
with separate native targets and generated Gradle projects. Both APKs contain
958 entries and have SHA-256
`16cdafb5be550cef73fe673bd452dfa999e18d24210a42bafaabc479f84d73bd`.
The initial comparison isolated random Tauri configuration map ordering as
the only differing entry; canonicalization removed that difference.
This is local reproducibility evidence, not a match against a post-migration
published release or certification of installed-app updates.

## Official buildserver verification of 0.0.4

The official `registry.gitlab.com/fdroid/fdroidserver:buildserver` image at
digest `sha256:9cb68105642ca4e7b295f0ceab10f069f5b3247dc18fa7c36046e9d81aa469a8`
was tested with fdroidserver commit
`5806784d0d43bed7b938fd4b327162da68927060` and the unmodified v0.0.4 source
commit `440929f5a3a1e03779f9dec4385bbd17b926cabb`. The initial JDK 17
provisioning failure is resolved by Debian Trixie's OpenJDK 21
(`21.0.12.1+1-1-deb13u1-Debian`).

The first JDK 21 build completed compilation and APK packaging, but
fdroidserver's automatic signature-copy verification failed (exit 1).
Entry hashes isolated the payload difference to `lib/arm64-v8a/libgarret_lib.so`
and `lib/x86_64/libgarret_lib.so`. Java/Dex, resources and assets matched.
Tauri 2.11.5's code generator appends the CSP hashes of `main.js` and
`workspace.js` in filesystem traversal order; the published library contains
main then workspace, while the failed rebuild contains workspace then main.
Both libraries have identical Rust, Clang and linker version strings.

The recipe builds through `disorderfs --sort-dirents=yes --reverse-dirents=no`
to stabilize traversal, following the
[F-Droid reproducibility guide](https://f-droid.org/docs/Reproducible_Builds/)
and the [F-Droid client recipe precedent](https://gitlab.com/fdroid/fdroiddata/-/blob/19792568d3bccd9b98bbcde4c5f4ba743949ea36/metadata/org.fdroid.fdroid.yml).
The container needs `/dev/fuse`, `SYS_ADMIN` and permission to mount FUSE
(for Docker, `--device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor=unconfined`).
This changes the build environment, not the tagged application source.

After sorting traversal, every payload entry matched, but signature verification
still failed because apksigner 35+ replaces AGP's zero padding with `0xd935`
Android ZIP Alignment Extra Fields. Ordinary SDK `zipalign -P 16 -f 4` does
not perform that replacement. The recipe therefore pins the existing
`reproducible-apk-tools` srclib to commit
`9401d827a2404827ec3de6cb90a879d9fbd3f60d` and runs:

```sh
python3 "$tools/zipalign.py" --page-size 16 --pad-like-apksigner --replace \
  app/shell-tauri/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk \
  fdroid-unsigned.apk
```

Here `$tools` denotes the srclib path supplied by fdroidserver. This follows
[apksigcopier's documented workaround](https://github.com/obfusk/apksigcopier#zip-alignment).
The recipe's unsigned output is `fdroid-unsigned.apk`, including this
normalization. Copying the published signature onto that output produced an
APK byte-identical to the published release, with SHA-256
`f7e11bb6ba0b3e2b52f358b5439ee4eff035c6e2cba330d8843661c42918a56b`.
`apksigner verify --print-certs` passed and confirmed the retained certificate
fingerprint above. No application source fix or replacement release is needed.
