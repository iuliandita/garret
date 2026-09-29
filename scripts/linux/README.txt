garret - Linux test preview (x86_64)
====================================

This is garret, an unfinished writing studio, shared for testing. Use a sample
manuscript or a copy of your work, and keep your original backup. Writing
stays on your machine: no account or manuscript uploads.

Requirements
------------
A 64-bit Intel/AMD Linux desktop with glibc 2.39 or newer, GTK 3 and WebKitGTK
4.1. The target baseline is Linux Mint 22.x / Ubuntu 24.04. This build does
NOT run on Mint 21.x / Ubuntu 22.04 or Debian 12; those need an older-base
build. Do not replace your system glibc to run this preview.

On Mint 22.x or Ubuntu 24.04, install the runtime with:

    sudo apt update
    sudo apt install libwebkit2gtk-4.1-0

APT installs GTK and the other runtime dependencies automatically. No Rust,
Bun, compiler or development packages are needed. Optional English spelling:

    sudo apt install hunspell-en-us

Use the dictionary package for your language, such as hunspell-de-de for
German. Other distributions need their WebKitGTK 4.1 runtime package
(Arch: webkit2gtk-4.1; Fedora: webkit2gtk4.1) and a compatible glibc.
The exact binary requirement and source revision are in BUILD.txt.

Running it
----------
Extract the whole archive, then open a terminal in the extracted folder:

    cd app
    ./garret

Keep the dist folder beside the executable. No administrator rights are
needed to run the app. If the window misbehaves under Wayland, try:

    GDK_BACKEND=x11 ./garret

To check the extracted files:

    sha256sum -c SHA256SUMS.txt

What to try
-----------
Create a test book, add a chapter and scene, type and format some text, then
close and reopen the app. Check that the text returns. Try undo/redo, search,
comments, the cast, the timeline, light/dark themes and English/German.
Try Markdown, DOCX and EPUB exports and open them in another program.
Try the outline table/cards, chapter editing, read-only references, revision
passes/tasks, series membership, analytics and local craft/consistency reports.
Explore explicit links in Knowledge and research > Relationships.
DOCX import reports unsupported content it cannot keep; review that notice
before relying on the imported copy.
Analytics is optional and shows where recorded activity is incomplete.
Craft reports show evidence to review, not a universal writing-quality score.
Book design can be transferred as a separate file after reviewing its changes.
Prose exports do not automatically carry those editable design choices,
font files or cover pictures into another project.
Research files are copied into the project; importing one does not execute
them. Readable prose exports do not include these research originals.

Use a disposable book to test encrypted portable archives: save the recovery
key separately, create an archive, and restore it into a new location. Losing
all copies of the key makes the encrypted archive unreadable. This does not
encrypt the live manuscript, its ordinary recovery copies or readable mirror.

PDF export is a proof copy, not a production print file. Check the result
in another reader before using it; unrepresentable content is refused.

The optional Linux privacy lock hides the app behind a PIN. It does not
encrypt your manuscripts or protect them from someone who can read your
files. Desktop lock integration depends on the desktop/session services;
behavior across Mint desktops has not been certified.

Where your work lives
---------------------
New books default to Documents/Books until you choose another folder, which
the app remembers. Existing books stay where they were created. If the
Documents folder cannot be resolved, the fallback is Books under your home.
Settings and recovery use:

    ~/.local/share/cc.local.app/

An absolute XDG_DATA_HOME override changes that data base. Older books may
also remain there. Project-associated pictures and covers can live in
adjacent .pictures folders. Imported research originals live in an adjacent
.research folder. A .db alone is not a complete backup of these assets.
Close the app before copying files for backup, and keep each manuscript
together with its associated folders.

Feedback
--------
Send the build identifier from BUILD.txt, your distribution and version,
what you did, what you expected and what happened. Include terminal output
for startup failures and a screenshot for display problems. Review logs for
personal paths before sharing them. You do not need to send real manuscript
content to report a problem. Report missing or changed writing immediately.

COPYING contains the application license. THIRD-PARTY-NOTICES.md contains
notices for code vendored into its source tree.
