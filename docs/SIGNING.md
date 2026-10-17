# Code signing policy

garret is GPL-3.0-or-later software. Official release builds come from the
public [source repository](https://github.com/iuliandita/garret) and its release
workflow. The application runs locally and offline. Distributed builds collect
no user data, telemetry, manuscript content, or usage information, and require
no account.

## Roles and approval

The project owner, [iuliandita](https://github.com/iuliandita), is the release
author and signing approver. The owner must use MFA for GitHub and any signing
service account. Each release submitted for platform code signing requires
explicit manual approval by the owner after reviewing its source commit,
successful checks, and proposed artifacts. Automated build completion alone
does not approve code signing.

## What is signed

Android APKs use the retained Android release identity. Windows installers and
installed executables currently have no Authenticode signature. macOS bundles
have no Developer ID signature or notarization; Linux packages have no platform
signature. These limits are separate from checksums and release provenance.

The release workflow prepares platform packages before generating `SHA256SUMS`
over every packaged download and checksum sidecar. It then GPG-signs that
manifest when the release key is configured and generates GitHub artifact
attestations for the downloads, manifest, and available signature. The manifest
cannot include itself or its detached signature. See
[release verification](../SECURITY.md#verifying-releases) for commands and the
signing key's publication status.

## Planned Windows signing

SignPath Foundation acceptance is pending and is at the Foundation's discretion.
No SignPath signing integration is enabled. If accepted, official Windows
installer executables and their installed application executable will be
submitted for Authenticode signing. Signing will require a protected GitHub
environment with the owner as required reviewer and a manual approval for
each release, followed by the signing service's approval process. The signed
artifacts must be returned before checksums and provenance are generated.

## Unsigned fallback

Windows installers and portable downloads remain available without platform
code signing if the application is declined or the service is unavailable.
Unsigned files may show operating system trust warnings. A platform signature
must never be claimed for an unsigned file.

The GPG manifest signature is required for publication by default. The owner
can explicitly allow publication without it using the repository variable
`ALLOW_UNSIGNED_RELEASE=true`; the workflow then warns in its logs and release
notes. This override does not bypass source eligibility, checksum validation,
or artifact attestations. An invalid configured signing key fails publication
even when the override is enabled.
