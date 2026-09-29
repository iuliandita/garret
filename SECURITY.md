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
