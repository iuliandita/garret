# Security Policy

## Reporting a vulnerability

Please report security problems privately. **Do not open a public issue.**

Use GitHub's
[private vulnerability reporting](https://github.com/iuliandita/garret/security/advisories/new),
or contact [@iuliandita](https://github.com/iuliandita) through GitHub.

## What to expect

- Acknowledgment within 7 days
- A status update within 14 days
- Fix and disclosure coordinated with you before any public announcement

## Scope

garret is a local, offline desktop app with no server and no account. In scope:
the application code, its file formats (books, recovery copies, encrypted
archives, review documents), import and export paths, and the packaging scripts
in this repository.

Worth knowing when you assess an issue: the optional privacy lock hides the app
behind a PIN but does not encrypt manuscripts; encrypted portable archives do
encrypt their contents with a separate recovery key.

## Supported versions

garret is pre-1.0. Only the latest release and the current `develop` branch
receive security fixes.

## Verifying releases

Release signing key fingerprint: `8270 74C7 C4A2 9486 FB48  BC00 8B54 EB1A DBE5 8725`

The public key is [docs/release-signing-key.asc](docs/release-signing-key.asc)
(`iuliandita (garret release signing) <iulian.dita@gmail.com>`). Releases from
0.0.3 add `SHA256SUMS`, its detached GPG signature `SHA256SUMS.asc`, and GitHub
build provenance attestations. Earlier releases provide only per-file checksums.
Do not trust a key supplied only alongside a download: compare its full
fingerprint with this page and the README before importing it.

Download the manifest, signature, all packaged downloads and their `.sha256`
sidecars from the same release into one directory. Import the key with
`gpg --import release-signing-key.asc`, check `gpg --fingerprint` against the
fingerprint above, then run:

```sh
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS
gh attestation verify <file> --repo iuliandita/garret \
  --signer-workflow iuliandita/garret/.github/workflows/release.yml
```

For a platform-specific subset, run `sha256sum -c --ignore-missing SHA256SUMS`,
or `shasum -a 256 -c --ignore-missing SHA256SUMS` on macOS. These commands skip
missing files; confirm that every intended download reports `OK`.

Replace `<file>` with each file to verify its repository provenance, including
`SHA256SUMS` and `SHA256SUMS.asc`. The manifest covers every packaged asset and
checksum sidecar, excluding itself and its detached signature. All listed files
must be present for the complete checksum check. A valid checksum alone does
not authenticate a publisher. A provenance attestation identifies the workflow
and source commit; it does not certify that the program is free of defects.

Publication fails without the GPG signature by default. An explicit repository
override can permit an unsigned release, which carries a warning in its release
notes. Missing signatures cannot be verified with GPG. Platform code signing is
separate; see the [code signing policy](docs/SIGNING.md).
