//! The readable manuscript mirror: the write path.
//!
//! One direction only, store -> files. Nothing here reads a mirror file back;
//! detection, the change set and acceptance are handled elsewhere, and every
//! string in this module is written under that constraint.

use crate::store::history::hash64;

/// The bidi controls the design names, removed rather than escaped.
///
/// A right-to-left override inside a filename makes the name render as
/// something other than what it is. In a directory of the writer's own
/// manuscript that is both a legibility failure and the one filename trick
/// worth pre-empting -- and this repo has already laid RTL prose out wrongly
/// once, in a way no gate could see.
fn is_bidi_control(ch: char) -> bool {
    matches!(ch, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// The mirror's name rule for ONE path segment.
///
/// NOT `projects::slugify`, and the two must never be merged. That one names a
/// directory the application owns and may reduce a title to ASCII; this one
/// names a file the WRITER reads, and the design forbids transliteration in as
/// many words -- the `tiny` fixture's titles are Hebrew and Arabic, and
/// `projects::slugify` does not transliterate them, it returns `None`, which
/// would render an entire manuscript as `0000-.md`, `0001-.md`, `0002-.md`.
///
/// An empty result is legal. `0000-.md` is ugly and honest; inventing
/// "Untitled" would put a word in the file that the manuscript does not
/// contain.
pub fn segment(title: &str) -> String {
    let mut out = String::new();
    let mut pending_gap = false;
    for ch in title.chars() {
        // WHITESPACE IS CLASSIFIED FIRST, and the order is load-bearing:
        // tab, newline and carriage return are `Cc` controls AND whitespace. A
        // removal that ran first would eat the gap, so a title carrying a tab
        // between two words would mirror as one word.
        if ch.is_whitespace() {
            // A RUN, not each character: the gap is remembered and spent only
            // when something follows it, so leading and trailing whitespace
            // leave no hyphen at either end.
            pending_gap = !out.is_empty();
            continue;
        }
        if is_removed(ch) {
            continue;
        }
        if std::mem::take(&mut pending_gap) {
            out.push('-');
        }
        out.push(ch);
    }
    truncate_on_boundary(&mut out, SEGMENT_MAX);
    // The cap can land immediately after a gap hyphen, which would leave a name
    // ending in `-`. `projects::slugify` trims twice for the same reason.
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// 64 UTF-8 BYTES, matching `projects::SLUG_MAX` and for its stated reason:
/// room for a suffix inside every filesystem's name limit.
const SEGMENT_MAX: usize = 64;

/// Truncate to at most `max` BYTES, never inside a character.
///
/// `String::truncate` panics on a non-boundary index, and `projects.rs:366`
/// calls it directly -- which is correct there only because that function's
/// output is ASCII by construction. This one's input is the writer's own
/// script, so the boundary walk is the whole difference.
fn truncate_on_boundary(out: &mut String, max: usize) {
    if out.len() <= max {
        return;
    }
    let cut = out
        .char_indices()
        .map(|(i, ch)| i + ch.len_utf8())
        .take_while(|end| *end <= max)
        .last()
        .unwrap_or(0);
    out.truncate(cut);
}

/// What never reaches a filename.
///
/// **This is a documented SUBSET of Unicode category C, not the whole of it**,
/// and the gap is deliberate. The design asks for "Unicode `C`-category
/// characters and the bidi controls"; the whole category also spans `Co`
/// (private use) and `Cn` (unassigned), which need a Unicode table this
/// codebase does not carry and neither of which is the risk the design names.
/// A private-use character in a title is the writer's own glyph and removing it
/// would be this function deciding their book is wrong.
///
/// What IS removed is everything that makes a filename render as something
/// other than what it is: `Cc` controls, the bidi overrides and isolates, the
/// zero-width and invisible formatters, the byte-order mark, and the tag block.
fn is_removed(ch: char) -> bool {
    ch == '/'
        || ch == '\0'
        || ch.is_control()
        || is_bidi_control(ch)
        || matches!(ch,
            '\u{00AD}'                 // soft hyphen: invisible, splits a name
            | '\u{061C}'                // Arabic letter mark
            | '\u{180E}'                // Mongolian vowel separator
            | '\u{200B}'..='\u{200F}'   // zero-width set and the LTR/RTL marks
            | '\u{2060}'..='\u{2064}'   // word joiner and the invisible operators
            | '\u{FEFF}'                // byte-order mark
            | '\u{FFF9}'..='\u{FFFB}'   // interlinear annotation
            | '\u{E0000}'..='\u{E007F}' // the tag block
        )
}

/// What the page is told about the mirror.
///
/// NEVER AN ERROR, for `recovery_status`'s reason: the panel that offers a
/// writer a readable copy of their book must not itself be able to fail to
/// render. A directory that is not there, a manifest that will not parse and a
/// project that has never been mirrored are all the same answer.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
pub struct MirrorReport {
    /// Whether the writer turned it on for this project. OFF is not an error
    /// state and not a failure; it is the default.
    pub enabled: bool,
    /// The RESOLVED destination, after any override. Showing this is the point:
    /// it is what catches a mirror landing in a synced or cloud folder, which
    /// is the one place two pen names' manuscripts end up side by side.
    pub dir: String,
    pub files: u64,
    /// When the last pass finished, or None if none ever has. Read from the
    /// MANIFEST -- the artifact on disk -- and deliberately not the same figure
    /// as `last_run_ms`. They disagree after a pass that failed before writing,
    /// and `recovery-indicator.ts`' header records why a surface that collapses
    /// two such times reports silent staleness.
    pub generated_at: Option<i64>,
    /// Whether the last ATTEMPT succeeded. True when none has run: `never run`
    /// is the `off` state, not `failing`.
    pub last_ok: bool,
    /// The cause, for the `failing` state, which the design requires to name it.
    pub last_error: Option<String>,
    /// When the last attempt ran, successful or not.
    pub last_run_ms: Option<i64>,
    /// How many entries have a pending inbound change, so the line can say
    /// `paused` and say how many. Counted against the MANIFEST: an id the
    /// manifest never wrote is one this mirror cannot show the writer a file
    /// for, and reporting it would be a pause with nothing behind it.
    pub paused: u64,
    /// Whether a pass is owed. The design's `updating` state, and the page has
    /// no other way to know it -- the dirty flag lives here.
    pub updating: bool,
    /// Where the last pass exposed a known other-identity name, if checked.
    /// A finding is neither a pause nor a failed mirror write.
    pub finding: Option<String>,
    /// `clear`, `finding`, `not_applicable`, or `unavailable`. Old mirrors without a matching
    /// persisted check are unavailable rather than silently clear.
    pub identity_check: String,
}

/// Describe the mirror directory. Read-only, and never an error.
#[cfg(test)]
pub fn describe(
    dir: &std::path::Path,
    enabled: bool,
    outcome: &PassOutcome,
    paused: &std::collections::HashSet<String>,
    updating: bool,
) -> MirrorReport {
    describe_checked(dir, enabled, outcome, paused, updating, None)
}

pub fn describe_checked(
    dir: &std::path::Path,
    enabled: bool,
    outcome: &PassOutcome,
    paused: &std::collections::HashSet<String>,
    updating: bool,
    content_digest: Option<[u8; 32]>,
) -> MirrorReport {
    describe_with_checked(dir, enabled, outcome, paused, updating, None, content_digest)
}

/// `describe`, plus an explicit finding supplied by its caller.
///
/// A finding rides on a mirror that is CURRENT. It does not pause the entry,
/// does not fail the pass and does not skip anything -- `paused` and `last_ok`
/// are computed here exactly as they are without it, and the tests assert that
/// rather than trusting it. Reporting a finding through either of those would
/// tell the writer their folder had stopped keeping up at the moment it is
/// exactly up to date, which is the falsehood the whole indicator is built to
/// avoid.
#[cfg(test)]
pub fn describe_with(
    dir: &std::path::Path,
    enabled: bool,
    outcome: &PassOutcome,
    paused: &std::collections::HashSet<String>,
    updating: bool,
    finding: Option<&str>,
) -> MirrorReport {
    describe_with_checked(dir, enabled, outcome, paused, updating, finding, None)
}

fn describe_with_checked(
    dir: &std::path::Path,
    enabled: bool,
    outcome: &PassOutcome,
    paused: &std::collections::HashSet<String>,
    updating: bool,
    finding: Option<&str>,
    content_digest: Option<[u8; 32]>,
) -> MirrorReport {
    let manifest: Option<crate::recovery::Manifest<MirrorEntry>> =
        crate::recovery::read_manifest(dir);
    let generated_at = manifest.as_ref().map(|m| m.generated_at);
    let (identity_check, persisted_finding) =
        crate::mirror_identity::reported(dir, manifest.as_ref(), content_digest);
    MirrorReport {
        enabled,
        dir: dir.display().to_string(),
        files: manifest
            .as_ref()
            .map(|m| m.entries.len() as u64)
            .unwrap_or(0),
        generated_at,
        last_ok: outcome.last_ok,
        last_error: outcome.last_error.clone(),
        last_run_ms: outcome.last_run_ms,
        paused: manifest
            .as_ref()
            .map(|m| {
                m.entries
                    .iter()
                    .filter(|e| paused.contains(e.id.as_str()))
                    .count() as u64
            })
            .unwrap_or(0),
        updating,
        finding: finding.map(str::to_string).or(persisted_finding),
        identity_check: if finding.is_some() { "finding" } else { identity_check }.to_string(),
    }
}

/// The staleness bound: 10 seconds of application-open time.
///
/// A PRODUCT DECISION INSIDE A MEASURED ENVELOPE, which is the right kind of
/// number here. No rig can produce how long a writer takes to alt-tab and start
/// reading. What measurement does is bound it on both sides: below, the store's
/// 1 s flush ceiling -- ten times that, so a mirror pass can never be mistaken
/// for part of a save, and a bound near the flush interval would make the
/// mirror look like a durability surface, which the design refuses. Above, the
/// cost table: an ordinary pass is 0.278 ms and the pathological one 131 ms, so
/// cost did not pick this number and would not object to a smaller one.
///
/// The evidence that could move it is a writer saying they alt-tabbed and read
/// a stale scene, not a rig run. It is one constant and a scheduler.
pub const STALENESS_BOUND_MS: i64 = 10_000;

/// Whether a pass is owed now.
///
/// The design's trigger is a `doc_flush` COMMIT, and a pass is *scheduled*
/// rather than run: `dirty` is that schedule. Nothing here touches the
/// keystroke path -- the precedent is on the record, `project_word_count` once
/// rescanned 15,200 documents after every successful flush and cost measurable
/// typing latency.
pub fn due(dirty: bool, last_run_ms: Option<i64>, now_ms: i64) -> bool {
    if !dirty {
        return false;
    }
    match last_run_ms {
        // Never passed: the writer who enables the mirror and types one
        // sentence should not watch an empty folder for ten seconds.
        None => true,
        // `>=`, so the bound is inclusive at exactly ten seconds.
        //
        // The comparison is `now < last` FIRST, and it is not defensive
        // pedantry: with a plain `now - last >= BOUND` an NTP step backwards
        // makes the difference negative and the mirror stops passing entirely
        // until the clock catches up -- silently, while the writer keeps typing
        // and the folder they were told is current goes stale. 018 found the
        // same shape on the recovery path.
        Some(last) => now_ms < last || now_ms - last >= STALENESS_BOUND_MS,
    }
}

/// How long the watcher waits for a directory to go quiet before it scans.
///
/// A save is not one event. An editor writing a file emits several, and the
/// bytes are only all there once they stop; scanning on the first one would
/// hash a half-written file and report a change nobody made. It also collapses
/// a `sed -i` or a `git checkout` over the whole folder into a single scan.
///
/// Well under `STALENESS_BOUND_MS`, which is what keeps the watcher an
/// optimization: the worst case it improves on is the next open, and the worst
/// case it adds is three quarters of a second.
pub const WATCH_QUIET_MS: i64 = 750;

/// Whether a watched change has stopped arriving and can be scanned.
///
/// `due`'s backwards-clock rule and for its reason: a plain subtraction leaves
/// a pending change unscanned across an NTP step backwards, and the mirror goes
/// on overwriting the edited file for the whole of that window.
pub fn settled(pending_since_ms: Option<i64>, now_ms: i64) -> bool {
    match pending_since_ms {
        None => false,
        Some(since) => now_ms < since || now_ms - since >= WATCH_QUIET_MS,
    }
}

/// What the last pass did, kept so the indicator can report it.
///
/// C1: 019 sent a failed pass to stderr and kept nothing, which left the
/// design's `failing` state (`:411`, and it must name the CAUSE) with no
/// producer. This is the smallest thing that gives it one.
///
/// `last_ok` DEFAULTS TO TRUE, and that is not optimism: `never run` and `ran
/// and failed` are two different states, told apart by `last_run_ms` being
/// `None`. A default of `false` would report `failing` for every project whose
/// mirror is simply off.
#[derive(Debug, Clone, PartialEq)]
pub struct PassOutcome {
    pub last_ok: bool,
    pub last_error: Option<String>,
    /// When the last ATTEMPT ran, successful or not. A failing mirror that
    /// reported no attempt time would read as one that never ran.
    pub last_run_ms: Option<i64>,
}

impl Default for PassOutcome {
    fn default() -> Self {
        Self {
            last_ok: true,
            last_error: None,
            last_run_ms: None,
        }
    }
}

impl PassOutcome {
    /// Record an attempt. Success CLEARS the previous cause -- without that,
    /// one transient error makes the indicator report `failing` forever while
    /// the folder is exactly current.
    pub fn record(&mut self, result: Result<(), String>, now_ms: i64) {
        match result {
            Ok(()) => {
                self.last_ok = true;
                self.last_error = None;
            }
            Err(e) => {
                self.last_ok = false;
                self.last_error = Some(e);
            }
        }
        self.last_run_ms = Some(now_ms);
    }
}

/// What one pass did.
#[derive(Debug, Clone, PartialEq)]
pub struct PassReport {
    pub written: u64,
    pub removed: u64,
    pub entries: Vec<MirrorEntry>,
    pub paused: bool,
    /// What happened to `wordlist.txt`, after the scenes and the manifest.
    pub wordlist: crate::mirror_wordlist::Outcome,
    /// The desired wordlist's bytes, so a later identity check can reject a
    /// source change between the pass and its check.
    pub wordlist_hash: Option<String>,
}

/// One mirror pass: walk, write what changed, remove what is gone, describe.
///
/// TAKES A PATH AND HOLDS NO STORE MUTEX, which is `take_point`'s shape and
/// rule: the caller reads the path off the store and drops the guard, so this
/// function structurally cannot take the lock. The recorded deadlock that shape
/// was written after is what makes it a rule.
///
/// `open_readonly`, never `open`: `open` migrates, and a mirror pass that
/// upgraded the schema of the project it is reading would close the writer's
/// book to the build they are running.
#[cfg(test)]
pub fn pass(
    source: &std::path::Path,
    slug: &str,
    name: &str,
    dir: &std::path::Path,
    now_ms: i64,
    paused: &std::collections::HashSet<String>,
) -> Result<PassReport, String> {
    pass_inner(source, None, slug, name, dir, now_ms, paused)
}

pub fn pass_for_book(
    source: &std::path::Path,
    book_id: &str,
    slug: &str,
    name: &str,
    dir: &std::path::Path,
    now_ms: i64,
    paused: &std::collections::HashSet<String>,
) -> Result<PassReport, String> {
    pass_inner(source, Some(book_id), slug, name, dir, now_ms, paused)
}

fn pass_inner(
    source: &std::path::Path,
    expected_book_id: Option<&str>,
    slug: &str,
    name: &str,
    dir: &std::path::Path,
    now_ms: i64,
    paused: &std::collections::HashSet<String>,
) -> Result<PassReport, String> {
    let (items, bodies, doc_revs, texts, schema_version, dictionary) = {
        let store = crate::store::Store::open_readonly(source).map_err(|e| e.to_string())?;
        if let Some(expected) = expected_book_id {
            if store.book_id().map_err(|error| error.to_string())?.as_deref() != Some(expected) {
                return Err("the source book changed; the readable folder was not updated".into());
            }
        }
        // WITHOUT THE BIN AND WITHOUT THE BIBLE. `manuscript_items`' own note
        // is the argument: it is what the BOOK is, as opposed to what the writer
        // can see. The raw walk would put a `Trash` directory in the writer's
        // manuscript folder and put every scene they deleted back in front of
        // them; it would also give the bible a directory of its own and roll its
        // words into the manifest's `words`, so `completeness` would describe a
        // manuscript nobody wrote.
        let items = crate::store::manuscript_items(store.items().map_err(|e| e.to_string())?);
        let bodies = store.documents().map_err(|e| e.to_string())?;
        let doc_revs = store.document_revs().map_err(|e| e.to_string())?;
        let (texts, _, _) = store.document_texts().map_err(|e| e.to_string())?;
        let schema_version = store.user_version().unwrap_or(0);
        // CARRIED AS A RESULT: an unreadable dictionary fails the list, never
        // the scenes.
        let dictionary = store
            .dict_words()
            .map(|words| words.into_iter().map(|w| w.word).collect::<Vec<_>>())
            .map_err(|e| format!("{}: {e}", crate::mirror_wordlist::WORDLIST_NAME));
        (items, bodies, doc_revs, texts, schema_version, dictionary)
    };

    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut effective_pauses = persisted_pauses(dir)?;
    effective_pauses.extend(paused.iter().cloned());
    let paused = &effective_pauses;

    // What the last pass left, by id. `rev` AND `path`, because either can move
    // without the other: an edit changes the rev, a reorder changes the path.
    let previous: Vec<MirrorEntry> = if paused.is_empty() {
        crate::recovery::read_manifest(dir)
            .map(|m: crate::recovery::Manifest<MirrorEntry>| m.entries)
            .unwrap_or_default()
    } else {
        strict_entries(dir)?
    };
    let was: std::collections::HashMap<&str, &MirrorEntry> =
        previous.iter().map(|e| (e.id.as_str(), e)).collect();

    let placed = layout(&items);
    let mut entries = Vec::with_capacity(placed.len());
    let mut written = 0u64;
    let mut unreadable_bodies = 0u64;
    let mut documents_with_prose = 0u64;
    // Every preserved copy this pass still wants, by relative path.
    let mut sidecars: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (item, place) in items.iter().zip(placed.iter()) {
        let body = bodies.get(&item.id).map(String::as_str);
        let content = file_body(item, body);
        let content_hash = format!("{:016x}", hash64(content.as_bytes()));
        if let Some(b) = body {
            if crate::export::document_markdown(b).is_none() {
                unreadable_bodies += 1;
            }
        }
        let words = texts
            .get(&item.id)
            .map(|t| crate::words::count_words(t))
            .unwrap_or(0);
        if words > 0 {
            documents_with_prose += 1;
        }

        // PAUSED: the writer changed this file outside the application and
        // has not resolved it yet. Overwriting it because a timer fired is what
        // the design calls the single worst thing this feature could do, and it
        // is the failure a mirror has that an export does not.
        //
        // PER ENTRY, never per project. A writer who edits one scene must keep
        // getting mirror updates for every other scene they are typing; a
        // pause that stopped the whole mirror would be indistinguishable from
        // one that broke.
        //
        // The old row is KEPT VERBATIM, which is the load-bearing half: the
        // manifest must go on describing what the application last wrote, not
        // what is on disk now. It is the baseline the next scan compares
        // against, and a row that followed the writer's edit would make the
        // change detect itself away and the edit would be silently forgotten.
        // HOISTED ABOVE THE PAUSE, because the pause needs it: an entry whose
        // document revision has moved since the manifest was written is a
        // CONFLICT, and a conflict owes the writer the book's side as a file.
        let doc_rev = doc_revs.get(&item.id).copied().unwrap_or(0);

        if paused.contains(item.id.as_str()) {
            if let Some(old) = was.get(item.id.as_str()) {
                // BOTH SIDES MOVED AND NEITHER IS STALE (design section 7).
                // The file on disk is the writer's and is not touched; the
                // book's side is written BESIDE it, so the preservation is an
                // artifact rather than a promise. Only on a conflict: an
                // ordinary external edit has one version worth keeping, and a
                // second file for every pause would put a duplicate of every
                // reviewed scene in the writer's folder.
                if old.doc_rev != doc_rev || old.hash != content_hash {
                    let rel = from_project_path(&old.path);
                    let full = dir.join(&rel);
                    if let Some(parent) = full.parent() {
                        std::fs::create_dir_all(parent)
                            .map_err(|e| format!("{}: {e}", parent.display()))?;
                    }
                    std::fs::write(&full, &content)
                        .map_err(|e| format!("{}: {e}", full.display()))?;
                    sidecars.insert(rel);
                }
                entries.push((*old).clone());
                continue;
            }
            // Paused with no previous row cannot happen through the shipped
            // path -- a pause is only ever raised for an entry the manifest
            // describes -- but if it ever does, writing the file would be the
            // one unrecoverable choice. Skip it and describe nothing.
            continue;
        }

        // UNCHANGED means both revisions, the path, and rendered content match.
        // Each condition covers a change the others cannot see: `rev` is the
        // item row (a rename, a move, a revision state), `doc_rev` is the
        // document row (every keystroke the writer has ever typed), and `path`
        // is the layout (a sibling whose ordinal moved carries neither
        // revision's change). Dropping any of the three leaves a class of edit
        // permanently absent from the writer's folder. A copied database can
        // carry matching revisions with different prose, so the rendered hash
        // is the final condition.
        if let Some(old) = was.get(item.id.as_str()) {
            if old.rev == item.rev
                && old.doc_rev == doc_rev
                && old.path == place.path
                && old.hash == content_hash
            {
                entries.push((*old).clone());
                continue;
            }
        }

        let full = dir.join(&place.path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&full, &content).map_err(|e| format!("{}: {e}", full.display()))?;
        written += 1;
        entries.push(MirrorEntry {
            id: item.id.clone(),
            path: place.path.clone(),
            rev: item.rev,
            doc_rev,
            bytes: content.len() as u64,
            hash: content_hash,
            mtime_ms: file_mtime_ms(&full).unwrap_or(now_ms),
            words,
        });
    }

    // WHAT IS GONE, by path. A pass that only ever wrote would leave the old
    // file beside the new one after a rename, and the writer would find two
    // copies of one scene in their manuscript folder.
    let kept: std::collections::HashSet<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    let mut removed = 0u64;
    for old in &previous {
        if kept.contains(old.path.as_str()) {
            continue;
        }
        let stale = dir.join(&old.path);
        match std::fs::remove_file(&stale) {
            Ok(()) => removed += 1,
            // Recorded, never fatal, for `take_point`'s reason: a file that
            // could not be removed is a directory with one stale scene in it,
            // which is a better outcome than a manifest that stops describing
            // the files that are there.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("mirror: could not remove {}: {e}", stale.display()),
        }
    }
    reap_sidecars(dir, &sidecars);
    prune_empty_dirs(dir);

    let manifest = crate::recovery::Manifest::mirror(
        crate::recovery::ProjectRef {
            slug: slug.to_string(),
            name: name.to_string(),
            schema_version,
        },
        now_ms,
        crate::recovery::Completeness {
            items_total: items.len() as u64,
            entries_written: entries.len() as u64,
            documents_with_prose,
            unreadable_bodies,
            // ZERO, AND IT IS NOT A COUNT OF THIS ARTIFACT'S OMISSIONS. The
            // mirror does not project the cast at all (the format is
            // bidirectional and an unknown front-matter key is a REFUSAL), so
            // there is no picture it could have carried and none it leaves out.
            // What the mirror does leave out -- comment anchors, history and
            // the synopsis -- is named in `Manifest::mirror`'s `exclusions`
            // instead, because none of the three is a count.
            pictures: 0,
            // AND ZERO ON THE SAME READING for a cover: the mirror is a folder
            // of the writer's prose, and a cover has never been prose.
            covers: 0,
        },
        entries.clone(),
    );
    crate::recovery::write_manifest(dir, &manifest)?;
    let wordlist_hash = dictionary.as_ref().ok()
        .and_then(|words| crate::mirror_wordlist::render(words).ok())
        .map(|text| format!("{:016x}", hash64(text.as_bytes())));
    let wordlist = crate::mirror_wordlist::maintain(dir, dictionary);

    Ok(PassReport {
        written,
        removed,
        entries,
        paused: !paused.is_empty(),
        wordlist,
        wordlist_hash,
    })
}

/// What a stat pass over the mirror found.
///
/// THREE DIFFERENT ANSWERS, deliberately not one list. A candidate can be
/// hashed in stage 2; a deleted file cannot be opened at all; an unmatched file
/// has no id, which is exactly what makes it unmatched. Collapsing them would
/// send stage 2 to read files that are not there.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ScanReport {
    /// Entry ids whose `(bytes, mtime_ms)` no longer match the manifest.
    /// CANDIDATES, not changes: an editor that rewrites a file byte-identically
    /// is ordinary, and stage 2 is what tells the two apart.
    pub candidates: Vec<String>,
    /// Entry ids whose file is gone.
    pub deleted_outside: Vec<String>,
    /// Paths present on disk that the manifest never wrote, relative to the
    /// mirror directory and `/`-separated. BY PATH, because they have no id.
    pub unmatched: Vec<String>,
}

/// Stage 1: stat every entry and walk for strays.
///
/// Cheap by design -- the measured cost is 2.22 us/file on tmpfs and ~2.35 on
/// ext4 (design `:461-464`), so ~47 ms for the 20,000-file tree. Nothing is
/// read or hashed here; that is stage 2, and keeping it that way is what makes
/// the open path proportional to what changed rather than to the size of the
/// book.
///
/// **Not a guarantee against a size- and mtime-preserving edit** (`touch -r`,
/// some rsync modes). The design records that gap rather than hiding it and
/// answers it with a thorough check, not by hashing everything on every open.
pub fn scan(dir: &std::path::Path, entries: &[MirrorEntry]) -> ScanReport {
    use std::collections::HashSet;

    let mut report = ScanReport::default();
    let known: HashSet<&str> = entries.iter().map(|e| e.path.as_str()).collect();

    for entry in entries {
        let full = dir.join(&entry.path);
        match std::fs::metadata(&full) {
            Ok(meta) => {
                // BOTH, and neither alone. A size-only check misses a typo fix
                // (one byte for one byte); an mtime-only check misses a
                // filesystem whose timestamp granularity swallowed the write.
                let moved = meta.len() != entry.bytes
                    || file_mtime_ms(&full).unwrap_or(entry.mtime_ms) != entry.mtime_ms;
                if moved {
                    report.candidates.push(entry.id.clone());
                }
            }
            Err(_) => report.deleted_outside.push(entry.id.clone()),
        }
    }

    walk_for_unmatched(dir, dir, &known, &mut report.unmatched);
    report.unmatched.sort();
    report
}

/// Stage 2: hash the candidates, and only the candidates.
///
/// A `(bytes, mtime_ms)` difference is a CANDIDATE, not a change. An editor
/// that opens a file and saves it unmodified rewrites it byte for byte with a
/// fresh mtime, which is ordinary and must not pause the mirror for a scene
/// nobody edited. Hashing is what tells the two apart, and hashing only what
/// stage 1 flagged is what keeps the open path proportional to what changed:
/// ~114 ms over the whole 20,000-file tree against stage 1's ~47 ms.
///
/// A candidate whose file vanished between the stages is NOT a change. The two
/// stages are not atomic and nothing can make them so; reporting a deletion as
/// an edit would send 021 to diff against a file that is not there.
#[cfg(test)]
pub fn confirm(
    dir: &std::path::Path,
    entries: &[MirrorEntry],
    candidates: &[String],
) -> Vec<String> {
    use std::collections::HashSet;

    let wanted: HashSet<&str> = candidates.iter().map(|s| s.as_str()).collect();
    let mut changed = Vec::new();
    for entry in entries {
        if !wanted.contains(entry.id.as_str()) {
            continue;
        }
        let Ok(bytes) = std::fs::read(dir.join(&entry.path)) else {
            continue;
        };
        if format!("{:016x}", hash64(&bytes)) != entry.hash {
            changed.push(entry.id.clone());
        }
    }
    changed
}

/// What the mirror on disk says has changed since the application last wrote
/// it: stages 1 and 2 run together, over the baseline the directory carries.
///
/// `changed` is the pause set and `deleted_outside` deliberately is NOT, on the
/// asymmetry the design's own words carry: overwriting an external edit is "the
/// single worst thing this feature could do", and rewriting a file the writer
/// deleted destroys nothing. A deletion that paused would leave the folder
/// permanently short a scene with no way to repair it until the resolve path
/// ships.
///
/// RETURNS A REPORT, NEVER A RESULT. This runs as a background task after the
/// window is up and is never a precondition for opening the project
/// (design `:487-491`), so there is no caller that could act on an error: a
/// mirror directory that cannot be read has nothing to say about what changed,
/// which is exactly an empty report.
#[cfg(test)]
pub fn detect(dir: &std::path::Path) -> DetectReport {
    let entries: Vec<MirrorEntry> = crate::recovery::read_manifest(dir)
        .map(|m: crate::recovery::Manifest<MirrorEntry>| m.entries)
        .unwrap_or_default();
    let stage1 = scan(dir, &entries);
    DetectReport {
        changed: confirm(dir, &entries, &stage1.candidates),
        deleted_outside: stage1.deleted_outside,
        unmatched: stage1.unmatched,
    }
}

/// The ordinary stat-first scan, plus a hash of entries already paused for this
/// project. A paused entry must be checked even when its metadata is unchanged:
/// an editor may restore the original bytes and timestamp, which makes it safe
/// for the next pass to maintain again.
#[cfg(test)]
pub fn detect_with_paused(
    dir: &std::path::Path,
    paused: &std::collections::HashSet<String>,
) -> DetectReport {
    let entries = match strict_entries(dir) {
        Ok(entries) => entries,
        // The ordinary open scan cannot fail the open. It also must not turn
        // an unreadable baseline into permission to overwrite an old pause.
        Err(_) => return paused_report(paused),
    };
    detect_entries_with(dir, &entries, paused, || {})
}

fn detect_entries_with(
    dir: &std::path::Path,
    entries: &[MirrorEntry],
    paused: &std::collections::HashSet<String>,
    after_scan: impl FnOnce(),
) -> DetectReport {
    let mut stage1 = scan(dir, entries);
    after_scan();
    let mut wanted: std::collections::HashSet<String> = stage1.candidates.into_iter().collect();
    wanted.extend(paused.iter().cloned());
    // `scan` reports every metadata failure as a deletion for its historic
    // non-fatal callers. Re-read those ids here: NotFound stays a deletion;
    // another error is an unreadable file which has to remain paused. This
    // reuses stage 1's stat result instead of doing a second full stat walk.
    wanted.extend(stage1.deleted_outside.iter().cloned());
    let (mut changed, unreadable, missing) =
        confirm_with_failures(dir, entries, &wanted.into_iter().collect::<Vec<_>>());
    // `scan`'s historic contract groups all metadata errors with missing
    // files. This path has now read the candidate, so keep only real missing
    // ids in `deleted_outside`; otherwise the change set would produce both a
    // deleted and unreadable row for one inaccessible file.
    stage1
        .deleted_outside
        .retain(|id| missing.iter().any(|missing| missing == id));
    changed.extend(unreadable);
    changed.sort();
    changed.dedup();
    DetectReport {
        changed,
        deleted_outside: stage1.deleted_outside,
        unmatched: stage1.unmatched,
    }
}

/// A deliberate full hash pass. Unlike `detect`, a missing or malformed
/// manifest is an error: the caller must never report a complete check whose
/// baseline was unavailable.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CheckReport {
    pub entries: u64,
    pub hashed: u64,
    pub changed: u64,
    pub deleted: u64,
}

/// The internal half of a strict check. The command returns only `report`, but
/// it needs the ids to install pauses before it tells the page the check ended.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckResult {
    pub report: CheckReport,
    pub found: DetectReport,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckFailure {
    pub report: CheckReport,
    pub paused: Vec<String>,
    pub error: String,
}

const PAUSE_STATE_NAME: &str = ".readable-mirror-pauses.json";
const PAUSE_TEMP_PREFIX: &str = ".readable-mirror-pauses.";
const PAUSE_STATE_FORMAT: &str = "cc.local.app/readable-mirror-pauses";
const PAUSE_STATE_VERSION: u64 = 1;

fn is_pause_temp(path: &str) -> bool {
    let Some(numbered) = path
        .strip_prefix(PAUSE_TEMP_PREFIX)
        .and_then(|path| path.strip_suffix(".tmp"))
    else {
        return false;
    };
    let Some((process, ordinal)) = numbered.split_once('.') else {
        return false;
    };
    process.parse::<u32>().is_ok() && ordinal.parse::<u64>().is_ok()
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedPauses {
    format: String,
    version: u64,
    ids: Vec<String>,
}

pub fn persisted_pauses(
    dir: &std::path::Path,
) -> Result<std::collections::HashSet<String>, String> {
    let path = dir.join(PAUSE_STATE_NAME);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let record: PersistedPauses =
        serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))?;
    if record.format != PAUSE_STATE_FORMAT || record.version != PAUSE_STATE_VERSION {
        return Err(format!(
            "{}: unrecognized readable-folder pause record",
            path.display()
        ));
    }
    Ok(record.ids.into_iter().collect())
}

pub fn persist_pauses(
    dir: &std::path::Path,
    ids: &std::collections::HashSet<String>,
) -> Result<(), String> {
    // Validate an existing reserved-name file before replacing it. A writer's
    // unrelated file must never be claimed merely because its name collided.
    match std::fs::metadata(dir.join(PAUSE_STATE_NAME)) {
        Ok(_) => {
            if persisted_pauses(dir)? == *ids {
                return Ok(());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if ids.is_empty() {
                return Ok(());
            }
        }
        Err(error) => return Err(format!("{}: {error}", dir.join(PAUSE_STATE_NAME).display())),
    }
    std::fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    let mut ids: Vec<String> = ids.iter().cloned().collect();
    ids.sort();
    let bytes = serde_json::to_vec_pretty(&PersistedPauses {
        format: PAUSE_STATE_FORMAT.to_string(),
        version: PAUSE_STATE_VERSION,
        ids,
    })
    .map_err(|error| error.to_string())?;
    static NEXT_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let ordinal = NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(
        "{PAUSE_TEMP_PREFIX}{}.{}.tmp",
        std::process::id(),
        ordinal
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|error| format!("{}: {error}", tmp.display()))?;
    use std::io::Write;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{}: {error}", tmp.display()));
    }
    std::fs::rename(&tmp, dir.join(PAUSE_STATE_NAME)).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {error}", dir.join(PAUSE_STATE_NAME).display())
    })
}

pub fn detect_and_persist(
    dir: &std::path::Path,
    paused: &std::collections::HashSet<String>,
) -> Result<DetectReport, DetectFailure> {
    detect_and_persist_with(dir, paused, persist_pauses)
}

#[derive(Debug)]
pub struct DetectFailure {
    pub found: DetectReport,
    pub error: String,
}

fn detect_and_persist_with(
    dir: &std::path::Path,
    paused: &std::collections::HashSet<String>,
    persist: impl FnOnce(&std::path::Path, &std::collections::HashSet<String>) -> Result<(), String>,
) -> Result<DetectReport, DetectFailure> {
    let mut retained = persisted_pauses(dir).map_err(|error| DetectFailure {
        found: paused_report(paused),
        error,
    })?;
    retained.extend(paused.iter().cloned());
    let entries = strict_entries(dir).map_err(|error| DetectFailure {
        found: paused_report(&retained),
        error,
    })?;
    let found = detect_entries_with(dir, &entries, &retained, || {});
    let next: std::collections::HashSet<String> = found.changed.iter().cloned().collect();
    persist(dir, &next).map_err(|error| DetectFailure {
        found: found.clone(),
        error,
    })?;
    Ok(found)
}

pub fn clear_persisted_pauses(
    dir: &std::path::Path,
    resolved: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let mut paused = persisted_pauses(dir)?;
    paused.retain(|id| !resolved.contains(id));
    persist_pauses(dir, &paused)
}

fn strict_entries(dir: &std::path::Path) -> Result<Vec<MirrorEntry>, String> {
    let path = dir.join(crate::recovery::MANIFEST_NAME);
    let text = std::fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_slice::<crate::recovery::Manifest<MirrorEntry>>(&text)
        .map(|manifest| manifest.entries)
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn paused_report(paused: &std::collections::HashSet<String>) -> DetectReport {
    let mut changed: Vec<String> = paused.iter().cloned().collect();
    changed.sort();
    DetectReport {
        changed,
        ..Default::default()
    }
}

fn confirm_with_failures(
    dir: &std::path::Path,
    entries: &[MirrorEntry],
    candidates: &[String],
) -> (Vec<String>, Vec<String>, Vec<String>) {
    use std::collections::HashSet;

    let wanted: HashSet<&str> = candidates.iter().map(String::as_str).collect();
    let mut changed = Vec::new();
    let mut unreadable = Vec::new();
    let mut missing = Vec::new();
    for entry in entries {
        if !wanted.contains(entry.id.as_str()) {
            continue;
        }
        match std::fs::read(dir.join(&entry.path)) {
            Ok(bytes) if format!("{:016x}", hash64(&bytes)) != entry.hash => {
                changed.push(entry.id.clone())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(entry.id.clone())
            }
            Err(_) => unreadable.push(entry.id.clone()),
        }
    }
    (changed, unreadable, missing)
}

pub fn check(dir: &std::path::Path) -> Result<CheckResult, CheckFailure> {
    let entries = strict_entries(dir).map_err(|error| CheckFailure {
        report: CheckReport {
            entries: 0,
            hashed: 0,
            changed: 0,
            deleted: 0,
        },
        paused: Vec::new(),
        error,
    })?;
    let mut report = CheckReport {
        entries: entries.len() as u64,
        hashed: 0,
        changed: 0,
        deleted: 0,
    };
    let mut paused = Vec::new();
    let mut errors = Vec::new();
    for entry in &entries {
        match std::fs::read(dir.join(&entry.path)) {
            Ok(bytes) => {
                report.hashed += 1;
                if format!("{:016x}", hash64(&bytes)) != entry.hash {
                    report.changed += 1;
                    paused.push(entry.id.clone());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                report.deleted += 1;
            }
            Err(error) => {
                paused.push(entry.id.clone());
                errors.push(format!("{}: {error}", entry.path));
            }
        }
    }
    paused.sort();
    paused.dedup();
    if errors.is_empty() {
        Ok(CheckResult {
            report,
            found: DetectReport {
                changed: paused,
                ..Default::default()
            },
        })
    } else {
        Err(CheckFailure {
            report,
            paused,
            error: errors.join("; "),
        })
    }
}

/// Stage 1 and stage 2's answer together, which is what the open path installs.
///
/// `changed` is narrower than `ScanReport::candidates` by exactly the hashing:
/// these are files whose CONTENT differs from what the application wrote, and
/// they are the ids the next pass must not overwrite.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DetectReport {
    /// Entry ids whose file on disk differs from what the manifest recorded.
    pub changed: Vec<String>,
    /// Entry ids whose file is gone. Reported, not paused.
    pub deleted_outside: Vec<String>,
    /// Paths the manifest never wrote, relative to the mirror directory.
    pub unmatched: Vec<String>,
}

/// Every directory a stage-3 watcher needs a watch on, the mirror root first.
///
/// inotify watches a DIRECTORY and does not recurse, so this list is the
/// watcher's whole reach: a container missing from it is a part of the book
/// where an external edit goes unnoticed until the next open. Measured at 3,778
/// directories for the `stress` fixture against the development machine's
/// `max_user_watches` of 524,288 -- 0.7% of the budget, on one instance.
///
/// Empty for a directory that is not there, which is the mirror-is-off case and
/// is not an error: the scan is the guarantee and it already reports an absent
/// mirror as empty.
pub fn watch_dirs(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    fn walk(here: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        out.push(here.to_path_buf());
        let Ok(read) = std::fs::read_dir(here) else {
            return;
        };
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            }
        }
    }
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    walk(dir, &mut out);
    out
}

/// Depth-first walk collecting files the manifest never wrote.
///
/// SKIPS `manifest.json`, which the application writes into the mirror
/// directory itself -- without that it would report its own bookkeeping as the
/// writer's stray file on every open.
fn walk_for_unmatched(
    root: &std::path::Path,
    dir: &std::path::Path,
    known: &std::collections::HashSet<&str>,
    out: &mut Vec<String>,
) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_for_unmatched(root, &path, known, out);
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        // Both application-owned names. The tmp one matters because a crash
        // mid-write leaves it behind, and without this the writer would be told
        // about the application's own debris on every open, forever.
        // Three application-owned names. The tmp one matters because a crash
        // mid-write leaves it behind; the preserved side of a conflict matters
        // because the mirror wrote it itself, and reporting it as the writer's
        // stray file would offer them an `added` row for their own book.
        if rel == crate::recovery::MANIFEST_NAME
            || rel == crate::recovery::MANIFEST_TMP_NAME
            || rel == PAUSE_STATE_NAME
            || crate::mirror_identity::is_reserved(&rel)
            || is_pause_temp(&rel)
            || crate::mirror_wordlist::is_reserved(&rel)
            || rel.ends_with(FROM_PROJECT_SUFFIX)
            || known.contains(rel.as_str())
        {
            continue;
        }
        out.push(rel);
    }
}

fn file_mtime_ms(path: &std::path::Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since.as_millis() as i64)
}

/// Remove directories the removals emptied, deepest first.
///
/// An item that stops having children stops being a directory, and the
/// directory it owned is left behind holding nothing. An empty
/// `0004-Winter-Cafe/` in the writer's manuscript folder reads as a part whose
/// scenes have vanished.
///
/// Never removes `dir` itself: that one is the mirror and it holds the
/// manifest.
fn prune_empty_dirs(dir: &std::path::Path) {
    fn walk(here: &std::path::Path, root: &std::path::Path) {
        let Ok(entries) = std::fs::read_dir(here) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, root);
            }
        }
        if here != root
            && std::fs::read_dir(here)
                .map(|mut d| d.next().is_none())
                .unwrap_or(false)
        {
            let _ = std::fs::remove_dir(here);
        }
    }
    walk(dir, dir);
}

/// One mirror file's whole content: front matter, the title, the prose.
///
/// `body` is the stored ProseMirror JSON, or None for an item that has none --
/// a container, or a leaf the writer has not written into. An item whose body
/// this build cannot read gets the file anyway, with no prose: the manifest's
/// `unreadable_bodies` is where that is counted, and a MISSING file would be
/// indistinguishable from an item that does not exist.
pub fn file_body(item: &crate::store::Item, body: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("id: {}\n", one_line(&item.id)));
    out.push_str(&format!("type: {}\n", one_line(&item.item_type)));
    out.push_str("---\n\n");
    // ALWAYS `#`, never `export::heading_level(depth)`. That function serves
    // the single concatenated manuscript, where one document holds the whole
    // book and depth is what keeps the outline. Each file here stands alone in
    // an editor that knows nothing about the rest of the book.
    out.push_str(&format!(
        "# {}\n",
        crate::export::heading_title(&item.title)
    ));
    if let Some(prose) = body.and_then(crate::export::document_markdown) {
        if !prose.is_empty() {
            out.push('\n');
            out.push_str(&prose);
            out.push('\n');
        }
    }
    out
}

/// What the mirror calls the book's side of a conflict, beside the writer's file.
///
/// DESIGN SECTION 7. When both sides moved, nothing is applied and nothing is
/// overwritten -- and "conflicting versions are preserved rather than silently
/// overwritten" is a promise until there is a FILE. This is the file: the
/// store's current body, in the same shape as the mirror's own documents, so
/// the writer can read both with anything they already have.
pub const FROM_PROJECT_SUFFIX: &str = ".from-project.md";

/// `NNNN-<slug>.md` -> `NNNN-<slug>.from-project.md`.
///
/// The suffix REPLACES the extension rather than following it: a folder listing
/// sorts the two side by side, which is the whole point of putting the second
/// copy beside the first rather than in a directory of its own.
pub fn from_project_path(path: &str) -> String {
    let stem = path.strip_suffix(".md").unwrap_or(path);
    format!("{stem}{FROM_PROJECT_SUFFIX}")
}

/// Remove every preserved copy the mirror is no longer holding.
///
/// A sidecar describes a STATE -- both sides moved and neither is stale -- so it
/// must not outlive it. One left behind is a stale second draft in the writer's
/// manuscript folder that they cannot tell from the one they are working in.
///
/// A WALK, and it costs nothing new: `prune_empty_dirs` already walks this tree
/// at the end of every pass. Reaping by name from the entry list instead would
/// miss the copy left at a path a resumed entry has since moved away from.
fn reap_sidecars(dir: &std::path::Path, wanted: &std::collections::HashSet<String>) {
    fn walk(
        root: &std::path::Path,
        here: &std::path::Path,
        wanted: &std::collections::HashSet<String>,
    ) {
        let Ok(read) = std::fs::read_dir(here) else {
            return;
        };
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, wanted);
                continue;
            }
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel.ends_with(FROM_PROJECT_SUFFIX) && !wanted.contains(rel.as_str()) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    walk(dir, dir, wanted);
}

/// A front-matter VALUE, flattened to one line.
///
/// `item_type` is a String out of the store and an imported project can carry
/// anything in it, `id` likewise. A raw value would let `scene\nid: it-999`
/// add a key -- and `id` is the one field the mirror reads back, so a forged
/// one would redirect an accepted change at whatever item it names.
///
/// The fold is to a space rather than an escape or a quote: these two values
/// are an opaque identifier and a short type word, neither of which has any
/// business containing a line break, and a reader of this file should see what
/// is there rather than a quoting convention.
fn one_line(value: &str) -> String {
    value
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect()
}

/// One row of the change set: a file the writer changed, and what kind of
/// change it is.
///
/// SERIALIZED TO THE PAGE, so field names are the host's snake_case by the
/// recorded rule. Both bodies ride the row rather than being fetched
/// separately, and that is not convenience: the two sides must describe the
/// same instant, and a page that asked for the store's body in a second call
/// could be handed one the writer moved in between.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Change {
    /// The store item this file is about. EMPTY for a file the manifest never
    /// wrote, which is the one row that corresponds to nothing in the book.
    pub id: String,
    /// Where the file is now, relative to the mirror directory.
    pub path: String,
    /// Where it was, for a move, and None otherwise.
    pub was_path: Option<String>,
    /// One of the constants below.
    pub state: &'static str,
    /// The item's title as THE BOOK has it. Empty for a row with no item.
    pub title: String,
    /// The title the FILE now carries, when the two differ.
    pub file_title: Option<String>,
    /// The store's body, for the diff's "in the project" side.
    pub store_body: Option<String>,
    /// The file's body, for the diff's "in the file" side.
    pub file_body: Option<String>,
    /// Why the file could not be read, for `UNREADABLE`.
    pub error: Option<String>,
    /// Whether this row is one the writer may take into their book.
    ///
    /// **TRUE FOR EXACTLY TWO STATES**, and the whole product decision of slice
    /// 022 is in that sentence. `PROSE` is the design's only applicable row.
    /// `CONFLICT` is applicable ONLY once the book's side is preserved beside
    /// the file (`from_project_path`), because accepting one of two live
    /// versions is a choice a writer is entitled to make and is only safe once
    /// the side they are not choosing still exists as a file they can open.
    ///
    /// Every other state carries no body at all, or carries one whose
    /// acceptance would destroy something: a forged identifier, a discarded
    /// rename, or a structural change import refuses to merge into an open
    /// book. **The page renders no control where this is false**, and the host
    /// refuses the id whether or not the page asked.
    pub can_accept: bool,
    /// Underlined runs in the STORE's body that the mirror's own write dropped.
    ///
    /// Markdown has no underline, so `export::document_markdown` drops the mark
    /// -- deliberately, counted, and argued in
    /// `decisions/2026-08-27-underline.md`, which predicted this exact call
    /// site. The file therefore never carried them and accepting it cannot
    /// bring them back. The figure is on the ROW so the writer is told before
    /// they press; a notice afterwards is an apology.
    pub store_underlined: u64,
}

/// The prose changed and the book has not moved under it. **The only
/// applicable row**, and the whole reason this design needs no merge
/// algorithm: accepting it is replacing one document's body with another,
/// which `doc_restore`, `snapshot_restore` and `replace_everywhere` already do.
pub const PROSE: &str = "prose";
/// The prose changed AND the store changed too -- both moved, neither is stale.
///
/// ITS PRODUCER IS `MirrorEntry::doc_rev`, which did not exist before slice
/// 029. Built on the item revision this state could never fire for a prose
/// edit, because typing does not move it.
pub const CONFLICT: &str = "conflict";
/// The file's `id` or `type` differs from what the application wrote, or it
/// carries a key this format does not define. **Outranks everything**: an
/// altered identifier means nothing else on the row can be trusted.
pub const FRONT_MATTER: &str = "front-matter";
/// The `# ` heading differs from the item's title.
///
/// NOT IN THE DESIGN'S TABLE, which was written three days before the title
/// moved into a heading OUTSIDE the front matter. Folding a renamed heading into
/// "front matter changed" would put a wrong word in front of a writer.
/// **Outranks `PROSE`**: accepting prose from a file whose heading also
/// changed would silently discard the rename, and half of what a writer did is
/// never the right thing to apply.
pub const TITLE: &str = "title";
/// A file on disk the manifest never wrote.
pub const ADDED: &str = "added";
/// One file the writer moved: an unmatched path whose front matter names an
/// entry whose own file is gone. **A synthesis, not a fourth detection stage**
/// -- reporting it as an unrelated add plus an unrelated delete would be two
/// rows for one act.
pub const MOVED: &str = "moved";
/// An entry whose file is gone.
pub const DELETED: &str = "deleted";
/// It does not parse as a mirror document. Carries the reason.
pub const UNREADABLE: &str = "unreadable";

/// What the writer changed in their folder, as rows they can read.
///
/// READS NOTHING BACK INTO THE STORE and writes nothing anywhere. This slice
/// says what a file now contains and how it differs from the book; applying it
/// is 022, and every string built on this must be true under that boundary.
///
/// TAKES A `DetectReport` RATHER THAN SCANNING. The three-stage detection in
/// 020 is the guarantee, and a second walk here would be a second answer to
/// the same question, free to disagree with the pause set the mirror pass is
/// actually honouring.
pub fn change_set(
    dir: &std::path::Path,
    entries: &[MirrorEntry],
    items: &[crate::store::Item],
    bodies: &std::collections::HashMap<String, String>,
    doc_revs: &std::collections::HashMap<String, i64>,
    found: &DetectReport,
) -> Vec<Change> {
    use std::collections::{HashMap, HashSet};

    let by_id: HashMap<&str, &MirrorEntry> = entries.iter().map(|e| (e.id.as_str(), e)).collect();
    let item_by_id: HashMap<&str, &crate::store::Item> =
        items.iter().map(|i| (i.id.as_str(), i)).collect();
    let gone: HashSet<&str> = found.deleted_outside.iter().map(|s| s.as_str()).collect();

    let blank = |id: String, path: String, state: &'static str, title: String| Change {
        id,
        path,
        was_path: None,
        state,
        title,
        file_title: None,
        store_body: None,
        file_body: None,
        error: None,
        can_accept: false,
        store_underlined: 0,
    };

    let mut rows: Vec<Change> = Vec::new();
    // MOVES FIRST, so the deletion half of a move is claimed before the
    // deletion loop can report it on its own. A move is one act.
    let mut moved: HashSet<String> = HashSet::new();

    for path in &found.unmatched {
        let parsed = std::fs::read_to_string(dir.join(path))
            .ok()
            .and_then(|text| read_file(&text).ok());
        // A move is an unmatched path whose front matter names an entry whose
        // OWN file is gone. Both halves are required: a copy leaves the
        // original in place, and reporting a copy as a move would tell the
        // writer a file left somewhere it is still sitting.
        let from = parsed
            .as_ref()
            .and_then(|f| f.id.clone())
            .filter(|id| gone.contains(id.as_str()));
        match from {
            Some(id) => {
                let was = by_id.get(id.as_str()).map(|e| e.path.clone());
                let title = item_by_id
                    .get(id.as_str())
                    .map(|i| i.title.clone())
                    .unwrap_or_default();
                moved.insert(id.clone());
                let mut row = blank(id, path.clone(), MOVED, title);
                row.was_path = was;
                rows.push(row);
            }
            None => rows.push(blank(String::new(), path.clone(), ADDED, String::new())),
        }
    }

    for id in &found.deleted_outside {
        if moved.contains(id) {
            continue;
        }
        let Some(entry) = by_id.get(id.as_str()) else {
            continue;
        };
        let title = item_by_id
            .get(id.as_str())
            .map(|i| i.title.clone())
            .unwrap_or_default();
        rows.push(blank(id.clone(), entry.path.clone(), DELETED, title));
    }

    for id in &found.changed {
        let Some(entry) = by_id.get(id.as_str()) else {
            // Changed against a manifest that does not describe it cannot
            // happen through `detect`, which reads the same manifest. Silence
            // rather than a guess: there is nothing to compare against.
            continue;
        };
        let title = item_by_id
            .get(id.as_str())
            .map(|i| i.title.clone())
            .unwrap_or_default();

        let read = std::fs::read_to_string(dir.join(&entry.path))
            .map_err(|e| e.to_string())
            .and_then(|text| read_file(&text));
        let file = match read {
            Ok(file) => file,
            Err(error) => {
                let mut row = blank(id.clone(), entry.path.clone(), UNREADABLE, title);
                row.error = Some(error);
                rows.push(row);
                continue;
            }
        };

        let Some(item) = item_by_id.get(id.as_str()) else {
            // The writer deleted the scene inside the application while their
            // edit to its file sat unresolved. The file is real and the book
            // has nothing for it, which is what `ADDED` means from the book's
            // side -- the id is kept, because here it is known.
            rows.push(blank(id.clone(), entry.path.clone(), ADDED, String::new()));
            continue;
        };

        // FRONT MATTER OUTRANKS EVERYTHING. An altered identifier means nothing
        // else on this row can be trusted, and a body carried beside it is a
        // body some later accept path could write into whatever item the forged
        // id names.
        if file.id.as_deref() != Some(entry.id.as_str())
            || file.item_type.as_deref() != Some(item.item_type.as_str())
            || !file.extra.is_empty()
        {
            rows.push(blank(id.clone(), entry.path.clone(), FRONT_MATTER, title));
            continue;
        }

        // TITLE OUTRANKS PROSE. Accepting the prose from a file whose heading
        // also changed would silently discard the rename.
        if file.title != item.title {
            let mut row = blank(id.clone(), entry.path.clone(), TITLE, title);
            row.file_title = Some(file.title);
            rows.push(row);
            continue;
        }

        // Both moved, neither is stale. A copied book can carry the same
        // revisions with different prose, so the rendered bytes are the second
        // store-side comparison beside the document revision.
        let store_hash = format!(
            "{:016x}",
            hash64(file_body(item, bodies.get(id.as_str()).map(String::as_str)).as_bytes())
        );
        let store_moved = doc_revs.get(id.as_str()).copied().unwrap_or(0) != entry.doc_rev
            || store_hash != entry.hash;
        let state = if store_moved { CONFLICT } else { PROSE };
        let mut row = blank(id.clone(), entry.path.clone(), state, title);
        row.store_body = bodies.get(id.as_str()).cloned();
        row.file_body = file.body;
        // A prose row is applicable outright. A conflict is applicable only
        // with the book's side already on disk beside it -- the pass that
        // honours the pause writes it, and until it has, the accept would be
        // the writer choosing one of two versions with nothing holding the
        // other. The check is the FILE and not a flag: a promise nobody can
        // open is not a preservation.
        row.can_accept = row.file_body.is_some()
            && (state == PROSE || dir.join(from_project_path(&entry.path)).is_file());
        row.store_underlined = row
            .store_body
            .as_deref()
            .and_then(crate::export::document_markdown_counted)
            .map(|(_, underlined)| underlined)
            .unwrap_or(0);
        rows.push(row);
    }

    // BY PATH, because that is the order the writer's file manager shows them
    // and the order the mirror itself is laid out in. A change set whose order
    // came from three loops would shuffle whenever a different kind of change
    // arrived first.
    rows.sort_by(|a, b| a.path.cmp(&b.path));
    rows
}

/// What an acceptance is about to do, derived from the rows the writer saw.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AcceptPlan {
    /// `(item id, the store's current document revision, the FILE's body)`, in
    /// the order the rows are listed.
    pub accepts: Vec<(String, i64, String)>,
    /// The mirror-relative paths accepted, so the manifest can be brought back
    /// into step with the files the writer already has.
    pub paths: Vec<String>,
    /// Underlined runs the folder had already dropped from the bodies being
    /// replaced. Reported so the notice can restate what the row said.
    pub underlined: u64,
}

/// Turn a set of ids the page named into the writes the host will perform.
///
/// **RE-DERIVED FROM THE CHANGE SET, NEVER TRUSTED FROM THE PAGE.** The page
/// names ids; this decides what may happen to them, and it refuses anything
/// whose row is not applicable. `doc_restore`'s owner check is the precedent
/// and its comment is the argument: a stale panel, a switch the panel did not
/// notice, or a page bug must not be able to write a body into a document the
/// writer never approved it for -- and it is one lookup away from impossible.
///
/// **A REFUSAL, NOT A FILTER.** An id that is dropped silently is an accept the
/// writer believes happened; the next thing they do is close the panel. The
/// message names the row and the state, because those are the two things a
/// writer needs to understand a refusal they did not expect.
pub fn accept_plan(
    rows: &[Change],
    doc_revs: &std::collections::HashMap<String, i64>,
    ids: &[String],
) -> Result<AcceptPlan, String> {
    if ids.is_empty() {
        // An empty accept would snapshot the whole manuscript, write nothing
        // and report success: a history row for an act that did not happen.
        return Err("no change was named".to_string());
    }
    let mut plan = AcceptPlan::default();
    for id in ids {
        let Some(row) = rows.iter().find(|r| !r.id.is_empty() && r.id == *id) else {
            return Err(format!("{id} is not a change in this folder"));
        };
        if !row.can_accept {
            return Err(format!(
                "{id} is {}, which cannot be taken into the book",
                row.state
            ));
        }
        let Some(body) = row.file_body.clone() else {
            // Unreachable through `change_set`, which sets `can_accept` only on
            // a row that has one. Refused rather than unwrapped: the one thing
            // that must never happen here is an empty body reaching the store.
            return Err(format!("{id} carries no words to take"));
        };
        let Some(rev) = doc_revs.get(id).copied() else {
            return Err(format!("{id} has no document in this book"));
        };
        plan.accepts.push((id.clone(), rev, body));
        plan.paths.push(row.path.clone());
        plan.underlined += row.store_underlined;
    }
    Ok(plan)
}

/// Bring the manifest back into step with the files an acceptance just read.
///
/// **WITHOUT THIS THE NEXT PASS REWRITES WHAT IT JUST READ.** An accept moves
/// the document row's revision, and the three-way skip compares it: ten seconds
/// later the mirror would rewrite the file the writer is looking at, from the
/// store, with a fresh mtime, in a folder they have open. Correct in content
/// and wrong in every other way -- and if the round trip through Markdown were
/// ever not byte-stable, wrong in content too.
///
/// **THE TWO HALVES COME FROM OPPOSITE SIDES, DELIBERATELY.** `bytes`, `hash`
/// and `mtime_ms` are re-stat-ed from the file the WRITER has; `doc_rev` and
/// `words` describe what the BOOK now holds. Recording the store's own
/// rendering of the accepted body instead would make the manifest describe a
/// file that is not on disk, which is the one thing a baseline may never do.
///
/// `rev` is untouched, because the item row is untouched.
///
/// The preserved copy goes with the choice: once the writer has taken the file,
/// the side they did not take lives in the snapshot the accept created, which
/// is somewhere the application can put back.
pub fn settle_accepted(
    dir: &std::path::Path,
    paths: &[String],
    accepted: &[crate::store::history::AcceptedDoc],
    now_ms: i64,
) -> Result<(), String> {
    let Some(mut manifest) = crate::recovery::read_manifest::<MirrorEntry>(dir) else {
        // No manifest is not an error here: the acceptance already committed,
        // and a mirror with nothing to settle is a mirror the next pass builds
        // from scratch. Failing would report a lost accept that did not happen.
        return Ok(());
    };
    let by_id: std::collections::HashMap<&str, &crate::store::history::AcceptedDoc> =
        accepted.iter().map(|a| (a.item_id.as_str(), a)).collect();
    for entry in &mut manifest.entries {
        let Some(landed) = by_id.get(entry.id.as_str()) else {
            continue;
        };
        let full = dir.join(&entry.path);
        let bytes = std::fs::read(&full).map_err(|e| format!("{}: {e}", full.display()))?;
        entry.doc_rev = landed.rev;
        entry.bytes = bytes.len() as u64;
        entry.hash = format!("{:016x}", hash64(&bytes));
        entry.mtime_ms = file_mtime_ms(&full).unwrap_or(now_ms);
        entry.words = crate::store::document_text(&landed.body)
            .map(|t| crate::words::count_words(&t))
            .unwrap_or(0);
    }
    manifest.generated_at = now_ms;
    for path in paths {
        let _ = std::fs::remove_file(dir.join(from_project_path(path)));
    }
    crate::recovery::write_manifest(dir, &manifest)
}

/// What one mirror file says, read back.
///
/// THE INVERSE OF `file_body`, and only of that. It is NOT `import::parse`'s
/// inverse and must not become one: `parse`'s file-level rule treats the first
/// H1 as the PROJECT and everything under it as sections, because it is reading
/// a whole manuscript. A mirror file is ONE document -- front matter, then an H1
/// that *is* the document, then its prose -- so it needs its own file rule and
/// shares `import`'s INLINE rule. Two file-level rules, one inline rule, which
/// is the split the design names (`:549-559`) and the same split the harness
/// oracle is built on.
#[derive(Debug, Clone, PartialEq)]
pub struct MirrorFile {
    /// The front matter's `id`, or None when the file does not carry one.
    ///
    /// OPTIONAL RATHER THAN REQUIRED, and the distinction decides which state
    /// the writer is shown. A file with no `id` is not unreadable -- it parses
    /// perfectly and says something different from what the application wrote,
    /// which is a front-matter change to report. Refusing it here would collapse
    /// that into "this file is broken", which is a different sentence and a
    /// wrong one.
    pub id: Option<String>,
    /// The front matter's `type`, on the same terms as `id`.
    pub item_type: Option<String>,
    /// Front-matter keys this format does not define, in the order they appear.
    ///
    /// `file_body` writes exactly two keys and a test pins that, so anything
    /// else came from outside. Carried rather than dropped because a key the
    /// application would never write is precisely what the writer needs telling
    /// about -- and because dropping it silently is how a forged `id` would get
    /// a second chance in some later reader.
    pub extra: Vec<String>,
    /// The `# ` heading, as a plain title. Empty is legal: an untitled item
    /// mirrors as `# ` and must read back as the empty string rather than as a
    /// missing heading.
    pub title: String,
    /// The prose as a ProseMirror document, or None when the file has none.
    ///
    /// THE SAME PARSE THAT WOULD WRITE IT. The design's rule (`:543-548`): a
    /// diff computed by one reader and applied by another is a diff of
    /// something the writer never approved. `import`'s paragraph and inline
    /// machinery is that parse, and there is no second one.
    pub body: Option<String>,
}

/// Read one mirror file.
///
/// ERRORS ARE STRUCTURAL ONLY -- no front-matter fence, no closing fence, no
/// heading. Everything else is content the writer can see and argue with, and
/// belongs in a row rather than in an error. The three that ARE errors share
/// one property: without them there is no way to tell which bytes are the
/// document's metadata and which are its prose, so any answer would be a guess
/// about the writer's file.
pub fn read_file(source: &str) -> Result<MirrorFile, String> {
    let mut lines = source.lines();
    match lines.next() {
        Some(first) if first.trim_end() == "---" => {}
        _ => return Err("the file does not open with a front-matter fence".to_string()),
    }

    let mut id = None;
    let mut item_type = None;
    let mut extra = Vec::new();
    let mut closed = false;
    for line in lines.by_ref() {
        if line.trim_end() == "---" {
            closed = true;
            break;
        }
        // A line with no colon is not a key. Recorded rather than refused: it
        // is the writer's file and reporting the front matter as changed says
        // more than refusing to read the document at all.
        let Some((key, value)) = line.split_once(':') else {
            extra.push(line.trim().to_string());
            continue;
        };
        match key.trim() {
            "id" => id = Some(value.trim().to_string()),
            "type" => item_type = Some(value.trim().to_string()),
            other => extra.push(other.to_string()),
        }
    }
    if !closed {
        return Err("the front matter is never closed".to_string());
    }

    // The heading is the FIRST `# ` after the fence, and nothing may precede it
    // but blank lines. A file whose prose starts before its heading is a file
    // this format did not write, and taking a later heading would let prose
    // above it disappear into a title.
    let mut rest: Vec<&str> = Vec::new();
    let mut title: Option<String> = None;
    for line in lines {
        if title.is_none() {
            if line.trim().is_empty() {
                continue;
            }
            match crate::import::heading(line) {
                Some((1, text)) => {
                    title = Some(crate::import::title_text(text));
                    continue;
                }
                _ => return Err("the file has no top-level heading".to_string()),
            }
        }
        rest.push(line);
    }
    let Some(title) = title else {
        return Err("the file has no top-level heading".to_string());
    };

    let paragraphs = crate::import::paragraphs(&rest);
    Ok(MirrorFile {
        id,
        item_type,
        extra,
        title,
        body: crate::import::document(&paragraphs),
    })
}

/// One mirrored file, as the `kind: "mirror"` manifest describes it.
///
/// THE SECOND ENTRY TYPE, and the reason `Manifest` is generic. It shares
/// `id`, `path`, `bytes`, `hash` and `mtime_ms` with the recovery form by NAME
/// and carries `rev` and `words`, which mean nothing for a whole-database
/// snapshot; the recovery form carries `verified` and `verified_at`, which mean
/// nothing for one Markdown file.
///
/// `path` is a FIELD here and is derived in the recovery form, where the file
/// is always `<id>.db`. A mirror path is the layout path and no rule recovers
/// it from the id.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MirrorEntry {
    /// The store item's id, and the identity. NEVER the path -- the path moves
    /// whenever the writer reorders a chapter.
    pub id: String,
    /// Relative to `mirror/<slug>/`, always `/`-separated.
    pub path: String,
    /// The item's `rev` at the moment this file was written. What makes the
    /// pass incremental -- TOGETHER WITH `doc_rev`, and never alone.
    pub rev: i64,
    /// The `doc` row's `rev` at the moment this file was written, or 0 when the
    /// item has no document.
    ///
    /// THE ITEM'S REVISION DOES NOT MOVE FOR PROSE. `Store::flush` -- the only
    /// path a keystroke takes to disk -- bumps the `doc` row and leaves the
    /// item row alone, so a skip keyed on `rev` alone made every edit after an
    /// entry's first write invisible to the mirror, permanently. That was the
    /// state of this file for four slices; the test that should have caught it
    /// was named for a prose edit and performed a rename.
    ///
    /// `i64` WITH A ZERO SENTINEL, not `Option`, and the distinction is
    /// load-bearing for the manifests already on disk. A `doc` revision starts
    /// at 1, so 0 can mean both "this item has no document" and "this row was
    /// written before the application recorded prose revisions" without the two
    /// ever colliding: a container compares 0 to 0 and is correctly skipped,
    /// while a scene written by an earlier build compares 0 to its real revision and
    /// is rewritten once. An `Option` would make both of those `None == None`
    /// and leave every mirror on disk stale forever.
    #[serde(default)]
    pub doc_rev: i64,
    pub bytes: u64,
    /// FNV-64 over the file's bytes, per artifact. Bitrot detection on a
    /// resting copy, never authentication -- the envelope's own note.
    pub hash: String,
    pub mtime_ms: i64,
    pub words: u64,
}

/// One mirrored item: where its file goes, and whether it is a directory.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: String,
    /// Relative to `mirror/<slug>/`, always `/`-separated.
    pub path: String,
    pub is_container: bool,
}

/// Where every item's file goes.
///
/// Takes the walk `Store::items` produces -- depth first, `ORDER BY path` over
/// the position chain -- so a parent is always seen before its children and the
/// directory it owns is known by the time they are placed.
///
/// **`NNNN` is the SIBLING ordinal, not the item's index in the walk.** It is
/// zero-based, zero-padded to four, and it exists because a sorted directory
/// listing is the only ordering a file manager or `ls` gives; without it the
/// reader gets alphabetical order over a book. The store already guarantees
/// uniqueness among siblings (`UNIQUE(parent_id, position)`), so this counts
/// encounters per parent rather than trying to reuse `position`, which is a
/// fractional index and not a number a filename can carry.
///
/// **Shape follows CHILDREN, never type.** The hierarchy is arbitrary by
/// product decision -- a part inside a scene is legal -- so a layout keyed on
/// `item_type` would be a lie the store can produce on any Tuesday. An item
/// becoming a container is the only thing that changes its shape here.
pub fn layout(items: &[crate::store::Item]) -> Vec<Entry> {
    use std::collections::{HashMap, HashSet};
    let parents: HashSet<&str> = items
        .iter()
        .filter_map(|i| i.parent_id.as_deref())
        .collect();
    let mut next_ordinal: HashMap<Option<&str>, u32> = HashMap::new();
    let mut dir_of: HashMap<&str, String> = HashMap::new();
    let mut out = Vec::with_capacity(items.len());

    for item in items {
        let parent = item.parent_id.as_deref();
        let ordinal = next_ordinal.entry(parent).or_insert(0);
        let name = format!("{:04}-{}", *ordinal, segment(&item.title));
        *ordinal += 1;

        let parent_dir = parent.and_then(|p| dir_of.get(p)).cloned();
        let prefix = match parent_dir {
            Some(d) => format!("{d}/"),
            None => String::new(),
        };

        let is_container = parents.contains(item.id.as_str());
        let path = if is_container {
            let dir = format!("{prefix}{name}");
            let index = format!("{dir}/index.md");
            dir_of.insert(&item.id, dir);
            index
        } else {
            format!("{prefix}{name}.md")
        };
        out.push(Entry {
            id: item.id.clone(),
            path,
            is_container,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashSet;

    use crate::recovery::{Completeness, Manifest, Point, ProjectRef};

    const NOW: i64 = 1_787_174_042_000;

    /// Write a file and force its recorded mtime, so a stage-1 test states the
    /// (bytes, mtime) pair it is testing rather than depending on the clock.
    fn put(dir: &std::path::Path, rel: &str, body: &str) -> MirrorEntry {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        MirrorEntry {
            id: format!("id-for-{rel}"),
            path: rel.to_string(),
            rev: 1,
            doc_rev: 0,
            bytes: meta.len(),
            hash: format!("{:016x}", hash64(body.as_bytes())),
            mtime_ms: file_mtime_ms(&path).unwrap_or(0),
            words: 0,
        }
    }

    #[test]
    fn a_byte_identical_rewrite_is_a_candidate_and_is_not_a_change() {
        // THE WHOLE REASON STAGE 2 EXISTS. An editor that opens a file and
        // saves it without edits rewrites it byte for byte with a fresh mtime.
        // Stage 1 must flag it (it cannot know) and stage 2 must clear it --
        // otherwise every stray save pauses the mirror for a scene that did
        // not change, and the writer is asked to review nothing.
        let tmp = tempfile::tempdir().unwrap();
        let mut entries = vec![put(tmp.path(), "0000-one.md", "one")];
        entries[0].mtime_ms -= 5_000;

        let stage1 = scan(tmp.path(), &entries);
        assert_eq!(stage1.candidates, vec!["id-for-0000-one.md".to_string()]);

        let changed = confirm(tmp.path(), &entries, &stage1.candidates);
        assert_eq!(changed, Vec::<String>::new());
    }

    #[test]
    fn a_file_whose_bytes_really_changed_survives_stage_two() {
        let tmp = tempfile::tempdir().unwrap();
        let entries = vec![put(tmp.path(), "0000-one.md", "one")];
        std::fs::write(tmp.path().join("0000-one.md"), "something else").unwrap();

        let stage1 = scan(tmp.path(), &entries);
        let changed = confirm(tmp.path(), &entries, &stage1.candidates);
        assert_eq!(changed, vec!["id-for-0000-one.md".to_string()]);
    }

    #[test]
    fn stage_two_hashes_only_what_stage_one_flagged() {
        // The cost argument, made falsifiable. Stage 2 is ~114 ms over the
        // 20,000-file tree against stage 1's ~47 ms, so hashing everything
        // would spend the whole budget on every open. Here: a file that
        // changed on disk but is NOT in the candidate list stays unreported,
        // which is only true if the candidate list is what bounds the work.
        let tmp = tempfile::tempdir().unwrap();
        let entries = vec![
            put(tmp.path(), "0000-one.md", "one"),
            put(tmp.path(), "0001-two.md", "two"),
        ];
        std::fs::write(tmp.path().join("0001-two.md"), "rewritten").unwrap();

        let changed = confirm(tmp.path(), &entries, &["id-for-0000-one.md".to_string()]);
        assert_eq!(changed, Vec::<String>::new());
    }

    #[test]
    fn a_candidate_whose_file_vanished_between_the_stages_is_not_a_change() {
        // The two stages are not atomic and nothing can make them so. A file
        // deleted in the gap must not be reported as an edit, because 021 will
        // ask to show a diff against it and there is nothing to read.
        let tmp = tempfile::tempdir().unwrap();
        let entries = vec![put(tmp.path(), "0000-one.md", "one")];
        std::fs::remove_file(tmp.path().join("0000-one.md")).unwrap();
        let changed = confirm(tmp.path(), &entries, &["id-for-0000-one.md".to_string()]);
        assert_eq!(changed, Vec::<String>::new());
    }

    #[test]
    fn detect_reads_the_manifest_itself_and_reports_the_file_that_changed() {
        // The open path's whole job in one call: the caller has a directory and
        // nothing else. Making it read its own baseline is what lets the scan
        // be spawned with a path and no store lock, which is `pass`'s rule and
        // the reason the open path can afford to run it at all.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let m: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        let edited = m.entries.iter().find(|e| e.words > 0).unwrap();
        std::fs::write(
            out.join(&edited.path),
            "# Letter Storm\n\nEdited elsewhere.\n",
        )
        .unwrap();

        let found = detect(&out);
        assert_eq!(found.changed, vec![edited.id.clone()]);
        assert_eq!(found.deleted_outside, Vec::<String>::new());
        assert_eq!(found.unmatched, Vec::<String>::new());
    }

    #[test]
    fn thorough_check_finds_an_edit_that_preserved_size_and_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let mut manifest: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        let index = manifest.entries.iter().position(|e| e.words > 0).unwrap();
        let path = out.join(&manifest.entries[index].path);
        let original = std::fs::read(&path).unwrap();
        let mut changed = original.clone();
        changed[0] ^= 1;
        std::fs::write(&path, changed).unwrap();
        // Simulate an external tool preserving the metadata baseline while
        // replacing bytes: the normal stat-first scan has no candidate.
        manifest.entries[index].mtime_ms = file_mtime_ms(&path).unwrap();
        crate::recovery::write_manifest(&out, &manifest).unwrap();
        assert!(scan(&out, &manifest.entries).candidates.is_empty());
        let report = check(&out).unwrap();
        assert_eq!(report.report.changed, 1);
        assert_eq!(
            report.found.changed,
            vec![manifest.entries[index].id.clone()]
        );
        assert_eq!(report.report.hashed, report.report.entries);
    }

    #[test]
    fn a_paused_entry_is_rehashed_even_when_its_stat_baseline_still_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let mut manifest: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        let entry = manifest
            .entries
            .iter()
            .find(|entry| entry.words > 0)
            .unwrap()
            .clone();
        let path = out.join(&entry.path);
        let original = std::fs::read(&path).unwrap();
        let mut changed = original.clone();
        changed[0] ^= 1;
        std::fs::write(&path, changed).unwrap();
        manifest
            .entries
            .iter_mut()
            .find(|candidate| candidate.id == entry.id)
            .unwrap()
            .mtime_ms = file_mtime_ms(&path).unwrap();
        crate::recovery::write_manifest(&out, &manifest).unwrap();

        assert!(detect(&out).changed.is_empty());
        let paused = HashSet::from([entry.id.clone()]);
        assert_eq!(
            detect_with_paused(&out, &paused).changed,
            vec![entry.id.clone()]
        );

        std::fs::remove_file(&path).unwrap();
        let deleted = detect_with_paused(&out, &paused);
        assert!(deleted.changed.is_empty());
        assert_eq!(deleted.deleted_outside, vec![entry.id.clone()]);

        std::fs::write(&path, original).unwrap();
        assert!(detect_with_paused(&out, &paused).changed.is_empty());
    }

    #[test]
    fn a_file_reappearing_during_confirmation_is_changed_not_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let manifest: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        let entry = manifest
            .entries
            .iter()
            .find(|entry| entry.words > 0)
            .unwrap();
        let path = out.join(&entry.path);
        let mut changed = std::fs::read(&path).unwrap();
        changed[0] ^= 1;
        std::fs::remove_file(&path).unwrap();

        let found = detect_entries_with(&out, &manifest.entries, &HashSet::new(), || {
            std::fs::write(&path, changed).unwrap();
        });

        assert_eq!(found.changed, vec![entry.id.clone()]);
        assert!(found.deleted_outside.is_empty());
    }

    #[test]
    fn an_unreadable_manifest_keeps_the_existing_pauses() {
        let tmp = tempfile::tempdir().unwrap();
        let paused = HashSet::from(["already-paused".to_string()]);
        assert_eq!(
            detect_with_paused(tmp.path(), &paused).changed,
            vec!["already-paused".to_string()]
        );
    }

    #[test]
    fn a_failed_thorough_check_keeps_partial_changes_and_unreadable_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let manifest: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        let changed = manifest
            .entries
            .iter()
            .find(|entry| entry.words > 0)
            .unwrap()
            .clone();
        let unreadable = manifest
            .entries
            .iter()
            .find(|entry| entry.id != changed.id)
            .unwrap()
            .clone();
        let mut bytes = std::fs::read(out.join(&changed.path)).unwrap();
        bytes.push(b'!');
        std::fs::write(out.join(&changed.path), bytes).unwrap();
        std::fs::remove_file(out.join(&unreadable.path)).unwrap();
        std::fs::create_dir(out.join(&unreadable.path)).unwrap();

        let found = detect_with_paused(&out, &HashSet::new());
        assert!(found.changed.contains(&changed.id));
        assert!(found.changed.contains(&unreadable.id));
        assert!(
            !found.deleted_outside.contains(&unreadable.id),
            "an unreadable entry is one change-set row, not a deletion beside it"
        );

        let failure = check(&out).unwrap_err();
        assert_eq!(failure.report.changed, 1);
        assert!(failure.report.hashed < failure.report.entries);
        let mut expected = vec![changed.id, unreadable.id];
        expected.sort();
        assert_eq!(
            failure.paused, expected,
            "both the observed change and the unreadable file remain protected"
        );
    }

    #[test]
    fn a_pass_with_known_pauses_refuses_a_missing_or_invalid_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let manifest: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        let entry = manifest
            .entries
            .iter()
            .find(|entry| entry.words > 0)
            .unwrap();
        let file = out.join(&entry.path);
        let outside = b"the writer's bytes stay here".to_vec();
        std::fs::write(&file, &outside).unwrap();
        let pauses = HashSet::from([entry.id.clone()]);
        let manifest_path = out.join(crate::recovery::MANIFEST_NAME);

        std::fs::write(&manifest_path, b"not json").unwrap();
        assert!(pass(&src, "my-book", "My Book", &out, NOW + 1, &pauses).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), outside);
        assert_eq!(std::fs::read(&manifest_path).unwrap(), b"not json");

        std::fs::remove_file(&manifest_path).unwrap();
        assert!(pass(&src, "my-book", "My Book", &out, NOW + 2, &pauses).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), outside);
        assert!(!manifest_path.exists());
    }

    #[test]
    fn a_thorough_finding_survives_restart_and_blocks_a_pass_with_empty_ram() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let mut manifest: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        let entry = manifest
            .entries
            .iter()
            .find(|entry| entry.words > 0)
            .unwrap()
            .clone();
        let path = out.join(&entry.path);
        let original = std::fs::read(&path).unwrap();
        let mut outside = original.clone();
        outside[0] ^= 1;
        std::fs::write(&path, &outside).unwrap();
        manifest
            .entries
            .iter_mut()
            .find(|candidate| candidate.id == entry.id)
            .unwrap()
            .mtime_ms = file_mtime_ms(&path).unwrap();
        crate::recovery::write_manifest(&out, &manifest).unwrap();

        let checked = check(&out).unwrap();
        let ids: HashSet<String> = checked.found.changed.iter().cloned().collect();
        persist_pauses(&out, &ids).unwrap();
        assert_eq!(persisted_pauses(&out).unwrap(), ids);

        {
            let store = crate::store::Store::open(&src).unwrap();
            let current = store.load_doc(&entry.id).unwrap();
            store
                .flush(&[crate::store::FlushEntry {
                    item_id: entry.id.clone(),
                    body: doc("the application moved after restart"),
                    base_rev: current.rev,
                    comments: None,
                }])
                .unwrap();
        }
        pass(&src, "my-book", "My Book", &out, NOW + 1, &HashSet::new()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), outside);
        let after_restart = detect_and_persist(&out, &HashSet::new()).unwrap();
        assert_eq!(after_restart.changed, vec![entry.id.clone()]);

        std::fs::write(&path, original).unwrap();
        assert!(detect_and_persist(&out, &HashSet::new())
            .unwrap()
            .changed
            .is_empty());
        assert!(persisted_pauses(&out).unwrap().is_empty());
        pass(&src, "my-book", "My Book", &out, NOW + 2, &HashSet::new()).unwrap();
        assert_ne!(std::fs::read(&path).unwrap(), outside);
    }

    #[test]
    fn a_persist_failure_returns_every_new_finding_to_the_live_pause_path() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let manifest: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        let entry = manifest
            .entries
            .iter()
            .find(|entry| entry.words > 0)
            .unwrap();
        std::fs::write(out.join(&entry.path), b"an outside edit").unwrap();

        let failure = detect_and_persist_with(&out, &HashSet::new(), |_dir, _ids| {
            Err("injected pause-record failure".to_string())
        })
        .unwrap_err();

        assert_eq!(failure.error, "injected pause-record failure");
        assert_eq!(failure.found.changed, vec![entry.id.clone()]);
    }

    #[test]
    fn an_unrecognized_pause_record_is_never_overwritten_and_fails_passes_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let path = out.join(PAUSE_STATE_NAME);
        let unrelated = b"the writer put something else here";
        std::fs::write(&path, unrelated).unwrap();

        assert!(persist_pauses(&out, &HashSet::from(["id".to_string()])).is_err());
        assert!(pass(&src, "my-book", "My Book", &out, NOW + 1, &HashSet::new()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), unrelated);
    }

    #[test]
    fn an_unchanged_pause_record_is_not_rewritten_and_only_real_temps_are_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let ids = HashSet::from(["held".to_string()]);
        persist_pauses(&out, &ids).unwrap();
        let state = out.join(PAUSE_STATE_NAME);
        let before = std::fs::metadata(&state).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        persist_pauses(&out, &ids).unwrap();
        assert_eq!(
            std::fs::metadata(&state).unwrap().modified().unwrap(),
            before
        );

        std::fs::write(out.join(".readable-mirror-pauses.notes"), b"mine").unwrap();
        std::fs::write(out.join(".readable-mirror-pauses.123.4.tmp"), b"old temp").unwrap();
        let found = detect_and_persist(&out, &HashSet::new()).unwrap();
        assert!(found
            .unmatched
            .contains(&".readable-mirror-pauses.notes".to_string()));
        assert!(!found
            .unmatched
            .contains(&".readable-mirror-pauses.123.4.tmp".to_string()));
    }

    #[test]
    fn detect_over_a_mirror_directory_that_is_not_there_is_EMPTY_and_not_an_error() {
        // The open path spawns this and never waits on it. A project whose
        // mirror is off, or whose folder the writer moved to a disconnected
        // drive, has no manifest to read -- and it must still open. Returning a
        // report rather than a Result is the shape that makes "the scan failed"
        // unable to become "the project would not open".
        let tmp = tempfile::tempdir().unwrap();
        let found = detect(&tmp.path().join("no-such-mirror"));
        assert_eq!(found, DetectReport::default());
    }

    #[test]
    fn detect_does_not_pause_a_scene_an_editor_merely_rewrote() {
        // Both stages composed, from the outside. Stage 1 alone would pause
        // this scene, and a paused scene stops being maintained -- so a writer
        // who opened a file to read it would find the mirror quietly frozen for
        // that scene until they resolved a change nobody made.
        //
        // THE MANIFEST'S RECORDED MTIMES ARE MOVED BACK, not the files
        // rewritten. The first version of this test rewrote each file with its
        // own bytes and passed against a `detect` that never called stage 2 at
        // all: `write` inside the same millisecond as the pass leaves
        // `mtime_ms` identical, so stage 1 flagged nothing and the assertion
        // held for the wrong reason. The mutation pass is what found it. The
        // stage-1 assertion below is the guard against it going vacuous again.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let mut m: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        for e in &mut m.entries {
            e.mtime_ms -= 5_000;
        }
        crate::recovery::write_manifest(&out, &m).unwrap();

        // Stage 1 must have something to hand stage 2, or the next assertion
        // is testing an empty list.
        assert_eq!(scan(&out, &m.entries).candidates.len(), m.entries.len());
        assert_eq!(detect(&out).changed, Vec::<String>::new());
    }

    #[test]
    fn detect_reports_a_file_the_writer_deleted_WITHOUT_pausing_it() {
        // The asymmetry the design's own words carry: overwriting an edit
        // destroys writing, and restoring a deleted file destroys nothing. A
        // deletion is reported so 021 can show it, and it is NOT in `changed`,
        // so the next pass writes the file back rather than leaving the
        // writer's folder permanently short a scene with no way to repair it.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let m: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        let gone = m.entries.iter().find(|e| e.words > 0).unwrap();
        std::fs::remove_file(out.join(&gone.path)).unwrap();

        let found = detect(&out);
        assert_eq!(found.deleted_outside, vec![gone.id.clone()]);
        assert_eq!(found.changed, Vec::<String>::new());
    }

    #[test]
    fn a_watched_change_is_not_scanned_the_instant_it_arrives() {
        // An editor writing a file emits several events, and a save that is
        // still in progress is a file whose bytes are half there. Scanning on
        // the first event would hash a partial write and report a change the
        // writer never made.
        assert!(!settled(Some(NOW), NOW));
        assert!(!settled(Some(NOW), NOW + WATCH_QUIET_MS - 1));
    }

    #[test]
    fn a_watched_change_is_scanned_once_the_writing_stops() {
        assert!(settled(Some(NOW), NOW + WATCH_QUIET_MS));
    }

    #[test]
    fn nothing_pending_is_never_settled() {
        // The vacuity guard. If this were true the watcher would rescan on
        // every tick, which is the walk the scan's whole cost argument exists
        // to avoid paying repeatedly.
        assert!(!settled(None, NOW));
    }

    #[test]
    fn a_clock_that_went_backwards_does_not_strand_a_watched_change() {
        // `due`'s rule, for its reason: with a plain subtraction an NTP step
        // backwards leaves a pending change unscanned until the clock catches
        // up -- and the mirror goes on overwriting the file the writer edited
        // for the whole of that window.
        assert!(settled(Some(NOW), NOW - 60_000));
    }

    #[test]
    fn every_directory_gets_a_watch_including_the_mirror_root() {
        // inotify watches a directory and does not recurse, so a container the
        // walk missed is a part of the book the watcher is blind to. The root
        // is in the list because a scene at the top level lives there.
        let tmp = tempfile::tempdir().unwrap();
        put(tmp.path(), "0000-one.md", "one");
        put(tmp.path(), "0001-Part/0000-two.md", "two");
        put(tmp.path(), "0001-Part/0001-Chapter/0000-three.md", "three");

        let mut dirs = watch_dirs(tmp.path());
        dirs.sort();
        assert_eq!(
            dirs,
            vec![
                tmp.path().to_path_buf(),
                tmp.path().join("0001-Part"),
                tmp.path().join("0001-Part").join("0001-Chapter"),
            ]
        );
    }

    #[test]
    fn a_mirror_directory_that_is_not_there_is_watched_NOWHERE() {
        // The watcher is an optimization and never the guarantee. A project
        // whose mirror folder is gone must leave the thread with nothing to
        // watch and no error to report -- the scan is what notices, and it
        // already reports an empty mirror as empty.
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            watch_dirs(&tmp.path().join("no-such-mirror")),
            Vec::<std::path::PathBuf>::new()
        );
    }

    #[test]
    fn a_mirror_nobody_touched_reports_nothing_at_all() {
        // The vacuity guard for every other stage-1 test in this file. If an
        // untouched tree reported candidates, "detected a change" would mean
        // nothing and each test below would pass for the wrong reason.
        let tmp = tempfile::tempdir().unwrap();
        let entries = vec![
            put(tmp.path(), "0000-one.md", "one"),
            put(tmp.path(), "0001-two.md", "two"),
        ];
        let r = scan(tmp.path(), &entries);
        assert_eq!(r.candidates, Vec::<String>::new());
        assert_eq!(r.deleted_outside, Vec::<String>::new());
        assert_eq!(r.unmatched, Vec::<String>::new());
    }

    #[test]
    fn a_file_whose_size_changed_is_a_candidate() {
        let tmp = tempfile::tempdir().unwrap();
        let entries = vec![put(tmp.path(), "0000-one.md", "one")];
        std::fs::write(tmp.path().join("0000-one.md"), "one, but longer").unwrap();
        let r = scan(tmp.path(), &entries);
        assert_eq!(r.candidates, vec!["id-for-0000-one.md".to_string()]);
    }

    #[test]
    fn a_file_whose_mtime_moved_is_a_candidate_even_at_the_same_size() {
        // The whole reason stage 1 compares BOTH. An editor that rewrites a
        // file to the same length is ordinary -- a typo fix is one byte for
        // one byte -- and a size-only check would call that unchanged and
        // overwrite it on the next tick.
        let tmp = tempfile::tempdir().unwrap();
        let mut entries = vec![put(tmp.path(), "0000-one.md", "one")];
        entries[0].mtime_ms -= 5_000;
        let r = scan(tmp.path(), &entries);
        assert_eq!(r.candidates, vec!["id-for-0000-one.md".to_string()]);
    }

    #[test]
    fn a_file_that_is_gone_is_deleted_outside_and_not_a_candidate() {
        // Two different answers about two different situations. A deleted file
        // cannot be hashed in stage 2, so calling it a candidate would send
        // stage 2 to open something that is not there.
        let tmp = tempfile::tempdir().unwrap();
        let entries = vec![put(tmp.path(), "0000-one.md", "one")];
        std::fs::remove_file(tmp.path().join("0000-one.md")).unwrap();
        let r = scan(tmp.path(), &entries);
        assert_eq!(r.deleted_outside, vec!["id-for-0000-one.md".to_string()]);
        assert_eq!(r.candidates, Vec::<String>::new());
    }

    #[test]
    fn a_file_the_manifest_never_wrote_is_unmatched_by_its_path() {
        // Reported by PATH, not by id: an unmatched file has no id -- that is
        // exactly what makes it unmatched -- and inventing one would be the
        // application claiming a file it did not write is one of its own.
        let tmp = tempfile::tempdir().unwrap();
        let entries = vec![put(tmp.path(), "0000-one.md", "one")];
        std::fs::write(tmp.path().join("notes-to-self.md"), "mine").unwrap();
        let r = scan(tmp.path(), &entries);
        assert_eq!(r.unmatched, vec!["notes-to-self.md".to_string()]);
        assert_eq!(r.candidates, Vec::<String>::new());
    }

    #[test]
    fn the_manifest_is_not_reported_as_a_file_the_writer_added() {
        // The application writes manifest.json into the mirror directory
        // itself, so a scan that walked naively would report the application's
        // own bookkeeping as the writer's stray file on every single open.
        let tmp = tempfile::tempdir().unwrap();
        let entries = vec![put(tmp.path(), "0000-one.md", "one")];
        std::fs::write(tmp.path().join("manifest.json"), "{}").unwrap();
        let r = scan(tmp.path(), &entries);
        assert_eq!(r.unmatched, Vec::<String>::new());
    }

    #[test]
    fn the_manifests_temp_file_is_not_reported_either() {
        // A crash between the tmp write and the rename leaves this behind. It
        // is the application's debris, and reporting it would tell the writer
        // about a file they did not create on every open until they deleted it.
        let tmp = tempfile::tempdir().unwrap();
        let entries = vec![put(tmp.path(), "0000-one.md", "one")];
        std::fs::write(tmp.path().join(".manifest.json.tmp"), "{}").unwrap();
        let r = scan(tmp.path(), &entries);
        assert_eq!(r.unmatched, Vec::<String>::new());
    }

    #[test]
    fn an_unmatched_file_is_found_inside_a_container_directory_too() {
        // The layout nests, so a walk that only read the top level would miss
        // a file dropped beside the scenes of a chapter -- which is exactly
        // where a writer would put one.
        let tmp = tempfile::tempdir().unwrap();
        let entries = vec![put(tmp.path(), "0000-part/0000-one.md", "one")];
        std::fs::write(tmp.path().join("0000-part").join("stray.md"), "mine").unwrap();
        let r = scan(tmp.path(), &entries);
        assert_eq!(r.unmatched, vec!["0000-part/stray.md".to_string()]);
    }

    #[test]
    fn a_project_full_of_pictures_leaves_the_mirror_walk_with_nothing_to_report() {
        // THE COST THE DESIGN RECORD PRICED, and it comes to zero because of
        // WHERE the pictures went. `walk_for_unmatched` reports every file under
        // the mirror root the manifest did not write, so a picture directory in
        // there is N stray reports on every open, forever -- and the writer
        // would be told about their own photographs as debris.
        //
        // `pictures::dir_for` derives its path from the STORE, and the mirror is
        // a different tree, so the walk is untouched BY CONSTRUCTION rather than
        // by an exclusion it had to be taught. That is exactly the kind of
        // property a later slice moves without noticing, which is why it is a
        // test and not a remark.
        //
        // THE CONTROL IS IN THE SAME TEST: a real stray file IS reported, so
        // this cannot pass against a walk that reports nothing at all.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let picture = "0198c0de-0000-7000-8000-000000000000.jpg";
        {
            let store = book(&src);
            let made = store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            store.cast_set_picture(&made.id, Some(picture)).unwrap();
        }
        // The directory the host would really have written, with real files in
        // it, sitting exactly where `pictures::dir_for` puts it.
        let pictures = crate::pictures::dir_for(&src);
        std::fs::create_dir_all(&pictures).unwrap();
        std::fs::write(pictures.join(picture), b"\xff\xd8\xff pretend").unwrap();
        std::fs::write(
            pictures.join("0198c0de-0000-7000-8000-000000000000.thumb.png"),
            b"x",
        )
        .unwrap();
        let out = tmp.path().join("mirror").join("my-book");

        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let clean = detect(&out);

        assert_eq!(clean.unmatched, Vec::<String>::new());
        assert!(
            !pictures.starts_with(&out),
            "the pictures landed in the mirror tree"
        );

        // THE CONTROL.
        std::fs::write(out.join("notes-to-self.md"), "mine").unwrap();
        assert_eq!(detect(&out).unmatched, vec!["notes-to-self.md".to_string()]);
    }

    #[test]
    fn a_report_carries_the_last_passs_cause_so_the_indicator_can_name_it() {
        // The design's `failing` state must name the cause (:411). The report
        // is the only channel between the pass and the page, so the cause
        // rides on it or the state cannot exist.
        let tmp = tempfile::tempdir().unwrap();
        let mut outcome = PassOutcome::default();
        outcome.record(Err("mirror/my-book: read-only file system".into()), NOW);

        let r = describe(
            &tmp.path().join("gone"),
            true,
            &outcome,
            &HashSet::new(),
            false,
        );
        assert!(!r.last_ok);
        assert_eq!(
            r.last_error.as_deref(),
            Some("mirror/my-book: read-only file system"),
        );
        assert_eq!(r.last_run_ms, Some(NOW));
    }

    #[test]
    fn a_failed_pass_leaves_its_cause_readable() {
        // C1: 019's background thread sent the cause to stderr and nothing
        // kept it, so the design's `failing` state -- which must name the
        // cause -- had no producer at all. This is that producer.
        let mut outcome = PassOutcome::default();
        outcome.record(Err("mirror/my-book: permission denied".into()), NOW);
        assert!(!outcome.last_ok);
        assert_eq!(
            outcome.last_error.as_deref(),
            Some("mirror/my-book: permission denied"),
        );
        // The ATTEMPT is when it ran, whether or not it worked. A failing
        // mirror that reported no attempt time would read as one that never
        // ran, which is the `off` state and a different sentence.
        assert_eq!(outcome.last_run_ms, Some(NOW));
    }

    #[test]
    fn a_pass_that_succeeds_clears_the_previous_cause() {
        // Without this the indicator reports `failing` forever after one
        // transient error, and a writer whose mirror recovered is told their
        // folder is stale while it is exactly current.
        let mut outcome = PassOutcome::default();
        outcome.record(Err("transient".into()), NOW);
        outcome.record(Ok(()), NOW + 1_000);
        assert!(outcome.last_ok);
        assert_eq!(outcome.last_error, None);
        assert_eq!(outcome.last_run_ms, Some(NOW + 1_000));
    }

    #[test]
    fn a_fresh_outcome_has_not_run_and_is_not_failing() {
        // `never run` and `ran and failed` are two different indicator states
        // and the default must be the first. A default of last_ok=false would
        // make every project with the mirror off report `failing`.
        let outcome = PassOutcome::default();
        assert_eq!(outcome.last_run_ms, None);
        assert!(outcome.last_ok);
        assert_eq!(outcome.last_error, None);
    }

    #[test]
    fn describing_a_project_that_was_never_mirrored_is_not_an_error() {
        // The panel that offers a writer a readable copy of their book must not
        // be able to fail to render, and OFF is the default rather than a
        // failure. A missing directory, an absent manifest and an unparseable
        // one are one answer.
        let tmp = tempfile::tempdir().unwrap();
        let never = tmp.path().join("nothing-here");
        let r = describe(
            &never,
            false,
            &PassOutcome::default(),
            &HashSet::new(),
            false,
        );
        assert!(!r.enabled);
        assert_eq!(r.files, 0);
        assert_eq!(r.generated_at, None);
        // The resolved path is reported even when nothing is there -- it is
        // what the writer is being asked to consent to.
        assert!(r.dir.ends_with("nothing-here"));
    }

    #[test]
    fn describing_a_mirrored_project_reports_its_files_and_when() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let r = describe(&out, true, &PassOutcome::default(), &HashSet::new(), false);
        assert!(r.enabled);
        assert_eq!(r.files, 3);
        assert_eq!(r.generated_at, Some(NOW));
    }

    #[test]
    fn a_report_counts_the_paused_entries_the_MANIFEST_knows_about() {
        // The indicator's `paused` state has to be able to say how many, and
        // the set it counts from outlives nothing: it is installed by the scan
        // and holds ids, not paths. An id the manifest has never heard of is
        // one the scan cannot have produced for THIS mirror, and counting it
        // would report a pause the writer cannot find a file for.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let m: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        let real = m.entries[0].id.clone();
        let paused = HashSet::from([real, "from-another-project".to_string()]);

        let r = describe(&out, true, &PassOutcome::default(), &paused, false);
        assert_eq!(r.paused, 1);
    }

    #[test]
    fn a_report_says_whether_a_pass_is_owed_so_the_line_can_read_updating() {
        // `updating` is the design's second state and the page has no other
        // way to know: the dirty flag lives in the host, and a line that could
        // not say "updating" would show `current` for the whole ten seconds
        // between a writer typing and the pass that catches up.
        let tmp = tempfile::tempdir().unwrap();
        let never = tmp.path().join("nothing-here");
        assert!(describe(&never, true, &PassOutcome::default(), &HashSet::new(), true).updating);
        assert!(
            !describe(
                &never,
                true,
                &PassOutcome::default(),
                &HashSet::new(),
                false
            )
            .updating
        );
    }

    #[test]
    fn a_finding_is_reported_ON_a_current_mirror_and_pauses_NOTHING() {
        // The design spends a paragraph forbidding the confusion this test
        // exists to catch: a finding does not pause the mirror, does not skip
        // the entry and does not fail the pass. Reporting it through `paused`
        // or `last_ok` would claim the folder is out of date at the exact
        // moment it is exactly current -- and the page has no way to tell that
        // apart from a mirror that really did stop keeping up.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let r = describe_with(
            &out,
            true,
            &PassOutcome::default(),
            &HashSet::new(),
            false,
            Some("0000-Winter-Cafe/0000-Letter-Storm.md"),
        );
        assert_eq!(
            r.finding.as_deref(),
            Some("0000-Winter-Cafe/0000-Letter-Storm.md")
        );
        assert_eq!(r.paused, 0);
        assert!(r.last_ok);
        // And the folder is still exactly what the pass wrote. A finding that
        // had skipped the entry would show here as a file short.
        assert_eq!(r.files, 3);
    }

    #[test]
    fn a_mirror_with_nothing_to_report_carries_NO_finding() {
        // The vacuity guard for the test above, and the shipped path's own
        // answer: 007's cross-identity check does not exist in this build, so
        // every report this application produces today carries `None`.
        let tmp = tempfile::tempdir().unwrap();
        let never = tmp.path().join("nothing-here");
        let r = describe(
            &never,
            false,
            &PassOutcome::default(),
            &HashSet::new(),
            false,
        );
        assert_eq!(r.finding, None);
    }

    #[test]
    fn a_book_nobody_edited_is_never_passed_over() {
        // The trigger is a commit, not the clock. A writer who is not typing
        // costs nothing, however long the application stays open -- which is
        // the difference between this schedule and the recovery one, where a
        // writer reorganising an outline still accumulates points.
        assert!(!due(false, None, NOW));
        assert!(!due(false, Some(NOW - STALENESS_BOUND_MS * 100), NOW));
    }

    #[test]
    fn the_first_edit_is_mirrored_without_waiting_out_the_bound() {
        // A writer who enables the mirror and types one sentence should not
        // watch an empty folder for ten seconds.
        assert!(due(true, None, NOW));
    }

    #[test]
    fn a_pass_runs_at_most_once_per_bound() {
        assert!(!due(true, Some(NOW), NOW));
        assert!(!due(true, Some(NOW), NOW + STALENESS_BOUND_MS - 1));
    }

    #[test]
    fn the_bound_is_INCLUSIVE_at_exactly_ten_seconds() {
        // The boundary itself, not near it: `>=` and `>` agree on every other
        // input, and `store::history`'s own hour test is written this way for
        // the same reason.
        assert!(due(true, Some(NOW), NOW + STALENESS_BOUND_MS));
    }

    #[test]
    fn a_clock_that_went_backwards_does_not_freeze_the_mirror() {
        // 018 found this shape on the recovery path and it is worse here. With
        // a plain `now - last >= BOUND`, an NTP step backwards makes the
        // difference negative and the mirror stops passing entirely until the
        // clock catches up -- silently, while the writer keeps typing and the
        // folder they were told is current goes stale.
        assert!(due(true, Some(NOW + STALENESS_BOUND_MS * 6), NOW));
    }

    use std::path::Path;

    /// A part with two scenes, one of which carries prose.
    fn book(path: &Path) -> crate::store::Store {
        let store = crate::store::Store::open(path).unwrap();
        let part = store.item_create(None, "part", "Winter Cafe").unwrap();
        let a = store
            .item_create(Some(&part.id), "scene", "Letter Storm")
            .unwrap();
        store
            .item_create(Some(&part.id), "scene", "Lantern Strasse")
            .unwrap();
        store
            .flush(&[crate::store::FlushEntry {
                item_id: a.id,
                body: doc("four words go here"),
                base_rev: a.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        store
    }

    #[test]
    fn a_paused_entry_is_not_overwritten_and_its_siblings_still_are() {
        // THE FAILURE THIS EXISTS TO CLOSE. The design calls overwriting
        // a writer's external edit because a timer fired "the single worst
        // thing this feature could do" (:496-502), and the mirror originally
        // shipped would do exactly that on the next ten-second tick.
        //
        // BOTH SCENES ARE MADE DIRTY IN THE STORE FIRST, and that is what
        // makes the sibling half mean anything. 019's incremental rule skips
        // any entry at the same rev and path, so a sibling nobody edited is
        // not rewritten either -- and a version of this test that clobbered a
        // file without moving its rev passes against a `pass` that writes
        // NOTHING AT ALL. Ask for two writes and forbid one of them.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");

        let first = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let scenes: Vec<MirrorEntry> = first
            .entries
            .iter()
            .filter(|e| !e.path.ends_with("index.md"))
            .cloned()
            .collect();
        assert_eq!(scenes.len(), 2, "the fixture has two leaves");
        let (held, other) = (scenes[0].clone(), scenes[1].clone());

        // Move BOTH revs, so the pass has real work for each.
        {
            let store = crate::store::Store::open(&src).unwrap();
            for e in [&held, &other] {
                let item = store
                    .items()
                    .unwrap()
                    .into_iter()
                    .find(|i| i.id == e.id)
                    .unwrap();
                store
                    .item_rename(&item.id, &format!("{} again", item.title), item.rev)
                    .unwrap();
            }
        }

        // The writer edits one of them in another editor.
        let mine = "I rewrote this myself.\n";
        std::fs::write(out.join(&held.path), mine).unwrap();

        let paused: HashSet<String> = [held.id.clone()].into_iter().collect();
        let second = pass(&src, "my-book", "My Book", &out, NOW + 20_000, &paused).unwrap();

        assert_eq!(
            std::fs::read_to_string(out.join(&held.path)).unwrap(),
            mine,
            "a paused entry must keep the writer's bytes even though its rev moved",
        );
        // Read the sibling through the REPORT rather than a guessed filename:
        // its title moved, so the segment rule chose its new path and guessing
        // it here would restate that rule in a test.
        let row = second.entries.iter().find(|e| e.id == other.id).unwrap();
        let sibling_now = std::fs::read_to_string(out.join(&row.path)).unwrap();
        assert!(
            sibling_now.contains("again"),
            "an entry that is not paused must still be maintained, got {sibling_now:?}",
        );
    }

    /// Move every item's rev, so a pass has real work to do for each of them.
    ///
    /// Without this the incremental rule skips everything and a pause test
    /// passes against a `pass` that writes nothing at all -- which is how two
    /// of these three were written the first time.
    fn touch_every_item(src: &Path) {
        let store = crate::store::Store::open(src).unwrap();
        for item in store.items().unwrap() {
            store
                .item_rename(&item.id, &format!("{} again", item.title), item.rev)
                .unwrap();
        }
    }

    #[test]
    fn a_paused_entry_keeps_its_manifest_row_describing_the_file_we_wrote() {
        // The manifest must go on describing what the APPLICATION last wrote,
        // not what is on disk now. It is the baseline every later scan and
        // diff compares against; a row that followed the writer's edit would
        // make the change detect itself away on the next pass, and the edit
        // would be silently forgotten.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");

        let first = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let edited = first
            .entries
            .iter()
            .find(|e| !e.path.ends_with("index.md"))
            .unwrap()
            .clone();
        touch_every_item(&src);
        // AND THE PROSE, which is the half `touch_every_item` cannot move: the
        // writer went on typing in the application while their external edit
        // sat unresolved. A row that took the new `doc_rev` would compare equal
        // on the pass after the pause lifted, and the words typed here would
        // never reach the folder -- the same defect, rebuilt inside the pause.
        {
            let store = crate::store::Store::open(&src).unwrap();
            let doc_rev = store.load_doc(&edited.id).unwrap().rev;
            store
                .flush(&[crate::store::FlushEntry {
                    item_id: edited.id.clone(),
                    body: doc("typed while the pause was in force"),
                    base_rev: doc_rev,
                    comments: None,
                }])
                .unwrap();
        }
        std::fs::write(out.join(&edited.path), "mine now").unwrap();

        let paused: HashSet<String> = [edited.id.clone()].into_iter().collect();
        let second = pass(&src, "my-book", "My Book", &out, NOW + 20_000, &paused).unwrap();

        let row = second.entries.iter().find(|e| e.id == edited.id).unwrap();
        assert_eq!(
            row.hash, edited.hash,
            "the baseline must not follow the edit"
        );
        assert_eq!(row.bytes, edited.bytes);
        assert_eq!(
            row.path, edited.path,
            "nor may it follow the rename the paused file did not receive",
        );
        assert_eq!(
            row.doc_rev, edited.doc_rev,
            "nor may it follow prose the paused file was never given",
        );

        // AND THE RESUME, which is what the stale baseline is FOR. Lift the
        // pause and the entry is written, carrying the prose typed above.
        let third = pass(
            &src,
            "my-book",
            "My Book",
            &out,
            NOW + 40_000,
            &HashSet::new(),
        )
        .unwrap();
        let resumed = third.entries.iter().find(|e| e.id == edited.id).unwrap();
        let on_disk = std::fs::read_to_string(out.join(&resumed.path)).unwrap();
        assert!(
            on_disk.contains("typed while the pause was in force"),
            "the resumed pass did not carry the prose typed during the pause:\n{on_disk}"
        );
    }

    #[test]
    fn the_preserved_copy_REPLACES_the_extension_rather_than_following_it() {
        // FOUND BY A SURVIVOR, and it is the shape of the survivor that makes it
        // worth a test of its own: a `from_project_path` that appended instead
        // of replacing produces `0000-Storm.md.from-project.md`, which still
        // ends with the suffix, is still reaped, and is still found by the
        // `is_file` check `can_accept` makes -- so every behavioural test in
        // this slice passed against it. The NAME is the part nothing else could
        // see, and the name is the whole reason the suffix replaces: a folder
        // listing sorts `0000-Storm.md` and `0000-Storm.from-project.md` side by
        // side, which is why the second copy goes BESIDE the first rather than
        // into a directory of its own.
        assert_eq!(
            from_project_path("0000-Part/0001-Storm.md"),
            "0000-Part/0001-Storm.from-project.md"
        );
        // A container's file is `index.md`, and it takes the same rule.
        assert_eq!(
            from_project_path("0000-Part/index.md"),
            "0000-Part/index.from-project.md"
        );
        // A path with no extension at all -- unreachable through `layout`,
        // which always writes one -- keeps its whole name and takes the suffix.
        // Enumerated rather than assumed, on the recorded rule that a naming
        // rule owes an answer for the inputs it was not designed for.
        assert_eq!(from_project_path("odd"), "odd.from-project.md");
    }

    #[test]
    fn a_paused_entry_whose_BOOK_ALSO_MOVED_keeps_the_books_side_as_a_file() {
        // DESIGN SECTION 7, MADE CONCRETE. Both sides moved and neither is
        // stale: the writer edited the file outside while the application was
        // closed, and typed into the same scene inside it. Nothing may be
        // overwritten, and the preservation the design asks for is a FILE the
        // writer can open with anything -- "conflicting versions are preserved
        // rather than silently overwritten" is a promise, and a promise is not
        // an artifact.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        let first = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let edited = first.entries.iter().find(|e| e.words > 0).unwrap().clone();

        // The book moves. `doc_rev` is what can see this -- 029.
        {
            let store = crate::store::Store::open(&src).unwrap();
            let doc_rev = store.load_doc(&edited.id).unwrap().rev;
            store
                .flush(&[crate::store::FlushEntry {
                    item_id: edited.id.clone(),
                    body: doc("the writer kept typing in the application"),
                    base_rev: doc_rev,
                    comments: None,
                }])
                .unwrap();
        }
        std::fs::write(
            out.join(&edited.path),
            "---\nid: x\ntype: scene\n---\n\n# Letter Storm\n\nrewritten outside.\n",
        )
        .unwrap();

        let paused: HashSet<String> = [edited.id.clone()].into_iter().collect();
        let second = pass(&src, "my-book", "My Book", &out, NOW + 20_000, &paused).unwrap();

        let beside = out.join(from_project_path(&edited.path));
        let held = std::fs::read_to_string(&beside)
            .unwrap_or_else(|e| panic!("{}: {e}", beside.display()));
        assert!(
            held.contains("the writer kept typing in the application"),
            "the book's side was not preserved beside the file:\n{held}"
        );
        assert!(
            std::fs::read_to_string(out.join(&edited.path))
                .unwrap()
                .contains("rewritten outside"),
            "the writer's own file was overwritten, which is the whole failure this prevents",
        );

        // IN NO ENTRY AND IN NO SCAN. `entries` is 1:1 with the walk, which is
        // what makes `completeness` countable; and a file the application wrote
        // itself must never come back to the writer as their own stray.
        assert!(
            !second
                .entries
                .iter()
                .any(|e| e.path.contains("from-project")),
            "the sidecar took an entry row"
        );
        let found = detect(&out);
        assert_eq!(
            found.unmatched,
            Vec::<String>::new(),
            "the mirror reported its own preserved copy as the writer's stray file"
        );
    }

    #[test]
    fn a_paused_entry_whose_book_did_NOT_move_gets_no_second_file() {
        // The asymmetry that makes the sidecar mean something. An ordinary
        // external edit has ONE version worth keeping -- the one on disk -- and
        // the book's side is reachable in the application, unchanged, whenever
        // the writer looks. A second file for every pause would put a duplicate
        // of every reviewed scene into the writer's manuscript folder.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        let first = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let edited = first.entries.iter().find(|e| e.words > 0).unwrap().clone();
        std::fs::write(out.join(&edited.path), "rewritten outside").unwrap();

        let paused: HashSet<String> = [edited.id.clone()].into_iter().collect();
        pass(&src, "my-book", "My Book", &out, NOW + 20_000, &paused).unwrap();
        assert!(
            !out.join(from_project_path(&edited.path)).exists(),
            "a pause that is not a conflict wrote a second copy of the scene"
        );
    }

    #[test]
    fn the_books_side_is_taken_away_once_the_entry_stops_being_in_conflict() {
        // The sidecar describes a state, so it must not outlive it. A resolved
        // conflict leaving a `.from-project.md` behind is a stale second draft
        // sitting in the writer's folder, and the next time they open that
        // directory they cannot tell it from the one they are working in.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        let first = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let edited = first.entries.iter().find(|e| e.words > 0).unwrap().clone();
        {
            let store = crate::store::Store::open(&src).unwrap();
            let doc_rev = store.load_doc(&edited.id).unwrap().rev;
            store
                .flush(&[crate::store::FlushEntry {
                    item_id: edited.id.clone(),
                    body: doc("the writer kept typing in the application"),
                    base_rev: doc_rev,
                    comments: None,
                }])
                .unwrap();
        }
        std::fs::write(out.join(&edited.path), "rewritten outside").unwrap();
        let paused: HashSet<String> = [edited.id.clone()].into_iter().collect();
        pass(&src, "my-book", "My Book", &out, NOW + 20_000, &paused).unwrap();
        let beside = out.join(from_project_path(&edited.path));
        assert!(beside.exists(), "the conflict never wrote its second file");

        pass(
            &src,
            "my-book",
            "My Book",
            &out,
            NOW + 40_000,
            &HashSet::new(),
        )
        .unwrap();
        assert!(
            !beside.exists(),
            "the resolved conflict left its second file behind"
        );
    }

    #[test]
    fn a_paused_entry_is_not_counted_as_written() {
        // `written` drives the change event. Counting a skip as a write would
        // make the page reload on every tick while a pause was in force.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        let first = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let all: HashSet<String> = first.entries.iter().map(|e| e.id.clone()).collect();

        // Every rev moved, so an unpaused pass would rewrite the whole book.
        touch_every_item(&src);
        let second = pass(&src, "my-book", "My Book", &out, NOW + 20_000, &all).unwrap();
        assert_eq!(
            second.written, 0,
            "every entry is paused, so nothing may be written despite every rev moving",
        );
    }

    fn files_under(dir: &Path) -> Vec<String> {
        fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, base, out);
                } else {
                    out.push(
                        p.strip_prefix(base)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out.sort();
        out
    }

    #[test]
    fn a_first_pass_writes_one_file_per_item_and_a_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");

        let report = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        assert_eq!(report.written, 3);
        assert_eq!(
            files_under(&out),
            [
                ".readable-mirror-wordlist.json",
                "0000-Winter-Cafe/0000-Letter-Storm.md",
                "0000-Winter-Cafe/0001-Lantern-Strasse.md",
                "0000-Winter-Cafe/index.md",
                "manifest.json",
                "wordlist.txt",
            ]
        );
        let prose =
            std::fs::read_to_string(out.join("0000-Winter-Cafe/0000-Letter-Storm.md")).unwrap();
        assert!(prose.contains("four words go here"), "{prose}");
    }

    #[test]
    fn a_pass_over_an_unchanged_book_writes_nothing() {
        // THE INCREMENTAL CLAIM. Without it the mirror rewrites 20,000 files
        // every ten seconds, which is the 115 ms pathological pass running as
        // the ordinary one.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");

        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let second = pass(&src, "my-book", "My Book", &out, NOW + 1, &HashSet::new()).unwrap();

        assert_eq!(second.written, 0, "an unchanged book was rewritten");
        assert_eq!(second.removed, 0);
        assert_eq!(second.entries.len(), 3, "the manifest lost its entries");
    }

    #[test]
    fn renaming_one_item_rewrites_ONLY_that_file() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let store = book(&src);
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let items = store.items().unwrap();
        let target = items.iter().find(|i| i.title == "Lantern Strasse").unwrap();
        let rev = store
            .item_rename(&target.id, "Lantern Strasse Revisited", target.rev)
            .unwrap();
        assert!(rev > target.rev);
        drop(store);

        let second = pass(&src, "my-book", "My Book", &out, NOW + 1, &HashSet::new()).unwrap();
        assert_eq!(
            second.written, 1,
            "more than the changed item was rewritten"
        );
    }

    #[test]
    fn a_prose_edit_reaches_the_file() {
        // THE DEFECT 029 EXISTS TO CLOSE, and the one property the whole
        // feature is for: a writer types, and the folder they opened in another
        // editor carries what they typed.
        //
        // `flush` is the ONLY path a keystroke takes to disk, and it bumps the
        // `doc` row's revision. `item.rev` -- what `MirrorEntry.rev` records --
        // does not move for prose, so a skip keyed on it alone made every edit
        // after the first pass invisible to the mirror, permanently.
        //
        // ASSERTS THE PROSE ON DISK, not `written`. A count of 1 is satisfied by
        // a pass that rewrote the file with the body it already had, which is
        // exactly what a half-fix would do.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let store = book(&src);
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let items = store.items().unwrap();
        let target = items.iter().find(|i| i.title == "Letter Storm").unwrap();
        let doc_rev = store.load_doc(&target.id).unwrap().rev;
        store
            .flush(&[crate::store::FlushEntry {
                item_id: target.id.clone(),
                body: doc("the writer typed something entirely new"),
                base_rev: doc_rev,
                comments: None,
            }])
            .unwrap();
        drop(store);

        pass(&src, "my-book", "My Book", &out, NOW + 1, &HashSet::new()).unwrap();

        let on_disk =
            std::fs::read_to_string(out.join("0000-Winter-Cafe/0000-Letter-Storm.md")).unwrap();
        assert!(
            on_disk.contains("entirely new"),
            "the mirror file does not carry the prose the writer typed:\n{on_disk}"
        );
        assert!(
            !on_disk.contains("four words go here"),
            "the mirror file still carries the prose the scene was born with:\n{on_disk}"
        );
    }

    #[test]
    fn a_manifest_written_before_prose_revisions_repairs_itself() {
        // THE MIRRORS ALREADY ON DISK. 019 and 020 wrote entries with no
        // `doc_rev` key at all, and every one of them describes a file whose
        // prose stopped being maintained the moment it was first written. The
        // sentinel is what gets those writers their words back without asking
        // them to do anything: a missing key reads as 0, 0 is not a revision
        // any document has, so the next pass rewrites the entry once.
        //
        // Drives it through the MANIFEST ON DISK rather than through a
        // constructed `MirrorEntry`, because the key being absent from the JSON
        // is the whole condition and a struct literal cannot express it.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let store = book(&src);
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        drop(store);

        // Strip every `doc_rev` from the manifest, which is exactly the shape
        // 019 and 020 wrote.
        let manifest_path = out.join("manifest.json");
        let raw = std::fs::read_to_string(&manifest_path).unwrap();
        assert!(
            raw.contains("\"doc_rev\""),
            "the field is not in the manifest at all"
        );
        let stripped = regex_free_strip(&raw);
        assert!(
            !stripped.contains("\"doc_rev\""),
            "the strip did not remove the key"
        );
        std::fs::write(&manifest_path, &stripped).unwrap();

        let entries: Vec<MirrorEntry> = crate::recovery::read_manifest(&out)
            .map(|m: crate::recovery::Manifest<MirrorEntry>| m.entries)
            .expect("a manifest without the key must still be readable");
        assert!(entries.iter().all(|e| e.doc_rev == 0));

        // Nothing in the book changed; the pass rewrites the documents anyway,
        // because it cannot tell a 019-era row from a scene whose prose it has
        // never seen -- and rewriting is the safe direction.
        // TWO OF THE THREE ITEMS, and the third is the assertion that matters:
        // both scenes carry a `doc` row from the moment they were created, so
        // both are repaired -- while the part is a container with no document
        // at all, compares 0 to 0, and is correctly left alone. A repair that
        // rewrote the container too would be the sentinel failing to tell
        // "no document" from "no record of one".
        let second = pass(&src, "my-book", "My Book", &out, NOW + 1, &HashSet::new()).unwrap();
        assert_eq!(
            second.written, 2,
            "the scenes were not repaired, or the part was rewritten"
        );
        let repaired: Vec<MirrorEntry> = crate::recovery::read_manifest(&out)
            .map(|m: crate::recovery::Manifest<MirrorEntry>| m.entries)
            .unwrap();
        assert!(
            repaired.iter().any(|e| e.doc_rev > 0),
            "the repaired manifest still records no prose revision"
        );

        // And it settles: a third pass over the repaired manifest writes
        // nothing, or the mirror would rewrite the whole book every ten
        // seconds forever.
        let third = pass(&src, "my-book", "My Book", &out, NOW + 2, &HashSet::new()).unwrap();
        assert_eq!(third.written, 0, "the repair did not settle");
    }

    /// Remove every `"doc_rev": N,` from a manifest, without a regex crate.
    fn regex_free_strip(raw: &str) -> String {
        let mut out = String::with_capacity(raw.len());
        let mut rest = raw;
        while let Some(at) = rest.find("\"doc_rev\":") {
            out.push_str(&rest[..at]);
            let after = &rest[at..];
            let end = after.find(',').expect("a doc_rev is never the last key");
            rest = &after[end + 1..];
        }
        out.push_str(rest);
        out
    }

    #[test]
    fn a_prose_edit_moves_the_manifests_word_count() {
        // The manifest's `words` is written by the same pass, so the skip that
        // hid the prose hid the count with it -- and `completeness` is built
        // from these numbers, so a stale one describes a book nobody has.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let store = book(&src);
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let items = store.items().unwrap();
        let target = items.iter().find(|i| i.title == "Letter Storm").unwrap();
        let doc_rev = store.load_doc(&target.id).unwrap().rev;
        let before: Vec<MirrorEntry> = crate::recovery::read_manifest(&out)
            .map(|m: crate::recovery::Manifest<MirrorEntry>| m.entries)
            .unwrap();
        let was = before.iter().find(|e| e.id == target.id).unwrap().words;
        assert_eq!(was, 4, "the fixture no longer starts at four words");

        store
            .flush(&[crate::store::FlushEntry {
                item_id: target.id.clone(),
                body: doc("one two three four five six seven"),
                base_rev: doc_rev,
                comments: None,
            }])
            .unwrap();
        drop(store);
        pass(&src, "my-book", "My Book", &out, NOW + 1, &HashSet::new()).unwrap();

        let after: Vec<MirrorEntry> = crate::recovery::read_manifest(&out)
            .map(|m: crate::recovery::Manifest<MirrorEntry>| m.entries)
            .unwrap();
        assert_eq!(after.iter().find(|e| e.id == target.id).unwrap().words, 7);
    }

    #[test]
    fn a_rename_the_PATH_cannot_see_still_rewrites_the_file() {
        // WHY `rev` IS IN THE SKIP AT ALL, and the mutation pass is what asked
        // the question: with `doc_rev` and `path` both compared, what is left
        // for the item's own revision to catch?
        //
        // This. The segment rule REMOVES a soft hyphen, so two titles that
        // differ by one produce the same filename -- while the `# ` heading
        // inside the file is the title verbatim and does differ. `doc_rev` did
        // not move (no prose was typed) and `path` did not move (same segment),
        // so without `rev` the file would keep the old title for the life of
        // the project.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let store = book(&src);
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let items = store.items().unwrap();
        let target = items.iter().find(|i| i.title == "Lantern Strasse").unwrap();
        let renamed = "Lantern\u{00AD} Strasse";
        assert_eq!(
            segment(renamed),
            segment("Lantern Strasse"),
            "the fixture no longer produces the same path, so this proves nothing"
        );
        store.item_rename(&target.id, renamed, target.rev).unwrap();
        drop(store);

        pass(&src, "my-book", "My Book", &out, NOW + 1, &HashSet::new()).unwrap();
        let on_disk =
            std::fs::read_to_string(out.join("0000-Winter-Cafe/0001-Lantern-Strasse.md")).unwrap();
        assert!(
            on_disk.contains(renamed),
            "the file kept a title the writer changed:\n{on_disk}"
        );
    }

    #[test]
    fn renaming_an_item_moves_its_file_and_leaves_no_ghost() {
        // The path carries the title, so a rename changes it. A pass that only
        // ever wrote would leave the old file beside the new one, and the
        // writer would have two copies of one scene in their manuscript folder.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let store = book(&src);
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let items = store.items().unwrap();
        let target = items.iter().find(|i| i.title == "Letter Storm").unwrap();
        store
            .item_rename(&target.id, "Snow Light", target.rev)
            .unwrap();
        drop(store);

        let second = pass(&src, "my-book", "My Book", &out, NOW + 1, &HashSet::new()).unwrap();
        assert_eq!(second.removed, 1, "the old path survived the rename");
        assert!(files_under(&out).contains(&"0000-Winter-Cafe/0000-Snow-Light.md".to_string()));
        assert!(!files_under(&out).contains(&"0000-Winter-Cafe/0000-Letter-Storm.md".to_string()));
    }

    #[test]
    fn a_sibling_whose_ORDINAL_moved_is_rewritten_even_though_its_rev_did_not() {
        // SAME REV, DIFFERENT PATH, which is the case a rev-only comparison
        // misses -- and the mutation pass caught that nothing here covered it.
        //
        // It is not exotic. Reordering one scene renumbers every sibling after
        // it, and those siblings were not edited: their `rev` is untouched and
        // their filename is now wrong. A rev-only check leaves every one of
        // them at its old path, so the writer opens their folder and finds two
        // copies of each scene with the ordinals disagreeing about the order.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let store = book(&src);
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let items = store.items().unwrap();
        let part = items.iter().find(|i| i.title == "Winter Cafe").unwrap();
        let second = items.iter().find(|i| i.title == "Lantern Strasse").unwrap();
        let untouched = items.iter().find(|i| i.title == "Letter Storm").unwrap();
        let rev_before = untouched.rev;
        // Move the second scene to the front of its parent.
        store
            .item_move(&second.id, Some(&part.id), None, second.rev)
            .unwrap();
        let after = store.items().unwrap();
        let still = after.iter().find(|i| i.title == "Letter Storm").unwrap();
        assert_eq!(
            still.rev, rev_before,
            "the fixture edited the untouched item"
        );
        drop(store);

        pass(&src, "my-book", "My Book", &out, NOW + 1, &HashSet::new()).unwrap();

        let files = files_under(&out);
        assert!(
            files.contains(&"0000-Winter-Cafe/0001-Letter-Storm.md".to_string()),
            "the unedited sibling kept its old ordinal: {files:?}"
        );
        assert!(
            !files.contains(&"0000-Winter-Cafe/0000-Letter-Storm.md".to_string()),
            "the old path survived: {files:?}"
        );
    }

    /// THE OPPOSITE ANSWER FOR THE OTHER SECTION, and it comes for free: the
    /// mirror walks `manuscript_items`, which KEEPS front matter because front
    /// matter is in the book. A readable copy of a manuscript that left the
    /// dedication out would be a copy of something else.
    ///
    /// Pinned rather than assumed, because "free" is a claim about a filter two
    /// modules share and the next reader of that filter is as likely to narrow
    /// it as to widen it.
    #[test]
    fn front_matter_is_the_manuscript_and_is_mirrored_with_it() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let store = book(&src);
        let out = tmp.path().join("mirror").join("my-book");

        let front = store
            .item_create(None, crate::store::FRONT_MATTER_TYPE, "Front matter")
            .unwrap();
        let dedication = store
            .item_create(Some(&front.id), crate::store::MATTER_TYPE, "Dedication")
            .unwrap();
        store
            .flush(&[crate::store::FlushEntry {
                item_id: dedication.id.clone(),
                body: doc("for three good people"),
                base_rev: dedication.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        drop(store);

        let report = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let files = files_under(&out);
        assert!(
            files.iter().any(|f| f.contains("Dedication")),
            "the dedication is missing from the mirror: {files:?}"
        );
        let mirrored: u64 = report.entries.iter().map(|e| e.words).sum();
        assert_eq!(
            mirrored, 8,
            "the manifest's manuscript figure must hold the dedication's words"
        );
    }

    #[test]
    fn the_BIBLE_is_not_the_manuscript_and_is_never_mirrored() {
        // The bin's argument, with the sign flipped: the bible is visible and
        // the writer is meant to have it, but a `Bible` directory of `.md` files
        // in the manuscript folder is a folder that no longer describes a book --
        // and its words would land in the manifest's `words`, so `completeness`
        // would describe a manuscript nobody wrote.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let store = book(&src);
        let out = tmp.path().join("mirror").join("my-book");

        let bible = store
            .item_create(None, crate::store::BIBLE_TYPE, "Bible")
            .unwrap();
        let note = store
            .item_create(Some(&bible.id), crate::store::NOTE_TYPE, "Magic System")
            .unwrap();
        store
            .flush(&[crate::store::FlushEntry {
                item_id: note.id.clone(),
                body: doc("five whole words of worldbuilding"),
                base_rev: note.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        drop(store);

        let report = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let files = files_under(&out);
        assert!(
            !files
                .iter()
                .any(|f| f.contains("Bible") || f.contains("Magic-System")),
            "the bible reached the mirror: {files:?}"
        );
        let mirrored: u64 = report.entries.iter().map(|e| e.words).sum();
        assert_eq!(
            mirrored, 4,
            "the bible's words entered the manifest's manuscript figure"
        );
    }

    /// A TIMELINE WRITES NO FILE (101, the timeline design's section 3). Not
    /// a new exclusion of its own: it lives under the bible exactly as a note
    /// does, and `manuscript_items` above already drops the whole subtree
    /// before `pass` ever builds `items`. This pins that the existing bible
    /// skip covers it, so a later change narrowing the bible exclusion by
    /// item type would be caught here rather than by a JSON file quietly
    /// appearing in a writer's Markdown folder.
    #[test]
    fn a_timeline_under_the_bible_is_never_mirrored() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let store = book(&src);
        let out = tmp.path().join("mirror").join("my-book");

        let bible = store
            .item_create(None, crate::store::BIBLE_TYPE, "Bible")
            .unwrap();
        let timeline = store
            .item_create(Some(&bible.id), crate::store::TIMELINE_TYPE, "Timeline")
            .unwrap();
        store
            .flush(&[crate::store::FlushEntry {
                item_id: timeline.id.clone(),
                body: crate::store::EMPTY_TIMELINE_BODY.to_string(),
                base_rev: timeline.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        drop(store);

        let report = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let files = files_under(&out);
        assert!(
            !files.iter().any(|f| f.contains("Timeline")),
            "the timeline reached the mirror: {files:?}"
        );
        let mirrored: u64 = report.entries.iter().map(|e| e.words).sum();
        assert_eq!(
            mirrored, 4,
            "must be the base fixture's scene alone -- a nonzero delta above \
             it would mean the timeline's body reached the manuscript figure"
        );
    }

    /// A SYNOPSIS IS NOT WRITTEN INTO THE FOLDER, AND THE SKIP IS UNTOUCHED.
    ///
    /// This is a decision that was required to be taken rather than deferred,
    /// and it is the NEGATIVE half of it: because a synopsis never reaches a
    /// file, `pass` needs no fourth condition and `MirrorEntry` needs no
    /// `syn_rev`. Retrofitting a missing revision into this skip is exactly the
    /// defect that hid for a long time, so the alternative had to be settled
    /// here. The short form is that this format is BIDIRECTIONAL -- `read_file` puts
    /// any front-matter key it does not know into `extra`, `change_set` turns a
    /// non-empty `extra` into `FRONT_MATTER`, and that is a refusal. A
    /// `synopsis:` key would make every externally edited file unacceptable
    /// until the reader learned it, and the accept path would then owe the
    /// writer a way back into the store for a value `one_line` had already
    /// folded to a single line.
    ///
    /// THE CONTROL IS IN THE SAME TEST, and it is what stops this being the
    /// recorded vacuous shape: a mirror assertion that no file was written
    /// passes against a `pass` that writes nothing at all. So the second half
    /// flushes prose into the same book and asserts ONE file is rewritten.
    #[test]
    fn a_synopsis_only_change_rewrites_no_mirror_file_and_a_prose_edit_still_does() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let scene = {
            let store = book(&src);
            store
                .items()
                .unwrap()
                .into_iter()
                .find(|i| i.title == "Letter Storm")
                .unwrap()
                .id
        };
        let out = tmp.path().join("mirror").join("my-book");

        let first = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        assert!(first.written > 0, "the first pass has to write the book");

        {
            let store = crate::store::Store::open(&src).unwrap();
            store
                .synopsis_set(&scene, "she finds the letter and burns it")
                .unwrap();
        }
        let second = pass(
            &src,
            "my-book",
            "My Book",
            &out,
            NOW + 20_000,
            &HashSet::new(),
        )
        .unwrap();

        assert_eq!(
            second.written, 0,
            "a synopsis reached the writer's folder, or churned a file that did not change"
        );
        let on_disk =
            std::fs::read_to_string(out.join("0000-Winter-Cafe/0000-Letter-Storm.md")).unwrap();
        assert!(
            !on_disk.contains("burns it"),
            "the synopsis is in the file: {on_disk}"
        );
        assert!(
            !on_disk.contains("synopsis"),
            "the front matter grew a key the reader would refuse: {on_disk}"
        );

        // THE CONTROL. Same book, same directory, one real prose change.
        {
            let store = crate::store::Store::open(&src).unwrap();
            let rev = store.load_doc(&scene).unwrap().rev;
            store
                .flush(&[crate::store::FlushEntry {
                    item_id: scene.clone(),
                    body: doc("the writer typed something entirely new"),
                    base_rev: rev,
                    comments: None,
                }])
                .unwrap();
        }
        let third = pass(
            &src,
            "my-book",
            "My Book",
            &out,
            NOW + 40_000,
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(
            third.written, 1,
            "the pass writes nothing at all, so the assertion above proves nothing"
        );
    }

    /// THE CAST IS NOT WRITTEN INTO THE FOLDER EITHER, AND THE SKIP IS STILL
    /// UNTOUCHED.
    ///
    /// Same decision as the synopsis one above and taken on the same argument,
    /// which is why it is asserted rather than assumed: the format is
    /// BIDIRECTIONAL, an unknown front-matter key lands in `extra`, and
    /// `change_set` turns a non-empty `extra` into `FRONT_MATTER` -- a refusal
    /// that would make every externally edited file unacceptable. A cast member
    /// is additionally not ABOUT any one file: it belongs to the book, and there
    /// is no `.md` in the tree it could ride on without inventing a directory
    /// the reader would then have to learn.
    ///
    /// THE CONTROL IS IN THE SAME TEST, for the recorded reason: an assertion
    /// that no file was written passes against a `pass` that writes nothing at
    /// all, which is how two of three pause tests once came to mean
    /// nothing.
    #[test]
    fn a_cast_change_rewrites_no_mirror_file_and_a_prose_edit_still_does() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let scene = {
            let store = book(&src);
            store
                .items()
                .unwrap()
                .into_iter()
                .find(|i| i.title == "Letter Storm")
                .unwrap()
                .id
        };
        let out = tmp.path().join("mirror").join("my-book");

        let first = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        assert!(first.written > 0, "the first pass has to write the book");

        {
            let store = crate::store::Store::open(&src).unwrap();
            let made = store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse Vandermeer")
                .unwrap();
            store
                .cast_set(
                    &made.id,
                    crate::store::cast::KIND_CHARACTER,
                    "Ilse Vandermeer",
                    "she finds the letter and burns it",
                    &[crate::store::cast::CastField {
                        label: "accent".into(),
                        value: "flat northern".into(),
                    }],
                    &[],
                )
                .unwrap();
        }
        let second = pass(
            &src,
            "my-book",
            "My Book",
            &out,
            NOW + 20_000,
            &HashSet::new(),
        )
        .unwrap();

        assert_eq!(
            second.written, 0,
            "the cast reached the writer's folder, or churned a file that did not change"
        );
        let entries: Vec<String> = std::fs::read_dir(&out)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            !entries.iter().any(|e| e.to_lowercase().contains("cast")),
            "the mirror grew a directory for the cast: {entries:?}"
        );
        let on_disk =
            std::fs::read_to_string(out.join("0000-Winter-Cafe/0000-Letter-Storm.md")).unwrap();
        assert!(
            !on_disk.contains("Vandermeer") && !on_disk.contains("burns it"),
            "the cast is in the file: {on_disk}"
        );
        assert!(
            !on_disk.contains("cast"),
            "the front matter grew a key the reader would refuse: {on_disk}"
        );

        // THE CONTROL. Same book, same directory, one real prose change.
        {
            let store = crate::store::Store::open(&src).unwrap();
            let rev = store.load_doc(&scene).unwrap().rev;
            store
                .flush(&[crate::store::FlushEntry {
                    item_id: scene.clone(),
                    body: doc("the writer typed something entirely new"),
                    base_rev: rev,
                    comments: None,
                }])
                .unwrap();
        }
        let third = pass(
            &src,
            "my-book",
            "My Book",
            &out,
            NOW + 40_000,
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(
            third.written, 1,
            "the pass writes nothing at all, so the assertion above proves nothing"
        );
    }

    #[test]
    fn the_BIN_is_not_the_manuscript_and_is_never_mirrored() {
        // `without_trashed` is what export, search and the word count already
        // use, and its own doc comment is the argument: it is "what the
        // manuscript is, as opposed to what the writer can see". Mirroring the
        // walk raw puts a `Trash` directory in the writer's manuscript folder
        // and puts every scene they deleted back in front of them.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        let store = book(&src);
        let out = tmp.path().join("mirror").join("my-book");

        let bin = store
            .item_create(None, crate::store::TRASH_TYPE, crate::store::TRASH_TITLE)
            .unwrap();
        store
            .item_create(Some(&bin.id), "scene", "Deleted Scene")
            .unwrap();
        drop(store);

        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let files = files_under(&out);
        assert!(
            !files
                .iter()
                .any(|f| f.contains("Trash") || f.contains("Deleted-Scene")),
            "the bin reached the mirror: {files:?}"
        );
    }

    #[test]
    fn a_pass_never_writes_to_the_project_it_is_reading() {
        // `open_readonly`, never `open`. `open` MIGRATES, and a mirror pass
        // that upgraded the schema of the writer's project would close their
        // book to the build they are running -- while claiming to be a
        // read-only projection.
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");

        let before = std::fs::read(&src).unwrap();
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        assert_eq!(
            std::fs::read(&src).unwrap(),
            before,
            "the pass wrote to the project"
        );
    }

    #[test]
    fn the_manifest_describes_the_projection_it_just_wrote() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");

        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();

        let m: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        assert_eq!(m.kind, "mirror");
        assert_eq!(m.project.slug, "my-book");
        // `entries` is 1:1 with the store's walk, which is what makes
        // `completeness` a countable claim rather than an adjective.
        assert_eq!(m.entries.len(), 3);
        assert_eq!(m.completeness.entries_written, 3);
        assert_eq!(m.completeness.items_total, 3);
        assert_eq!(m.completeness.documents_with_prose, 1);
        assert_eq!(m.completeness.unreadable_bodies, 0);
        // The entry that carries prose carries its word count with it.
        let prose = m.entries.iter().find(|e| e.words > 0).unwrap();
        assert_eq!(prose.words, 4);
        assert_eq!(prose.path, "0000-Winter-Cafe/0000-Letter-Storm.md");
    }

    fn doc(text: &str) -> String {
        crate::test_support::body(text)
    }

    /// The lines between the two `---` fences.
    fn front_matter(rendered: &str) -> Vec<String> {
        let mut lines = rendered.lines();
        assert_eq!(
            lines.next(),
            Some("---"),
            "no opening fence in {rendered:?}"
        );
        lines
            .take_while(|l| *l != "---")
            .map(str::to_string)
            .collect()
    }

    /// A mirrored book on disk, and everything `change_set` needs about it.
    struct Mirrored {
        src: std::path::PathBuf,
        out: std::path::PathBuf,
        entries: Vec<MirrorEntry>,
    }

    /// The fixture every change-set test starts from: a real book, mirrored.
    ///
    /// Real files and a real manifest, because the rows are about what is ON
    /// DISK and a constructed entry could describe a file that was never
    /// written that way.
    fn mirrored(tmp: &Path) -> Mirrored {
        let src = tmp.join("my-book.db");
        drop(book(&src));
        let out = tmp.join("mirror").join("my-book");
        let report = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        age_manifest(&out);
        Mirrored {
            src,
            out,
            entries: report.entries,
        }
    }

    /// Move every recorded `mtime_ms` back by one, so stage 1 flags every entry
    /// and stage 2 is what decides.
    ///
    /// NOT A CONVENIENCE. `std::fs::write` inside the same millisecond as the
    /// pass leaves `mtime_ms` untouched, so a rewrite that happens to preserve
    /// the byte COUNT is invisible to stage 1 -- and two of these tests hit that
    /// by accident on the first run, one of them because replacing a 36-byte
    /// UUID with a 21-byte forgery and appending 19 bytes of prose came to
    /// exactly zero. Both reported no rows and looked like a broken change set.
    /// This is the recorded fix from an earlier mutation pass: move the manifest
    /// rather than touch the files, and let the hash answer.
    fn age_manifest(dir: &Path) {
        let manifest: crate::recovery::Manifest<MirrorEntry> =
            crate::recovery::read_manifest(dir).unwrap();
        let mut manifest = manifest;
        for entry in &mut manifest.entries {
            entry.mtime_ms -= 1;
        }
        crate::recovery::write_manifest(dir, &manifest).unwrap();
    }

    /// The scene that has prose, which is the one every applicable row is about.
    fn prose_entry(m: &Mirrored) -> MirrorEntry {
        m.entries
            .iter()
            .find(|e| e.words > 0)
            .expect("the fixture has no scene with prose")
            .clone()
    }

    /// `change_set` over the current state of a mirrored book.
    fn changes_now(m: &Mirrored) -> Vec<Change> {
        let store = crate::store::Store::open_readonly(&m.src).unwrap();
        let items = crate::store::without_trashed(store.items().unwrap());
        let bodies = store.documents().unwrap();
        let doc_revs = store.document_revs().unwrap();
        drop(store);
        let entries: Vec<MirrorEntry> = crate::recovery::read_manifest(&m.out)
            .map(|man: crate::recovery::Manifest<MirrorEntry>| man.entries)
            .unwrap_or_default();
        let found = detect(&m.out);
        change_set(&m.out, &entries, &items, &bodies, &doc_revs, &found)
    }

    /// A copied database can carry the same document revision while its prose
    /// differs. This fixture writes that impossible-through-the-app state so
    /// the mirror cannot mistake matching counters for matching content.
    fn replace_body_without_revision(path: &Path, id: &str, text: &str) {
        rusqlite::Connection::open(path)
            .unwrap()
            .execute(
                "UPDATE doc SET body = ?1 WHERE item_id = ?2",
                rusqlite::params![doc(text), id],
            )
            .unwrap();
    }

    /// Rewrite one mirror file with a body of the writer's own, keeping the
    /// front matter and heading the application wrote.
    fn rewrite_prose(m: &Mirrored, entry: &MirrorEntry, prose: &str) {
        let current = std::fs::read_to_string(m.out.join(&entry.path)).unwrap();
        let head: Vec<&str> = current
            .lines()
            .take_while(|l| !l.starts_with("# "))
            .collect();
        let heading = current.lines().find(|l| l.starts_with("# ")).unwrap();
        let next = format!("{}\n{}\n\n{}\n", head.join("\n"), heading, prose);
        std::fs::write(m.out.join(&entry.path), next).unwrap();
    }

    #[test]
    fn a_scene_edited_outside_is_an_APPLICABLE_prose_row() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");

        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "expected exactly one row, got {rows:?}");
        let row = &rows[0];
        assert_eq!(row.state, PROSE);
        assert_eq!(row.id, entry.id);
        assert_eq!(row.path, entry.path);
        // BOTH SIDES, or the panel has no diff to draw.
        let file = crate::store::document_text(row.file_body.as_ref().unwrap()).unwrap();
        let store = crate::store::document_text(row.store_body.as_ref().unwrap()).unwrap();
        assert_eq!(file, "the writer rewrote this in another editor");
        assert_eq!(store, "four words go here");
    }

    /// AND A SCENE THAT HAS A SYNOPSIS IS STILL AN ORDINARY FILE TO READ BACK.
    ///
    /// The other half of the mirror decision. The reason a synopsis stays out of
    /// the front matter is that `read_file` collects an unknown key into `extra`
    /// and `change_set` turns a non-empty `extra` into `FRONT_MATTER` -- a
    /// refusal, which would make the writer's own prose edit unacceptable. This
    /// asserts the refusal is NOT triggered: the same edit on the same scene
    /// reports as PROSE whether or not the item carries a synopsis.
    #[test]
    fn a_scene_that_has_a_synopsis_is_still_an_ordinary_file_to_read_back() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        {
            let store = crate::store::Store::open(&m.src).unwrap();
            store
                .synopsis_set(&entry.id, "she burns the letter before dawn")
                .unwrap();
        }
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");

        let rows = changes_now(&m);

        assert_eq!(rows.len(), 1, "expected exactly one row, got {rows:?}");
        assert_eq!(
            rows[0].state, PROSE,
            "a scene carrying a synopsis reads back as {:?} rather than an ordinary prose edit",
            rows[0].state
        );
    }

    /// AND A BOOK THAT HAS A CAST IS STILL AN ORDINARY FILE TO READ BACK.
    ///
    /// The other half of the decision above, and the same shape as the synopsis
    /// pair: this asserts the `FRONT_MATTER` refusal is NOT triggered, so the
    /// writer's own prose edit still reports as PROSE with a cast in the file.
    #[test]
    fn a_scene_in_a_book_that_has_a_cast_is_still_an_ordinary_file_to_read_back() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        {
            let store = crate::store::Store::open(&m.src).unwrap();
            store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse Vandermeer")
                .unwrap();
        }
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");

        let rows = changes_now(&m);

        assert_eq!(rows.len(), 1, "expected exactly one row, got {rows:?}");
        assert_eq!(
            rows[0].state, PROSE,
            "a book carrying a cast reads back as {:?} rather than an ordinary prose edit",
            rows[0].state
        );
    }

    #[test]
    fn a_mirror_nobody_touched_has_NO_rows() {
        // The vacuity guard every test above depends on: if an untouched
        // mirror produced rows, "exactly one row" would be a claim about
        // arithmetic rather than about detection.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        assert_eq!(changes_now(&m), Vec::new());
    }

    #[test]
    fn equal_revisions_with_different_prose_replace_the_outbound_file() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        let before = std::fs::read_to_string(m.out.join(&entry.path)).unwrap();
        replace_body_without_revision(&m.src, &entry.id, "copied prose has diverged");

        let report = pass(&m.src, "my-book", "My Book", &m.out, NOW + 1, &HashSet::new()).unwrap();
        let after = std::fs::read_to_string(m.out.join(&entry.path)).unwrap();
        let updated = report.entries.iter().find(|candidate| candidate.id == entry.id).unwrap();
        assert_eq!(updated.doc_rev, entry.doc_rev);
        assert_ne!(updated.hash, entry.hash);
        assert_ne!(after, before);
        assert!(after.contains("copied prose has diverged"));
    }

    #[test]
    fn a_replaced_source_cannot_touch_another_books_readable_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let source = crate::store::Store::open(&m.src).unwrap();
        let captured_id = source.book_id().unwrap().unwrap();
        let replacement_id = source.fork_book_identity(&captured_id).unwrap();
        drop(source);
        let fresh_dir = tmp.path().join("not-created");
        assert!(pass_for_book(&m.src, &captured_id, "my-book", "My Book", &fresh_dir,
            NOW + 1, &HashSet::new()).is_err());
        assert!(!fresh_dir.exists());
        let entry = prose_entry(&m);
        let before = std::fs::read(m.out.join(&entry.path)).unwrap();
        let manifest = std::fs::read(m.out.join(crate::recovery::MANIFEST_NAME)).unwrap();
        assert!(pass_for_book(&m.src, &captured_id, "my-book", "My Book", &m.out,
            NOW + 1, &HashSet::new()).is_err());
        assert_eq!(std::fs::read(m.out.join(&entry.path)).unwrap(), before);
        assert_eq!(std::fs::read(m.out.join(crate::recovery::MANIFEST_NAME)).unwrap(), manifest);
        assert!(pass_for_book(&m.src, &replacement_id, "my-book", "My Book", &fresh_dir,
            NOW + 1, &HashSet::new()).is_ok());
    }

    #[test]
    fn ONLY_a_prose_row_offers_an_accept() {
        // THE SLICE'S WHOLE PRODUCT DECISION, asserted state by state. Six of
        // the eight states carry no body at all, or carry one whose acceptance
        // would destroy something: `front-matter` outranks everything because an
        // altered identifier means nothing on the row can be trusted, `title`
        // outranks `prose` because accepting words from a renamed file would
        // silently discard the rename, and `added`, `moved` and `deleted` are
        // STRUCTURE, which import refuses to merge into an open book for the
        // recorded reason that merging can wreck one with no recovery.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");
        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, PROSE);
        assert!(rows[0].can_accept, "a prose row is the applicable row");
    }

    #[test]
    fn a_front_matter_row_and_a_title_row_offer_NO_accept() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);

        // A forged id: front matter, which outranks everything.
        let current = std::fs::read_to_string(m.out.join(&entry.path)).unwrap();
        std::fs::write(
            m.out.join(&entry.path),
            current.replace(&entry.id, "it-999-not-this-document"),
        )
        .unwrap();
        let rows = changes_now(&m);
        assert_eq!(rows[0].state, FRONT_MATTER);
        assert!(
            !rows[0].can_accept,
            "a forged identifier must not be applicable"
        );
        assert!(
            rows[0].file_body.is_none(),
            "and it carries no body to apply"
        );

        // A renamed heading: title, which outranks prose.
        std::fs::write(
            m.out.join(&entry.path),
            current.replace("# Letter Storm", "# Letter Storm, revised"),
        )
        .unwrap();
        let rows = changes_now(&m);
        assert_eq!(rows[0].state, TITLE);
        assert!(
            !rows[0].can_accept,
            "accepting words would discard the rename"
        );
    }

    #[test]
    fn an_added_a_moved_a_deleted_and_an_unreadable_row_offer_NO_accept() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);

        // Added: a file the manifest never wrote.
        std::fs::write(
            m.out.join("notes-to-self.md"),
            "---\nid: x\ntype: scene\n---\n\n# Mine\n\nmine.\n",
        )
        .unwrap();
        // Moved: the same file's content under a new name, its own file gone.
        let body = std::fs::read_to_string(m.out.join(&entry.path)).unwrap();
        std::fs::write(m.out.join("somewhere-else.md"), &body).unwrap();
        std::fs::remove_file(m.out.join(&entry.path)).unwrap();
        // Deleted: another entry's file, taken away.
        let gone = m
            .entries
            .iter()
            .find(|e| e.id != entry.id && !e.path.ends_with("index.md"))
            .unwrap()
            .clone();
        std::fs::remove_file(m.out.join(&gone.path)).unwrap();

        let rows = changes_now(&m);
        let states: Vec<&str> = rows.iter().map(|r| r.state).collect();
        assert!(states.contains(&ADDED), "{states:?}");
        assert!(states.contains(&MOVED), "{states:?}");
        assert!(states.contains(&DELETED), "{states:?}");
        for row in &rows {
            assert!(
                !row.can_accept,
                "{} offered an accept; structure is never merged",
                row.state
            );
        }
    }

    #[test]
    fn an_unreadable_row_offers_NO_accept() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        std::fs::write(m.out.join(&entry.path), "no fence, no heading, nothing").unwrap();
        let rows = changes_now(&m);
        assert_eq!(rows[0].state, UNREADABLE);
        assert!(!rows[0].can_accept, "there is no body to take");
    }

    #[test]
    fn a_conflict_is_acceptable_ONLY_once_the_books_side_is_preserved_beside_it() {
        conflict_side_is_preserved(false);
        conflict_side_is_preserved(true);
    }

    fn conflict_side_is_preserved(equal_revision: bool) {
        // THE ANSWER THAT CANNOT LOSE THE WRITER'S WORDS. Both sides moved and
        // neither is stale; accepting the file is a legitimate choice, and it is
        // only legitimate once the side it replaces exists as a file the writer
        // still has. Without the sidecar on disk the accept is refused -- not
        // because a conflict is unacceptable in principle, but because the
        // preservation is the thing that makes it safe, and a preservation that
        // has not happened is not one.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");
        if equal_revision {
            replace_body_without_revision(&m.src, &entry.id, "and also typed here");
            let same_rev = crate::store::Store::open_readonly(&m.src)
                .unwrap().load_doc(&entry.id).unwrap().rev;
            assert_eq!(same_rev, entry.doc_rev);
        } else {
            let store = crate::store::Store::open(&m.src).unwrap();
            store.flush(&[crate::store::FlushEntry {
                item_id: entry.id.clone(),
                body: doc("and also typed here"),
                base_rev: entry.doc_rev,
                comments: None,
            }]).unwrap();
            assert_ne!(store.load_doc(&entry.id).unwrap().rev, entry.doc_rev);
        }

        let rows = changes_now(&m);
        assert_eq!(rows[0].state, CONFLICT);
        assert!(
            !rows[0].can_accept,
            "a conflict whose other side is nowhere on disk must not be applicable"
        );

        // The pass that honours the pause is what writes it.
        let paused: HashSet<String> = [entry.id.clone()].into_iter().collect();
        pass(&m.src, "my-book", "My Book", &m.out, NOW + 20_000, &paused).unwrap();
        let preserved = std::fs::read_to_string(m.out.join(from_project_path(&entry.path))).unwrap();
        assert!(preserved.contains("and also typed here"));
        assert!(std::fs::read_to_string(m.out.join(&entry.path)).unwrap()
            .contains("the writer rewrote this in another editor"));

        let rows = changes_now(&m);
        assert_eq!(rows[0].state, CONFLICT);
        assert!(
            rows[0].can_accept,
            "with the book's side preserved beside it, the writer may choose the file"
        );
    }

    #[test]
    fn an_applicable_row_says_how_many_underlined_runs_the_folder_ALREADY_dropped() {
        // MEASURED, NOT ASSERTED IN PROSE. Markdown has no underline, so the
        // mirror's own write dropped it -- the file never carried it and
        // no accept can bring it back. The number is the store's, counted by
        // the same tally the export notice uses, and it is on the row so the
        // writer is told BEFORE they press rather than after.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        {
            let store = crate::store::Store::open(&m.src).unwrap();
            let doc_rev = store.load_doc(&entry.id).unwrap().rev;
            let body = r#"{"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":"plain "},
                {"type":"text","text":"under","marks":[{"type":"underline"}]},
                {"type":"text","text":" and "},
                {"type":"text","text":"again","marks":[{"type":"underline"}]}]}]}"#;
            store
                .flush(&[crate::store::FlushEntry {
                    item_id: entry.id.clone(),
                    body: body.to_string(),
                    base_rev: doc_rev,
                    comments: None,
                }])
                .unwrap();
        }
        // The mirror writes it out, dropping both runs, and then the writer
        // edits that file -- which is how an ordinary prose row is reached.
        let second = pass(
            &m.src,
            "my-book",
            "My Book",
            &m.out,
            NOW + 20_000,
            &HashSet::new(),
        )
        .unwrap();
        let m = Mirrored {
            entries: second.entries,
            ..m
        };
        age_manifest(&m.out);
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");

        let rows = changes_now(&m);
        assert_eq!(rows[0].state, PROSE);
        assert_eq!(
            rows[0].store_underlined, 2,
            "the row must carry the underline the round trip already lost"
        );
    }

    #[test]
    fn the_plan_takes_the_FILES_body_and_the_STORES_current_revision() {
        // Both halves matter and they come from different places. The body is
        // the file's, parsed by the parse that would write it -- design
        // `:543-548`, and the reason `change_set` carries it on the row rather
        // than letting a later reader parse the file a second time. The
        // revision is the STORE's, so the write is refused if a keystroke
        // landed between the writer reading the row and pressing.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");
        let rows = changes_now(&m);
        let store = crate::store::Store::open_readonly(&m.src).unwrap();
        let doc_revs = store.document_revs().unwrap();
        drop(store);

        let plan = accept_plan(&rows, &doc_revs, &[entry.id.clone()]).unwrap();
        assert_eq!(plan.accepts.len(), 1);
        assert_eq!(plan.accepts[0].0, entry.id);
        assert_eq!(plan.accepts[0].1, doc_revs[&entry.id]);
        assert_eq!(
            crate::store::document_text(&plan.accepts[0].2).unwrap(),
            "the writer rewrote this in another editor"
        );
        assert_eq!(plan.paths, vec![entry.path.clone()]);
    }

    #[test]
    fn the_HOST_refuses_an_id_the_change_set_does_not_make_applicable() {
        // THE PAGE NAMES IDS; THE HOST DECIDES. `doc_restore`'s rule, which is
        // one query away from being impossible to get wrong: a stale panel, a
        // switch the panel did not notice or a page bug must not be able to
        // write a body into a document the writer never approved it for.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        let current = std::fs::read_to_string(m.out.join(&entry.path)).unwrap();
        std::fs::write(
            m.out.join(&entry.path),
            current.replace("# Letter Storm", "# Letter Storm, revised"),
        )
        .unwrap();
        let rows = changes_now(&m);
        assert_eq!(rows[0].state, TITLE);
        let store = crate::store::Store::open_readonly(&m.src).unwrap();
        let doc_revs = store.document_revs().unwrap();
        drop(store);

        let refused = accept_plan(&rows, &doc_revs, &[entry.id.clone()]);
        let message = refused.unwrap_err();
        assert!(
            message.contains(TITLE),
            "the refusal must name the state: {message}"
        );
        assert!(message.contains(&entry.id), "and the row: {message}");
    }

    #[test]
    fn an_id_the_change_set_never_named_is_refused() {
        // Not merely dropped. A silently ignored id is an accept the writer
        // believes happened, and the next thing they do is close the panel.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");
        let rows = changes_now(&m);
        let store = crate::store::Store::open_readonly(&m.src).unwrap();
        let doc_revs = store.document_revs().unwrap();
        drop(store);

        assert!(accept_plan(&rows, &doc_revs, &["it-999".to_string()]).is_err());
    }

    #[test]
    fn a_plan_over_no_ids_at_all_is_refused() {
        // An empty accept would take a snapshot of the whole manuscript, write
        // nothing, and report success -- a history row for an act that did not
        // happen. `snapshot_restore` refuses an empty snapshot for the mirror
        // image of this reason.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let rows = changes_now(&m);
        assert!(accept_plan(&rows, &std::collections::HashMap::new(), &[]).is_err());
    }

    #[test]
    fn a_plan_carries_the_underline_the_round_trip_already_lost() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");
        let mut rows = changes_now(&m);
        rows[0].store_underlined = 3;
        let store = crate::store::Store::open_readonly(&m.src).unwrap();
        let doc_revs = store.document_revs().unwrap();
        drop(store);
        let plan = accept_plan(&rows, &doc_revs, &[entry.id.clone()]).unwrap();
        assert_eq!(plan.underlined, 3);
    }

    /// Accept every applicable row, the way the command does: plan, write,
    /// settle. The three steps in one place so a test can assert what the
    /// FOURTH does not have to repeat.
    fn accept_all(m: &Mirrored, ids: &[String]) -> Vec<String> {
        let rows = changes_now(m);
        let store = crate::store::Store::open(&m.src).unwrap();
        let doc_revs = store.document_revs().unwrap();
        let plan = accept_plan(&rows, &doc_revs, ids).unwrap();
        let report = store
            .accept_from_mirror(&plan.accepts, "Before accepting from the readable folder")
            .unwrap();
        drop(store);
        settle_accepted(&m.out, &plan.paths, &report.documents, NOW + 30_000).unwrap();
        plan.paths
    }

    #[test]
    fn a_pass_immediately_after_an_accept_writes_NOTHING() {
        // THE WHOLE POINT OF SETTLING. Without it the next tick sees a
        // `doc_rev` the manifest does not carry and rewrites the file the
        // writer is looking at -- from the store, with a fresh mtime, in a
        // folder they have open. It would be correct in content and wrong in
        // every other way, and if the round trip were ever not byte-stable it
        // would be wrong in content too.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");
        accept_all(&m, &[entry.id.clone()]);

        let after = pass(
            &m.src,
            "my-book",
            "My Book",
            &m.out,
            NOW + 40_000,
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(
            after.written, 0,
            "the pass after an accept rewrote {} file(s) it had just read",
            after.written
        );
        assert_eq!(after.removed, 0);
        // And the words the writer chose are still the ones on disk.
        assert!(std::fs::read_to_string(m.out.join(&entry.path))
            .unwrap()
            .contains("the writer rewrote this in another editor"));
    }

    #[test]
    fn settling_records_the_FILE_and_the_books_new_revision_together() {
        // The two halves come from opposite sides, and taking either from the
        // other is a defect the three-way skip would then hide. `bytes`, `hash`
        // and `mtime_ms` describe the file the WRITER has; `doc_rev` and
        // `words` describe what the BOOK now holds. A manifest that recorded
        // the store's rendering of the body would compare equal to a file that
        // is not on disk.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "she rewrote the whole scene in another editor");
        accept_all(&m, &[entry.id.clone()]);

        let manifest: crate::recovery::Manifest<MirrorEntry> =
            crate::recovery::read_manifest(&m.out).unwrap();
        let row = manifest.entries.iter().find(|e| e.id == entry.id).unwrap();
        let on_disk = std::fs::read(m.out.join(&entry.path)).unwrap();
        assert_eq!(row.bytes, on_disk.len() as u64);
        assert_eq!(row.hash, format!("{:016x}", hash64(&on_disk)));
        assert_eq!(
            row.mtime_ms,
            file_mtime_ms(&m.out.join(&entry.path)).unwrap()
        );
        assert_eq!(row.words, 8, "the words the writer's file brought");
        let store = crate::store::Store::open_readonly(&m.src).unwrap();
        assert_eq!(row.doc_rev, store.document_revs().unwrap()[&entry.id]);
        assert_eq!(
            row.rev, entry.rev,
            "the item row did not move and nor may this"
        );
    }

    #[test]
    fn accepting_a_conflict_takes_away_the_preserved_copy() {
        // The sidecar exists to hold the side the writer is not choosing while
        // they decide. Once they have chosen, it is a stale second draft in
        // their manuscript folder -- and the snapshot the accept took is where
        // the book's side lives from then on, which is a place the application
        // can put back.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");
        {
            let store = crate::store::Store::open(&m.src).unwrap();
            let doc_rev = store.load_doc(&entry.id).unwrap().rev;
            store
                .flush(&[crate::store::FlushEntry {
                    item_id: entry.id.clone(),
                    body: doc("and also typed here"),
                    base_rev: doc_rev,
                    comments: None,
                }])
                .unwrap();
        }
        let paused: HashSet<String> = [entry.id.clone()].into_iter().collect();
        pass(&m.src, "my-book", "My Book", &m.out, NOW + 20_000, &paused).unwrap();
        let beside = m.out.join(from_project_path(&entry.path));
        assert!(beside.exists());

        accept_all(&m, &[entry.id.clone()]);
        assert!(!beside.exists(), "the preserved copy outlived the choice");
    }

    #[test]
    fn settling_leaves_every_OTHER_entrys_row_exactly_as_it_was() {
        // A change set of one scene must not touch the manifest rows of the
        // other 15,188. If it did, the next pass would rewrite the whole book
        // -- and this is the shape 019's rev-only comparison had, arrived at
        // from the other end.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        let before: crate::recovery::Manifest<MirrorEntry> =
            crate::recovery::read_manifest(&m.out).unwrap();
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");
        accept_all(&m, &[entry.id.clone()]);
        let after: crate::recovery::Manifest<MirrorEntry> =
            crate::recovery::read_manifest(&m.out).unwrap();

        for old in &before.entries {
            if old.id == entry.id {
                continue;
            }
            let now = after.entries.iter().find(|e| e.id == old.id).unwrap();
            assert_eq!(now, old, "an untouched entry's row moved");
        }
    }

    #[test]
    fn WHAT_A_ROUND_TRIP_THROUGH_THE_FOLDER_ACTUALLY_LOSES() {
        // MEASURED, AND THE MEASUREMENT IS THIS TEST. The importer is not the
        // inverse of the exporter and `import.rs`' own header says so, so
        // accepting a file can flatten formatting the application wrote. This
        // enumerates what survives and what does not, once, rather than leaving
        // the write-back to assert it in prose.
        //
        // The trip is `file_body` -> `read_file`, which is exactly what an
        // accept performs: the mirror writes the file, the writer edits it
        // somewhere else, and the parse that produced the diff produces the
        // body that lands.
        let item = crate::store::Item {
            id: "it-1".to_string(),
            parent_id: None,
            item_type: "scene".to_string(),
            title: "One".to_string(),
            position: "0000".to_string(),
            rev: 1,
            state: None,
            depth: 0,
        };
        let body = r#"{"type":"doc","content":[
            {"type":"paragraph","content":[
                {"type":"text","text":"plain "},
                {"type":"text","text":"bold","marks":[{"type":"strong"}]},
                {"type":"text","text":" "},
                {"type":"text","text":"italic","marks":[{"type":"em"}]},
                {"type":"text","text":" "},
                {"type":"text","text":"under","marks":[{"type":"underline"}]},
                {"type":"text","text":" "},
                {"type":"text","text":"both","marks":[{"type":"strong"},{"type":"em"}]}]},
            {"type":"paragraph","content":[{"type":"text","text":"a second paragraph"}]}]}"#;

        let file = file_body(&item, Some(body));
        let back = read_file(&file).unwrap().body.unwrap();

        let marks_on = |doc: &str, word: &str| -> Vec<String> {
            let v: serde_json::Value = serde_json::from_str(doc).unwrap();
            let mut out = Vec::new();
            let mut stack = vec![v];
            while let Some(node) = stack.pop() {
                if node.get("text").and_then(|t| t.as_str()) == Some(word) {
                    if let Some(marks) = node.get("marks").and_then(|m| m.as_array()) {
                        out = marks
                            .iter()
                            .filter_map(|m| m.get("type").and_then(|t| t.as_str()))
                            .map(str::to_string)
                            .collect();
                    }
                }
                if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
                    stack.extend(children.iter().cloned());
                }
            }
            out
        };

        // SURVIVES: the two marks the export format has.
        assert_eq!(marks_on(&back, "bold"), vec!["strong".to_string()]);
        assert_eq!(marks_on(&back, "italic"), vec!["em".to_string()]);
        let both = marks_on(&back, "both");
        assert!(both.contains(&"strong".to_string()) && both.contains(&"em".to_string()));

        // LOST: underline, and this is the ONLY mark in the schema that is.
        // The export drops it by design and counts it, so the FILE never
        // carried it -- the loss happens on the way out, not on the way back,
        // and no accept could restore what is not in the file. `under` comes
        // back as a bare text run.
        assert_eq!(marks_on(&back, "under"), Vec::<String>::new());
        assert!(
            back.contains("under"),
            "the WORDS are never lost, only the mark"
        );

        // KEPT: paragraph structure. The second paragraph is still its own.
        let v: serde_json::Value = serde_json::from_str(&back).unwrap();
        assert_eq!(v["content"].as_array().unwrap().len(), 2);

        // AND THE SCHEMA HAS EXACTLY THREE MARKS, so this enumeration is
        // COMPLETE rather than a sample. A fourth mark added to the page
        // without a decision about this trip fails here.
        assert_eq!(
            crate::export::MARKS_THE_FORMAT_CARRIES,
            ["strong", "em"],
            "the format carries two marks; a third would need its own answer here"
        );
    }

    #[test]
    fn markup_the_format_does_not_read_comes_back_AS_TEXT_and_never_as_nothing() {
        // `import.rs`' own rule -- "everything outside the subset survives AS
        // TEXT" -- restated on the accept path, because this is the path where
        // it decides whether a writer loses words. A writer who pastes a link
        // or a bullet list into their file gets its characters in their book,
        // visibly wrong rather than invisibly gone. That is a rendering loss and
        // never a text loss, and it is the honest thing to tell them.
        let file = "---\nid: it-1\ntype: scene\n---\n\n# One\n\n                    See [the map](maps/one.png) and:\n\n- a bullet\n";
        let back = read_file(file).unwrap().body.unwrap();
        let text = crate::store::document_text(&back).unwrap();
        assert!(text.contains("[the map](maps/one.png)"), "{text}");
        assert!(text.contains("- a bullet"), "{text}");
    }

    #[test]
    fn a_scene_edited_on_BOTH_sides_is_a_conflict_and_not_applicable() {
        // The design's second row, and the state that had no producer before
        // 029: without `doc_rev` in the manifest, typing in the application
        // moved nothing this comparison could see.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "the writer rewrote this in another editor");

        let store = crate::store::Store::open(&m.src).unwrap();
        let doc_rev = store.load_doc(&entry.id).unwrap().rev;
        store
            .flush(&[crate::store::FlushEntry {
                item_id: entry.id.clone(),
                body: doc("and also typed here"),
                base_rev: doc_rev,
                comments: None,
            }])
            .unwrap();
        drop(store);

        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, CONFLICT);
        // Both sides are still carried: a conflict is the row a writer most
        // needs to READ, even though 021 offers no way to resolve it.
        assert!(rows[0].file_body.is_some() && rows[0].store_body.is_some());
    }

    #[test]
    fn a_forged_id_is_a_front_matter_row_and_outranks_the_prose_change() {
        // The precedence that matters most: an altered identifier means nothing
        // else on the row can be trusted, so it must not be reported as prose
        // an accept path would later write into whatever item the id names.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        let current = std::fs::read_to_string(m.out.join(&entry.path)).unwrap();
        let forged = current.replace(&format!("id: {}", entry.id), "id: it-somebody-elses")
            + "\nand new prose too\n";
        std::fs::write(m.out.join(&entry.path), forged).unwrap();

        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, FRONT_MATTER);
        assert!(
            rows[0].file_body.is_none(),
            "a row nobody may apply carries no body to apply"
        );
    }

    #[test]
    fn a_key_this_format_never_writes_is_a_front_matter_row() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        let current = std::fs::read_to_string(m.out.join(&entry.path)).unwrap();
        std::fs::write(
            m.out.join(&entry.path),
            current.replacen("---\n\n", "author: someone\n---\n\n", 1),
        )
        .unwrap();

        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, FRONT_MATTER);
    }

    #[test]
    fn a_renamed_heading_is_a_title_row_and_outranks_the_prose_change() {
        // Accepting prose from a file whose heading also changed would silently
        // discard the rename. Half of what a writer did is never the right
        // thing to apply.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        let current = std::fs::read_to_string(m.out.join(&entry.path)).unwrap();
        let heading = current
            .lines()
            .find(|l| l.starts_with("# "))
            .unwrap()
            .to_string();
        std::fs::write(
            m.out.join(&entry.path),
            current.replace(&heading, "# A Name The Writer Chose") + "\nand new prose\n",
        )
        .unwrap();

        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, TITLE);
        assert_eq!(
            rows[0].file_title.as_deref(),
            Some("A Name The Writer Chose")
        );
        assert_eq!(
            rows[0].title, "Letter Storm",
            "the row must also carry the book's title"
        );
    }

    #[test]
    fn a_file_that_no_longer_parses_is_an_unreadable_row_carrying_the_reason() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        std::fs::write(
            m.out.join(&entry.path),
            "just some words, no front matter\n",
        )
        .unwrap();

        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, UNREADABLE);
        assert!(
            rows[0]
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("front-matter fence"),
            "the parse failure must be shown, not swallowed: {:?}",
            rows[0].error
        );
    }

    #[test]
    fn a_file_the_writer_deleted_is_a_deleted_row() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        std::fs::remove_file(m.out.join(&entry.path)).unwrap();

        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, DELETED);
        assert_eq!(rows[0].id, entry.id);
    }

    #[test]
    fn a_file_the_writer_added_is_an_added_row_with_no_item() {
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        std::fs::write(m.out.join("notes-to-self.md"), "thoughts\n").unwrap();

        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, ADDED);
        assert_eq!(rows[0].path, "notes-to-self.md");
        assert_eq!(
            rows[0].id, "",
            "a file the manifest never wrote names no item"
        );
    }

    #[test]
    fn a_file_the_writer_MOVED_is_one_row_and_not_an_add_beside_a_delete() {
        // Two rows for one act is a change set that reads as twice the damage.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        let body = std::fs::read_to_string(m.out.join(&entry.path)).unwrap();
        std::fs::remove_file(m.out.join(&entry.path)).unwrap();
        std::fs::write(m.out.join("moved-here.md"), body).unwrap();

        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "a move produced more than one row: {rows:?}");
        assert_eq!(rows[0].state, MOVED);
        assert_eq!(rows[0].id, entry.id);
        assert_eq!(rows[0].path, "moved-here.md");
        assert_eq!(rows[0].was_path.as_deref(), Some(entry.path.as_str()));
    }

    #[test]
    fn a_COPY_is_an_added_row_and_NOT_a_move() {
        // BOTH HALVES ARE REQUIRED for a move: an unmatched path AND the
        // original being gone. A copy leaves the original in place, and calling
        // it a move tells the writer a file left somewhere it is still sitting.
        // The rule was written with that comment beside it and nothing covered
        // it; the mutation pass is what asked.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        let body = std::fs::read_to_string(m.out.join(&entry.path)).unwrap();
        std::fs::write(m.out.join("a-copy.md"), body).unwrap();

        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, ADDED, "a copy was reported as a move");
        assert_eq!(rows[0].path, "a-copy.md");
        assert!(rows[0].was_path.is_none(), "a copy came from nowhere");
    }

    #[test]
    fn a_reflowed_file_is_an_applicable_row_whose_two_sides_AGREE() {
        // Bytes changed, prose did not -- a writer who re-wrapped their lines.
        // It stays a row, because the entry IS paused and the writer is owed an
        // explanation; the diff simply has nothing in it. Reporting nothing
        // would leave a pause with no visible cause.
        let tmp = tempfile::tempdir().unwrap();
        let m = mirrored(tmp.path());
        let entry = prose_entry(&m);
        rewrite_prose(&m, &entry, "four words\ngo here");

        let rows = changes_now(&m);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].state, PROSE);
        let file = crate::store::document_text(rows[0].file_body.as_ref().unwrap()).unwrap();
        let store = crate::store::document_text(rows[0].store_body.as_ref().unwrap()).unwrap();
        assert_eq!(file, store, "a reflow must not change the prose");
    }

    fn read_back(rendered: &str) -> MirrorFile {
        read_file(rendered).expect("a file this module wrote must read back")
    }

    #[test]
    fn a_file_this_module_wrote_reads_back_as_the_item_it_came_from() {
        // THE ROUND TRIP, and the property the whole change set rests on: the
        // parse that produces the diff must be the parse that would produce the
        // body written back. If these two disagree, every row in the panel is a
        // diff of something the writer never approved.
        let item = crate::store::Item {
            id: "it-000600".into(),
            parent_id: None,
            item_type: "scene".into(),
            title: "Letter Storm".into(),
            position: "0000".into(),
            rev: 3,
            state: None,
            depth: 0,
        };
        let rendered = file_body(&item, Some(&doc("four words go here")));
        let read = read_back(&rendered);
        assert_eq!(read.id.as_deref(), Some("it-000600"));
        assert_eq!(read.item_type.as_deref(), Some("scene"));
        assert_eq!(read.title, "Letter Storm");
        assert!(read.extra.is_empty());
        let body = read.body.expect("the prose was lost");
        assert_eq!(
            crate::store::document_text(&body).unwrap(),
            "four words go here"
        );
    }

    #[test]
    fn a_title_carrying_markdown_metacharacters_survives_the_round_trip() {
        // The title is ESCAPED on the way out (`heading_title`) and resolved on
        // the way back (`title_text`). A reader that took the raw heading would
        // hand the writer a title with backslashes in it and then offer to
        // write that into their book.
        for title in [
            "A *starred* scene",
            "# not a heading",
            "one_two_three",
            "Kap. 3",
        ] {
            let item = crate::store::Item {
                id: "it-1".into(),
                parent_id: None,
                item_type: "scene".into(),
                title: title.to_string(),
                position: "0000".into(),
                rev: 1,
                state: None,
                depth: 0,
            };
            let rendered = file_body(&item, None);
            assert_eq!(
                read_back(&rendered).title,
                title,
                "round trip lost {title:?}"
            );
        }
    }

    #[test]
    fn an_untitled_item_reads_back_as_an_EMPTY_title_and_not_as_a_missing_one() {
        // `# ` alone is what an untitled scene mirrors as, and it is a legal
        // file. A reader that refused it would report every untitled scene as
        // unreadable, which is a broken folder for a book nobody has renamed.
        let item = crate::store::Item {
            id: "it-1".into(),
            parent_id: None,
            item_type: "scene".into(),
            title: String::new(),
            position: "0000".into(),
            rev: 1,
            state: None,
            depth: 0,
        };
        let read = read_back(&file_body(&item, None));
        assert_eq!(read.title, "");
        assert!(read.body.is_none());

        // THE CONTROL, without which this test passes against a reader that
        // answers with an empty title for every file it is given -- which is a
        // reader that has read nothing. The recorded vacuity shape.
        let titled = crate::store::Item {
            title: "Named".into(),
            ..item
        };
        assert_eq!(read_back(&file_body(&titled, None)).title, "Named");
    }

    #[test]
    fn the_front_matter_fence_never_reaches_the_prose() {
        // The `---` lines are the document's metadata and are not words the
        // writer typed. A body carrying them would report three added lines on
        // the first diff of every file.
        let item = crate::store::Item {
            id: "it-1".into(),
            parent_id: None,
            item_type: "scene".into(),
            title: "T".into(),
            position: "0000".into(),
            rev: 1,
            state: None,
            depth: 0,
        };
        let read = read_back(&file_body(&item, Some(&doc("prose here"))));
        let body = read
            .body
            .expect("the prose was dropped, so this proves nothing about the fence");
        let text = crate::store::document_text(&body).unwrap();
        assert!(
            text.contains("prose here"),
            "the prose itself was lost: {text:?}"
        );
        assert!(
            !text.contains("---"),
            "the fence reached the prose: {text:?}"
        );
        assert!(
            !text.contains("id:"),
            "the front matter reached the prose: {text:?}"
        );
        assert!(
            !text.contains("T"),
            "the heading reached the prose: {text:?}"
        );
    }

    #[test]
    fn the_FIRST_heading_is_the_title_and_a_later_one_is_prose() {
        // A writer whose scene contains a line starting with `# ` must not have
        // it stolen as the title, and the prose above it must not vanish.
        let source = "---\nid: it-1\ntype: scene\n---\n\n# Real Title\n\nfirst line\n\n# Later\n";
        let read = read_back(source);
        assert_eq!(read.title, "Real Title");
        let text = crate::store::document_text(&read.body.unwrap()).unwrap();
        assert!(text.contains("first line"), "prose was lost: {text:?}");
        assert!(
            text.contains("Later"),
            "a later heading did not survive as prose: {text:?}"
        );
    }

    #[test]
    fn a_front_matter_key_this_format_does_not_write_is_CARRIED_not_dropped() {
        // A key the application would never write is exactly what the writer
        // needs telling about. Dropping it silently is how a forged `id` gets a
        // second chance in some later reader.
        let source = "---\nid: it-1\ntype: scene\nauthor: someone else\n---\n\n# T\n";
        let read = read_back(source);
        assert_eq!(read.extra, vec!["author".to_string()]);
        assert_eq!(read.id.as_deref(), Some("it-1"));
    }

    #[test]
    fn a_file_with_no_front_matter_is_REFUSED() {
        // Without the fence there is no way to say which bytes are metadata and
        // which are prose, and inventing an id would let a file the application
        // never wrote be matched to an item in the writer's book.
        let err = read_file("# Just a heading\n\nprose\n").unwrap_err();
        assert!(err.contains("front-matter fence"), "{err}");
    }

    #[test]
    fn a_front_matter_that_is_never_closed_is_REFUSED() {
        let err = read_file("---\nid: it-1\ntype: scene\n\n# T\n").unwrap_err();
        assert!(err.contains("never closed"), "{err}");
    }

    #[test]
    fn prose_BEFORE_the_heading_is_REFUSED() {
        // Only blank lines may precede the title. A reader that skipped ahead
        // to the next `# ` would take a LATER heading as the document's name
        // and drop everything above it -- silently, and the dropped part is the
        // writer's prose. Found by mutation: every other refusal test here
        // still passed against that reader, because none of them put anything
        // between the fence and the heading.
        let err = read_file("---\nid: it-1\ntype: scene\n---\n\nprose first\n\n# T\n").unwrap_err();
        assert!(err.contains("no top-level heading"), "{err}");
    }

    #[test]
    fn a_file_with_no_heading_is_REFUSED() {
        let err =
            read_file("---\nid: it-1\ntype: scene\n---\n\nprose with no heading\n").unwrap_err();
        assert!(err.contains("no top-level heading"), "{err}");
    }

    #[test]
    fn a_DEEPER_heading_where_the_title_belongs_is_REFUSED() {
        // `##` is a heading `import::heading` reads happily, and taking it as
        // the title would accept a file whose shape this format never wrote.
        let err = read_file("---\nid: it-1\ntype: scene\n---\n\n## T\n").unwrap_err();
        assert!(err.contains("no top-level heading"), "{err}");
    }

    #[test]
    fn a_file_is_front_matter_then_the_title_then_the_prose() {
        let it = item("it-000600", None, "chapter", "Letter Storm 443");
        let out = file_body(&it, Some(&doc("The prose.")));
        assert_eq!(
            out,
            "---\nid: it-000600\ntype: chapter\n---\n\n# Letter Storm 443\n\nThe prose.\n"
        );
    }

    #[test]
    fn the_front_matter_carries_TWO_KEYS_and_no_others() {
        // A third key is a sidecar growing inside the file. The design gives
        // the front matter exactly `id` and `type`, and puts everything that is
        // genuinely mirror-level -- completeness, exclusions, conflicts, the
        // unmatched list -- in the manifest, which is a different claim about a
        // different scope rather than the same claim at finer granularity.
        let it = item("it-1", None, "scene", "T");
        let fm = front_matter(&file_body(&it, Some(&doc("x"))));
        assert_eq!(fm, ["id: it-1", "type: scene"]);
    }

    #[test]
    fn the_heading_is_always_top_level_because_a_file_is_its_own_document() {
        // NOT `export::heading_level(depth)`. That function serves the single
        // concatenated manuscript, where one document holds the whole book and
        // depth is what keeps the outline. Here each file stands alone in an
        // editor that knows nothing about the rest of the book, so its title is
        // that document's `#`.
        let deep = crate::store::Item {
            depth: 4,
            ..item("it-1", Some("it-0"), "scene", "T")
        };
        assert!(file_body(&deep, None).contains("\n# T\n"));
    }

    #[test]
    fn a_title_is_escaped_the_way_the_export_escapes_one() {
        // `export::heading_title`, not a second escaper: two Markdown dialects
        // for one manuscript is what the STOP condition in the plan forbids.
        let it = item("it-1", None, "scene", "A *starred* title");
        assert!(
            file_body(&it, None).contains(r"# A \*starred\* title"),
            "{}",
            file_body(&it, None)
        );
    }

    #[test]
    fn a_newline_in_the_type_cannot_forge_a_front_matter_key() {
        // `item_type` is a String out of the store and an imported project can
        // carry anything in it. A raw value would let `scene\nid: it-999` add a
        // key -- and `id` is the one field the mirror reads back, so a forged
        // one redirects an accepted change at whatever item it names.
        let it = item("it-1", None, "scene\nid: it-999", "T");
        let fm = front_matter(&file_body(&it, None));
        // THE KEY SET is the property, not the absence of the text. The value
        // still reads `scene id: it-999`, on one line, which is the corrupt
        // type rendered honestly -- inventing a replacement would be the file
        // lying about what the store holds. What must not happen is a SECOND
        // `id` key.
        assert_eq!(fm.len(), 2, "the type forged a key: {fm:?}");
        let keys: Vec<&str> = fm.iter().map(|l| l.split(':').next().unwrap()).collect();
        assert_eq!(keys, ["id", "type"]);
        assert_eq!(fm[0], "id: it-1", "the real id moved: {fm:?}");
    }

    #[test]
    fn an_item_with_no_prose_is_still_a_whole_file() {
        // A container's `index.md`, and a leaf the writer has not written into.
        let it = item("it-1", None, "part", "Winter Cafe");
        assert_eq!(
            file_body(&it, None),
            "---\nid: it-1\ntype: part\n---\n\n# Winter Cafe\n"
        );
    }

    #[test]
    fn an_unreadable_body_still_produces_the_file_without_its_prose() {
        // Counted in the manifest's `unreadable_bodies`. A MISSING file would
        // be indistinguishable from an item that does not exist, which is the
        // one thing the mirror must never say about a scene the writer has.
        let it = item("it-1", None, "scene", "T");
        assert_eq!(
            file_body(&it, Some(r#"{"foo":1}"#)),
            "---\nid: it-1\ntype: scene\n---\n\n# T\n"
        );
    }

    fn project() -> ProjectRef {
        ProjectRef {
            slug: "my-book".into(),
            name: "My Book".into(),
            schema_version: 5,
        }
    }

    fn complete(entries: u64) -> Completeness {
        Completeness {
            items_total: 20_000,
            entries_written: entries,
            documents_with_prose: 15_200,
            unreadable_bodies: 0,
            pictures: 0,
            covers: 0,
        }
    }

    fn mirror_entry() -> MirrorEntry {
        MirrorEntry {
            id: "it-000600".into(),
            path: "0004-Winter-Cafe/0030-Letter-Storm.md".into(),
            rev: 7,
            doc_rev: 12,
            bytes: 740,
            hash: "b1946ac92492d234".into(),
            mtime_ms: 1_771_599_990_123,
            words: 131,
        }
    }

    #[test]
    fn the_mirror_form_is_the_envelope_with_kind_mirror() {
        let m = Manifest::mirror(project(), NOW, complete(1), vec![mirror_entry()]);
        assert_eq!(m.kind, "mirror");
        // Two contracts, not one: the envelope's version and the artifact's.
        // A mirror file's artifact format is its Markdown dialect.
        assert_eq!(m.manifest_version, 1);
        assert_eq!(m.entries.len(), 1);
    }

    #[test]
    fn ONE_ENVELOPE_the_two_forms_have_identical_top_level_keys() {
        // THE TEST THAT PINS "one envelope, one reader". Two structs with the
        // same field names in different files is the fork 013's maintenance
        // note forbids, and the generic exists to make it unnecessary -- but
        // nothing else in the suite would notice if the mirror form quietly
        // grew or lost a top-level key.
        fn keys(text: &str) -> Vec<String> {
            let v: serde_json::Value = serde_json::from_str(text).unwrap();
            let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        }
        let mirror = Manifest::mirror(project(), NOW, complete(1), vec![mirror_entry()]);
        let recovery = Manifest::recovery(
            project(),
            NOW,
            complete(1),
            vec![Point {
                id: "2026-08-19T21-14-02Z".into(),
                at_ms: NOW,
                bytes: 16_781_312,
                hash: "b1946ac92492d234".into(),
                verified: true,
                database_verified: false,
                verified_at: Some(NOW),
                bundle: false,
                errors: Vec::new(),
            }],
        );
        assert_eq!(
            keys(&serde_json::to_string(&mirror).unwrap()),
            keys(&serde_json::to_string(&recovery).unwrap()),
        );
        // Vacuity guard: an envelope that serialized to `{}` satisfies the
        // equality above.
        assert!(keys(&serde_json::to_string(&mirror).unwrap()).len() >= 10);
    }

    #[test]
    fn a_mirror_entry_carries_rev_and_words_and_never_the_recovery_fields() {
        let m = Manifest::mirror(project(), NOW, complete(1), vec![mirror_entry()]);
        let text = serde_json::to_string(&m).unwrap();
        // Asserted BY NAME: these are a contract shared with the recovery form,
        // and a rename silently forks one envelope into two.
        for key in [
            "\"id\"",
            "\"path\"",
            "\"rev\"",
            "\"bytes\"",
            "\"hash\"",
            "\"mtime_ms\"",
            "\"words\"",
        ] {
            assert!(text.contains(key), "mirror entry is missing {key}: {text}");
        }
        // And the fields that mean nothing for one Markdown file are ABSENT
        // rather than null. `Option` fields on one flat struct is the shape
        // this rejected: nothing in that type stops a mirror entry claiming it
        // passed a structural read.
        for key in ["\"verified\"", "\"verified_at\""] {
            assert!(!text.contains(key), "mirror entry carries {key}: {text}");
        }
        assert_eq!(
            serde_json::from_str::<Manifest<MirrorEntry>>(&text).unwrap(),
            m
        );
    }

    #[test]
    fn the_checksum_contract_holds_in_the_mirror_form_too() {
        // The same promise 018 settled and pinned for the recovery form: an
        // independent reader recomputes it by clearing the field and
        // re-serializing. It is a property of the ENVELOPE, so a second form
        // that broke it would break the reader for both.
        let m = Manifest::mirror(project(), NOW, complete(1), vec![mirror_entry()]);
        let mut round: Manifest<MirrorEntry> =
            serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        let claimed = std::mem::take(&mut round.checksum);
        let recomputed = format!(
            "{:016x}",
            crate::store::history::hash64(&serde_json::to_vec(&round).unwrap())
        );
        assert_eq!(claimed, recomputed);
        assert_eq!(claimed.len(), 16);
    }

    /// An item in walk position. `rev` and `state` are not read by `layout`.
    fn item(id: &str, parent: Option<&str>, item_type: &str, title: &str) -> crate::store::Item {
        crate::store::Item {
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            item_type: item_type.to_string(),
            title: title.to_string(),
            position: String::new(),
            rev: 1,
            state: None,
            depth: 0,
        }
    }

    #[test]
    fn a_flat_book_is_ordinal_prefixed_leaves() {
        let items = vec![
            item("it-1", None, "scene", "First"),
            item("it-2", None, "scene", "Second"),
            item("it-3", None, "scene", "Third"),
        ];
        let paths: Vec<String> = layout(&items).into_iter().map(|e| e.path).collect();
        assert_eq!(paths, ["0000-First.md", "0001-Second.md", "0002-Third.md"]);
    }

    #[test]
    fn an_item_with_children_becomes_a_directory_carrying_an_index() {
        let items = vec![
            item("it-p", None, "part", "Winter Cafe"),
            item("it-c", Some("it-p"), "scene", "Letter Storm"),
        ];
        assert_eq!(
            layout(&items),
            vec![
                Entry {
                    id: "it-p".into(),
                    path: "0000-Winter-Cafe/index.md".into(),
                    is_container: true
                },
                Entry {
                    id: "it-c".into(),
                    path: "0000-Winter-Cafe/0000-Letter-Storm.md".into(),
                    is_container: false
                },
            ]
        );
    }

    #[test]
    fn the_ordinal_is_the_SIBLING_ordinal_and_restarts_under_each_parent() {
        // THE TEST THAT SEPARATES a sibling ordinal from the walk index. The
        // walk is depth first, so `it-c` is the SECOND item overall and the
        // FIRST child of its parent; a `enumerate()` over the walk numbers it
        // 0001 and every assertion about a flat book still passes.
        let items = vec![
            item("it-p", None, "part", "P"),
            item("it-c", Some("it-p"), "scene", "C"),
            item("it-d", Some("it-p"), "scene", "D"),
            item("it-q", None, "part", "Q"),
        ];
        let paths: Vec<String> = layout(&items).into_iter().map(|e| e.path).collect();
        assert_eq!(
            paths,
            [
                "0000-P/index.md",
                "0000-P/0000-C.md",
                "0000-P/0001-D.md",
                // Back at the root, and the root counter did NOT see the
                // children: this is 0001, not 0003.
                "0001-Q.md",
            ]
        );
    }

    #[test]
    fn depth_never_means_type_and_neither_does_shape() {
        // The hierarchy is arbitrary by product decision: a part inside a scene
        // is legal. Shape follows CHILDREN. A `scene` with a child is a
        // directory and a `part` without one is a file, and a layout keyed on
        // `item_type` gets both backwards.
        let items = vec![
            item("it-s", None, "scene", "A scene that owns a part"),
            item("it-p", Some("it-s"), "part", "A childless part"),
        ];
        let out = layout(&items);
        assert!(
            out[0].is_container,
            "a scene with children is still a directory"
        );
        assert!(!out[1].is_container, "a childless part is still a file");
        assert_eq!(
            out[1].path,
            "0000-A-scene-that-owns-a-part/0000-A-childless-part.md"
        );
    }

    #[test]
    fn nesting_carries_the_whole_ancestor_chain() {
        let items = vec![
            item("it-a", None, "part", "A"),
            item("it-b", Some("it-a"), "chapter", "B"),
            item("it-c", Some("it-b"), "scene", "C"),
        ];
        let paths: Vec<String> = layout(&items).into_iter().map(|e| e.path).collect();
        assert_eq!(
            paths,
            [
                "0000-A/index.md",
                "0000-A/0000-B/index.md",
                "0000-A/0000-B/0000-C.md"
            ]
        );
    }

    #[test]
    fn an_untitled_leaf_is_the_ordinal_and_nothing_else() {
        // `0000-.md` is ugly and honest, and it is in the design's own example.
        let items = vec![item("it-1", None, "scene", "")];
        assert_eq!(layout(&items)[0].path, "0000-.md");
    }

    #[test]
    fn the_ordinal_is_zero_padded_to_four_and_keeps_a_listing_sorted() {
        // Without the padding a sorted listing reads 0, 1, 10, 11, 2 -- which is
        // the alphabetical order over a book this prefix exists to prevent.
        let items: Vec<_> = (0..11)
            .map(|n| item(&format!("it-{n}"), None, "scene", "S"))
            .collect();
        let paths: Vec<String> = layout(&items).into_iter().map(|e| e.path).collect();
        assert_eq!(paths[0], "0000-S.md");
        assert_eq!(paths[10], "0010-S.md");
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(sorted, paths, "a sorted listing does not match walk order");
    }

    #[test]
    fn the_writers_own_script_survives() {
        // THE DEFAULT FIXTURE, not an edge case: the `tiny` fixture's titles are
        // Hebrew and Arabic. `projects::slugify` returns `None` for both, which
        // is why this module exists at all.
        assert_eq!(segment("שלום עולם"), "שלום-עולם");
        assert_eq!(segment("مرحبا بالعالم"), "مرحبا-بالعالم");
        // And Latin still works, unchanged in case: a filename the writer reads
        // is not a slug the application owns.
        assert_eq!(segment("Winter Cafe"), "Winter-Cafe");
    }

    #[test]
    fn a_bidi_override_is_removed_and_not_escaped() {
        let sneaky = format!("report{}fdp.md", '\u{202E}');
        let out = segment(&sneaky);
        assert!(
            !out.chars().any(is_bidi_control),
            "bidi control survived: {out:?}"
        );
        // REMOVED, not escaped: an escape leaves the sequence in the name in a
        // different form, and the name is what a file manager renders.
        assert_eq!(out, "reportfdp.md");
    }

    #[test]
    fn separators_and_nul_cannot_reach_the_name() {
        // `/` would create a directory level the tree does not have, and NUL
        // truncates a path at the syscall boundary.
        assert_eq!(segment("a/b"), "ab");
        assert_eq!(segment("a\0b"), "ab");
    }

    #[test]
    fn control_characters_are_removed() {
        // Unicode category C, of which the bidi controls are one part.
        assert_eq!(segment("a\u{0007}b\u{200B}c"), "abc");
    }

    #[test]
    fn whitespace_runs_collapse_to_one_hyphen() {
        assert_eq!(segment("a   b\t\tc"), "a-b-c");
        // Leading and trailing whitespace leaves no hyphen at either end: a
        // name that starts with `-` is a name that argues with every CLI.
        assert_eq!(segment("  padded  "), "padded");
    }

    #[test]
    fn a_control_that_is_also_whitespace_is_a_gap_and_not_a_removal() {
        // THE ORDER OF TWO CHECKS, and it shipped wrong for one commit. Tab,
        // newline and carriage return are `Cc` controls and whitespace at the
        // same time. Classify removal first and the gap is eaten, so a title
        // carrying a tab between two words mirrors as one word --
        // `segment("a\tb")` gave "ab" rather than "a-b".
        assert_eq!(segment("a\tb"), "a-b");
        assert_eq!(segment("a\nb"), "a-b");
        assert_eq!(segment("a\r\nb"), "a-b");
        // And a control that is NOT whitespace still goes, so this test cannot
        // be satisfied by dropping the removal step entirely.
        assert_eq!(segment("a\u{0007}b"), "ab");
    }

    #[test]
    fn an_empty_result_is_legal() {
        // `0000-.md` is ugly and honest. Inventing "Untitled" would put a word
        // in the file that the manuscript does not contain.
        assert_eq!(segment(""), "");
        assert_eq!(segment("///"), "");
    }

    #[test]
    fn truncation_is_at_a_character_boundary_and_not_at_a_byte() {
        // C2, and the case that separates this from `projects::slugify`'s
        // `String::truncate`: that call is safe there ONLY because its output
        // is ASCII by construction. A test with `"a".repeat(65)` passes against
        // a byte truncation and proves nothing here.
        //
        // A THREE-BYTE character, and the width is the whole test. Hebrew alef
        // is TWO bytes, so byte 64 is always a character boundary and a naive
        // byte truncation passes -- which is exactly what this fixture used to
        // be, and the mutation pass caught it: "byte truncation instead of a
        // char boundary" SURVIVED. Hiragana A is three bytes, so 22 of them is
        // 66 and the 64-byte cap lands INSIDE the 22nd character (63..66).
        let long = "あ".repeat(22);
        assert_eq!(long.len(), 66);
        assert!(
            !long.is_char_boundary(64),
            "the fixture is not straddling the cap"
        );
        let out = segment(&long);
        assert!(out.len() <= 64, "{} bytes", out.len());
        // It yielded the whole character rather than half of one: 21 of them.
        assert_eq!(out, "あ".repeat(21));
        assert_eq!(out.len(), 63);
    }

    #[test]
    fn a_four_byte_character_straddling_the_cap_yields_whole() {
        // The worst case for a boundary walk, and the one an off-by-one in it
        // survives: an emoji is four bytes, so 16 of them is 64 and the
        // seventeenth straddles nothing -- 15 plus a three-byte character does.
        // 15 emoji is 60 bytes; a three-byte character then spans 60..63 and
        // the next spans 63..66, so the cap at 64 lands inside it.
        let long = format!("{}{}", "😀".repeat(15), "あ".repeat(2));
        assert_eq!(long.len(), 66);
        assert!(!long.is_char_boundary(64));
        let out = segment(&long);
        assert!(out.len() <= 64);
        assert!(out.is_char_boundary(out.len()));
        assert_eq!(out, format!("{}{}", "😀".repeat(15), "あ"));
    }

    #[test]
    fn a_pass_carries_the_dictionary_out_as_wordlist_txt() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        {
            let store = book(&src);
            store.dict_add("Mireth").unwrap();
            store.dict_add("Amberline").unwrap();
        }
        let out = tmp.path().join("mirror").join("my-book");
        let first = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        assert_eq!(first.wordlist, crate::mirror_wordlist::Outcome::Written);
        let list = out.join(crate::mirror_wordlist::WORDLIST_NAME);
        assert_eq!(std::fs::read_to_string(&list).unwrap(), "Amberline\nMireth\n");
        assert!(first.entries.iter().all(|e| !e.path.contains("wordlist")));

        // A dictionary change alone, with no scene moving, still reaches the file.
        crate::store::Store::open(&src).unwrap().dict_remove("Mireth").unwrap();
        let second = pass(&src, "my-book", "My Book", &out, NOW + 20_000, &HashSet::new()).unwrap();
        assert_eq!(second.written, 0);
        assert_eq!(second.wordlist, crate::mirror_wordlist::Outcome::Written);
        assert_eq!(std::fs::read_to_string(&list).unwrap(), "Amberline\n");

        let third = pass(&src, "my-book", "My Book", &out, NOW + 40_000, &HashSet::new()).unwrap();
        assert_eq!(third.wordlist, crate::mirror_wordlist::Outcome::Unchanged);
    }

    #[test]
    fn an_unreadable_dictionary_is_named_by_the_wordlist_and_costs_no_scene() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        rusqlite::Connection::open(&src)
            .unwrap()
            .execute_batch("DROP TABLE dict_word")
            .unwrap();
        let out = tmp.path().join("mirror").join("my-book");
        let report = pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        assert_eq!(report.written, 3);
        let problem = report.wordlist.problem().unwrap().to_string();
        assert!(problem.starts_with("wordlist.txt: "), "{problem}");
        assert!(!out.join(crate::mirror_wordlist::WORDLIST_NAME).exists());
    }

    #[test]
    fn the_wordlist_and_its_debris_are_not_strays_the_scan_reports() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        book(&src).dict_add("Mireth").unwrap();
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        std::fs::write(out.join(crate::mirror_wordlist::WORDLIST_NAME), "edited\n").unwrap();
        std::fs::write(out.join(".readable-mirror-wordlist.99.0.tmp"), "half").unwrap();
        std::fs::write(out.join("Stray.md"), "the writer's own").unwrap();

        let found = detect(&out);
        assert_eq!(found.unmatched, vec!["Stray.md".to_string()]);
        assert!(found.changed.is_empty() && found.deleted_outside.is_empty());
    }

    #[test]
    fn scenes_and_manifest_are_current_even_when_the_wordlist_is_held() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("my-book.db");
        drop(book(&src));
        let out = tmp.path().join("mirror").join("my-book");
        pass(&src, "my-book", "My Book", &out, NOW, &HashSet::new()).unwrap();
        let list = out.join(crate::mirror_wordlist::WORDLIST_NAME);
        std::fs::write(&list, "the writer's list\n").unwrap();

        touch_every_item(&src);
        crate::store::Store::open(&src).unwrap().dict_add("Mireth").unwrap();
        let report = pass(&src, "my-book", "My Book", &out, NOW + 20_000, &HashSet::new()).unwrap();

        assert!(matches!(report.wordlist, crate::mirror_wordlist::Outcome::Conflict(_)));
        assert_eq!(std::fs::read_to_string(&list).unwrap(), "the writer's list\n");
        assert!(report.written > 0);
        for entry in &report.entries {
            assert!(std::fs::read_to_string(out.join(&entry.path)).unwrap().contains("again"));
        }
        let manifest: Manifest<MirrorEntry> = crate::recovery::read_manifest(&out).unwrap();
        assert_eq!(manifest.generated_at, NOW + 20_000);
        assert_eq!(manifest.entries, report.entries);
    }
}
