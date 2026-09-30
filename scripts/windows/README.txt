garret - Windows test preview
=============================

This is garret, an unfinished writing studio, shared for testing. This build
is unsigned. Testers have run garret successfully on Windows with no issues
reported. Please use a sample manuscript or a copy of your work, and keep
your original backup.

Running it
----------
Extract the entire ZIP, open the app folder and double-click
garret.exe. Keep the dist folder beside the executable.
Use a 64-bit Intel/AMD Windows PC. No installer or administrator rights are
required by this package.

Windows may show an unknown-publisher or SmartScreen warning. This package
has no trusted signing certificate. Check that it came from the person who
sent you the preview. Do not disable antivirus or other security protection.
If security software blocks it, send back the exact detection name and build
identifier from BUILD.txt rather than adding an exclusion.

The app needs Microsoft Edge WebView2. If startup fails, check whether the
Evergreen Runtime is installed. Install it if absent, then try again:
https://developer.microsoft.com/microsoft-edge/webview2/
An installed runtime does not rule out another startup problem. Keep the
technical details in startup-error.txt for the report.
The app itself keeps writing locally: no account or manuscript uploads.
Installing WebView2 may require a download.

If startup fails, look for:
    %APPDATA%\cc.local.app\startup-error.txt
Send that file back if it exists. Review diagnostic files for personal paths
before sharing them. Do not send your manuscript unless you intend to.

What to try
-----------
Create a test book, add a chapter and scene, type and format some text, then
close and reopen the app. Check that the text returns. Try undo/redo, search,
comments, the cast, the timeline, light/dark themes and English/German.
Try a Markdown, DOCX or EPUB export and open the result in another program.
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

These features are implemented. Further Windows testing and feedback help
cover different machines and workflows.

Known Windows limitations
-------------------------
- PDF proof/preview is not implemented for Windows. Use another export format.
- Application privacy locking is Linux-only in this preview. Its settings
  are unavailable on Windows. Do not copy a Linux privacy.json into this app.
- The application's spelling settings and project dictionary integration
  target Linux; Windows spelling behavior is not verified.
- A per-user single-instance guard is implemented, but its native Windows
  behavior remains unverified. Check that a second launch does not create a
  second running editor; use only one copy at a time.
- Scaling, accessibility, printing and sleep/resume have not been separately
  certified across Windows configurations.

Where your work lives
---------------------
New books default to Documents\Books until you choose another folder, which
the app remembers. Existing books stay where they were created. If the
Documents folder cannot be resolved, the fallback is Books under your home.
Settings and recovery use this location in Explorer:
    %APPDATA%\cc.local.app\
Older books may also remain there. Project-associated pictures
and covers can live in adjacent .pictures folders. Imported research originals
live in an adjacent .research folder. A .db alone is not a complete asset
backup. Close the app before copying files for backup, and keep each
manuscript together with its associated folders. Books created in
a folder you chose remain there.

Feedback
--------
Send the build identifier from BUILD.txt, your Windows version, what you did,
what you expected and what happened. A screenshot helps for display problems.
Report missing or changed writing immediately and keep the original files.
You do not need to send real manuscript content to report a problem.

COPYING contains the application license. THIRD-PARTY-NOTICES.md contains
notices for code vendored into its source tree.
