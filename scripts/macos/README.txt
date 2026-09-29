garret - Mac test preview
=========================

This is garret, an unfinished writing studio, shared for testing. Native Mac
building, window behavior and manuscript workflows have not been verified
by the Linux development checks. Use a disposable sample or a copy of your
work, and retain your original backup. No account or manuscript uploads.

Build preparation
-----------------
A Mac maintainer can run scripts/package-macos from a clean source checkout
with Apple command-line tools, native Rust and Bun installed and the locked
workspace dependencies available. The script builds the interface and host
for the Mac's native architecture with at most eight Cargo jobs. It refuses
Rosetta builds and unexpected non-system dynamic library dependencies.
It does not download an Apple SDK, provision an account or buy signing.

Each attempt keeps its own directory under app/dist-macos; previous outputs
are preserved. Do not distribute a directory containing INCOMPLETE.txt.
BUILD.txt identifies source revision, architecture, toolchain, signing and
minimum macOS version read from the executable. That minimum is a loader
requirement, not certification on every macOS version above it.

Running a supplied package
--------------------------
Extract the complete ZIP. Keep the README, BUILD.txt and checksums. Move
garret.app to a writable location if desired and double-click it.
Use the architecture named in BUILD.txt: arm64 for Apple Silicon or x86_64
for Intel. This is not a universal binary. Keep the application bundle
intact; the interface lives beside the executable inside its Contents folder.
No Rust, Bun or development tools are required just to run a supplied app.

The bundle has an ad-hoc integrity signature only. It has no trusted signing
identity and is not notarized. Gatekeeper may block it. This package does
not establish trusted publisher identity or Gatekeeper approval. Do not
disable system protection or remove quarantine attributes to follow these
instructions. Report the exact warning and build identifier with your feedback.

From Terminal in the extracted app folder, check its contents with:

    shasum -a 256 -c SHA256SUMS.txt

An archive checksum is supplied separately. Checksums detect changes but do
not authenticate the publisher. Obtain the package only from a source you
trust.

What to try after the app opens
------------------------------
Create a disposable book, add a chapter and scene, type and format text,
close the app, and reopen it. Check that the text returns. Try undo/redo,
search, comments, the cast, light/dark themes and English/German. Check
keyboard navigation and screen-reader access. Try Markdown, DOCX and EPUB
exports and inspect them in another program. DOCX import reports unsupported
content it cannot keep; review that notice before relying on the imported copy.
Explore saved relationships through Knowledge and research > Relationships.
This view shows explicit links, not inferred connections.

PDF proof/preview and application privacy locking are Linux-only in this
preview. Mac spelling settings, dictionary integration, native accessibility,
window behavior and the single-instance guard remain unverified. Use one
copy at a time. Do not copy a Linux privacy.json into this app. No Mac
functional checks are performed by the packaging script.

Where your work lives
---------------------
New books default to Documents/Books until you choose another folder. The
app remembers that folder. Existing books stay where they were created.
If a Documents folder cannot be resolved, the default falls back to Books
under your home directory.

This preview currently uses the non-Windows data layout for settings and
recovery, not the usual Mac Application Support folder:

    ~/.local/share/cc.local.app/

An absolute XDG_DATA_HOME override changes the data base directory. Older
books may also remain under that data directory. Manuscript .db files can
have adjacent .pictures and .research folders; the .db alone is not a
complete backup. Close the app before file-copy backups, and keep each
manuscript with its associated folders.

Feedback
--------
Send the source/build identifier from BUILD.txt, Mac model/architecture,
macOS version, steps, expected result and actual result. Include a screenshot
for display problems. Review logs for personal paths before sharing them.
Do not send real manuscripts to report a problem. Report missing or changed
writing immediately and preserve the original files.

COPYING contains the application license. THIRD-PARTY-NOTICES.md contains
notices for code vendored into its source tree.
