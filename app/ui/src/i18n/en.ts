// app/ui/src/i18n/en.ts
// The English source catalog. Every user-facing string the page renders.
//
// THIS FILE IS THE ONE PLACE A UI STRING MAY BE WRITTEN AS A LITERAL.
// `app/ui/test/no-hardcoded-strings.test.ts` parses `app/ui/src` and fails on
// a user-facing literal anywhere else, with a short, explicit allowlist for
// the genuine non-UI ones (CSS text, DOM key names, internal invariant
// messages). That guard is the point: an architecture nobody is forced to use
// is worth nothing the week after it lands.
//
// KEYS ARE `area.name`, grouped by the unit that renders them, in the order
// the units appear in `app/ui/src`. A plural has one entry per CLDR category
// under `area.name.<category>`; English needs `one` and `other`, and
// `messages.ts` falls back to `other` for any category a catalog omits.
//
// THE CLDR CATEGORY SUFFIXES ARE RESERVED. A key ending `.one`, `.other`,
// `.zero`, `.two`, `.few` or `.many` is read as one arm of a plural, by
// `messages.plural` and by the test that checks every plural base has an
// English pair. `find.replaced.single` and `outline.attempt.generic` are named
// that way because the obvious spellings would have collided.
//
// PLACEHOLDERS ARE `{name}` and are substituted with `String(value)` and
// nothing else. Any figure a writer or a rig reads with thousands separators
// is formatted at the call site with `.toLocaleString()`, exactly as it was
// before this catalog existed - see the header of `messages.ts` for why the
// formatting must not move in here.
//
// THE TEXT IS NOT UP FOR REVISION HERE. This catalog was populated by moving
// literals, byte for byte, out of the units that held them. Two graded rigs
// parse strings in it (`words-cli` and `export-cli` read the word count's
// accessible name; `menu-cli` and the outline run locate rows and menu titles
// by name), and a wording change has already silently demoted a graded gate to
// UNKNOWN once. Change a string here only with a rig run behind it.

export const EN = {
  "creation.destination-changed": "The destination changed. Open the chooser again before adding an item.",
  "creation.plus": "+",
  "prefs.sidebar-word-counts": "Sidebar word counts",
  "prefs.sidebar-word-counts.scene": "Scenes",
  "prefs.sidebar-word-counts.chapter": "Chapters",
  "prefs.sidebar-word-counts.part": "Parts (acts)",
  "prefs.tab.writing": "Writing",
  "prefs.tab.appearance": "Appearance",
  "prefs.tab.application": "Application",
  "prefs.writing-aids": "Writing aids",
  "prefs.tabs.label": "Preferences categories",
  "menu.new": "New…",
  "menu.more": "More…",
  "menu.back": "Back",
  "menu.organize": "Organize…",
  "menu.planning": "Planning…",
  "menu.views": "Views…",
  "menu.review": "Review…",
  "menu.publishing": "Publishing…",
  "menu.copies": "Copies…",
  "menu.book-pages": "Book pages",
  "registration.preference": "Saved at {path} and available in the Library, but the folder for future books could not be remembered.",
  "registration.unavailable": "A file was saved at {path}, but its book identity could not be checked. Keep this file; it cannot be added to the Library here.",
  "registration.warning": "Saved at {path}, but not added to the Library.",
  "registration.session": "Add this book before closing garret. This retry is available only until garret closes; the saved book stays on disk.",
  "registration.retry": "Add to Library",
  "registration.done": "{name} was added to the Library.",
  "creation.manuscript": "Add",
  "creation.bible": "Add to Bible",
  "creation.destination": "Destination: {name}",
  "creation.entry": "Entry",
  "creation.folder": "Folder",
  "creation.timeline": "Timeline",
  "creation.open": "Add to book",
  "creation.bible.open": "Add to Bible",
  "chrome.home": "Home",
  "chrome.home.label": "Home: Library",
  "chrome.home.hint": "Return to the Library.",
  "nav.words.described": "{count} words",
  "nav.state.described": "Revision status: {state}",
  "library.new-book.cancel": "Cancel",
  "chrome.outline.close": "Close outline",
  "prefs.focus.note": "Dim other paragraphs and fade the frame while you type. Move the pointer or press Escape to show it again.",
  "prefs.typewriter.note": "Keep the line you are writing near the center of the pane as you type or move the caret.",
  "prefs.mark-cast-names.note": "Underline names from your cast. Hover over a marked name or press Ctrl+Shift+I to show its entry.",
  "library.pen-name.sort-note": "Optional. For Jane Smith, use Smith, Jane to sort by surname.",
  "help.guide.heading": "Writing guide",
  "help.shortcuts.heading": "Keyboard shortcuts",
  "help.guide.structure.title": "Structure a book",
  "help.guide.structure.body": "Use the plus next to the book name to add a scene, chapter or part. Select an item and use Outline > Organize to reorder or nest it. Delete moves manuscript items to the bin; select them there to Restore. Outline > Views > Book overview shows titles, synopses and revision states together.",
  "help.guide.annotate.title": "Annotate a passage",
  "help.guide.annotate.body": "Select prose, then choose Edit > Add comment or press Ctrl+Alt+M. Edit > Comments lists the notes for the open scene and lets you return to a passage or resolve a note. Outline > Planning > Synopsis describes the selected scene or chapter rather than a passage.",
  "help.guide.export.title": "Export the manuscript",
  "help.guide.export.body": "File > Publishing offers Markdown for readable text and Word for an editor. EPUB preview and PDF proof show the book with its publishing layout. Set Book design, Covers and Pen names before preparing a publication. Exports are copies; writing continues in the original book.",
  "help.guide.protect.title": "Protect copies of your work",
  "help.guide.protect.body": "garret saves your writing as you work. File > Copies > Create recovery point keeps a recovery copy on this device.\n\nTo protect against losing your computer, open File > Copies > Encrypted backups. Create a recovery key, keep a spare copy separately, then make an encrypted archive. Choose a backup folder in Google Drive, Dropbox or on a USB drive, or copy the archive there afterward. Repeat regularly and keep a few older copies.\n\nVerify encrypted archive checks your backup; Restore encrypted archive creates a separate book. Open it from your library.\n\nKeep your working book outside cloud folders. A readable folder is not a complete backup. Privacy lock hides the window; it does not encrypt your book.",
  "menu.outline.group.create": "Add to the book",
  "menu.outline.group.navigate": "Navigate",
  "menu.outline.group.structure": "Arrange the outline",
  "menu.outline.group.plan": "Plan scenes and cast",
  "menu.outline.group.views": "Read and compare",
  "menu.outline.group.review": "Review the book",
  "editor.name": "Manuscript editor",
  // panel-shell.ts: the Close icon every anchored panel shares.
  "panel.close": "Close {title}",
  "help.about": "About {label}",
  "menu.review-proposals": "Review proposals…",
  "review.heading": "Review proposals",
  "review.author": "Review author",
  "review.author-name": "New author name",
  "review.author-create": "Create author",
  "review.author-add": "Add reviewer",
  "review.choose-author": "Choose an author",
  "review.views": "Review view",
  "review.proposals": "Proposals",
  "review.new": "New proposal",
  "review.refresh": "Refresh",
  "review.first": "Newest",
  "review.next": "Older",
  "review.history": "Include decided proposals",
  "review.message": "Your message",
  "review.post": "Post message",
  "review.message-immutable": "Posted messages cannot be edited.",
  "review.bold": "Bold",
  "review.italic": "Italic",
  "review.underline": "Underline",
  "review.submit": "Submit proposal",
  "review.one-block": "This draft becomes one change block. Edits in different places will be accepted or rejected together. Submit separate proposals for separate decisions.",
  "review.leave-question": "Discard unsubmitted drafts and messages?",
  "review.keep": "Keep editing",
  "review.discard": "Discard drafts",
  "review.no-text": "No text",
  "review.unchanged": "The draft has no changes.",
  "review.invalid-draft": "This document cannot be used as a review draft. Your saved prose is unchanged.",
  "review.unsaved": "Unsaved draft. It is kept only while this app stays open.",
  "review.saved-baseline": "Draft based on the saved document.",
  "review.draft-label": "Proposal draft",
  "review.summary": "{author}, {date}: {counts}",
  "review.summary.bare": "{author}, {date}",
  "review.count.pending": "{count} pending",
  "review.count.conflicted": "{count} in conflict",
  "review.count.accepted": "{count} accepted",
  "review.count.rejected": "{count} rejected",
  "review.empty": "No proposals on this page.",
  "review.state.pending": "Pending",
  "review.state.conflicted": "Conflicted",
  "review.state.accepted": "Accepted",
  "review.state.rejected": "Rejected",
  "review.state.unknown": "Unknown state",
  "review.by": "Proposed by {author}",
  "review.hunk": "Change {number}: {state}",
  "review.decided-by": "Decision by {author}",
  "review.conflict": "The saved text changed here. This change can be rejected, but cannot be accepted.",
  "review.before": "Before",
  "review.after": "Proposed",
  "review.accept": "Accept selected",
  "review.reject": "Reject selected",
  "review.discussion": "Discussion",
  "review.message-by": "{author}, {date}",
  "review.load-failed": "Could not refresh this review. Your drafts are kept.",
  "review.save-failed": "Could not save this review action. Your drafts are kept. Refresh, then try again explicitly.",
  "review.keep-target": "This review has unsubmitted work. Close it first to review another document.",
  "review.no-prose": "Open a prose document first.",
  "review.unsaved-prose": "Could not save the prose before reviewing it.",
  "review.busy": "A review action is already in progress.",
  "review.invalid-result": "Could not safely apply the review result.",
  "review.saved": "Review saved.",
  "review.transport.tab": "Review in Word",
  "review.transport.heading": "Review in Word",
  "review.transport.scope": "For {title} only. Word changes this app cannot read are refused, and the Word file never replaces your manuscript.",
  "review.transport.export": "Prepare review copy",
  "review.transport.return": "Open the returned Word file",
  "review.transport.export-preview": "Before saving the review copy",
  "review.transport.return-preview": "Review changes from Word",
  "review.transport.export-ready": "Review copy ready. Read the names and discussion below before saving.",
  "review.transport.return-ready": "Returned review ready. Check every decision and choose local names before applying.",
  "review.transport.scene": "Scene: {title}",
  "review.transport.authors": "Reviewer names included: {names}",
  "review.transport.none": "none",
  "review.transport.export-warning": "The reviewer names and discussion below go into the Word file. Saving a copy does not change your manuscript.",
  "review.transport.return-warning": "Only the listed changes can be applied. New suggestions stay pending. Unsupported or stale returns leave your manuscript unchanged.",
  "review.transport.discussion": "Discussion included ({count})",
  "review.transport.old-decisions": "Decisions on existing proposals ({count})",
  "review.transport.new-suggestions": "New suggestions ({count})",
  "review.transport.accept": "Accepted proposal by {author}",
  "review.transport.reject": "Rejected proposal by {author}",
  "review.transport.attribution": "Choose local attribution",
  "review.transport.decision-actor": "Who made the decisions above?",
  "review.transport.map-author": "Word reviewer {name} becomes",
  "review.transport.choose-author": "Choose a local name",
  "review.transport.create-author": "Create a new local name",
  "review.transport.new-author-name": "New local name",
  "review.transport.no-new-work": "No new suggestions or discussion to attribute.",
  "review.transport.save": "Save the Word file…",
  "review.transport.apply": "Apply reviewed decisions",
  "review.transport.cancel": "Discard preview",
  "review.transport.cancel-first": "Discard the Word review preview before switching views.",
  "review.transport.drafts-first": "Submit or discard your local review drafts before opening a Word review.",
  "review.transport.preview-failed": "Could not prepare this Word review. No changes were applied: {reason}",
  "review.transport.save-failed": "Could not save the review copy. Prepare a fresh preview before trying again: {reason}",
  "review.transport.apply-failed": "No changes were applied. Open the returned file again for a fresh preview: {reason}",
  "review.transport.reconcile-failed": "The book may have changed, but this view could not refresh safely. Restart garret before editing this book: {reason}",
  "review.transport.saved": "Review copy saved.",
  "review.transport.applied": "Returned review applied.",

  "menu.knowledge": "Knowledge and research",
  "menu.craft-reports": "Craft reports",
  "craft.heading": "Knowledge and craft reports",
  "relationships.title": "Relationships",
  "relationships.search": "Find a person, document or source",
  "relationships.focus": "Explore relationships for",
  "relationships.endpoint": "{caption} ({kind}){distinction} {state}",
  "relationships.distinction": " [{id}]",
  "relationships.kind.item": "Document",
  "relationships.kind.cast": "Cast entry",
  "relationships.kind.resource": "Research copy",
  "relationships.missing": "Missing reference",
  "relationships.empty": "No entries to explore. Add relationships in Knowledge.",
  "relationships.summary": "{links} with {neighbors}.",
  "relationships.count.one": "{count} relationship",
  "relationships.count.other": "{count} relationships",
  "relationships.entries.one": "{count} entry",
  "relationships.entries.other": "{count} entries",
  "relationships.omitted.one": "{count} entry is left out of the diagram; the list below has every relationship.",
  "relationships.omitted.other": "{count} entries are left out of the diagram; the list below has every relationship.",
  "relationships.incoming": "Incoming",
  "relationships.outgoing": "Outgoing",
  "relationships.both": "Both directions",
  "relationships.detail.label": "Relationship: {value}.",
  "relationships.detail.note": "Note: {value}.",
  "relationships.detail.citation": "Citation: {value}.",
  "relationships.previous": "Previous relationships",
  "relationships.next": "Next relationships",
  "relationships.page": "Page {page} of {pages}",
  "craft.views": "Craft view",
  "craft.knowledge": "Knowledge",
  "craft.reports": "Reports",
  "craft.search": "Search notes and research",
  "craft.resources": "Research copies",
  "craft.resource-limits": "Each file you import is copied into the book, up to 256 MB a file and 2 GB in all, and at most 2,000 files. Full backups include the copies. The app keeps each file as it is and never opens it for you.",
  "craft.resource-title": "Title",
  "craft.resource-type": "File type (optional)",
  "craft.source-note": "Source note",
  "craft.citation": "Citation",
  "craft.source-line": "{note} ({citation})",
  "craft.import": "Import a copy…",
  "craft.links": "Relationships",
  "craft.link-from": "From",
  "craft.link-to": "To",
  "craft.link-label": "Relationship label",
  "craft.link-note": "Note",
  "craft.anchor": "Link the selected passage",
  "craft.add-link": "Add relationship",
  "craft.scope": "What to check",
  "craft.scope.document": "Current document",
  "craft.scope.chapter": "Current chapter",
  "craft.scope.book": "Whole book",
  "craft.language": "Language of these documents",
  "craft.language.unknown": "Unknown or mixed",
  "craft.language.english": "English",
  "craft.language.german": "German",
  "craft.quotes": "Dialogue quotation style",
  "craft.quotes.curly": "Curly double quotes",
  "craft.quotes.ascii": "Straight double quotes",
  "craft.watch-term": "Word or phrase to watch for",
  "craft.watch-mode": "Match",
  "craft.watch.literal": "Exact",
  "craft.watch.folded": "Any case",
  "craft.watch-add": "Add to watchlist",
  "craft.run": "Run on saved text",
  "craft.cancel": "Cancel reading",
  "craft.export-json": "Export as JSON…",
  "craft.export-csv": "Export for a spreadsheet…",
  "craft.error": "Could not update knowledge or reports: {error}",
  "craft.included": "kept in full backups",
  "craft.missing": "the copy is missing or has changed",
  "craft.removed": "removed, still kept in backups",
  "craft.size.bytes.one": "{count} byte",
  "craft.size.bytes.other": "{count} bytes",
  "craft.size.kb": "{size} KB",
  "craft.size.mb": "{size} MB",
  "craft.unavailable": "unavailable",
  "craft.anchor-stale": "passage changed; saved quote retained",
  "craft.save-copy": "Save a copy…",
  "craft.remove": "Remove",
  "craft.open-passage": "Open passage",
  "craft.restore": "Restore",
  "craft.imported": "Research copy imported.",
  "craft.no-passage": "Select a passage in the open document first.",
  "craft.unsaved": "The latest edits could not be saved.",
  "craft.linked": "Relationship saved.",
  "craft.coverage": "Read {documents} and {words}; {findings}.",
  "craft.count.documents.one": "{count} document",
  "craft.count.documents.other": "{count} documents",
  "craft.count.words.one": "{count} word",
  "craft.count.words.other": "{count} words",
  "craft.count.findings.one": "{count} finding",
  "craft.count.findings.other": "{count} findings",
  "craft.truncated.documents": "Stopped at the document limit.",
  "craft.truncated.words": "Stopped at the word limit.",
  "craft.truncated.findings": "Stopped at the findings limit.",
  "craft.metric.paragraphs": "Paragraphs",
  "craft.metric.sentences": "Sentences (estimated)",
  "craft.metric.dialogue": "Words in dialogue",
  "craft.metric.unmatched": "Unmatched quotes",
  "craft.metric.readability": "Readability (English)",
  "craft.findings": "Findings",
  "craft.finding.adjacent_word": "Repeated adjacent word",
  "craft.finding.repeated_phrase": "Repeated phrase",
  "craft.finding.watchlist": "Watchlist match",
  "craft.structural": "exact match",
  "craft.suggestion": "style suggestion",
  "craft.stale": "The text changed; run the report again before opening this.",
  "craft.canceled": "Report reading canceled.",
  "craft.reading": "Reading {title}…",
  "craft.ready": "Report ready, from the saved text.",
  "craft.no-sources": "No saved documents in this scope.",
  "craft.no-report": "Run a report before exporting.",
  "craft.resource-row": "{title}: {name}, {size}, {state}.",
  "craft.link-row": "{source} to {target}: {label}.",
  "craft.link-row.plain": "{source} to {target}.",
  "craft.watch-row.literal": "{term} (exact)",
  "craft.watch-row.folded": "{term} (any case)",
  "craft.finding-row": "{kind}, {class}: {excerpt}",
  "craft.def.tokens": "Words are letters and numbers, with apostrophes and hyphens inside a word kept; case is ignored.",
  "craft.def.repeated_phrase": "A repeated phrase is three words in a row that appear again within 100 words in the same paragraph.",
  "craft.def.sentences": "A full stop, question mark or exclamation mark followed by a space or the end of a paragraph ends a sentence, so abbreviations can be miscounted.",
  "craft.def.dialogue": "Words between a matching pair of the chosen double quotes. Nested or unmatched quotes are counted as uncertain, not as dialogue.",
  "craft.def.readability": "An English Flesch score estimated from vowel groups and sentence punctuation. Names, abbreviations and other languages throw it off.",
  "craft.def.csv_text": "Every cell is quoted, and a cell that starts like a formula gets a leading apostrophe so a spreadsheet will not run it.",
  "craft.limit.documents": "Most documents to read",
  "craft.limit.words": "Most words to read",
  "craft.limit.findings": "Most findings to list",
  "craft.knowledge-row": "{kind}: {caption}. {detail} ({class})",
  "craft.consistency.unavailable_link": "Unavailable relationship target",
  "craft.consistency.missing_resource": "Research original unavailable",
  "craft.consistency.alias_collision": "Alias shared by different cast entries",
  "craft.consistency.unused_entry": "Cast entry has no tagged appearance",
  "craft.consistency.no-appearance": "No manuscript appearance is tagged; this does not mean the name is absent from the prose.",
  "analytics.title": "Analytics",
  "analytics.close": "Return to writing",
  "analytics.loading": "Reading your sessions…",
  "analytics.ready": "Sessions are up to date.",
  "analytics.coverage": "Sessions are recorded only after you start recording. Earlier writing time and saved words are kept separately and are not rebuilt here.",
  "analytics.archive": "Full backups and archives keep this history; prose exports and readable folders do not. After you delete it here, earlier backups may still hold it.",
  "analytics.definition": "A minute counts when a change was saved in it, so this is not a timer. Added and deleted words come from the editor; their net is checked against the change in the saved word count.",
  "analytics.spanDefinition": "A session runs from opening the book to closing it, so breaks fall inside it. Its length is not time spent writing.",
  "analytics.recording": "Session recording",
  "analytics.recording.on": "On for this book. You can stop it here at any time.",
  "analytics.recording.off": "Off. Nothing is recorded until you start it.",
  "analytics.recording.timeOff": "Time tracking is off in Preferences, so this book records no minutes or saved words.",
  "analytics.recording.enable": "Start recording",
  "analytics.recording.resume": "Resume recording",
  "analytics.recording.disable": "Stop recording",
  "analytics.category": "Current activity",
  "analytics.category.drafting": "Drafting",
  "analytics.category.revision": "Revision",
  "analytics.category.planning": "Planning",
  "analytics.category.review": "Review",
  "analytics.category.named": "{name} (custom)",
  "analytics.category.namedDuplicate": "{name} (custom {number})",
  "analytics.category.retiredNamed": "{name} (retired custom)",
  "analytics.category.retiredDuplicate": "{name} (retired custom {number})",
  "analytics.category.duplicate": "An active activity already has that name. Choose a different name.",
  "analytics.category.custom": "New activity name",
  "analytics.category.namingRule": "Each active activity needs its own name. A retired name can be used again; past sessions keep the name they had.",
  "analytics.category.add": "Add activity",
  "analytics.category.retire": "Retire selected activity",
  "analytics.category.all": "All activities",
  "analytics.category.filter": "Activity filter",
  "analytics.filters": "Filters",
  "analytics.scope": "Scope",
  "analytics.scope.book": "This book",
  "analytics.scope.library": "Library",
  "analytics.scope.all": "All",
  "analytics.identity": "Pen name",
  "analytics.series": "Series",
  "analytics.universe": "Universe",
  "analytics.from": "From",
  "analytics.through": "Through",
  "analytics.duplicate.skip": "Skip duplicate copies",
  "analytics.duplicate.choose": "Choose one copy",
  "analytics.library.coverage": "Library totals read each chosen book without changing it. Books that cannot be read, and copies of one book you have not chosen between, are left out.",
  "analytics.library.unknown.books.one": "{count} book could not be read.",
  "analytics.library.unknown.books.other": "{count} books could not be read.",
  "analytics.library.unknown.sessions.one": "Sessions for {count} book were unavailable.",
  "analytics.library.unknown.sessions.other": "Sessions for {count} books were unavailable.",
  "analytics.library.unknown.words.one": "Saved words for {count} book were unavailable.",
  "analytics.library.unknown.words.other": "Saved words for {count} books were unavailable.",
  "analytics.library.unknown.copies.one": "{count} book has copies; choose one above to include it.",
  "analytics.library.unknown.copies.other": "{count} books have copies; choose one of each above to include them.",
  "analytics.summary": "Observed activity",
  "analytics.summary.definition": "Figures come from recorded sessions only (measurement version {version}). Totals include your corrections; the last column shows what was recorded before them.",
  "analytics.structure": "Current book structure",
  "analytics.structure.parts": "Parts",
  "analytics.structure.chapters": "Chapters",
  "analytics.structure.scenes": "Scenes",
  "analytics.structure.passes": "Revision passes",
  "analytics.structure.tasks.open": "Open revision tasks",
  "analytics.structure.tasks.done": "Done revision tasks",
  "analytics.structure.comments.open": "Open comments",
  "analytics.structure.comments.resolved": "Resolved comments",
  "analytics.structure.states.one": "{count} item has a revision state.",
  "analytics.structure.states.other": "{count} items have a revision state.",
  "analytics.structure.definition": "Parts, chapters, scenes and states leave out the bin and the bible. Tasks and comments count every one stored, including those on items in the bin.",
  "analytics.structure.statistics": "Open manuscript statistics",
  "analytics.no-history": "No sessions recorded here yet.",
  "analytics.since": "Recorded since {date}.",
  "analytics.minutes": "Minutes editing",
  "analytics.net": "Net words saved",
  "analytics.sessions": "Sessions",
  "analytics.saved.book": "Saved words in this book",
  "analytics.saved.library": "Saved words in selected books",
  "analytics.saved.unreadable.one": "{count} document could not be read and is not in the saved words.",
  "analytics.saved.unreadable.other": "{count} documents could not be read and are not in the saved words.",
  "analytics.pace": "Net words per minute",
  "analytics.gaps.sessions.one": "{count} session is unfinished or has a gap.",
  "analytics.gaps.sessions.other": "{count} sessions are unfinished or have gaps.",
  "analytics.gaps.corrections.one": "{count} correction has no date, so it counts in the totals but not in the daily list.",
  "analytics.gaps.corrections.other": "{count} corrections have no date, so they count in the totals but not in the daily list.",
  "analytics.gaps.more.one": "{count} earlier session is not shown here; the exported history includes it.",
  "analytics.gaps.more.other": "{count} earlier sessions are not shown here; the exported history includes them.",
  "analytics.source": "Source",
  "analytics.added": "Added",
  "analytics.deleted": "Deleted",
  "analytics.observed": "Net before corrections",
  "analytics.source.typing": "Typing",
  "analytics.source.pasted": "Paste or drop",
  "analytics.source.imported": "Import",
  "analytics.source.restored": "Restore",
  "analytics.source.unattributed": "Unattributed",
  "analytics.source.definition": "Corrections change the totals only. Imports and restores made outside an ordinary save belong to no session. The saved-word counts in Statistics cover more, so do not add them to these.",
  "analytics.daily": "Daily activity",
  "analytics.day.one": "{date}: {count} minute editing, {net} words typed (net)",
  "analytics.day.other": "{date}: {count} minutes editing, {net} words typed (net)",
  "analytics.daily.definition": "Each day shows the minutes and typed words recorded on it. Corrections have no date of their own, so they count in the totals but not here.",
  "analytics.motivation": "Streaks and forecast",
  "analytics.motivation.show": "Show streaks and forecast",
  "analytics.goal": "Optional book word target",
  "analytics.streak": "Current streak: {current}. Longest: {longest}.",
  "analytics.days.one": "{count} day",
  "analytics.days.other": "{count} days",
  "analytics.forecast.one": "At your typing pace over the last 14 days, about {count} day to the target. An estimate, not a deadline.",
  "analytics.forecast.other": "At your typing pace over the last 14 days, about {count} days to the target. An estimate, not a deadline.",
  "analytics.forecast.unavailable": "No typing progress in the last 14 days, so there is no forecast.",
  "analytics.motivation.reset": "Start streaks over from today",
  "analytics.motivation.since": "Streaks count from {date}. Older sessions are still listed below.",
  "analytics.milestone.one": "Milestone reached: {count} minute of editing since your streaks began.",
  "analytics.milestone.other": "Milestone reached: {count} minutes of editing since your streaks began.",
  "analytics.history": "Sessions and corrections",
  "analytics.session": "{date}, session {id}",
  "analytics.current": "Current session in progress.",
  "analytics.unfinished": "Unfinished session. The app may have closed before it ended.",
  "analytics.ended": "Closed session.",
  "analytics.exclude": "Leave this session out of the totals",
  "analytics.include": "Count this session in the totals",
  "analytics.segment.one": "{category}: {count} minute",
  "analytics.segment.other": "{category}: {count} minutes",
  "analytics.correct": "Correct this activity",
  "analytics.correction.category": "Corrected activity",
  "analytics.correction.minutes": "Corrected minutes (optional)",
  "analytics.correction.exclude": "Exclude this activity",
  "analytics.correction.reason": "Reason (optional)",
  "analytics.correction.words": "Correct the words added and deleted for each source. Leave a field blank to keep what was recorded.",
  "analytics.save": "Save correction",
  "analytics.revert": "Undo this correction",
  "analytics.export": "Export session history",
  "analytics.export.done": "Session history saved to {path}.",
  "analytics.purge": "Delete session history…",
  "analytics.purge.note": "This deletes this book's recorded sessions and your corrections, and stops recording. Your manuscript and the saved-word counts stay. Earlier backups may still hold the old history.",
  "analytics.purge.confirm": "Delete session history",
  "analytics.error.number": "Enter a whole number, 0 or more.",
  "analytics.error.category": "Choose an available activity category.",
  "analytics.error.closed": "This book changed; reopen Analytics.",
  "analytics.error.action": "Could not change Analytics: {error}",
  "analytics.error.load": "Could not read your sessions: {error}. Nothing was changed.",
  "menu.analytics": "Analytics…",
  "privacy.settings": "Privacy lock…",
  "privacy.lock": "Lock application",
  "privacy.shortcut": "Ctrl+Alt+L",
  "privacy.shortcut.alternate": "Ctrl+Alt+P",
  "privacy.shortcut.off": "Off",
  "privacy.boundary": "Hides this application on screen. It does not encrypt your manuscripts or protect their files.",
  "privacy.error": "Could not open privacy lock settings.",

  // ---- statistics.ts: the measurements panel's content -------------------
  "stats.excludes": "Excludes the bin and any scene that could not be read.",
  "stats.excludes.tree": "Excludes the bin.",
  "stats.value.none": "none",
  "stats.value.uncounted": "not counted",
  "stats.scope.uncounted": "Not counted",
  "stats.scope.uncounted.titled": "{title}, not counted",
  "stats.absent.scene": "No scene is open",
  "stats.absent.chapter": "This scene is not inside a chapter",
  "stats.absent.part": "This scene is not inside a part",
  "stats.group.words": "Words",
  "stats.group.units": "Sentences and paragraphs",
  "stats.row.sentences.scene": "Sentences in this scene",
  "stats.row.paragraphs.scene": "Paragraphs in this scene",
  "stats.row.sentences.chapter": "Sentences in this chapter",
  "stats.row.paragraphs.chapter": "Paragraphs in this chapter",
  "stats.row.sentences.part": "Sentences in this part",
  "stats.row.paragraphs.part": "Paragraphs in this part",
  "stats.row.sentences.manuscript": "Sentences in the manuscript",
  "stats.row.paragraphs.manuscript": "Paragraphs in the manuscript",
  "stats.def.sentences.scene": "Sentences in the open scene, as last saved. A sentence ends at a full stop, question mark, exclamation mark or ellipsis followed by a space or the end of the paragraph; closing quotes may follow it. So 'Dr. Smith' is two and '3.14' is one. {excludes}",
  "stats.def.paragraphs.scene": "Paragraphs in the open scene, as last saved. A paragraph holds at least one word; blank lines do not count. {excludes}",
  "stats.def.sentences.chapter": "Sentences in the chapter the open scene belongs to, including everything nested in it, by the same rule as the scene figure. {excludes}",
  "stats.def.paragraphs.chapter": "Paragraphs in the chapter the open scene belongs to, including everything nested in it, by the same rule as the scene figure. {excludes}",
  "stats.def.sentences.part": "Sentences in the part the open scene belongs to, including everything nested in it, by the same rule as the scene figure. {excludes}",
  "stats.def.paragraphs.part": "Paragraphs in the part the open scene belongs to, including everything nested in it, by the same rule as the scene figure. {excludes}",
  "stats.def.sentences.manuscript": "Sentences in every scene of the outline, by the same rule as the scene figure. {excludes}",
  "stats.def.paragraphs.manuscript": "Paragraphs in every scene of the outline, by the same rule as the scene figure. {excludes}",
  "stats.group.sections": "By section",
  "stats.row.chapters.words": "Words in chapters",
  "stats.row.front": "Front matter",
  "stats.row.back": "Back matter",
  "stats.absent.front": "This book has no front matter",
  "stats.absent.back": "This book has no back matter",
  "stats.def.chapters.words": "Words in the chapters alone: the whole manuscript less the front and back matter. The figure to quote for the book's length. {excludes}",
  "stats.def.front": "Words in the front matter section: dedication, foreword and the rest. Counted in the whole manuscript; only typed changes count toward the daily goal. {excludes}",
  "stats.def.back": "Words in the back matter section: acknowledgements, afterword and the rest. Counted in the whole manuscript; only typed changes count toward the daily goal. {excludes}",
  "stats.group.structure": "Structure",
  "stats.group.states": "Revision states",
  "stats.group.session": "This session",
  "stats.group.sources": "Saved words by source",
  "stats.source.typing": "Typed (net)",
  "stats.source.pasted": "Pasted or dropped (net)",
  "stats.source.imported": "Imported (net)",
  "stats.source.restored": "Restored (net)",
  "stats.source.unattributed": "Unattributed (net)",
  "stats.sources.detail": "Added {added}; removed {deleted}.",
  "stats.sources.definition": "Changes to the saved word count, sorted by how the words arrived: typed, pasted, imported or restored. This is not a keystroke count, and it does not say where the words now in the book came from. The bin, the bible and timelines are left out.",
  "stats.sources.since": "Measurement started {since}; earlier activity is not reconstructed.",
  "stats.sources.today": "Typed today (net)",
  "stats.sources.today.definition": "Typed additions minus typed deletions on your local calendar day. Paste, import and restore do not advance the daily goal.",
  "stats.sources.unavailable": "Source statistics unavailable",
  "stats.sources.unavailable.detail": "The stored source statistics could not be read. Your manuscript still saves; damaged statistics are preserved.",
  "stats.group.today": "Today",
  "stats.row.writing-time": "Time writing",
  "stats.value.not-tracked": "not counted",
  "stats.time.minutes": "{minutes} min",
  "stats.time.hours": "{hours} h {minutes} min",
  "stats.def.writing-time": "Minutes of today in which you changed the manuscript, on this computer's clock. Not a timer: a minute counts when an edit landed in it, and an hour spent reading counts as nothing. Turns at your local midnight.",
  "stats.def.writing-time.off": "Not counted. The minutes you edit in are not recorded while this is off; the figure so far is kept.",
  "stats.tracking.stop": "Stop counting my time",
  "stats.tracking.start": "Count my time again",
  "stats.sources.paused": "Counting is paused: saves are not measured until you resume.",
  "stats.sources.interrupted": "Counting was paused during this measurement; changes saved while it was paused are not included.",
  "stats.sources.pause": "Pause counting saved words",
  "stats.sources.resume": "Resume counting saved words",
  "stats.sources.reset": "Reset saved-word counts\u2026",
  "stats.sources.reset.confirm": "Delete the counts and start again",
  "stats.sources.reset.cancel": "Cancel reset",
  "stats.sources.reset.note": "This deletes the saved-word counts by source and today\u2019s typed figure, and starts a new measurement now. Your manuscript, version history, snapshots, time writing, this session\u2019s figures and the pause setting are kept.",
  "stats.sources.error": "Could not update the word statistics: {error}",
  "stats.sources.error.busy": "Another change is still in progress.",
  "stats.sources.error.closed": "This book is no longer open.",
  "stats.sources.error.unsaved": "Your latest changes could not be saved, so the statistics were not changed.",
  "stats.row.scene": "This scene",
  "stats.row.chapter": "This chapter",
  "stats.row.part": "This part",
  "stats.row.manuscript": "Whole manuscript",
  "stats.row.parts": "Parts",
  "stats.row.chapters": "Chapters",
  "stats.row.scenes": "Scenes",
  "stats.row.longest": "Longest scene",
  "stats.row.shortest": "Shortest scene",
  "stats.row.median": "Median scene",
  "stats.row.empty": "Empty scenes",
  "stats.row.uncounted": "Scenes not counted",
  "stats.row.added": "Words added",
  "stats.row.deleted": "Words deleted",
  "stats.row.net": "Net this session",
  "stats.def.scene": "Words in the open scene, as last saved. {excludes}",
  "stats.def.chapter": "Words in every scene of the chapter the open scene belongs to, however deeply nested. {excludes}",
  "stats.def.part": "Words in every scene of the part the open scene belongs to, however deeply nested. {excludes}",
  "stats.def.manuscript": "Words in every scene of this book's outline. {excludes}",
  "stats.def.parts": "Parts in the outline, wherever they sit. A part inside a scene still counts as a part. {excludes}",
  "stats.def.chapters": "Chapters in the outline, wherever they sit. {excludes}",
  "stats.def.scenes": "Scenes in the outline. Only scenes hold prose. {excludes}",
  "stats.def.longest": "The largest word count among scenes that could be counted. {excludes}",
  "stats.def.shortest": "The smallest word count among scenes that could be counted, including scenes of zero words. {excludes}",
  "stats.def.median": "The middle word count among scenes that could be counted; with an even number of them, the mean of the two central values. {excludes}",
  "stats.def.empty": "Scenes that were read and hold no words, such as a scene created and never written in. This is not the same as a scene that could not be counted, which is the figure below.",
  "stats.def.uncounted": "Scenes whose saved text this version of the app cannot read. Every figure here leaves them out rather than treating them as zero.",
  "stats.def.state": "Items you have marked {state}: parts, chapters and scenes alike. {excludes}",
  "stats.def.state.none": "Items you have not marked. Every item starts here, so in a book nobody has marked this is all of them. {excludes}",
  "stats.def.added": "Words that appeared in saved text since this window opened. Measured between saves rather than keystroke by keystroke, so a word typed and removed again before a save counts in neither this figure nor the one below.",
  "stats.def.deleted": "Words that disappeared from saved text since this window opened. Moving a scene to the bin does not count here: nothing was rewritten, and the words come back if it is restored.",
  "stats.def.net": "Words added minus words deleted. A day spent cutting is a negative session, which is what it was.",
  "stats.note": "Every figure describes this book alone, as saved. Words are counted as the footer and an exported manuscript count them: any run of characters between spaces (word rule 1). Session figures cover this window since the book opened; they are not stored and belong to no calendar day, so no timezone applies.",
  "stats.empty": "This manuscript holds no scenes yet, so there is nothing to measure.",
  // ---- statistics-panel.ts ------------------------------------------------
  "stats.panel.heading": "Statistics",
  "stats.panel.loading": "Measuring\u2026",
  "stats.panel.failed": "Could not read the word counts, so nothing here would be true. Nothing was changed.",
  "stats.panel.row.label": "{label}: {value}",

  // ---- comments-panel.ts --------------------------------------------------
  "comments.when.now": "just now",
  "comments.when.minutes.one": "{count} minute ago",
  "comments.when.minutes.other": "{count} minutes ago",
  "comments.when.hours.one": "{count} hour ago",
  "comments.when.hours.other": "{count} hours ago",
  "comments.when.days.one": "{count} day ago",
  "comments.when.days.other": "{count} days ago",
  "comments.orphan": "The passage this was on was deleted.",
  "comments.capped": "This scene has more comments than can be followed while you type, so their positions have stopped moving with your edits. Resolve some, or reopen the scene to see them where they last were.",
  "comments.no-selection": "Select the passage you want to comment on first, then add the note.",
  "comments.empty-body": "Write the note first, then add it.",
  "comments.status.none": "No comments on this scene yet.",
  "comments.status.resolved.one": "{count} resolved comment",
  "comments.status.resolved.other": "{count} resolved comments",
  "comments.status.open.one": "{count} open comment",
  "comments.status.open.other": "{count} open comments",
  "comments.status.settled.shown": "Nothing open. {settled}, shown below.",
  "comments.status.settled.hidden": "Nothing open. {settled}, hidden.",
  "comments.status.live": "{live}.",
  "comments.status.live.shown": "{live}, and {resolved} resolved, shown below.",
  "comments.status.live.hidden": "{live}. {resolved} resolved, hidden.",
  "comments.row.state.resolved": "resolved comment",
  "comments.row.state.open": "comment",
  "comments.row.label.orphaned": "{state}, {when}, on a passage that was deleted: {body}",
  "comments.row.label": "{state}, {when}, on \u201c{passage}\u201d: {body}",
  "comments.panel.label": "comments on this scene",
  "comments.heading": "Comments",
  "comments.list.label": "comments on this scene",
  "comments.show-resolved": "Show resolved",
  "comments.hide-resolved": "Hide resolved",
  "comments.compose.placeholder": "What about this passage?",
  "comments.compose.label": "the note to leave on the selected passage",
  "comments.compose.add": "Add comment",
  "comments.compose.save": "Save comment",
  "comments.compose.cancel": "Cancel",
  "comments.compose.editing": "Rewriting a note made {when}",
  "comments.compose.on": "On \u201c{text}\u201d",
  "comments.empty.none": "Select a passage and leave a note on it.",
  "comments.empty.all-resolved": "Nothing open. Use Show resolved to see the settled ones.",
  "comments.quote.empty": "(no text)",
  "comments.meta.orphaned": "{note} {when}",
  "comments.row.reopen": "Reopen",
  "comments.row.resolve": "Resolve",
  "comments.row.reopen.label": "reopen this comment: {body}",
  "comments.row.resolve.label": "resolve this comment: {body}",
  "comments.row.edit": "Edit",
  "comments.row.edit.label": "rewrite this comment: {body}",
  "comments.reading": "Reading comments\u2026",
  "comments.done.added": "Comment added.",
  "comments.done.rewritten": "Comment rewritten.",
  "comments.done.reopened": "Comment reopened.",
  "comments.done.resolved": "Comment resolved. It is kept, under Show resolved.",
  "comments.error.read": "Could not read this scene's comments: {error}",
  "comments.error.add": "Could not add that comment: {error}",
  "comments.error.rewrite": "Could not rewrite that comment: {error}",
  "comments.error.change": "Could not change that comment: {error}",
  "scene-notes.label.one": "Open comments for this scene, {count} open comment",
  "scene-notes.label.other": "Open comments for this scene, {count} open comments",
  // ---- history.ts: the version history and snapshot panel ----------------
  "history.when.now": "just now",
  "history.when.minutes.one": "{count} minute ago",
  "history.when.minutes.other": "{count} minutes ago",
  "history.when.hours.one": "{count} hour ago",
  "history.when.hours.other": "{count} hours ago",
  "history.when.days.one": "{count} day ago",
  "history.when.days.other": "{count} days ago",
  "history.delta.none": "no change",
  "history.words.one": "{count} word",
  "history.words.other": "{count} words",
  "history.documents.one": "{count} document",
  "history.documents.other": "{count} documents",
  "history.version.snapshot-label": "“{label}”",
  "history.version.when.snapshot": "snapshot “{label}”, {when}",
  "history.version.label": "{when}, {words}",
  "history.version.label.same": "{when}, {words}, the same length as the version before",
  "history.version.label.more": "{when}, {words}, {size} more than the version before",
  "history.version.label.fewer": "{when}, {words}, {size} fewer than the version before",
  "history.diff.none": "No difference: this version and the scene as it is now hold the same words.",
  "history.diff.added.one": "{count} word added",
  "history.diff.added.other": "{count} words added",
  "history.diff.removed.short": "{count} removed",
  "history.diff.removed-only.one": "{count} word removed since this version.",
  "history.diff.removed-only.other": "{count} words removed since this version.",
  "history.diff.summary": "{parts} since this version.",
  "history.diff.comparing": "Comparing\u2026",
  "history.diff.legend": "Struck through: in that version, not now. Underlined: now, not in that version.",
  "history.diff.of": "{when} compared with this scene as it is now",
  "history.diff.region.label": "comparing {version} with this scene as it is now",
  "history.diff.region.label.totals": "comparing {version} with this scene as it is now, {added} words added and {removed} removed since that version",
  "history.title": "History",
  "history.panel.label": "version history",
  "history.heading": "This scene",
  "history.list.label": "past versions of this scene",
  "history.reading": "Reading history\u2026",
  "history.status.empty": "No earlier versions of this scene yet.",
  "history.status.count.one": "{count} version of this scene.",
  "history.status.count.other": "{count} versions of this scene.",
  "history.row.words.one": "{count} word",
  "history.row.words.other": "{count} words",
  "history.row.restore": "Restore",
  "history.row.restore.label": "Restore: return this scene to {version}",
  "history.row.compare": "Compare",
  "history.row.compare.label": "compare {version} with this scene as it is now",
  "history.done.restored": "Restored. The version you replaced is in this scene's history.",
  "history.error.reconcile": "The saved document changed, but the editor could not reload it. Restart garret before editing this book.",
  "history.error.busy": "Another action is still running. Wait for it to finish.",
  "history.error.unsaved": "Your latest changes could not be saved. History cannot continue.",
  "history.error.changed": "The open document changed. Open History again before restoring.",
  "history.error.read": "Could not read this book's history: {error}",
  "history.error.compare": "Could not compare that version: {error}",
  "history.error.restore": "Could not restore: {error}",
  "history.error.unknown-rev": "This scene's revision is not known yet; nothing was restored.",
  "history.snapshots.heading": "Snapshots",
  "history.snapshots.name.placeholder": "Name this moment",
  "history.snapshots.name.label": "Snapshot name",
  "history.snapshots.take": "Take snapshot",
  "history.snapshots.take.label": "Take snapshot: capture every document in the manuscript",
  "history.snapshots.list.label": "Named snapshots",
  "history.snapshots.empty": "No snapshots yet. Name a moment before a big revision.",
  "history.snapshots.row": "{label} · {documents} · Restore",
  "history.snapshots.restore.label": "{label} · {documents} · Restore. Return the whole manuscript to this snapshot from {when}.",
  "history.snapshots.confirm": "Really restore \u201c{label}\u201d? {documents}",
  "history.snapshots.done.taken": "Snapshot “{label}” covers {documents}.",
  "history.snapshots.done.no-change": "Nothing had changed since that snapshot.",
  "history.snapshots.done.restored": "Restored {documents} of {covered}. What they held is in each scene's history.",
  "history.snapshots.error.no-name": "Give the snapshot a name first.",
  "history.snapshots.error.take": "Could not take a snapshot: {error}",
  "history.snapshots.error.restore": "Could not restore that snapshot: {error}",

  // ---- revision-states.ts and revision-panel.ts --------------------------
  "state.label.outline": "Outline",
  "state.label.draft": "Draft",
  "state.label.revising": "Revising",
  "state.label.done": "Done",
  "state.label.none": "No state",
  "state.no-selection": "Select a row in the outline first, then choose where it stands.",
  "state.failed": "That state could not be set, and nothing was changed.",
  "state.panel.label": "revision state",
  "state.heading": "Revision state",
  "state.choices.label": "where this item stands",
  "planning.heading": "Revision plan",
  "planning.passes": "Passes",
  "planning.pass-filter": "Filter tasks by pass",
  "planning.pass-counts": "{name} ({open} open / {done} done)",
  "host-error.archive-stage": "An earlier backup was interrupted. Its temporary files have been kept. Open Details for recovery steps.",
  "host-error.unavailable": "This file could not be opened. Check that it is still in its folder and that you can read it, then try again.",
  "host-error.archive-stage.steps": "Close garret before checking these files. Keep a local copy of the retained folder and inspect it before discarding anything. Application-private temporary files may contain unencrypted writing; keep them out of cloud folders.\n\nList retained folders with garret archive-stage-list \"<parent-folder>\". Only after checking and preserving the selected folder, use garret archive-stage-clean \"<parent-folder>\" \"<stage-name>\" to discard it. Replace the placeholders with the parent directory and folder name shown above.\n\nFor temporary encrypted files in a backup folder, you can choose a different backup folder while keeping the retained files. Changing the filename in the same folder does not help. Changing the backup folder does not bypass unfinished application-private files.",
  "host-error.failed": "That could not be finished. Please try again.",
  "host-error.busy": "Another program is using this book's file. Close that program, then try again.",
  "host-error.read-only": "This book's file or folder cannot be written to. Check that the drive is not read-only, then try again.",
  "host-error.disk-full": "The disk is full. Free some space, then try again.",
  "host-error.io": "The disk could not be read or written. Check that the drive is still connected, then try again.",
  "host-error.corrupt": "This book's file is damaged or is not a book file. Leave the file as it is and restore a recovery point.",
  "host-error.locked": "The application is locked. Unlock it to continue.",
  "host-error.picture-bytes": "That file is too large to use as a picture. Choose a smaller file.",
  "host-error.picture-format": "That file is not a PNG or JPEG picture. Choose a PNG or JPEG file.",
  "host-error.picture-pixels": "That picture has more pixels than this book can read. Choose a smaller picture, or resize it first.",
  "host-error.picture-unreadable": "That picture could not be read. It may be damaged; try another copy.",
  "host-error.with-detail": "{primary} Technical details: {detail}",
  "open.missing": "{item} is not in the outline",
  "open.failed": "{reason} (could not open {item})",
  "session.save-refused": "Autosave failed. The scene stayed open to protect unsaved work.",
  "session.late-save-refused": "Autosave failed while loading. The previous scene stayed open to protect unsaved work.",
  "planning.pass-all": "All passes",
  "planning.pass-none": "Ungrouped",
  "planning.pass-name": "Pass name",
  "planning.pass-purpose": "Purpose (optional)",
  "planning.pass-create": "Add pass",
  "planning.pass-new": "New pass",
  "planning.pass-editing": "Editing draft for: {name}",
  "planning.pass-save": "Save pass",
  "planning.pass-discard": "Discard pass draft",
  "planning.pass-remove": "Remove pass",
  "planning.pass-confirm-remove": "Confirm: keep tasks ungrouped",
  "planning.pass-required": "Enter a pass name.",
  "planning.discard-pass-first": "Save or discard the pass draft first.",
  "planning.tasks": "Tasks",
  "planning.scope": "Show tasks for",
  "planning.scope-book": "Book",
  "planning.scope-selected": "Selected item",
  "planning.scope-all": "All items",
  "planning.empty": "No tasks in this view.",
  "planning.task-placeholder": "What needs work?",
  "planning.task-text": "Task text",
  "planning.task-limit": "A task can be up to 4,000 characters long.",
  "planning.task-pass": "Pass for this task",
  "planning.task-save": "Save task",
  "planning.task-discard": "Discard draft",
  "planning.task-required": "Enter task text.",
  "planning.discard-task-first": "Save or discard the current task draft first.",
  "planning.target": "Target: {title}",
  "planning.target-binned": "{title} (in bin)",
  "planning.target-removed": "{title} (item removed)",
  "planning.no-selection": "Select an item first.",
  "planning.done": "Done",
  "planning.reopen": "Reopen",
  "planning.edit": "Edit",
  "planning.remove": "Remove",
  "planning.confirm-remove": "Confirm removal",
  "planning.load-failed": "Could not load revision plan: {error}",
  "planning.save-failed": "Could not save revision plan: {error}",
  // ---- help.ts: the keyboard shortcuts panel ------------------------------
  // The chord spellings are catalog entries too: a German build says Strg, not
  // Ctrl. `help.test.ts` parses `editor.ts`'s keymap and compares it against
  // what this panel claims, and it reads the claim through `SHORTCUTS`, so
  // these values are what that guard sees.
  "help.heading": "Help",
  "help.group.writing": "Writing",
  "help.group.moving": "Moving around",
  "help.group.find": "In the find panel",
  "help.group.outline": "Outline",
  "help.group.menus": "Menus",
  "help.keys.undo": "Ctrl+Z",
  "help.keys.redo": "Ctrl+Shift+Z",
  "help.keys.italic": "Ctrl+I",
  "help.keys.bold": "Ctrl+B",
  "help.keys.underline": "Ctrl+U",
  "help.keys.comment": "Ctrl+Alt+M",
  "help.keys.cast-card": "Ctrl+Shift+I",
  "help.keys.quick-open": "Ctrl+P",
  "help.keys.find": "Ctrl+F",
  "help.keys.inspector": "F6",
  "help.keys.quit": "Ctrl+Q",
  "help.keys.export": "Ctrl+E",
  "help.keys.nav-history": "Alt+Left / Alt+Right",
  "help.keys.up-down": "Up / Down",
  "help.keys.left-right": "Left / Right",
  "help.keys.home-end": "Home / End",
  "help.keys.page": "Page Up / Page Down",
  "help.keys.open": "Enter / Space",
  "help.keys.enter": "Enter",
  "help.keys.escape": "Escape",
  "help.keys.delete": "Delete",
  "help.keys.type-ahead": "Type a title",
  "help.keys.move-item": "Alt+Up / Alt+Down",
  "help.keys.outline-undo": "Ctrl+Z / Ctrl+Shift+Z",
  "help.keys.context-menu": "Shift+F10 / Menu",
  "help.keys.menu.file": "Alt+F",
  "help.keys.menu.edit": "Alt+E",
  "help.keys.menu.outline": "Alt+O",
  "help.keys.menu.help": "Alt+H",
  "help.undo": "Undo your typing",
  "help.redo": "Redo your typing",
  "help.italic": "Italic",
  "help.bold": "Bold",
  "help.underline": "Underline (not carried by the Markdown export)",
  "help.comment": "Comment on the selected passage",
  "help.cast-card": "Show the cast card for a marked name",
  "help.quick-open": "Go to a part, chapter or scene by title",
  "help.find": "Find in the manuscript",
  "help.inspector": "Move between the prose and the open side panel",
  "help.nav-history": "Back and forward through the scenes you have opened",
  "help.outline-select": "Move the outline selection",
  "help.open": "Open the selected scene",
  "help.collapse": "Collapse or expand",
  "help.home-end": "Jump to the first or last item",
  "help.page": "Move a screenful of outline at a time",
  "help.type-ahead": "Jump to the next item starting with what you type",
  "help.find.move": "Move through the results",
  "help.find.open": "Open the highlighted result",
  "help.find.close": "Close the panel",
  "help.move-item": "Move an item within its siblings",
  "help.indent": "Change an item's depth (while the outline has focus)",
  "help.delete": "Move the selected item to the Trash",
  "help.context-menu":
    "Open the context menu for the selected item (a scene or note also offers Synopsis and Who appears here)",
  "help.rename": "Commit a rename",
  "help.outline-undo": "Undo or redo the last change to the outline (while the outline has focus)",
  "help.menu.file": "File menu",
  "help.menu.edit": "Edit menu",
  "help.menu.outline": "Outline menu",
  "help.menu.help": "Help menu",
  "help.menu.close": "Close a menu, a panel, or a rename",
  "help.quit": "Close the application, asking first if anything is unsaved",
  "help.export": "Export the manuscript as Markdown",

  // ---- preferences.ts -----------------------------------------------------
  // The daily target's other four spellings ARE the numbers ("500" -> 500) and
  // are deliberately NOT keys: a catalog entry mapping "500" to "500" is the
  // drift table `goals.ts` refuses to have.
  "prefs.on": "On",
  "prefs.off": "Off",
  "prefs.focus.paragraph": "Paragraph",
  "prefs.palette.editorial": "Editorial",
  "prefs.palette.neutral": "Neutral",
  "prefs.palette.atmospheric": "Sage",
  "prefs.theme.system": "System",
  "prefs.theme.light": "Light",
  "prefs.theme.dark": "Dark",
  "prefs.family.serif": "Serif",
  "prefs.family.sans": "Sans",
  "prefs.family.mono": "Mono",
  "prefs.size.small": "Small",
  "prefs.size.medium": "Medium",
  "prefs.size.large": "Large",
  "prefs.size.larger": "Larger",
  "prefs.measure.narrow": "Narrow",
  "prefs.measure.medium": "Medium",
  "prefs.measure.wide": "Wide",
  "prefs.legend.theme": "Theme",
  "prefs.legend.palette": "Palette",
  "prefs.legend.font": "Font",
  "prefs.legend.size": "Size",
  "prefs.legend.width": "Width",
  "prefs.legend.goal": "Goal",
  "prefs.legend.zoom": "Zoom",
  "prefs.legend.focus": "Focus",
  "prefs.legend.spelling": "Spelling",
  "prefs.legend.typewriter": "Typewriter",
  "prefs.legend.dictionary": "Dictionary",
  // whether the cast-marks plugin is fed any names at all. Short on
  // the row, `prefs.name.mark-cast-names`'s own reason -- the Goal group's own
  // pattern of a fixed-width legend beside a longer aria-label.
  "prefs.legend.mark-cast-names": "Cast names",
  "prefs.name.mark-cast-names": "Mark cast names in the text",
  // The language chooser. Both catalogs carry both language names, spelled in
  // their own language, because this is the one control whose two options are
  // themselves names of languages rather than English words describing a
  // choice.
  "prefs.title": "Preferences",
  "prefs.section.writing": "Writing",
  "prefs.section.app": "Application",
  "prefs.language": "Language",
  "prefs.language.en": "English",
  "prefs.language.de": "Deutsch",
  "prefs.language.applied": "The language changes when the application is next opened.",
  "prefs.name.goal": "Daily goal",
  "prefs.goal.custom": "Custom daily word goal",
  "prefs.goal.invalid": "Enter a whole number from {min} to {max}.",
  // What the window opens onto next launch. A <select>, LOCALES'
  // own reason -- each answer is a full sentence, not a short word a row
  // of buttons fits. The label itself stays SHORT (a review capture showed
  // "When the application starts" wrapping to its own full-width line above
  // the select, breaking the label-left layout every other row in this
  // panel has) -- the group's title lives in the three option sentences.
  "prefs.start.label": "Start",
  "prefs.start.home": "Show the library",
  "prefs.start.last": "Open the last book I was writing",
  "prefs.start.blank": "Start with nothing open",
  "prefs.what.palette": "palette",
  "prefs.what.theme": "theme",
  "prefs.what.spelling": "spelling",
  "prefs.what.typography": "typography",
  "prefs.what.writing-modes": "writing modes",
  "prefs.what.daily-goal": "daily goal",
  "prefs.what.zoom": "zoom",
  "prefs.what.language": "language",
  "prefs.what.mark-cast-names": "cast names",
  "prefs.what.start": "when the application starts",
  "prefs.error.save": "Could not save the {what} preference: {error}",
  // This project's own spelling wordlist -- see store::dict and
  // commands/spell.rs. Beside the spelling toggle rather than a panel of its
  // own: the project bar is five controls wide and cannot take a sixth.
  "prefs.dict.word.label": "Add a word",
  "prefs.dict.add": "Add",
  "prefs.dict.remove": "Remove {word}",
  "prefs.dict.loading": "Loading dictionary…",
  "prefs.dict.unavailable": "Dictionary unavailable. Reopen the book to try again.",
  "prefs.dict.empty": "No words added yet.",
  "prefs.dict.error.add": "Could not add {word} to this book's dictionary: {error}",
  "prefs.dict.error.remove": "Could not remove {word} from this book's dictionary: {error}",
  "prefs.dict.note":
    "An underline already drawn stays until you edit that line; adding a word from the prose (select it) clears it at once.",
  // ---- find-bar.ts: find, replace and replace-everywhere ------------------
  "find.title": "Find and replace",
  "find.panel.label": "Find in manuscript",
  "find.query.label": "Search the manuscript",
  "find.run": "Search",
  "find.searching": "Searching…",
  "find.failed": "Search failed.",
  "find.error": "Search failed: {error}",
  "find.results.label": "Search results",
  "find.replace.label": "Replace with",
  "find.replace-one": "Replace",
  "find.replace-one.label": "Replace this occurrence in the open scene",
  "find.replace-all": "All in scene",
  "find.replace-all.label": "All in scene: replace every occurrence in the open scene",
  "find.replace-book": "All in book",
  "find.replace-book.armed": "Really, whole book?",
  "find.replace-book.label": "All in book: replace every occurrence in the whole manuscript, saving a snapshot first",
  "find.summary.none": "No matches for “{query}”.",
  "find.summary.truncated": "Showing {shown} of {total} results for “{query}”.",
  "find.summary.one": "{count} result for “{query}”.",
  "find.summary.other": "{count} results for “{query}”.",
  "find.result.label.title": "{title}, {kind}, title match",
  "find.result.label": "{title}, {kind}: {snippet}",
  "find.refuse.no-query": "Type what to look for in the field above, then Replace.",
  "find.replaced.single": "Replaced one occurrence in this scene.",
  "find.replaced.none": "Nothing replaced. Press Replace again to change the occurrence now selected.",
  "find.replaced.appended": "{said} {summary}",
  "find.replaced.no-occurrences": "No occurrences of \"{query}\" in this scene.",
  "find.report.scene.one": "Replaced {count} occurrence in this scene.",
  "find.report.scene.other": "Replaced {count} occurrences in this scene.",
  "find.report.scene.spanning": "{head} {left} {verb} left alone: replacing across a paragraph break would join the paragraphs.",
  "find.report.documents.one": "{count} document",
  "find.report.documents.other": "{count} documents",
  "find.report.book.one": "Replaced {count} occurrence in {documents}.",
  "find.report.book.other": "Replaced {count} occurrences in {documents}.",
  "find.report.book.spanning": " {left} {verb} left alone: replacing across a paragraph break or an emphasis would change more than the words.",
  "find.report.book.saved": "{report} Saved as \u201c{label}\u201d.",
  "find.spanning.left.one": "One match",
  "find.spanning.left.other": "{count} matches",
  "find.spanning.verb.one": "was",
  "find.spanning.verb.other": "were",
  "find.replacing": "Replacing throughout the manuscript\u2026",
  "find.error.unsaved": "Your latest changes could not be saved. Nothing was replaced.",
  "find.error.replace-book": "Could not replace throughout the manuscript: {error}",

  // ---- quick-open.ts ------------------------------------------------------
  "quick-open.panel.label": "go to a part, chapter or scene",
  "quick-open.query.label": "type part of a title",
  "quick-open.results.label": "matching titles",
  "quick-open.none": "No title contains \"{query}\".",
  "quick-open.truncated": "{total} titles match. Showing the first {shown}; type more to narrow it.",
  "quick-open.count.one": "{count} title.",
  "quick-open.count.other": "{count} titles.",

  // ---- rename-panel.ts ----------------------------------------------------
  "rename.title": "Rename",
  "rename.panel.label": "rename an outline item",
  "rename.field.label": "New title",
  "rename.commit": "Rename",

  // ---- synopsis-panel.ts --------------------------------------------------
  // A synopsis is NOT the book: it is what the writer means a part, a chapter
  // or a scene to do, kept beside it. None of these strings say "notes",
  // because the application already has notes -- comments on a passage -- and
  // two surfaces sharing one word is how a writer learns to distrust both.
  "synopsis.panel.label": "synopsis",
  "synopsis.heading": "Synopsis",
  "synopsis.field.label": "What this is about",
  "synopsis.field.placeholder": "What happens here, and why it is in the book.",
  "synopsis.about": "About {title}",
  "synopsis.edit": "Edit",
  "synopsis.cancel": "Cancel",
  "synopsis.save": "Save",
  "synopsis.done.saved": "Synopsis saved.",
  "synopsis.done.cleared": "Synopsis cleared.",
  "synopsis.error.read": "Could not read this item's synopsis: {error}",
  "synopsis.error.write": "Could not save this synopsis, and nothing was changed: {error}",

  // ---- cast-panel.ts ------------------------------------------------------
  // The people, the places and the things a book is about. NOT "notes" and not
  // "bible": the bible is a section of documents in the outline and this is a
  // list of records beside it, and two surfaces sharing one word is how a
  // writer learns to distrust both.
  //
  // "Point of interest" is the OWNER'S word for the drawer everything that is
  // neither a person nor a place goes in -- a ship, a sword, a treaty, a scar.
  // Kept rather than improved on, because a writer who asked for it will look
  // for it.
  "cast.panel.label": "cast",
  "cast.heading": "Cast",
  "cast.empty": "Nobody and nowhere yet. Add the first one above.",
  "cast.status.reading": "Reading the cast\u2026",
  "cast.status.choose": "Choose one to read, or add another below.",
  // NEUTRAL NOW: this used to say "Editing {name}" unconditionally, but
  // selecting a member now opens the READ sheet by default -- "editing"
  // somebody the panel is only showing would be a claim the panel is not
  // making. "About" is true in both of the panel's two modes.
  "cast.status.about": "About {name}",
  // ---- cast-panel.ts: the sheet -----------------------------
  "cast.edit": "Edit",
  "cast.cancel": "Cancel",
  "cast.new.toggle": "Add\u2026",
  "cast.group.character": "Characters",
  "cast.group.place": "Places",
  "cast.group.poi": "Points of interest",
  "cast.kind.character": "Character",
  "cast.kind.place": "Place",
  "cast.kind.poi": "Point of interest",
  "cast.new.name.label": "name of the new entry",
  "cast.new.name.placeholder": "A name",
  "cast.new.kind.label": "kind of the new entry",
  "cast.new": "Add",
  "cast.name.label": "Name",
  // ---- cast-panel.ts: the aliases ("including aliases") ----------------
  // AFTER THE NAME, BEFORE THE SUMMARY: aliases are names, and the record's
  // order is who this is, then what they are called, then the paragraph.
  "cast.alias.label": "an alias",
  "cast.alias.placeholder": "Also known as\u2026",
  // HIDDEN WHEN THE MEMBER HAS NONE -- the summary's own rule, one field up.
  "cast.aliases.label": "Also called: {aliases}",
  "cast.alias.short": "{alias} is too short to use as an alias.",
  "cast.alias.same-as-name": "{alias} is already this member\u2019s name.",
  "cast.alias.repeated": "{alias} is already in the list.",
  "cast.detail.kind.label": "Kind",
  "cast.summary.label": "Summary",
  "cast.summary.placeholder": "Who or what this is, in a sentence or two.",
  "cast.field.label.label": "detail name",
  "cast.field.label.placeholder": "eye colour",
  "cast.field.value.label": "detail",
  "cast.field.value.placeholder": "grey",
  "cast.add-field": "Add detail",

  // ---- cast-panel.ts: the photograph -------------------------------------
  // FOUR STATES AND FOUR SENTENCES, because "there is no picture", "the file is
  // not where I keep it" and "it is there and I cannot read it" send a writer to
  // three different places. One word for all three would send them to the wrong
  // one two times in three.
  //
  // "this book keeps it" rather than a path: the panel never learns one, and the
  // place is `<project>.pictures/` beside the project file -- which the writer
  // finds through their book, not through a sentence in a form.
  "cast.picture.none": "No picture yet.",
  "cast.picture.missing": "The picture file is not where this book keeps it.",
  "cast.picture.unreadable": "That picture could not be read.",
  "cast.picture.choose": "Add a picture\u2026",
  "cast.picture.replace": "Change picture\u2026",
  "cast.picture.remove": "Remove picture",
  // NAMED AFTER THE MEMBER, never after the file. A uuid is not a description
  // of anybody, and the filename is the one thing about a picture the writer
  // never chose.
  "cast.picture.alt": "Picture of {name}",
  "cast.save": "Save",
  // TWO WORDS FOR ONE CONTROL, and the second is the whole of the safeguard: a
  // cast member does not go to the bin, so this delete is permanent and no
  // Ctrl+Z in this application reaches it. The first press changes what the
  // button is called; the second acts.
  "cast.remove": "Remove",
  "cast.remove.armed": "Move to Deleted entries?",
  "cast.deleted.show": "Deleted entries ({count})",
  "cast.deleted.back": "Back to Cast",
  "cast.deleted.empty": "No deleted entries.",
  "cast.deleted.status": "Deleted entries can be restored here.",
  "cast.deleted.restore": "Restore",
  "cast.deleted.restore.named": "Restore {name}",
  "cast.done.restored": "{name} restored.",
  "cast.error.restore": "Could not restore that, and nothing was changed: {error}",
  "cast.done.created": "{name} added.",
  "cast.done.saved": "{name} saved.",
  "cast.done.removed": "{name} moved to Deleted entries.",
  "cast.done.picture-added": "Picture added to {name}.",
  "cast.done.picture-removed": "Picture removed from {name}.",
  "cast.error.no-name": "Type a name first, then press Add.",
  "cast.error.list": "Could not read this book\u2019s cast: {error}",
  "cast.error.create": "Could not add that, and nothing was changed: {error}",
  "cast.error.save": "Could not save that, and nothing was changed: {error}",
  "cast.error.remove": "Could not remove that, and nothing was changed: {error}",
  "cast.error.picture": "Could not change the picture, and nothing was changed: {error}",

  // ---- cast-card.ts: the hover card over a marked name in the prose --
  "cast.card.open": "Open in Cast",
  "cast.card.error.open": "Could not open the Cast panel for that name: {error}",

  // ---- appearances-panel.ts: who appears in ONE part, chapter or scene -----
  //
  // TAGGING IS ABOUT ONE ROW and the rollup is about the book, so the two
  // surfaces have two vocabularies here as well as two panels: this one says
  // "in {title}" and never names the manuscript.
  "appears.panel.label": "who appears here",
  "appears.heading": "Who appears here",
  "appears.about": "Who appears in {title}",
  "appears.reading": "Reading\u2026",
  "appears.list.label": "who appears in this one",
  // NOT AN EMPTY LIST OF CHECKBOXES. Tagging is impossible before there is
  // anybody to tag, and a blank panel would read as a surface that failed to
  // paint -- the recorded `renderProjects` defect. It names the route out.
  "appears.empty-cast": "This book has nobody in it yet. Add a character, a place or a point of interest under Outline \u203a Cast\u2026 and they can appear here.",
  "appears.save": "Save",
  "appears.done.saved": "Saved who appears in {title}.",
  // TWO SENTENCES, because untagging everybody is a different act from tagging
  // somebody and a writer who emptied the list deliberately should be told it
  // took. The synopsis panel's rule.
  "appears.done.cleared": "Nobody now appears in {title}.",
  "appears.error.read": "Could not read who appears here: {error}",
  "appears.error.write": "Could not save that, and nothing was changed: {error}",

  // ---- appearances-map.ts: who appears where, across the whole book --------
  "appears.map.panel.label": "who appears where",
  "appears.map.heading": "Who appears where",
  "appears.map.scope": "Shows the manuscript, including front and back matter. Tags on bible documents and deleted items are kept but hidden from this map.",
  "appears.map.reading": "Reading the book\u2026",
  "appears.map.list.label": "the parts, chapters and scenes somebody appears in",
  "appears.map.empty-cast": "This book has nobody in it yet. Add a character, a place or a point of interest under Outline \u203a Cast\u2026 first.",
  // THE OTHER EMPTY STATE, and a different one. The book HAS a cast and nobody
  // has been placed in it yet, so the route out is the tagging panel rather
  // than the cast panel.
  "appears.map.empty": "Nobody has been placed yet. Choose a part, a chapter or a scene and use Outline \u203a Who appears here\u2026",
  // TWO LISTS PER ROW AND THEY ARE DISJOINT. "Here" is what the writer said
  // about this row itself; "Further down" is what arrived from the scenes
  // underneath it and is derived. Saying which is which is the difference
  // between a list a writer can act on and a list they have to go looking
  // through their outline to explain.
  "appears.map.here": "Here: {names}",
  // THE ACCESSIBLE NAME FOR A SINGLE KIND LINE. The
  // visible "Here:"/"Further down:" is said once per bucket, on its first
  // line only, so a screen reader needs its own statement of which bucket and
  // which kind THIS line is -- there is no indentation for it to infer that
  // from. `{kind}` is the cast panel's own plural group name (`cast.group.
  // <kind>`), restated rather than invented so the two lists never name a
  // kind two different ways.
  "appears.map.aria.here": "{kind} here: {names}",
  "appears.map.aria.below": "{kind} further down: {names}",
  "appears.map.members.label": "where each member of the cast appears",
  "appears.map.members.heading": "By member",
  "appears.map.member.in": "{name}: {titles}",
  "appears.map.member.nowhere": "{name}: no appearances in this map",
  "appears.map.below": "Further down: {names}",
  "appears.map.error.read": "Could not read who appears where: {error}",

  // ---- switcher.ts: the project panel -------------------------------------
  "switcher.new.heading": "New book",
  "switcher.name.label": "New book name",
  "switcher.create": "Create",
  // WHERE THE BOOK WILL GO, said before the writer commits, for its reason:
  // the resolved destination is the thing being consented
  // to. It is also the line that catches a book about to land in a folder the
  // writer syncs, which is the one place a live manuscript file should not be.
  "switcher.where": "New books go in {dir}",
  "switcher.where.unknown": "Cannot read where new books would go",
  "switcher.where.choose": "Choose a folder\u2026",
  // WHERE THE OPEN BOOK IS, and the one act that changes it. The path is the
  // fact a writer needs when they go looking for their file in a file manager.
  "switcher.here": "This book is in {folder}",
  "switcher.book-required": "Open a book to make recovery points, archives, or a readable mirror.",
  "switcher.copies": "Backups and archives",
  "switcher.import.show": "Show the import folder",
  "switcher.move": "Move this book\u2026",
  "switcher.move.hint": "Move the database and its pictures and research folders together. The name stays.",
  "switcher.loading": "Loading books…",
  "switcher.empty.open": "The open book is not listed in this library. Name another below to create it.",
  "switcher.done.created": "{name} created. Open it from the list.",
  "switcher.empty": "No books in the library yet. Name one below and create it.",
  "switcher.row.located": "{name}, {path}",
  "switcher.row.error": "{name} - {error}",
  "switcher.row.missing": "{name} - not found at {path}",
  "switcher.row.missing.notice": "There is no file at {path}. If you moved this book, open it from its new place; if it is gone, forget it.",
  "switcher.forget": "Forget",
  "switcher.forget.label": "Forget {name}",
  "switcher.forget.hint": "Remove this book from the list. No file is touched.",
  "switcher.error.list": "Could not list books.",
  "switcher.refuse.no-name": "Type a name for the new book, then Create.",
  "switcher.import.heading": "Import",
  "switcher.import.list.label": "files to import",
  "switcher.title": "Books",
  "switcher.rename.label": "the name of the open book",
  // The button's tooltip AND its accessible description of what pressing it
  // does. The visible text is the book's title, which says what the control is
  // ABOUT and not what it does - the one case in this page where those differ.
  "switcher.rename.hint": "Rename this book",
  "switcher.import.where": "Files are imported from {dir}",
  "switcher.import.empty": "Drop a .md or .docx file in the import folder.",
  "switcher.import.error": "Could not read the import folder.",
  // A loss report, for a DOCX source: a Markdown import always reports
  // zeros and never reaches this sentence at all. The
  // `{list}` is built in `switcher.ts::lossesNotice`, one clause per
  // non-zero kind below, in this FIXED order.
  "import.contents-derived": "The opening contents list \"{title}\" was omitted. Exports regenerate it from the outline; the source file is unchanged.",
  "import.losses": "Imported without: {list}",
  "import.loss.tables.one": "{count} table",
  "import.loss.tables.other": "{count} tables",
  "import.loss.pictures.one": "{count} picture",
  "import.loss.pictures.other": "{count} pictures",
  "import.loss.notes.one": "{count} footnote or endnote",
  "import.loss.notes.other": "{count} footnotes or endnotes",
  "import.loss.comments.one": "{count} comment",
  "import.loss.comments.other": "{count} comments",
  "import.loss.links.one": "{count} link",
  "import.loss.links.other": "{count} links",
  "import.loss.fields.one": "{count} field",
  "import.loss.fields.other": "{count} fields",
  "import.loss.lists.one": "{count} numbered or bulleted paragraph",
  "import.loss.lists.other": "{count} numbered or bulleted paragraphs",
  "import.loss.revisions.one": "{count} tracked revision",
  "import.loss.revisions.other": "{count} tracked revisions",
  "import.loss.revisions.warning": "Tracked revisions and their authors were not retained. Keep the original DOCX for review.",

  // ---- format-bubble.ts -----------------------------------------------
  // These are icon-only controls in a bubble over the selection,
  // not a bar in the header -- the visible text is gone, and the name below
  // is the control's `aria-label` alone.
  //
  // The underline hint is not decoration: Markdown has no underline, so the
  // export drops the mark (counted, and reported in the notice below). A writer
  // who learns that only after underlining a chapter has been told too late.
  "format.group.label": "Formatting",
  "format.bold": "Bold",
  "format.italic": "Italic",
  "format.underline": "Underline",
  "format.underline.hint": "Underline is kept in your book but not in the Markdown export.",
  "format.comment": "Add comment",
  "format.comment.hint": "Ctrl+Alt+M",
  "format.find": "Find in manuscript",
  "format.find.hint": "Search the whole book for the selected words",
  "format.dictionary": "Add to dictionary",
  "format.dictionary.hint": "Stop the checker underlining this word in this book",
  "dict.no-word": "Put the caret in a word, or select one, to add it to the dictionary.",
  "dict.added": "{word} added to this book's dictionary.",

  // ---- chrome-toggles.ts --------------------------------------------------
  "chrome.outline.label": "Outline",
  "chrome.outline.hint": "Show or hide the outline",
  "chrome.focus.label": "Focus",
  "chrome.focus.hint": "Dim everything but the paragraph you are in",

  // ---- book-design.ts and design-panel.ts ---------------------------------
  // HOW THE BOOK IS SET WHEN IT LEAVES, per book. Deliberately NOT the
  // `prefs.*` family: those are per writer and about this screen, these are per
  // book and about a printed page. The panel holds no measurement of its own --
  // the host sends every figure with the design -- so nothing here states one.
  //
  // The page-size and preset names are keyed by the host's own ids. An id with
  // no key renders as the id, which is the same rule `export.format.*` follows
  // and for the same reason: a host one version ahead must not be described
  // with the wrong word.
  "design.panel.label": "Book design",
  "design.heading": "Book design",
  "design.legend.preset": "Preset",
  "design.name.preset": "Design preset",
  "design.legend.font": "Font",
  "design.name.font": "Body font",
  "design.legend.page": "Page",
  "design.name.page": "Page size",
  "design.legend.margins": "Margins",
  "design.preset.fiction": "Fiction",
  "design.preset.non-fiction": "Non-fiction",
  "design.page.digest": "Digest (5.5 x 8.5 in)",
  "design.page.five-by-eight": "5 x 8 in (127 x 203.2 mm)",
  "design.page.letter": "US Letter (215.9 x 279.4 mm)",
  "design.page.b5": "ISO B5 (176 x 250 mm)",
  "design.page.a4": "A4 (210 x 297 mm)",
  "design.page.a5": "A5 (148 x 210 mm)",
  "design.page.trade": "Trade (6 x 9 in)",
  "design.page.large": "Large (7 x 10 in)",
  "design.page.custom": "Custom size: {size}",
  // Millimetres first because they are exact -- micrometres are thousandths of
  // one -- and inches beside them because that is how a trim size is quoted.
  "design.page.readout": "{width} x {height} mm ({widthIn} x {heightIn} in)",
  // Inner and outer rather than left and right: facing pages mirror, so the
  // margin against the binding is the same one on both.
  "design.margin.inner": "Inner",
  "design.margin.outer": "Outer",
  "design.margin.top": "Top",
  "design.margin.bottom": "Bottom",
  "design.margin.label": "{axis} margin, in millimetres",
  "design.margin.label.unit": "{axis} margin, in {unit}",
  "design.margin.unit": "mm",
  "design.margin.unit.mm": "millimetres",
  "design.margin.unit.in": "inches",
  "design.margin.unit.label.mm": "Millimetres",
  "design.margin.unit.label.in": "Inches",
  "design.margin.abbr.mm": "mm",
  "design.margin.abbr.in": "in",
  "design.error.margin": "{typed} is not a measurement in millimetres.",
  "design.error.margin.unit": "{typed} is not a measurement in {unit}.",
  "design.error.save": "Book design not saved: {error}",
  "design.transfer.heading": "Move book design between books",
  "design.transfer.export": "Export design file…",
  "design.transfer.preview": "Preview design file or salvage report…",
  "design.transfer.apply": "Apply these design changes",
  "design.transfer.review": "Review these changes from {source} before applying them.",
  "design.transfer.source.book-design": "a book design file",
  "design.transfer.source.salvage": "a salvage report",
  "design.transfer.change": "{field} will change from {before} to {after}.",
  "design.transfer.skipped": "{field} will stay as it is: {reason}.",
  "design.transfer.default": "the default",
  "design.transfer.invalid-saved": "a setting this version cannot read",
  "design.transfer.named-page": "{name}: {size}",
  "design.transfer.custom-page": "Custom size ({name}): {size}",
  "design.transfer.margin-value": "{axis} {value} mm",
  "design.transfer.no-options": "No chapter options",
  "design.transfer.note": "Only settings move. Font files and cover pictures do not travel with this file.",
  "design.transfer.exported": "Book design saved to {path}",
  "design.transfer.applied": "Book design changes applied.",
  "design.transfer.refresh-error": "Book design was applied, but the panel could not refresh: {error}",
  "design.transfer.error": "Could not move the book design: {error}",
  "design.transfer.field.font": "Body font",
  "design.transfer.field.page": "Page size",
  "design.transfer.field.margins": "Margins",
  "design.transfer.field.glyph": "Chapter ornament",
  "design.transfer.field.chapter": "Chapter options",
  "design.transfer.field.cover_fit_front": "Front cover in the PDF",
  "design.transfer.field.cover_fit_back": "Back cover in the PDF",
  "design.transfer.reason.unreadable": "its value in the file could not be read",
  "design.transfer.reason.invalid_font": "the font name cannot be used",
  "design.transfer.reason.invalid_page": "the page size cannot be used",
  "design.transfer.reason.invalid_margins": "the margins cannot be used",
  "design.transfer.reason.unknown_ornament": "unknown ornament",
  "design.transfer.reason.invalid_chapter_option": "unknown or repeated chapter option",
  "design.transfer.reason.unknown_cover_fit": "unknown cover placement",
  "design.transfer.reason.unknown_design_field": "this version does not know that setting",
  "design.transfer.reason.absent_or_unrecovered": "the salvage report cannot establish a value",
  "design.transfer.reason.legacy_or_not_chosen": "not recorded by this older report or not chosen",
  "design.transfer.reason.not_chosen": "not chosen in the source",
  "design.error.load": "Book design could not be read: {error}",
  "proof.setup.page": "Page size",
  "proof.setup.margins": "Margins",
  "proof.setup.error": "Page setup not saved: {error}",

  // ---- identity.ts, identity-panel.ts and preflight-panel.ts --------------
  // PEN NAMES, AND WHAT AN EXPORT CAN HONESTLY SAY IT CHECKED.
  //
  // THE LANGUAGE HERE IS PART OF THE FEATURE AND NOT A WORDING PASS. The
  // cross-identity check proves a LITERAL OCCURRENCE of a known other-identity
  // name, with a location, and nothing else. An initialism, a misspelling, a
  // name the vault has never seen and an allusion are all invisible to it, and
  // no offline check can see them. So the sentence is "no occurrence of a known
  // other-identity name was found in the surfaces listed" and it is NEVER "no
  // leaks were found" -- a check that overstates what it proves is worse than no
  // check, because a writer acts on it.
  //
  // AND IT NEVER IMPLIES CONFIDENTIALITY. The private tier is kept out of
  // exports by never being copied into them, which is a data-flow property and
  // needs no key. `identities.json` is plaintext on a disk whose whole
  // manuscript library is also plaintext. What is protected is TRAVELLING, not
  // being read by somebody at this machine, and no string below may say
  // otherwise.
  //
  // Every state word, check name, surface name and field name arrives from the
  // host as a machine word and is looked up here. The host has no catalog.
  "identity.panel.label": "Pen names",
  "identity.heading": "Pen names",
  "identity.intro": "A pen name lives in this library and can be used by any book. What a book is written under is pinned to that book, so editing a name here never changes a book you have already published.",
  "identity.list.heading": "In this library",
  "identity.list.empty": "No pen names yet.",
  "identity.new": "New pen name",
  "identity.remove": "Remove pen name",
  // ONE LABEL AND A PRESSED STATE, not two labels. The first capture of this
  // panel had a row reading "Ad\u2026" beside a control reading "Use no pen name
  // for this book": the longest string in the row had squeezed out the only one
  // a writer needs to read. `aria-pressed` already carries which name this book
  // is written under, the line above the list says it in words, and the
  // the bubble's three mark toggles are the same shape.
  "identity.pin": "Use for this book",
  "identity.repin": "Update this book",
  "identity.preview.heading": "Review this book's pen name",
  "identity.preview.note": "Only the public and publishing fields below will be copied into this book. The book changes when you confirm.",
  "identity.preview.unreadable": "This book has a pen-name pin that cannot be read. Confirming will replace that damaged pin with the public and publishing fields below.",
  "identity.preview.unreadable.value": "(unreadable pin)",
  "identity.preview.replace": "Replace damaged pin",
  "identity.preview.field": "Field",
  "identity.preview.current": "Current book",
  "identity.preview.proposed": "After update",
  "identity.preview.empty": "(empty)",
  "identity.preview.confirm": "Confirm for this book",
  "identity.preview.cancel": "Cancel",
  "identity.pinned": "This book is written as {name}.",
  "identity.unpinned": "This book has no pen name.",
  "identity.stale": "This pen name has changed since this book was pinned to it. The book keeps what it was pinned with.",
  "identity.tier.public": "Public",
  "identity.tier.aliases": "Other bylines",
  "identity.tier.aliases.note": "These names stay in the library vault. When this pen name is used for a book, these names do not block that book; other names still can.",
  "identity.tier.publishing": "Publishing",
  "identity.tier.private": "Private",
  // THE ONE SENTENCE THAT SAYS WHAT THE PRIVATE TIER IS AND IS NOT. It is the
  // whole of the protection: what is here is kept out of books because it is
  // never copied into them, and this file is not encrypted.
  "identity.tier.private.note": "These fields stay in this file. They are never copied into a book, an export, a backup or a recovery, because the copy a book keeps has no place to put them. This file is not encrypted, so anyone using this computer can read it.",
  "identity.field.name": "Pen name",
  "identity.field.sort_name": "Sorted as",
  "identity.field.bio": "Biography",
  "identity.field.links": "Links, one per line",
  "identity.field.aliases": "Other names, one per line",
  "identity.field.imprint": "Imprint",
  "identity.field.rights": "Rights statement",
  "identity.field.legal_name": "Legal name",
  "identity.field.contact": "Contact",
  "identity.field.admin": "Notes",
  "identity.save": "Save pen name",
  "identity.check": "What an export would carry\u2026",
  "identity.done.saved": "{name} saved.",
  "identity.done.removed": "Pen name removed. Books already pinned to it keep what they were pinned with.",
  "identity.done.pinned": "This book is now written as {name}.",
  "identity.done.unpinned": "This book now has no pen name.",
  "identity.error.load": "The pen names could not be read: {error}",
  "identity.error.save": "That pen name was not saved, and nothing was changed: {error}",

  // The export report. `format` is the machine word `ExportResult.format`
  // carries, so the notice and the report name the same file.
  "preflight.panel.label": "Export checks",
  "preflight.heading": "What an export would carry",
  "preflight.heading.of": "What an export would carry \u2014 {format}",
  "preflight.check.row": "{name}: {state}",
  "preflight.format.markdown": "Markdown",
  "preflight.format.epub": "EPUB",
  "preflight.format.pdf": "PDF proof",
  "preflight.format.docx": "Word",
  "preflight.fields.heading": "Identity fields this format writes",
  "preflight.fields.none": "This format writes no identity field at all. Whatever pen name this book is pinned to, it will not be in the file.",
  "preflight.field.row": "{field} \u2192 {at}: {value}",
  "preflight.at.dc:creator": "the author field",
  "preflight.at.file-as": "the author sort field",
  "preflight.at.dc:publisher": "the publisher field",
  "preflight.at.dc:rights": "the rights field",
  "preflight.at.title-page": "the title page",
  "preflight.checks.heading": "Checks",
  "preflight.check.identity_disclosure": "Identity disclosure",
  "preflight.check.cross_identity": "Another pen name in this book",
  "preflight.check.missing_metadata": "Required fields",
  "preflight.check.broken_links": "Links",
  "preflight.check.validator": "Format validator",
  "preflight.check.assets": "Alt text, fonts and images",
  "preflight.state.ran": "checked",
  "preflight.state.vacuous": "nothing to check",
  "preflight.state.not_applicable": "does not apply",
  // THE HEADING THAT MAKES THE REPORT HONEST. A preflight showing six rows and
  // hiding that four of them checked nothing is the recorded failure mode.
  "preflight.skipped.heading": "Checks that did not run",
  "preflight.skipped.none": "Every check ran.",
  "preflight.findings.heading": "Findings",
  "preflight.findings.none": "Nothing was found in the surfaces listed below.",
  "preflight.reason.label": "Why you would proceed despite this warning",
  "preflight.reason.record": "Record reason",
  "preflight.reason.empty": "Enter a reason before recording it.",
  "preflight.reason.error": "The reason was not recorded: {error}",
  "preflight.history.heading": "Earlier warning reasons",
  "preflight.history.context": "Earlier reasons are historical context. They do not clear a current warning or allow a blocked export.",
  "preflight.history.none": "No earlier reasons were recorded.",
  "preflight.history.unavailable": "Earlier reasons cannot be read. The stored history was preserved; recording is unavailable.",
  "preflight.history.kind.identity_unset": "No pen name",
  "preflight.history.kind.cross_identity": "Another pen name",
  "preflight.history.kind.cross_identity_unpinned": "Pen-name occurrence without a pinned identity",
  "preflight.history.kind.link_not_a_url": "Link is not a web address",
  "preflight.history.entry": "{check} in {surface}, {format}, {at}",
  "preflight.severity.blocker": "Stops the export",
  "preflight.severity.warning": "Worth knowing",
  "preflight.finding.identity_unset": "This book has no pen name. It will be exported without one.",
  // NEVER "a leak was found". It is an occurrence of a name, with where it is.
  "preflight.finding.cross_identity": "{matched} occurs in {surface}{where}. That name is another pen name in this library, so this export is stopped.",
  "preflight.finding.cross_identity_unpinned": "{matched} occurs in {surface}{where}. That name is a pen name in this library. This book is pinned to none, so nothing here can say whether that is this book\u2019s own name.",
  "preflight.finding.link_not_a_url": "{matched} is not a web address. It is written into the book as it stands and nothing was fetched to check it.",
  "preflight.finding.at": " (item {item}, at {offset})",
  "preflight.surfaces.checked": "Checked in this book",
  "preflight.surfaces.unchecked": "Not checked",
  // THE SENTENCE THE DESIGN FIXES. It says what was compared and what was
  // looked at, and it claims nothing beyond that.
  "preflight.surfaces.claim": "No occurrence of a known other-identity name was found in the surfaces listed. A name this library has never been told about, an initialism, a misspelling or an allusion is invisible to this check, and no check that never leaves this machine can see one.",
  "preflight.surfaces.nothing": "There is no other pen name in this library to compare this book against, so nothing was compared. That is not the same as finding nothing.",
  "preflight.surface.project_name": "the book\u2019s name",
  "preflight.surface.item_title": "the titles in the outline",
  "preflight.surface.document_body": "the prose",
  "preflight.surface.revision_pass_name": "revision pass names",
  "preflight.surface.revision_pass_purpose": "revision pass purposes",
  "preflight.surface.revision_task_body": "revision tasks",
  "preflight.surface.project": "this book",
  "preflight.surface.identity_links": "the pen name\u2019s links",
  "preflight.surface.comment_body": "comments",
  "preflight.surface.comment_quote": "the text comments are attached to",
  "preflight.surface.snapshot_label": "snapshot names",
  "preflight.surface.synopsis": "synopses",
  "preflight.surface.cast": "the cast",
  "preflight.surface.export_directory": "what else is in the export folder",
  "preflight.surface.window_title": "the window title",
  "preflight.surface.diagnostics": "the crash file",
  "preflight.surface.readable_mirror": "the readable folder",
  "preflight.surface.series_name": "series names",
  "preflight.surface.universe_name": "universe names",
  "preflight.error.load": "The export checks could not be run: {error}",

  // ---- covers.ts, covers-panel.ts and picture-viewer.ts -------------------
  // THE BOOK'S OWN TWO PICTURES. Deliberately NOT the `cast.picture.*` family:
  // those are about one character and these are about the book, and the two
  // panels say different things about the same four states -- a cast
  // photograph that is missing costs a face, and a cover that is missing is the
  // front of the book.
  //
  // The three findings are one family and are always painted, including the one
  // that says nothing is wrong. A surface that speaks only when it disapproves
  // leaves a writer unable to tell "checked and fine" from "not checked", which
  // is the state they are in the moment before they upload their book.
  //
  // Every figure in them comes from the host: the page holds no threshold, no
  // dpi and no trim size. `design::check` and `covers::check` own the
  // arithmetic, for the recorded reason two statements of one rule end up
  // disagreeing and nobody notices which one answered.
  "covers.panel.label": "Covers",
  "covers.heading": "Covers",
  "covers.side.front": "Front",
  "covers.side.back": "Back",
  // WHAT THE COVERS ARE BEING JUDGED AGAINST, painted unconditionally for
  // `design.page.readout`'s reason: it is the only thing on the panel that says
  // where every number below it came from, and a writer who disagrees with the
  // verdict needs to know which page produced it.
  "covers.page": "Checked against a {width} x {height} mm ({widthIn} x {heightIn} in) page. Change it in File\u00a0\u203a\u00a0Book\u00a0design.",
  "covers.none": "No cover yet.",
  "covers.missing": "The cover file is not where this book keeps it.",
  "covers.unreadable": "That cover could not be read.",
  "covers.choose": "Add a cover\u2026",
  "covers.replace": "Change cover\u2026",
  "covers.remove": "Remove cover",
  "covers.view": "View full size",
  "covers.fit.label": "PDF page placement",
  "covers.fit.contain": "Show whole image (may leave bands)",
  "covers.fit.fill": "Fill page (crop edges)",
  "covers.fit.option.contain": "Show whole image",
  "covers.fit.option.fill": "Fill page",
  "covers.fit.explain.contain": "May leave blank bands to show the whole image.",
  "covers.fit.explain.fill": "May crop image edges to fill the page.",
  // The SIDE and not the filename, for `cast.picture.alt`'s reason: a uuid is
  // not a description of anything, and the filename is the one thing about a
  // cover the writer never chose. The BOOK's name is not in it either: this
  // panel is about the open book and nothing else, so repeating its name would
  // be a second copy of a fact the window title already carries.
  "covers.alt.front": "Front cover",
  "covers.alt.back": "Back cover",
  "covers.check.ok": "{width} x {height} pixels, about {dpi} dpi on this page. That suits it.",
  "covers.check.resolution": "{width} x {height} pixels is about {dpi} dpi on this page. Print wants {wanted} dpi, which is {wantedWidth} x {wantedHeight} pixels.",
  "covers.check.shape.contain": "This is not the shape of the page. The whole image will show with blank bands.",
  "covers.check.shape.fill": "This is not the shape of the page. Filling it will crop image edges.",
  "covers.done.added": "{side} cover added.",
  "covers.done.removed": "{side} cover removed.",
  "covers.done.fit": "{side} cover placement changed for the PDF proof.",
  "covers.error.load": "The covers could not be read: {error}",
  "covers.error.change": "Could not change the cover, and nothing was changed: {error}",
  // THE FULL-SIZE VIEWER, shared by the cast panel and the covers panel. There
  // was no way to see a picture full size before this; there is one
  // viewer and one bound rather than two of each.
  "viewer.label": "Picture",
  "viewer.error": "That picture could not be shown full size: {error}",
  // A full read can fail where the thumbnail beside it succeeded -- the file can
  // go between the two reads -- so the failure is NAMED rather than left as a
  // viewer that does not open.
  "viewer.unavailable": "There is nothing to show full size: the picture file is not readable.",

  // ---- export-bar.ts and export-formats.ts --------------------------------
  // EVERY EXPORT SENTENCE NAMES ITS FORMAT. Markdown was the only
  // thing this application could write, so the notices said "Exported to" and
  // meant one file type without ever saying which; the publishing track adds
  // EPUB and PDF, and a writer told only "Exported to /home/w/book" cannot tell
  // which of three controls they just used. `export.format.*` is the display
  // name, keyed by the host's own `export::Format::id`.
  "export.format.markdown": "Markdown",
  "export.format.epub": "EPUB",
  "export.format.pdf": "PDF",
  "export.format.docx": "Word",
  "stats.export.format.csv": "statistics CSV",
  "stats.export.format.json": "statistics JSON",
  "stats.export.csv": "Export for a spreadsheet (CSV)\u2026",
  "stats.export.json": "Export as data (JSON)\u2026",
  "export.done": "Exported {format} to {path}",
  // THE COUNTED LOSS, said in the writer's own words. The host counts the
  // underlined runs it dropped and the count rides back with the path; a drop
  // nobody is told about is the class of silent loss this repo has spent four
  // slices removing.
  "export.done.underlined.one":
    "Exported {format} to {path}. {format} has no underline, so {count} underlined run was written as plain text.",
  "export.done.underlined.other":
    "Exported {format} to {path}. {format} has no underline, so {count} underlined runs were written as plain text.",
  // NAMES THE FORMAT THE WRITER ASKED FOR, not one taken off a result: there is
  // no result. A failed export is the one path where the page's own request is
  // the only thing that knows which control was pressed.
  "export.error.unsaved": "Your latest changes could not be saved. Export cannot continue.",
  "preview.error.unsaved": "Your latest changes could not be saved. The preview cannot be built.",
  "publishing.error.unavailable": "This book is not available for this action right now.",
  "export.error": "{format} export failed: {error}",
  // ---- epub-preview.ts and preview-rail.ts -----------------------------------
  // THE RAIL IS NOT A PANEL and its words say so: it has a Close rather than
  // dismissing itself, because a preview that vanished when the writer clicked
  // their prose would be a preview nobody could work beside.
  // TWO FORMATS, ONE RAIL, so the words that are about the RAIL are shared and
  // the words that are about a BOOK are per format. The label and the heading
  // are per format because a region labelled "EPUB preview" while it shows a
  // proof copy tells a screen-reader user the wrong thing.
  "preview.epub.label": "EPUB preview",
  "preview.pdf.label": "PDF proof",
  "preview.refresh": "Refresh",
  "preview.save-as": "Save as\u2026",
  "preview.close": "Close",
  "preview.options": "Book appearance",
  // ON DEMAND, and the line says why rather than leaving a writer wondering
  // whether the rail is broken. A full render is O(the manuscript) and this
  // application's keystroke path is measured and gated; a preview that
  // repainted as somebody typed would spend that budget on every word.
  "preview.epub.note":
    "Rendered from the book as saved. Press Refresh after you write more. How a reading system sets the page will differ. EPUB includes the front cover, but not the back cover.",
  // A PROOF COPY AND NOT A PRINTER'S FILE, said on the surface rather than only
  // in a decision record: a writer who sent this to a printer expecting bleed
  // and a spine would find out from the printer.
  "preview.pdf.note":
    "A proof copy to read or send to a first reader, laid out at the page size and margins selected here. Not a printer\u2019s file: no bleed, no spreads. Press Refresh after you write more.",
  "preview.legend.ornament": "Chapter ornament",
  "preview.name.ornament": "The ornament under each chapter title",
  "preview.glyph.none": "None",
  "preview.glyph.asterisks": "Three asterisks",
  "preview.glyph.asterism": "Asterism",
  "preview.glyph.fleuron": "Fleuron",
  "preview.glyph.diamond": "Diamond",
  "preview.legend.chapter": "Book style",
  "preview.name.chapter": "Heading and chapter styling",
  "preview.option.new_page": "New page for parts and chapters",
  "preview.option.caps_title": "Book-body headings in capitals",
  "preview.option.drop_cap": "Drop cap at chapter openings",
  "preview.epub.summary.one": "{items} section, {words} words.",
  "preview.epub.summary.other": "{items} sections, {words} words.",
  "preview.pdf.summary.one": "{leaves} page, {items} sections, {words} words.",
  "preview.pdf.summary.other": "{leaves} pages, {items} sections, {words} words.",
  // THE FONT GAP, CLOSED BY SAYING IT. This application ships no font files, so
  // a book naming a face the machine does not have is set in something else --
  // and a proof copy that quietly lies about its own type is worse than none.
  "preview.pdf.font-missing":
    "{font} is not installed on this machine, so this proof is set in a substitute. The PDF carries the face it was actually set in.",
  // THE GUTTER, WHICH NEEDS THE PAGE COUNT AND SO COULD NOT BE SAID UNTIL NOW.
  // Both verdicts are spoken, never only the unhappy one: a surface that speaks
  // when it disapproves and is silent otherwise leaves a writer unable to tell
  // "checked and fine" from "not checked".
  "preview.pdf.gutter.clears":
    "At {pages} pages a common print service asks for at least {minimum} mm against the spine. Your inner margin is {inner} mm.",
  "preview.pdf.gutter.below":
    "At {pages} pages a common print service asks for at least {minimum} mm against the spine, and your inner margin is {inner} mm. Change it under Margins above.",
  "preview.pdf.truncated":
    "Showing the first {shown} of {leaves} pages. The file has all of them.",
  "preview.cover.alt": "Front cover",
  // A DOCUMENT THIS PAGE COULD NOT PARSE. The rail parses each EPUB document as
  // XHTML, which is what a reading system does; saying so names the file rather
  // than showing a gap the writer would read as an empty chapter.
  "preview.error.document": "{name} is not well-formed and no reading system will open it.",
  "preview.error.stylesheet": "The book\u2019s stylesheet could not be shown here. The file itself carries it.",
  "preview.error.load": "The preview could not be built: {error}",
  "preview.error.style": "That was not changed: {error}",
  // ---- menu-bar.ts and nav-context-menu.ts --------------------------------
  // `menu-cli` locates a title by DOM id, so `menu.file`/`menu.edit`/
  // `menu.outline`/`menu.help` are rig-VISIBLE (counted as
  // `menu_titles_found`) but not rig-located. The `item.numbered.*`
  // patterns below ARE rig-located: `rowNamed` builds the accessible name it
  // searches for from those same patterns, so they stay rig-visible strings
  // too. The chords are restated here rather than shared with `help.*`: the
  // panel and the menu are two independent statements of the same binding by
  // design, and `help.test.ts` is what catches them disagreeing with
  // `editor.ts`.
  "menu.bar.label": "Application menu",
  "menu.button.label": "Menu",
  "menu.button.hint": "File, Edit, Outline and Help",
  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.outline": "Outline",
  "menu.view.manuscript": "Manuscript view",
  "menu.view.table": "Book overview",
  "menu.view.cards": "Cards view",
  "menu.view.reading": "Read manuscript",
  "menu.view.continuous": "Edit chapter continuously",
  "continuous.scope": "Chapter scope: {title}",
  "continuous.loose": "Loose scenes at manuscript root",
  "continuous.loose-in": "Loose scenes in {title}",
  "continuous.window": "Scenes {first}–{last} of {total}",
  "continuous.editing": "Editing: {title}",
  "continuous.previous": "Previous scene window",
  "continuous.next": "Next scene window",
  "continuous.return": "Single scene view",
  "continuous.loading": "Loading saved text…",
  "continuous.unavailable": "This saved scene could not be read.",
  "continuous.error": "A surrounding scene could not be read: {error}",
  "continuous.need-scene": "Open a scene to edit its chapter continuously.",
  "continuous.boundary": "Continuous chapter view edits one scene at a time. Alt+Page Up and Alt+Page Down switch scenes after saving. Undo belongs to the active scene and resets when you switch. Cross-scene text can be copied but not changed together.",
  "help.keys.continuous": "Alt+Page Up / Alt+Page Down",
  "menu.open-reference": "Open selection as reference",
  "menu.close-reference": "Close reference",
  "reference.label": "Saved reference",
  "reference.refresh": "Refresh",
  "reference.open-source": "Open source",
  "reference.close": "Close",
  "reference.loading": "Loading saved text…",
  "reference.revision": "Saved revision {revision}",
  "reference.stale": "Saved revision {revision} · changed; refresh to read the latest",
  "reference.unavailable": "This source is no longer available.",
  "reference.unsupported": "This document uses a format this build cannot read.",
  "reference.timeline": "A timeline is not prose and cannot be opened as a reference.",
  "reference.not-prose": "Select a scene, book page, or bible note to open as a reference.",
  "reference.error": "The reference could not be read: {error}",
  "reference.save-refused": "The reference was not refreshed because the current draft could not be saved.",
  "reading.title": "Read manuscript",
  "reading.pages": "Reading pages",
  "reading.page": "Page {page} of {pages}",
  "reading.scope": "Documents {from}–{to} of {total} in manuscript order · Bin and Bible excluded",
  "reading.loading": "Loading saved text…",
  "reading.unavailable": "This document could not be read.",
  "menu.help": "Help",
  // the Alt letter that opens each menu, one uppercase chord token so
  // the completeness test reads it as a chord. Must be the first letter of
  // the title above it in THIS catalog; `menu-accelerators.test.ts` pins it.
  "menu.file.key": "F",
  "menu.edit.key": "E",
  "menu.outline.key": "O",
  "menu.help.key": "H",
  "outline-view.table": "Book overview",
  "outline-view.cards": "Cards",
  "outline-view.return": "Return to editor",
  "outline-view.pages.label": "Outline pages",
  "outline-view.previous": "Previous page",
  "outline-view.next": "Next page",
  "outline-view.page.one": "Page {page} of {pages}, {count} item",
  "outline-view.page.other": "Page {page} of {pages}, {count} items",
  "outline-view.empty": "No manuscript items yet.",
  "outline-view.scope": "Manuscript order · Bin and Bible excluded",
  "outline-view.scroll-hint": "Scroll horizontally to see all columns.",
  "outline-view.column.title": "Title",
  "outline-view.column.type": "Type",
  "outline-view.column.state": "Revision",
  "outline-view.column.words": "Words",
  "outline-view.column.synopsis": "Synopsis",
  "outline-view.column.actions": "Actions",
  "outline-view.no-synopsis": "No synopsis",
  "outline-view.synopsis-loading": "Loading synopsis…",
  "outline-view.synopsis-unavailable": "Synopsis unavailable",
  "outline-view.uncounted": "Not counted",
  "outline-view.open": "Open in editor",
  "outline-view.undo": "Undo outline change",
  "outline-view.redo": "Redo outline change",
  "outline-view.synopsis-error": "The outline synopses could not be read: {error}",
  "outline-view.meta": "{type}, {state} · {words}",
  "outline-view.meta.no-state": "{type} · {words}",
  "outline-view.words.one": "{count} word",
  "outline-view.words.other": "{count} words",
  "outline-view.open.short": "Open",
  "outline-view.move": "Move",
  "outline-view.move.label": "Move {title}",
  "outline-view.moved": "Moved {title}.",
  "outline-view.drop-refused": "A row drags only among the rows beside it. To change its part or chapter, use Move out or Move in.",
  "outline-view.type.part": "Part",
  "outline-view.type.chapter": "Chapter",
  "outline-view.type.scene": "Scene",
  "outline-view.type.front": "Front matter",
  "outline-view.type.back": "Back matter",
  "outline-view.type.matter": "Matter page",
  "menu.project-new": "New book\u2026",
  "menu.project-open": "Open book\u2026",
  // ---- book-copy-prompt.ts -------------------------------------------------
  "book-copy.label": "Choose how to open this copy",
  "book-copy.heading": "This is a copy of a book you already opened",
  "book-copy.explanation": "Same book continues its recovery history and readable folder from this copy. Separate book starts independent protection. Neither manuscript's text will change.",
  "book-copy.path.label": "Previously opened at",
  "book-copy.same": "Same book",
  "book-copy.separate": "Separate book",
  "book-copy.cancel": "Cancel",
  "book-copy.separate.unavailable": "Separate book is unavailable because the original file cannot be checked.",
  "menu.project-rename": "Rename book\u2026",
  "menu.import": "Import\u2026",
  "menu.book-design": "Book design\u2026",
  "menu.covers": "Covers\u2026",
  "menu.export": "Export manuscript (Markdown)",
  "menu.export-as": "Export Markdown to\u2026",
  "menu.export-docx": "Export for an editor (Word)\u2026",
  // BELOW the two exports in the File menu, and the position is measured
  // rather than chosen: an item above Export costs `export-cli` one more
  // ArrowDown out of a 1000 ms debounce window that had 141 ms left.
  "menu.epub-preview": "EPUB preview\u2026",
  "menu.pdf-preview": "PDF proof\u2026",
  "menu.identities": "Pen names\u2026",
  "menu.backup-now": "Create recovery point",
  "menu.encrypted-backups": "Encrypted backups…",
  // "Folder" is the mirror's own word everywhere else in this catalog, and the
  // ellipsis is this menu's convention for an item that opens something rather
  // than doing something.
  "menu.mirror-changes": "Changes in your folder\u2026",
  // The switcher on the list, below the exports and above
  // Preferences -- the File menu's last unspent slot above Export stays
  // unspent, because this is not on the export route.
  "menu.library": "Library\u2026",
  "menu.preferences": "Preferences\u2026",
  "menu.quit": "Quit",
  "menu.undo": "Undo",
  "menu.redo": "Redo",
  "menu.find": "Find\u2026",
  "menu.replace": "Replace\u2026",
  "menu.history": "History\u2026",
  "menu.add-comment": "Add comment\u2026",
  "menu.comments": "Comments\u2026",
  "menu.add-to-dictionary": "Add word to dictionary",
  "menu.nav-back": "Back",
  "menu.nav-back.empty": "Back (nothing earlier)",
  "menu.nav-forward": "Forward",
  "menu.nav-forward.empty": "Forward (nothing further)",
  "menu.go-to": "Go to\u2026",
  "menu.new-part": "New part",
  "menu.new-chapter": "New chapter",
  "menu.new-scene": "New scene",
  "menu.new-note": "New bible document",
  "menu.new-bible-folder": "New bible folder",
  "menu.new-timeline": "New timeline",
  // THE FOUR PAGES A BOOK HAS THAT ARE NOT CHAPTERS. Named for what a writer
  // would look for rather than for the mechanism: nothing here says "matter",
  // "front" or "section", because a writer wanting to thank their editor looks
  // for the word acknowledgements.
  "menu.new-dedication": "New dedication",
  "menu.new-foreword": "New foreword",
  "menu.new-acknowledgements": "New acknowledgements",
  "menu.new-afterword": "New afterword",
  // The moves. Verbs, and OUT/IN rather than left/right: the chord is
  // Alt+Left and Alt+Right, and the shortcut column beside the label already
  // says so -- but "Move left" describes the key while "Move out" describes
  // what happens to the manuscript.
  "menu.move-up": "Move up",
  "menu.move-down": "Move down",
  "menu.move-out": "Move out",
  "menu.move-in": "Move in",
  "menu.rename": "Rename\u2026",
  "menu.restore": "Restore",
  "menu.delete": "Delete",
  "menu.statistics": "Statistics\u2026",
  "menu.revision-state": "Revision state\u2026",
  "menu.synopsis": "Synopsis\u2026",
  "menu.cast": "Cast\u2026",
  "menu.appears": "Who appears here\u2026",
  "menu.appears-map": "Who appears where\u2026",
  "menu.outline-undo": "Undo {what}",
  "menu.outline-undo.empty": "Undo outline change (nothing to undo)",
  "menu.outline-redo": "Redo {what}",
  "menu.outline-redo.empty": "Redo outline change (nothing to redo)",
  "menu.shortcuts": "Writing guide and shortcuts",
  "menu.shortcut.undo": "Ctrl+Z",
  "menu.shortcut.redo": "Ctrl+Shift+Z",
  "menu.shortcut.find": "Ctrl+F",
  "menu.shortcut.add-comment": "Ctrl+Alt+M",
  "menu.shortcut.nav-back": "Alt+Left",
  "menu.shortcut.nav-forward": "Alt+Right",
  "menu.shortcut.go-to": "Ctrl+P",
  "menu.shortcut.library": "Ctrl+Shift+L",
  "menu.shortcut.quit": "Ctrl+Q",
  "menu.shortcut.move-up": "Alt+Up",
  "menu.shortcut.move-down": "Alt+Down",
  "menu.shortcut.move-out": "Alt+Left",
  "menu.shortcut.move-in": "Alt+Right",
  "menu.shortcut.export": "Ctrl+E",
  "nav.context.label": "Outline item",
  // NUMBERED, not "Untitled". `{n}` is the lowest positive
  // integer not already used by an item of that type, so renaming Chapter 1
  // frees the 1. The PATTERN is what `numbering.ts` parses back, so a
  // translated build reads its own titles instead of scanning for the English
  // word -- which is why these carry a placeholder rather than being three
  // bare words with a number appended by code.
  "item.numbered.part": "Part {n}",
  "item.numbered.chapter": "Chapter {n}",
  "item.numbered.scene": "Scene {n}",
  "item.numbered.note": "Note {n}",
  "item.numbered.bible-folder": "Folder {n}",
  // THE FOUR MATTER DOCUMENTS, and these carry NO `{n}`. The numbered patterns
  // above exist because `Untitled part` three times is a tree nobody can read;
  // these are already the name of the page a writer asked for, and
  // `Dedication 1` in a book with one dedication would be a lie about the book.
  // A second one of a kind is a duplicate title the writer can see and rename,
  // which is the same answer this application gives for two chapters a writer
  // names alike.
  "item.matter.dedication": "Dedication",
  "item.matter.foreword": "Foreword",
  "item.matter.acknowledgements": "Acknowledgements",
  "item.matter.afterword": "Afterword",
  // A TIMELINE'S TITLE CARRIES NO `{n}` EITHER, `item.matter`'s reason: the
  // model is one story clock per book, so "Timeline 1" would be a
  // lie about a book that has exactly one.
  "timeline.untitled": "Timeline",
  // the menu's Add comment while a timeline is open. comment_create
  // already refuses the type server-side; this is the writer-facing half.
  "timeline.no-comments": "A timeline cannot carry a comment.",
  // The card's live date beside the day number (timeline-model.ts's
  // `calendarDate`). LAYOUT, not just words -- a language can want the day
  // first, which is why this is a catalog key and not string concatenation
  // inside the pure model.
  // The two safety sentences (design section 3's whole-document leniency
  // rule): a future schema version, and a body this parser cannot read at
  // all. Both render read-only and never reach onDirty -- caught missing
  // by `catalog-key-guard.test.ts`, which is why that guard exists.
  "timeline.newer": "This timeline was saved by a newer build and is shown read-only.",
  "timeline.invalid": "This timeline's data could not be read; it is shown read-only and left untouched.",
  "timeline.calendar.label": "{month} {day}, {year}",
  "timeline.calendar.tick": "{month} {day}",

  // ---- timeline-view.ts, timeline-card.ts ---------------------------------
  "timeline.toolbar.fit": "Fit",
  "timeline.toolbar.zoom-in": "Zoom in",
  "timeline.toolbar.zoom-out": "Zoom out",
  "timeline.toolbar.add-track": "+ Track",
  "timeline.toolbar.add-event": "+ Event",
  // The measuring instrument's own sentence (`#timeline-status`, section 4's
  // exact wording), read by `timeline-cli` through AT-SPI. A writer never
  // asked for either figure; it exists so a rig can grade
  // timeline_zoom_p95_ms and timeline_visible_dom_bounded from what the page
  // itself painted, `#library-timing`'s own reason.
  "timeline.status": "zoom p95 {p95} ms, visible {visible}, px per unit {pxPerUnit}",
  "timeline.empty": "Add a track first, then double-click its lane to add an event.",
  "timeline.event.untitled": "Untitled event",
  "timeline.track.untitled": "Untitled track",
  "timeline.scene.gone": "This scene is missing or in the bin.",
  "timeline.dot.count.one": "{count} event here",
  "timeline.dot.count.other": "{count} events here",
  "timeline.card.edit": "Edit",
  "timeline.card.open-scene": "Open scene",
  "timeline.card.delete": "Delete",
  "timeline.card.delete.confirm": "Delete for good?",
  "timeline.card.save": "Save",
  "timeline.card.when": "Day {at}",
  "timeline.card.when-dated": "Day {at} ({date})",
  "timeline.card.tracks": "Tracks: {tracks}",
  "timeline.card.scene": "Scene: {title}",
  "timeline.card.cast": "Cast: {cast}",
  "timeline.card.field.title": "Title",
  "timeline.card.field.at": "Day",
  "timeline.card.field.until": "Until (optional)",
  "timeline.card.field.tracks": "Tracks",
  "timeline.card.field.scene": "Scene",
  "timeline.card.field.cast": "Cast",
  "timeline.card.field.note": "Note",
  "timeline.card.field.branch": "Branch",
  "timeline.card.field.branch.main": "The main line",

  // ---- branches ------------------------------------------------------
  "timeline.toolbar.add-branch": "+ Branch",
  "timeline.branch.form.title": "New branch",
  "timeline.branch.field.name": "Name",
  "timeline.branch.field.fork-at": "Fork day",
  "timeline.branch.field.fork-track": "Fork track",
  "timeline.branch.create": "Create",
  "timeline.branch.cancel": "Cancel",
  "timeline.branch.untitled": "Untitled branch",
  "timeline.branch.header": "{name}, forked at {at} on {track}",
  "timeline.branch.writing": "The one being written",
  "timeline.branch.not-writing": "Make this the one I am writing",
  "timeline.branch.delete": "Delete branch",
  "timeline.branch.delete.confirm": "Delete for good?",
  "timeline.branch.delete.count.one": "Deletes {count} event with it.",
  "timeline.branch.delete.count.other": "Deletes {count} events with it.",

  // ---- the calendar, eras, the scale panel ---------------------------
  "timeline.toolbar.scale": "Scale: {unit}",
  "timeline.toolbar.edit-scale": "Edit scale…",
  "timeline.scale.panel.title": "Edit scale",
  "timeline.scale.field.unit": "Unit name",
  "timeline.scale.field.zero-label": "Zero label",
  "timeline.scale.use-calendar": "Use a calendar",
  "timeline.scale.months": "Months",
  "timeline.scale.month.name": "Name",
  "timeline.scale.month.days": "Days",
  "timeline.scale.month.season": "Season",
  "timeline.scale.month.add": "+ Month",
  "timeline.scale.month.remove": "Remove month",
  "timeline.scale.field.year-label": "Year label",
  "timeline.scale.field.epoch-year": "Epoch year",
  "timeline.scale.year-label.default": "year {n}",
  "timeline.calendar.days": "Every month needs at least one day.",
  "timeline.era.eras": "Eras",
  "timeline.era.name": "Name",
  "timeline.era.from": "From",
  "timeline.era.to": "To",
  "timeline.era.tint": "Tint",
  "timeline.era.add": "+ Era",
  "timeline.era.remove": "Remove era",
  "timeline.era.range": "An era's end cannot come before its start.",
  "timeline.scale.save": "Save",
  "timeline.scale.cancel": "Cancel",

  // ---- cast tracks and track naming -----------------------------------
  "timeline.track.new.thread": "A thread",
  "timeline.track.new.cast": "A cast member",
  "timeline.track.default": "Track {n}",
  "timeline.track.rename": "Rename…",
  "timeline.track.relink": "Relink…",
  "timeline.track.delete": "Delete track",
  "timeline.track.gone": "(gone from the cast)",

  // ---- drag and the collapsed dots ------------------------------------
  "timeline.drag.at": "{at}",
  "timeline.drag.at-dated": "{at} ({date})",

  // ---- outline.ts ---------------------------------------------------------
  "outline.adoption-kept-order": "Added. Existing chapters stayed in place because moving them into the new part would change the reading order. You can move them manually.",
  "outline.trash-title": "Trash",
  "outline.bible-title": "Bible",
  // THE TWO SECTIONS, named for where their documents PRINT. The outline shows
  // them below the chapters, where every reserved root appends -- so the name is
  // what says a dedication comes first, and it has to say it plainly.
  "outline.front-matter-title": "Front matter",
  "outline.back-matter-title": "Back matter",
  "outline.reason.parent-missing": "its parent {parentId} is not in the outline",
  "outline.attempt": "{attempt} Your writing is untouched, and the outline below is what your book holds.",
  "outline.attempt.create": "That item could not be added.",
  "outline.attempt.rename": "That item could not be renamed.",
  "outline.attempt.set-state": "That item's revision state could not be set.",
  "outline.attempt.move": "That item could not be moved.",
  "outline.section.front": "front matter",
  "outline.section.body": "the chapter run",
  "outline.section.back": "back matter",
  "outline.section.outside": "outside the book",
  "outline.section-change.heading": "Change print section?",
  "outline.section-change.body.one": "Moving {title} changes the print section of {count} item. This item goes from {from} to {to}.",
  "outline.section-change.body.other": "Moving {title} changes the print section of {count} items. This item goes from {from} to {to}.",
  "outline.section-change.same.one": "Moving {title} changes the print section of {count} other item. This item stays in {from}.",
  "outline.section-change.same.other": "Moving {title} changes the print section of {count} other items. This item stays in {from}.",
  "outline.section-change.cancel": "Keep where it is",
  "outline.section-change.accept": "Move item",
  "outline.attempt.generic": "That change to the outline could not be made.",
  "outline.failed.command": "{attempt} ({command} failed: {error})",
  "outline.failed.reread": "The outline could not be re-read from your book, so what you see below may be out of date. (project_items failed: {error})",
  "outline.failed.read": "The outline could not be read from your book. (project_items failed: {error})",
  "outline.failed.malformed": "That item could not be moved: your book and this page disagree about the shape of the outline. ({id}: {reason})",
  "outline.failed.no-bin": "The deleted-items folder could not be created, so nothing was deleted.",
  "outline.failed.no-bible": "The bible section could not be created, so no document was added.",
  "outline.failed.no-matter": "That section could not be created, so no page was added.",
  "outline.gone.rename": "That item is no longer in your outline, so it could not be renamed. ({id})",
  "outline.gone.set-state": "That item is no longer in your outline, so its revision state could not be set. ({id})",
  "outline.gone.move": "That item is no longer in your outline, so it could not be moved. ({id})",
  "outline.gone.delete": "That item is no longer in your outline, so it could not be deleted. ({id})",
  "outline.gone.restore": "That item is no longer in your outline, so it could not be restored. ({id})",
  // ---- structural undo ------------------------------------------------------
  "outline.undo.label.create": "adding {title}",
  "outline.undo.label.move": "moving {title}",
  "outline.undo.label.rename": "renaming {title}",
  "outline.undo.label.state": "changing the revision state of {title}",
  "outline.undo.label.delete": "deleting {title}",
  "outline.undo.label.restore": "restoring {title}",
  "outline.undone": "Undone: {what}.",
  "outline.redone": "Redone: {what}.",
  "outline.undo.gone": "That change could not be undone: {title} is no longer in your outline. ({id})",
  "outline.undo.parent-gone": "That change could not be undone: the place {title} came from is no longer in your outline.",
  // ---- word-count.ts ------------------------------------------------------
  // THE MOST RIG-COUPLED STRINGS IN THE CATALOG. `words-cli` and `export-cli`
  // both parse the accessible name with
  //   /^Word count: ([\d,]+) words? in this scene, ([\d,]+|\u2026|\u2014) saved in the project(?:, .+)?$/
  // and `goals-cli` parses the trailing clause. The figures are still formatted
  // at the call site with `.toLocaleString()`, so the harness's LANG=C pinning
  // still decides the separators. Changing any of these six strings changes
  // what three graded rigs can see.
  "words.label.prefix": "Word count: ",
  "words.label": "{prefix}{scene}, {project}{progress}",
  "words.scene.one": "{count} word",
  "words.scene.other": "{count} words",
  "words.scene.spoken": "{display} in this scene",
  "words.project": "{figure} in the book",
  "words.project.spoken": "{figure} saved in the book",
  "words.progress.spoken": ", {progress}",

  // ---- goals.ts: the daily figure -----------------------------------------
  // The four target spellings are NOT here; see the note above `prefs.off`.
  "goals.today": "{count} typed today",
  "goals.today.target": "{count} of {target} typed today",
  "goals.spoken.cut.one": "{count} word cut",
  "goals.spoken.cut.other": "{count} words cut",
  "goals.spoken.written.one": "{count} word typed",
  "goals.spoken.written.other": "{count} words typed",
  "goals.spoken.today": "{count} today",
  "goals.spoken.today.target": "{count} today of a {target} word target",
  "goals.paused": "typing not counted",
  "goals.spoken.paused": "typed words are not being counted",

  // ---- recovery-indicator.ts: the second copy, and how old it is ----------
  // "on this device" is not decoration. A recovery point lives beside the
  // project it recovers, so it is exactly as lost as the project is when the
  // machine goes; the design forbids wording that implies otherwise.
  //
  // A RESTORE EXISTS NOW and only the startup sentence changed.
  // `recovery.text.none` was re-read and deliberately left alone: it states a
  // fact -- there is no recovery point on this device -- that is true and
  // complete whether or not a restore is possible, and mentioning restore in
  // the one state where there is nothing to restore would promise something.
  // The bar strings still say nothing about restoring, because the bar answers
  // "is there a second copy and how old is it" and the panel is where a writer
  // acts on the answer.
  "recovery.when.now": "just now",
  "recovery.when.minutes.one": "{count} minute ago",
  "recovery.when.minutes.other": "{count} minutes ago",
  "recovery.when.hours.one": "{count} hour ago",
  "recovery.when.hours.other": "{count} hours ago",
  "recovery.when.days.one": "{count} day ago",
  "recovery.when.days.other": "{count} days ago",
  "recovery.text.none": "No recovery point on this device",
  "recovery.text.protected": "Recovery point on this device {when}",
  "recovery.text.attempt-failed": "Backup failed {when} \u00b7 last verified {earlier}",
  "recovery.text.stale": "Backup stale: failed {when} \u00b7 last verified {earlier}",
  "recovery.name.none": "Recovery: no recovery point has been taken on this device yet.",
  "recovery.name.protected": "Recovery: a recovery point was taken on this device {when}. It does not protect against losing this computer.",
  "recovery.name.attempt-failed": "Recovery: the last backup attempt failed {when}. The most recent good recovery point on this device is still from {earlier}.",
  "recovery.name.stale": "Recovery is stale: the last backup attempt failed {when}. The most recent good recovery point on this device is still from {earlier}.",
  "recovery.notice.done": "Recovery point taken on this device.",
  "recovery.notice.failed": "Could not take a recovery point: {error}",
  "recovery.startup.point": "This book has a same-device recovery point from {when}. It sits beside the book file, so it is lost with the computer. Restoring it adds a NEW book and replaces nothing: open another book and use the recovery list in the book panel, or run `garret restore <point.point> <library-dir>` from a terminal.",
  "recovery.startup.none": "There is no same-device recovery point for this book.",

  // ---- switcher.ts: restoring from a recovery point ----------------------
  // A RESTORE NEVER REPLACES ANYTHING. It makes a new project beside the one
  // the writer already has, because guessing which of two real states of a book
  // is the live one silently discards the newer. The note says so where the
  // action is, not in a dialog the writer has to have read.
  //
  // "on this device" is load-bearing here too: these points sit beside the
  // project they came from and are lost with the computer.
  "switcher.recovery.heading": "Recovery points on this device",
  // Name the asset gap on older database-only points while describing the
  // complete folder required for new points.
  "switcher.recovery.note":
    "Restoring adds a new book. Nothing is replaced. New recovery point folders include referenced original pictures and research files. Older database-only points do not.",
  "switcher.recovery.list.label": "recovery points",
  "switcher.recovery.row": "From {when}",
  "switcher.recovery.row.partial": "From {when} (manuscript available; some originals incomplete)",
  "switcher.recovery.row.legacy": "From {when} (older database-only point)",
  "switcher.recovery.partial.warning": "This point has a sound manuscript, but some original pictures or research files could not be verified. Restoring it leaves their references in the book. Check the missing originals afterward.",
  "switcher.recovery.partial.confirm": "Restore with missing originals",
  "switcher.recovery.empty": "No recovery point has been taken on this device yet.",
  "switcher.recovery.error": "The recovery points could not be read.",
  "switcher.recovery.done": "Restored as a new book: {name}",
  "switcher.recovery.done.partial": "Restored as a new book: {name}. Some picture or research originals may be missing or unverified; their references remain in the book.",
  "switcher.recovery.done.legacy": "Restored as a new book: {name}. This older point did not include original pictures, covers, or research files.",
  "switcher.legacy.notice": "Older recovery or readable folders could not be linked to this book. Open the book panel to inspect their locations.",
  "switcher.legacy.recovery.heading": "Older recovery folder to inspect",
  "switcher.legacy.recovery.note": "This preserved folder may belong to an older copy. Copy a .db file from it before opening that copy as a separate book for inspection.",
  "switcher.legacy.mirror.heading": "Older readable folder to inspect",
  "switcher.legacy.mirror.note": "Preserve and inspect these older readable files. This book's new folder does not overwrite them.",

  // ---- archive-indicator.ts + switcher.ts: the copy that can leave --------
  // ITS OWN NAMESPACE, and that is a decision rather than tidiness. The design
  // mandates telling the writer to move the archive off this computer in those
  // words, and `recovery-indicator.test.ts`'s blur guard forbids "off this
  // computer" in every `recovery.*` key -- correctly, because that guard is
  // what stops the same-device surface implying this one. Splitting the
  // namespace keeps both guards at full strength instead of weakening either.
  //
  // NOTHING HERE MAY SAY "on this device", which is the recovery surface's
  // phrase, and nothing here may put the archive's departure in the past tense.
  // The application cannot see whether it left, has no dialog through
  // which to arrange it, and the failure this feature exists to prevent is a
  // writer believing they are protected when they are not.
  "archive.text.none": "No ordinary local archive made",
  "archive.text.taken": "Ordinary local archive made {when}",
  "archive.name.none":
    "Device loss: no ordinary local archive has been made yet. Encrypted archive files are separate. Move a complete archive folder off this computer yourself.",
  "archive.name.taken":
    "Device loss: an ordinary local archive was made {when}. Move a complete folder off this computer yourself; older .db archives omit pictures. Encrypted archive files are separate.",
  "archive.notice.done": "Archive written: {file}",
  "archive.notice.failed": "Could not write an archive: {error}",
  "mirror.error.closed": "No open book is available for the readable folder.",
  "mirror.error.unsaved": "Current edits could not be saved. The readable folder was not enabled.",
  "mirror.error.changed": "The open book changed while preparing the readable folder. Try again.",
  "archive.error.closed": "No open book is available for archiving.",
  "archive.error.unsaved": "Current edits could not be saved, so no archive was made.",
  "archive.error.changed": "The open book changed while preparing the archive. Try again.",

  "switcher.archive.heading": "If you lose this computer",
  // The instruction to move the whole folder appears where the action is. Not in a dialog
  // the writer has to have read, and not in the past tense: the application has
  // done its half and cannot do the other half.
  "switcher.archive.note":
    "A new archive is one complete, unencrypted folder. Anyone with access to it can read your book. To protect against losing this computer, move the whole folder off this computer yourself: onto a USB stick, another machine, or a sync folder. Older .db archives did not include pictures.",
  "switcher.archive.where": "Archives are written to {dir}",
  "switcher.archive.action": "Make unencrypted archive",
  "switcher.archive.working": "Writing an archive…",
  "switcher.archive.list.label": "archives",
  "switcher.archive.row": "{file} · from {when}",
  "switcher.archive.empty": "No archive has been made yet.",
  "switcher.archive.error": "The archives could not be read.",
  "switcher.archive.destination.choose": "Choose backup folder",
  "switcher.archive.destination.none": "No backup folder chosen. You can choose where to save each encrypted archive.",
  "switcher.archive.destination.where": "Backup folder: {dir}",
  "switcher.archive.destination.loading": "Reading backup folder…",
  "switcher.archive.destination.error": "The backup folder could not be read.",
  "switcher.archive.destination.note": "garret remembers this folder for encrypted archives. Make a new archive regularly; backups are not automatic.",
  "switcher.archive.encrypted.heading": "Encrypted backups",
  "switcher.archive.encrypted.note": "Keep a protected copy of your whole book somewhere else. Create a recovery key first and keep a spare copy separately; without it, you cannot open your backups. Then make an encrypted archive. Choose a Google Drive or Dropbox folder, or a USB drive, and check that the copy reaches it. Keep your working book outside cloud folders. Only the archive is encrypted; your working book and ordinary recovery copies are not.",
  "switcher.archive.key.action": "Create recovery key",
  "switcher.archive.key.done": "Recovery key created. Keep a spare copy separate from your backups.",
  "switcher.archive.encrypted.action": "Make encrypted archive",
  "switcher.archive.encrypted.done": "Encrypted archive saved: {file}. Check that you have a copy beyond this computer.",
  "switcher.archive.encrypted.verify": "Verify encrypted archive",
  "switcher.archive.encrypted.verified": "Encrypted archive verified: {file}",
  "switcher.archive.encrypted.restore": "Restore encrypted archive",
  "switcher.archive.encrypted.restored": "Encrypted archive restored as a new book: {name}",
  "switcher.archive.encrypted.failed": "Encrypted archive action failed: {error}",

  // ---- mirror ------------------------------------------------------------
  // A THIRD THING, and it is neither of the two above it. The recovery section
  // is a second copy on this device; the archive section is a file to carry
  // away. This is the writer's own manuscript in ordinary Markdown, kept
  // current, so they can open one scene in any editor. It protects nothing and
  // must never say it does.
  "switcher.mirror.heading": "A readable copy you can open anywhere",
  "switcher.mirror.note":
    "The mirror keeps your manuscript as ordinary Markdown files, one per scene, within ten seconds of what you have typed. It is a copy to read and edit elsewhere, not a backup: it is on this computer, and this application writes it rather than reading it back.",
  "switcher.mirror.where": "The mirror is written to {dir}",
  "switcher.mirror.off": "The mirror is off for this book.",
  "switcher.mirror.on.one": "{count} file, last written {when}.",
  "switcher.mirror.on.other": "{count} files, last written {when}.",
  "switcher.mirror.pending": "The mirror is on. Nothing has been written yet.",
  "switcher.mirror.enable": "Turn the mirror on",
  "switcher.mirror.disable": "Turn the mirror off",
  "switcher.mirror.working": "Writing the mirror…",
  "switcher.mirror.check": "Check the mirror thoroughly",
  "switcher.mirror.checking": "Checking the mirror thoroughly…",
  "switcher.mirror.error": "The mirror could not be read.",
  "switcher.mirror.previewing": "Checking what the mirror will expose…",
  "switcher.mirror.preview.heading": "Before turning on the readable folder",
  "switcher.mirror.preview.plaintext": "This writes ordinary plaintext files on this computer. If the destination syncs, the sync service may copy them. The application cannot inspect operating-system or sync-service history.",
  "switcher.mirror.preview.destination": "Resolved destination: {dir}",
  "switcher.mirror.preview.checked": "The preview examined {files} projected Markdown files and the wordlist.",
  "switcher.mirror.preview.pin.unset": "No pen name is pinned to this book. Every known name was checked, but a match cannot be classified as another identity.",
  "switcher.mirror.preview.pin.pinned": "This book has a pinned pen name. Names and aliases of the other known identities were checked.",
  "switcher.mirror.preview.pin.stale": "This book's pinned pen name is older than the private list. The pin was not changed by this preview.",
  "switcher.mirror.preview.scope.destination": "Resolved destination path",
  "switcher.mirror.preview.scope.project_name": "Book name and mirror manifest",
  "switcher.mirror.preview.scope.markdown": "Rendered file names, headings and prose",
  "switcher.mirror.preview.scope.wordlist": "Book wordlist",
  "switcher.mirror.preview.state.ran": "Known other-identity names and aliases were checked. Review the findings below before enabling.",
  "switcher.mirror.preview.state.clear": "No known other-identity names or aliases were found in the checked files. This cannot rule out names missing from the private list.",
  "switcher.mirror.preview.state.vacuous": "There was no emitted text to compare. This is not a clean identity check.",
  "switcher.mirror.preview.state.not_applicable": "No known names or aliases were available to compare. This is not a clean identity check.",
  "switcher.mirror.preview.finding": "{match} in {where}",
  "switcher.mirror.preview.limit.known_names": "The scan can only find names and aliases recorded in the private pen-name list.",
  "switcher.mirror.preview.limit.excluded": "Synopses, notes, history and original images are not written to this folder.",
  "switcher.mirror.preview.limit.external": "Operating-system and sync-service history cannot be checked here.",
  "switcher.mirror.preview.confirm": "Write this plaintext folder",
  "switcher.mirror.preview.cancel": "Cancel; write nothing",
  "mirror.notice.enabled": "The mirror is on. Your manuscript is in {dir}",
  // Says what it did NOT do. Deleting a folder of the writer's prose because a
  // preference was switched off is not a thing this application gets to do,
  // and a writer who expects the files gone would otherwise not know.
  "mirror.notice.disabled": "The mirror is off. The files already written are still in {dir}",
  "mirror.notice.failed": "Could not write the mirror: {error}",
  "mirror.notice.checked": "Checked {entries} mirror files. Changed: {changed}. Missing: {deleted}.",
  "mirror.notice.check-failed": "Could not check the mirror thoroughly.",

  // ---- mirror-indicator.ts ------------------------------------------------
  // The bar's third statement, and the one that is NOT a protection. Every
  // string here describes a folder of ordinary files that this application
  // writes and does not read back; `mirror-strings.test.ts` forbids the
  // protection vocabulary the two indicators beside it own.
  //
  // `text` is what fits in a 39px bar; `name` is what a screen reader gets,
  // and it is longer because a name has no bar around it to give it context.
  // The three stale readings share a shape and NAME THE REASON, which the
  // design requires of them: "last updated {time}" alone would tell a writer
  // their folder is behind and leave them unable to tell an edit of their own
  // waiting for review from a mirror that cannot write at all.
  // Substituted for {when} when nothing has ever been written. "last updated
  // never" is clumsy and it is also exactly true; the alternative is a state
  // that reports a time no pass ever produced.
  "mirror.when.never": "never",
  "mirror.text.current": "Folder current",
  "mirror.text.updating": "Folder updating\u2026",
  "mirror.text.paused": "Folder paused, last updated {when}",
  "mirror.text.failing": "Folder failing, last updated {when}",
  "mirror.text.stale": "Folder off, last updated {when}",
  // CURRENT FIRST, because it is. A finding is an aside on a folder that is
  // exactly up to date, and the location it names does not fit on this line --
  // the accessible name carries it, and the panel has room to say it properly.
  "mirror.text.finding": "Folder current, one to check",
  "mirror.text.unavailable": "Folder current, identity check unavailable",
  "mirror.text.not_applicable": "Folder current, no comparison names configured",
  "mirror.text.off": "Readable folder off",
  "mirror.name.current": "The readable folder matches what you have typed",
  "mirror.name.updating": "The readable folder is being written",
  // NAMES THE COUNT and names what stopped. A writer who edited a scene in
  // another editor has to be able to tell this apart from a mirror that broke.
  "mirror.name.paused.one":
    "The readable folder was last updated {when}. 1 file you changed elsewhere is waiting for you, and this application is not writing over it.",
  "mirror.name.paused.other":
    "The readable folder was last updated {when}. {count} files you changed elsewhere are waiting for you, and this application is not writing over it.",
  // NAMES THE CAUSE, which the design requires of this state.
  "mirror.name.failing":
    "The readable folder was last updated {when}. The last attempt to write it did not finish: {error}",
  "mirror.name.stale": "The readable folder was last updated {when}",
  // CURRENT, and the finding is an aside. The folder is exactly up to date;
  // saying anything else here would claim staleness that does not exist.
  "mirror.name.finding":
    "The readable folder matches what you have typed. One file is worth a look: {where}",
  "mirror.name.unavailable": "The readable folder matches what you have typed, but its identity check is unavailable. Inspect the folder before sharing or syncing it.",
  "mirror.name.not_applicable": "The readable folder matches what you have typed. No known pen names or aliases were available for comparison, so identity exposure was not checked.",
  "mirror.name.off": "No readable folder is being written for this book",

  // ---- mirror-changes.ts --------------------------------------------------
  // THE DIRECTION IS SAID FOUR TIMES -- row summary, row accessible name, diff
  // region accessible name, legend -- and the design records that as deliberate
  // rather than as redundancy: a diff whose direction a reader has to guess is
  // a diff half its readers will read backwards, and being confidently
  // backwards about which side holds a paragraph is how someone would accept
  // the wrong one.
  //
  // NOTHING HERE MAY PROMISE THAT A CHANGE CAN BE APPLIED. This build shows
  // what a file now holds; taking it into the book is a later slice and does
  // not exist. `mirror-strings.test.ts` is what keeps that true one string at
  // a time.
  "mirror.changes.heading": "Changes in your folder",
  // THIS SENTENCE WAS FALSE FROM THE START, and a capture is what said
  // so: it read "Looking here changes nothing in your book" beside a control
  // that changes the book. Looking still changes nothing; the panel is no
  // longer only for looking, so the sentence says both halves and names where
  // the way back is.
  "mirror.changes.note":
    "What each file now holds, and how it differs from your book. Looking changes nothing. Taking a file's words replaces that scene in your book, and what it replaced is kept in the history panel.",
  "mirror.changes.empty": "Nothing in your folder differs from your book.",
  "mirror.changes.error": "Could not read the folder: {error}",
  "mirror.changes.status.one": "1 file differs from your book",
  "mirror.changes.status.other": "{count} files differ from your book",
  "mirror.changes.state.prose": "The words changed",
  // NAMES BOTH SIDES. A writer who typed in the application and also edited the
  // file has two versions of the same scene and neither is stale; a state that
  // said only "changed" would leave them guessing which one they are looking
  // at.
  "mirror.changes.state.conflict": "The words changed here and in your book",
  "mirror.changes.state.front-matter": "The file's header changed",
  "mirror.changes.state.title": "The heading changed",
  "mirror.changes.state.added": "Your book has nothing for this file",
  "mirror.changes.state.moved": "Moved here from {from}",
  "mirror.changes.state.deleted": "The file is gone",
  "mirror.changes.state.unreadable": "This file could not be read: {error}",
  "mirror.changes.direction": "Your book, against what is in the file",
  "mirror.changes.title.was": "In your book it is called {book}; in the file it is called {file}.",
  "mirror.changes.row.name":
    "{title}. {state}. Comparing what is in your book with what is in the file.",
  "mirror.changes.compare": "Compare",
  // ITS OWN SUMMARY SENTENCE, and not `history.diff.*`. Those strings all end
  // in "since this version", which is false here: the two sides are a book and
  // a file, neither of which is a version of the other. The RULE is shared --
  // count words, say the singular, and say "no difference" in words rather than
  // painting an empty box -- and only the wording differs.
  "mirror.changes.diff.none": "No difference: your book and this file hold the same words.",
  "mirror.changes.diff.added.one": "{count} word only in the file",
  "mirror.changes.diff.added.other": "{count} words only in the file",
  "mirror.changes.diff.removed.one": "{count} word only in your book",
  "mirror.changes.diff.removed.other": "{count} words only in your book",
  "mirror.changes.diff.summary": "{parts}.",
  "mirror.changes.legend":
    "Struck through is what your book has; underlined is what the file has.",
  "mirror.changes.diff.region":
    "Comparison of {title}: what your book has, against what the file has.",
  // THE JOINER IS A CATALOG STRING, not a space in the source. Two sentences
  // put together with a hardcoded separator is a composed sentence whose
  // composition no translator can reach -- and the build guard that forbids
  // user-facing literals outside this file caught it, correctly, on the first
  // run.
  "mirror.changes.diff.region.full": "{intro} {summary}",

  // ---- taking a change into the book --------------------------------
  // THE VERBS ARE THE WRITER'S, not the version-control ones. Nothing here is
  // merged, synced or pulled: one whole document replaces another whole
  // document, which is the only operation this design has and the reason it
  // needs no merge algorithm. `mirror-strings.test.ts` forbids the other
  // vocabulary one word at a time.
  "mirror.changes.accept": "Take these words",
  "mirror.changes.accept.name": "Take the words in the file into {title}",
  "mirror.changes.accept.all.one": "Take the words from 1 file",
  "mirror.changes.accept.all.other": "Take the words from {count} files",
  "mirror.changes.accept.error": "Could not take the words in: {error}",
  "mirror.changes.accept.error.unsaved": "Your latest changes could not be saved. The words were not taken in.",
  "mirror.changes.accept.reconcile.error": "The words were taken in, but the open scene could not be refreshed: {error}",
  "mirror.changes.undo": "Undo taking these words",
  "mirror.changes.undo.name": "Undo taking the words into {title}",
  "mirror.changes.undo.note": "Undo restores the words in {title}. Orphaned comments stay orphaned.",
  "mirror.changes.undo.error": "Could not undo taking the words in: {error}",
  "mirror.changes.undo.error.destroyed": "This book is no longer open.",
  "mirror.changes.undo.error.busy": "Another undo is still running.",
  "mirror.changes.undo.error.opening": "A document is still opening.",
  "mirror.changes.undo.error.unsaved": "Your latest changes could not be saved. Undo is unavailable.",
  // SAID BEFORE THE PRESS AND AGAIN AFTER IT. The folder is Markdown and
  // Markdown has no underline, so the file never carried one and taking it
  // cannot bring one back (decisions/2026-08-27-underline.md). A writer told
  // this afterwards has been apologised to, not informed.
  "mirror.changes.loss.underline.one":
    "1 underlined run in your book is not in this file, and taking the file will lose it.",
  "mirror.changes.loss.underline.other":
    "{count} underlined runs in your book are not in this file, and taking the file will lose them.",
  "mirror.changes.accepted.one":
    "1 file taken in. Your book before this is in the history panel, under {label}",
  "mirror.changes.accepted.other":
    "{count} files taken in. Your book before this is in the history panel, under {label}",
  "mirror.changes.accepted.underline.one":
    "1 underlined run was in the words this replaced and is not in the file.",
  "mirror.changes.accepted.underline.other":
    "{count} underlined runs were in the words this replaced and are not in the file.",

  // ---- save-indicator.ts --------------------------------------------------
  "save.text.saved": "Saved",
  "save.text.pending": "Saving\u2026",
  "save.text.failed": "Not saved",
  "save.name.saved": "All changes saved",
  "save.name.pending": "Saving changes",
  "save.name.failed": "Changes not saved",

  // ---- status-dot.ts ------------------------------------------------------
  // ONE DOT FOR THREE SENTENCES. The sentences keep their three vocabularies
  // (mirror-strings, archive-strings and the recovery blur guard police them);
  // the dot's own two names say nothing about any of the three files. NOT
  // "protection": the mirror is a copy to read and edit elsewhere, not a
  // backup, and its guard forbids the word. "Copy" is what all three are.
  "status.name.quiet": "Copies: all three are current",
  "status.name.neutral": "Copies: not all of them are set up",
  "status.name.amber": "Copies: something needs attention",
  "status.label.amber": "Copies need attention",
  "status.action.mirror-setup": "Set up a readable folder\u2026",
  "status.popover.label": "Copies",

  // ---- navigator/index.ts, loading.ts, project.ts, project-switch.ts ------
  "nav.label": "manuscript navigator",
  // The header's cast button, the same word the Outline menu's
  // `menu-cast` item and the cast panel itself use.
  "nav.cast.label": "Cast",
  "nav.synopsis.described": "Has a synopsis",
  "nav.appearances.described": "Has tagged people, places, or things",
  "nav.history.no-back": "Nothing earlier to go back to.",
  "nav.history.no-forward": "Nothing further forward.",
  "loading.opening": "Opening the book…",
  "banner.dismiss": "dismiss this message",
  "banner.details": "Details",
  "project.error.persist": "Not saved: {message} Automatic saving has stopped. Your latest changes are only in this window.",
  "project.error.open-document": "Could not open that document: {error}",
  // A body written by a NEWER build of the application: it carries a mark or a
  // node this schema has no type for. Named rather than described in
  // ProseMirror's words, and it says what the writer can do about it.
  "project.error.unreadable-body":
    "{item} was written by a different build of the application and could not be opened. Your work is still in the file.",
  "project.error.import": "Could not import that file: {error}",
  "project.error.quit": "Could not close the application: {error}",
  // The empty workspace: what the page shows with no book open.
  "library.no-book": "No book is open",
  "library.open-prompt": "Open the library to choose a book.",
  "library.open": "Open the library",
  // Every menuActions arm in empty-project.ts raises this one notice.
  "library.nothing-open": "No book is open. Open one from the library.",
  // The library screen itself.
  "library.series": "Series",
  "library.universe": "Universe",
  "library.series.filter": "Filter by series",
  "library.universe.filter": "Filter by universe",
  "library.series.all": "All series",
  "library.universe.all": "All universes",
  "library.series.name": "Series name",
  "library.universe.name": "Universe name",
  "library.group-conflict-separator": " / ",
  "library.group-disambiguated": "{name} ({id})",
  "library.membership.open": "Series and universe…",
  "library.membership.title": "This book’s series and universe",
  "library.membership.scope": "Only this book’s membership changes when you save.",
  "library.membership.none": "None",
  "library.membership.new": "Create a new group",
  "library.membership.save": "Save membership",
  "library.membership.cancel": "Cancel",
  "library.membership.saved": "Membership saved.",
  "library.membership.changed": "The open book changed. Reopen membership to edit it.",
  "library.membership.discard-question": "Discard the unsaved membership changes?",
  "library.membership.discard": "Discard changes",
  "library.membership.keep": "Keep editing",
  "library.summary.open": "Show library summary",
  "library.summary.close": "Hide library summary",
  "library.summary.title": "Saved library summary",
  "library.summary.definition": "Words and documents as saved in the books shown. Recorded changes cover only what was recorded, not everything you ever wrote. Filters combine, and books that cannot be read or are not shown are left out.",
  "library.summary.counts": "{books} with {documents} and {words}.",
  "library.summary.books.one": "{count} book",
  "library.summary.books.other": "{count} books",
  "library.summary.documents.one": "{count} document",
  "library.summary.documents.other": "{count} documents",
  "library.summary.words.one": "{count} saved word",
  "library.summary.words.other": "{count} saved words",
  "library.summary.activity-unavailable": "Recorded activity unavailable for this selection.",
  "library.summary.activity": "Recorded changes, from {counted} of {total} books: {values}",
  "library.summary.activity-none": "no changes",
  "library.summary.source.typing": "typing +{added}/−{deleted}",
  "library.summary.source.pasted": "pasted +{added}/−{deleted}",
  "library.summary.source.imported": "imported +{added}/−{deleted}",
  "library.summary.source.restored": "restored +{added}/−{deleted}",
  "library.summary.source.unattributed": "unattributed +{added}/−{deleted}",
  "library.summary.left.failed.one": "{count} book could not be read.",
  "library.summary.left.failed.other": "{count} books could not be read.",
  "library.summary.left.missing.one": "{count} missing book may belong here and is not counted.",
  "library.summary.left.missing.other": "{count} missing books may belong here and are not counted.",
  "library.summary.left.copies.one": "{count} book has copies; choose one above to count it.",
  "library.summary.left.copies.other": "{count} books have copies; choose one of each above to count them.",
  "library.summary.left.membership.one": "The series or universe of {count} book could not be read.",
  "library.summary.left.membership.other": "The series or universe of {count} books could not be read.",
  "library.summary.left.unreadable.one": "{count} document could not be read.",
  "library.summary.left.unreadable.other": "{count} documents could not be read.",
  "library.summary.left.interrupted.one": "Recording was interrupted in {count} book.",
  "library.summary.left.interrupted.other": "Recording was interrupted in {count} books.",
  "library.summary.left.omitted.one": "{count} book beyond the list is not counted.",
  "library.summary.left.omitted.other": "{count} books beyond the list are not counted.",
  "library.summary.not-read": "Not read yet.",
  "library.summary.read": "Last read {time}.",
  "library.summary.duplicate": "These are copies of one book ({id}). Choose the one to count:",
  "library.summary.exclude-copies": "Exclude all copies",
  "library.summary.copy": "{name} ({path}); series: {series}; universe: {universe}",
  "library.title": "Library",
  "library.writing-as": "Writing as",
  "library.all": "All",
  "library.yours": "Your library",
  "library.new-pen-name": "New pen name…",
  "library.pen-name.name": "Name",
  "library.pen-name.sort-name": "Sort name",
  "library.pen-name.bio": "Bio",
  "library.pen-name.save": "Save",
  "library.pen-name.cancel": "Cancel",
  "library.vault-error": "The identity vault could not be read: {error}",
  "library.desk": "On the desk",
  "library.shelf": "On the shelf",
  "library.continue": "Continue writing",
  "library.by": "by {name}",
  "library.no-pen-name": "no pen name",
  "library.opened": "last opened {when}",
  "library.never-opened": "never opened",
  "library.words.one": "{count} word",
  "library.words.other": "{count} words",
  "library.new-book": "New book",
  "library.new-book.name": "Book name",
  "library.new-book.create": "Create",
  "library.empty": "No books yet.",
  "library.import": "Import a manuscript…",
  "library.restore": "Restore an encrypted backup…",
  "library.more.one": "{count} more book is not shown. Use {menu}",
  "library.more.other": "{count} more books are not shown. Use {menu}",
  "library.close": "Close",
  "library.when.now": "just now",
  "library.when.minutes.one": "{count} minute ago",
  "library.when.minutes.other": "{count} minutes ago",
  "library.when.hours.one": "{count} hour ago",
  "library.when.hours.other": "{count} hours ago",
  "library.when.days.one": "{count} day ago",
  "library.when.days.other": "{count} days ago",
  "library.error.overview": "The library could not be read: {error}",
  "library.book.missing": "This book could not be found. Check that its drive or folder is available.",
  "library.book.unreadable": "This book could not be read. Check access to its file, or restore a backup as a separate book.",
  "library.error.words": "That book's word count could not be read.",
  "library.error.create": "Could not create {name}: {error}",
  "library.error.pin": "Could not pin that pen name to the new book: {error}",
  "library.meta-separator": " · ",
  "library.timing.overview": "Overview {ms} ms",
  "library.timing.words": "Words {ms} ms",
  "library.created-unopened": "{name} was created but could not be opened. It is available in the Library.",
  "library.busy.opening": "Opening book…",
  "library.busy.creating": "Creating book…",
  "library.done.book-created": "{name} created.",
  "help.library": "Open the library",
  "switch.error.closed-unnamed": "Could not open the selected book: {error}. Nothing is open. Choose a book to continue.",
  "switch.error.kept-unnamed": "Could not open the selected book: {error}. The book you were in is still open.",
  "switch.error.closed": "Could not open {name}: {error}. Nothing is open. Choose a book to continue.",
  "switch.error.kept": "Could not switch to {name}: {error}. The book you were in is still open.",

  // ---- main.ts: the surface a writer sees when nothing else could be built -
  "startup.failed.title": "This book could not be opened",
  "startup.failed.advice": "Your work is not lost: the book file itself is untouched. Close this window and open a different book. To look at this one without opening it, run the application from a terminal: `garret validate <project.db>`, or `salvage <project.db> <out-dir>` to write out what can be recovered.",

  // ---- close-prompt.ts: the blocking prompt at close with a failed autosave
  "close-prompt.heading": "Unsaved work",
  "close-prompt.body.one": "{count} document has not been saved. Closing now will discard it.",
  "close-prompt.body.other": "{count} documents have not been saved. Closing now will discard them.",
  "close-prompt.stay": "Keep editing",
  "close-prompt.discard": "Close and discard the unsaved work",
} as const satisfies Readonly<Record<string, string>>;
