//! The book's dictionary words, carried out to the readable folder.
//!
//! OUTBOUND ONLY. `wordlist.txt` lets a writer take the book's own words to
//! another checker; nothing here reads it back into the store, and neither the
//! scan nor acceptance may treat it as a source.
//!
//! THE FILE IS THE WRITER'S ONCE THEY EDIT IT. `.readable-mirror-wordlist.json`
//! records what the application last wrote, and the file is replaced only
//! while it still matches that record. Anything else on disk that is not
//! already the wanted list is left exactly as it is and reported.

use crate::store::history::hash64;

pub const WORDLIST_NAME: &str = "wordlist.txt";
pub const OWNER_NAME: &str = ".readable-mirror-wordlist.json";
const TEMP_PREFIX: &str = ".readable-mirror-wordlist.";
const OWNER_FORMAT: &str = "cc.local.app/readable-mirror-wordlist";
const OWNER_VERSION: u64 = 1;

/// Whether a mirror-relative path is one this module owns. The scan skips
/// these, so the list is never offered back as a stray scene.
pub fn is_reserved(rel: &str) -> bool {
    rel == WORDLIST_NAME || rel == OWNER_NAME || is_temp(rel)
}

fn is_temp(rel: &str) -> bool {
    let Some(numbered) = rel
        .strip_prefix(TEMP_PREFIX)
        .and_then(|rel| rel.strip_suffix(".tmp"))
    else {
        return false;
    };
    let Some((process, ordinal)) = numbered.split_once('.') else {
        return false;
    };
    process.parse::<u32>().is_ok() && ordinal.parse::<u64>().is_ok()
}

/// What one pass did to the list.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// The file and its record already describe the book's list.
    Unchanged,
    /// The file was written, then its record.
    Written,
    /// The file already held the wanted list; only the record was written.
    Adopted,
    /// Something on disk is not the application's to replace. Nothing moved.
    Conflict(String),
    /// The list could not be produced or checked. Nothing moved.
    Failed(String),
}

impl Outcome {
    /// The cause the mirror status names, or None when the list is current.
    pub fn problem(&self) -> Option<&str> {
        match self {
            Outcome::Conflict(why) | Outcome::Failed(why) => Some(why),
            _ => None,
        }
    }
}

/// What the application wrote, as a length and an FNV-64 hash.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Baseline {
    bytes: u64,
    hash: String,
}

impl Baseline {
    fn of(content: &[u8]) -> Self {
        Self {
            bytes: content.len() as u64,
            hash: format!("{:016x}", hash64(content)),
        }
    }

    fn matches(&self, content: &[u8]) -> bool {
        *self == Self::of(content)
    }
}

/// `next` is an INTENT: present only between announcing a replacement and
/// settling it. A crash inside that window leaves either baseline on disk, and
/// both stay the application's, so a dictionary change before the next pass
/// cannot turn the application's own list into an outside edit.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Ownership {
    format: String,
    version: u64,
    bytes: u64,
    hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next: Option<Baseline>,
}

impl Ownership {
    fn new(base: Baseline, next: Option<Baseline>) -> Self {
        Self {
            format: OWNER_FORMAT.to_string(),
            version: OWNER_VERSION,
            bytes: base.bytes,
            hash: base.hash,
            next,
        }
    }

    fn settled(content: &[u8]) -> Self {
        Self::new(Baseline::of(content), None)
    }

    fn intent(from: Baseline, to: &[u8]) -> Self {
        Self::new(from, Some(Baseline::of(to)))
    }

    fn base(&self) -> Baseline {
        Baseline {
            bytes: self.bytes,
            hash: self.hash.clone(),
        }
    }

    fn describes(&self, content: &[u8]) -> bool {
        self.base().matches(content) || self.next.as_ref().is_some_and(|n| n.matches(content))
    }

    fn is_settled_on(&self, content: &[u8]) -> bool {
        self.next.is_none() && self.base().matches(content)
    }
}

/// Every character some reader ends a line at: LF, VT, FF, CR, NEL and the
/// Unicode line and paragraph separators.
const LINE_BREAKS: [char; 7] = [
    '\n', '\u{0B}', '\u{0C}', '\r', '\u{85}', '\u{2028}', '\u{2029}',
];

/// The file's whole content: one word per line, each ending in `\n`, and an
/// empty file for an empty dictionary.
///
/// SORTED BY THE BYTES OF THE UTF-8 ENCODING, which is Unicode code point
/// order and SQLite's BINARY collation: `Zed` before `apple`, `apple` before
/// `Äpfel`. No locale and no case folding, so one book gives the same bytes on
/// every machine. Words are written exactly as stored, never normalized.
///
/// A WORD HOLDING A LINE BREAK REFUSES THE WHOLE FILE. One such word would read
/// back as two, and quietly dropping it would publish a list that claims to be
/// the book's and is not. `Store::dict_add` only trims, so such a word can
/// arrive through the page as well as through an older or imported file; the
/// writer is told which word to take out.
pub fn render(words: &[String]) -> Result<String, String> {
    if let Some(word) = words.iter().find(|w| w.contains(LINE_BREAKS)) {
        return Err(format!(
            "{WORDLIST_NAME} was left as it is: the dictionary word {word:?} contains a line \
             break. Remove that word from the book's dictionary to update the list again."
        ));
    }
    let mut sorted: Vec<&str> = words.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    let mut out = String::new();
    for word in sorted {
        out.push_str(word);
        out.push('\n');
    }
    Ok(out)
}

/// Bring `wordlist.txt` into step with the book's dictionary, when it is still
/// the application's to change.
///
/// Runs AFTER the prose and the manifest, so a conflict here never costs the
/// writer a scene update. A replacement is announced in the record, then
/// written, then settled; a crash at any point leaves a file the record still
/// calls the application's.
pub fn maintain(dir: &std::path::Path, words: Result<Vec<String>, String>) -> Outcome {
    reap_temps(dir);
    let desired = match words.and_then(|words| render(&words)) {
        Ok(desired) => desired,
        Err(why) => return Outcome::Failed(why),
    };
    let record = match read_owner(dir) {
        Ok(record) => record,
        Err(why) => return Outcome::Failed(why),
    };
    let on_disk = match read_regular(&dir.join(WORDLIST_NAME)) {
        Ok(on_disk) => on_disk,
        Err(why) => return Outcome::Failed(why),
    };
    let desired = desired.as_bytes();

    match on_disk {
        Some(current) if current == desired => {
            if record.as_ref().is_some_and(|r| r.is_settled_on(desired)) {
                return Outcome::Unchanged;
            }
            match write_owner(dir, &Ownership::settled(desired)) {
                Ok(()) => Outcome::Adopted,
                Err(why) => Outcome::Failed(why),
            }
        }
        Some(current) if !record.as_ref().is_some_and(|r| r.describes(&current)) => {
            Outcome::Conflict(format!(
                "{WORDLIST_NAME} was changed outside the application and was left as it is. \
                 Delete {WORDLIST_NAME}, or put back the list the application last wrote, and \
                 the application will keep it up to date again."
            ))
        }
        // The application's own earlier list, or none at all: a deleted file
        // destroys nothing by being written again.
        on_disk => {
            let from = Baseline::of(on_disk.as_deref().unwrap_or(desired));
            match write_owner(dir, &Ownership::intent(from, desired))
                .and_then(|()| write_atomically(dir, WORDLIST_NAME, desired))
                .and_then(|()| write_owner(dir, &Ownership::settled(desired)))
            {
                Ok(()) => Outcome::Written,
                Err(why) => Outcome::Failed(why),
            }
        }
    }
}

/// Remove temp files a crash left behind. Only names this module's own writer
/// produces, and only plain files: a symlink wearing the name is neither
/// followed nor removed.
fn reap_temps(dir: &std::path::Path) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        if !entry.file_name().to_str().is_some_and(is_temp) {
            continue;
        }
        let path = entry.path();
        if !std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_file()) {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!("mirror: could not remove {}: {error}", path.display()),
        }
    }
}

/// The record, None when there is none. A record this build cannot read in
/// full is an error, never an absent baseline: treating it as absent would let
/// a later adoption claim a file nobody can prove the application wrote.
fn read_owner(dir: &std::path::Path) -> Result<Option<Ownership>, String> {
    let path = dir.join(OWNER_NAME);
    let Some(bytes) = read_regular(&path)? else {
        return Ok(None);
    };
    let way_out =
        format!("delete it and {WORDLIST_NAME} to let the application write the list again");
    let record: Ownership = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{}: {error}; {way_out}", path.display()))?;
    if record.format != OWNER_FORMAT || record.version != OWNER_VERSION {
        return Err(format!(
            "{}: unrecognized readable-folder wordlist record; {way_out}",
            path.display()
        ));
    }
    Ok(Some(record))
}

fn write_owner(dir: &std::path::Path, record: &Ownership) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?;
    write_atomically(dir, OWNER_NAME, &bytes)
}

/// Read a file that must be a plain file. A symlink or anything else at a name
/// this module owns is refused: following one would write the list wherever
/// the link points.
fn read_regular(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
        Ok(meta) if !meta.file_type().is_file() => Err(format!(
            "{}: not a regular file; the readable folder will not replace it. Remove it to let \
             the application write the list again.",
            path.display()
        )),
        Ok(_) => std::fs::read(path)
            .map(Some)
            .map_err(|error| format!("{}: {error}", path.display())),
    }
}

/// `persist_pauses`' discipline: a fresh temp file, synced, then renamed over
/// the name, so a reader never sees half a list. The directory is synced after
/// the rename because the record, content, record order is what makes a crash
/// recoverable, and unsynced renames can reach the disk out of that order.
fn write_atomically(dir: &std::path::Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    static NEXT_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let ordinal = NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(
        "{TEMP_PREFIX}{}.{}.tmp",
        std::process::id(),
        ordinal
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|error| format!("{}: {error}", tmp.display()))?;
    use std::io::Write;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{}: {error}", tmp.display()));
    }
    let dest = dir.join(name);
    std::fs::rename(&tmp, &dest).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {error}", dest.display())
    })?;
    sync_dir(dir)
}

#[cfg(unix)]
fn sync_dir(dir: &std::path::Path) -> Result<(), String> {
    std::fs::File::open(dir)
        .and_then(|handle| handle.sync_all())
        .map_err(|error| format!("{}: {error}", dir.display()))
}

// std offers no directory sync on Windows, where a directory cannot be opened
// as a file; the rename is the last step there.
#[cfg(not(unix))]
fn sync_dir(_dir: &std::path::Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Result<Vec<String>, String> {
        Ok(list.iter().map(|w| w.to_string()).collect())
    }

    fn list(dir: &std::path::Path) -> String {
        std::fs::read_to_string(dir.join(WORDLIST_NAME)).unwrap()
    }

    #[cfg(unix)]
    fn identity(path: &std::path::Path) -> (u64, std::time::SystemTime) {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(path).unwrap();
        (meta.ino(), meta.modified().unwrap())
    }

    #[test]
    fn wordlist_sorts_by_code_point_and_keeps_case_and_unicode() {
        let tmp = tempfile::tempdir().unwrap();
        // Decomposed and precomposed forms are different words and stay so.
        let decomposed = "A\u{308}pfel";
        let outcome = maintain(
            tmp.path(),
            words(&[
                "zeta", "Äpfel", "Zed", "apple", decomposed, "Émile", "émile", "東京",
            ]),
        );
        assert_eq!(outcome, Outcome::Written);
        assert_eq!(
            list(tmp.path()),
            format!("{decomposed}\nZed\napple\nzeta\nÄpfel\nÉmile\némile\n東京\n")
        );
    }

    #[test]
    fn wordlist_follows_additions_and_removals() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            maintain(tmp.path(), words(&["Mireth", "Kethrani"])),
            Outcome::Written
        );
        assert_eq!(
            maintain(tmp.path(), words(&["Mireth", "Amberline"])),
            Outcome::Written
        );
        assert_eq!(list(tmp.path()), "Amberline\nMireth\n");
        assert_eq!(maintain(tmp.path(), words(&[])), Outcome::Written);
        assert_eq!(list(tmp.path()), "");
    }

    #[test]
    fn wordlist_for_an_empty_dictionary_is_an_empty_file() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(maintain(tmp.path(), words(&[])), Outcome::Written);
        assert_eq!(std::fs::read(tmp.path().join(WORDLIST_NAME)).unwrap(), b"");
        assert!(tmp.path().join(OWNER_NAME).is_file());
    }

    #[test]
    fn wordlist_edited_outside_is_preserved_and_reported() {
        let tmp = tempfile::tempdir().unwrap();
        maintain(tmp.path(), words(&["Mireth"]));
        std::fs::write(tmp.path().join(WORDLIST_NAME), "Mireth\nmine\n").unwrap();
        let record = std::fs::read(tmp.path().join(OWNER_NAME)).unwrap();
        let outcome = maintain(tmp.path(), words(&["Mireth", "Kethrani"]));
        assert!(matches!(outcome, Outcome::Conflict(_)), "{outcome:?}");
        assert!(outcome.problem().unwrap().contains(WORDLIST_NAME));
        assert_eq!(list(tmp.path()), "Mireth\nmine\n");
        assert_eq!(std::fs::read(tmp.path().join(OWNER_NAME)).unwrap(), record);
        // An unchanged dictionary does not make the edit the application's.
        assert!(matches!(
            maintain(tmp.path(), words(&["Mireth"])),
            Outcome::Conflict(_)
        ));
    }

    #[test]
    fn wordlist_deleted_file_or_record_is_recreated() {
        let tmp = tempfile::tempdir().unwrap();
        maintain(tmp.path(), words(&["Mireth"]));
        std::fs::remove_file(tmp.path().join(WORDLIST_NAME)).unwrap();
        assert_eq!(maintain(tmp.path(), words(&["Mireth"])), Outcome::Written);
        assert_eq!(list(tmp.path()), "Mireth\n");

        std::fs::remove_file(tmp.path().join(OWNER_NAME)).unwrap();
        assert_eq!(maintain(tmp.path(), words(&["Mireth"])), Outcome::Adopted);
        assert!(tmp.path().join(OWNER_NAME).is_file());
        assert_eq!(maintain(tmp.path(), words(&["Mireth"])), Outcome::Unchanged);
    }

    #[test]
    fn wordlist_without_a_record_is_not_claimed_unless_it_is_already_the_list() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(WORDLIST_NAME), "the writer's own\n").unwrap();
        assert!(matches!(
            maintain(tmp.path(), words(&["Mireth"])),
            Outcome::Conflict(_)
        ));
        assert_eq!(list(tmp.path()), "the writer's own\n");
        assert!(!tmp.path().join(OWNER_NAME).exists());
    }

    #[test]
    fn wordlist_malformed_or_unknown_record_fails_closed() {
        let tmp = tempfile::tempdir().unwrap();
        maintain(tmp.path(), words(&["Mireth"]));
        let good = std::fs::read_to_string(tmp.path().join(OWNER_NAME)).unwrap();
        for bad in [
            "{not json".to_string(),
            good.replace("\"version\": 1", "\"version\": 2"),
            good.replace(OWNER_FORMAT, "someone.else/list"),
            good.replace("\"format\"", "\"extra\": 1,\n  \"format\""),
        ] {
            assert_ne!(bad, good);
            std::fs::write(tmp.path().join(OWNER_NAME), &bad).unwrap();
            let outcome = maintain(tmp.path(), words(&["Kethrani"]));
            assert!(matches!(outcome, Outcome::Failed(_)), "{bad}: {outcome:?}");
            assert_eq!(list(tmp.path()), "Mireth\n");
            assert_eq!(
                std::fs::read_to_string(tmp.path().join(OWNER_NAME)).unwrap(),
                bad
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn wordlist_already_holding_the_list_is_adopted_without_a_rewrite() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(WORDLIST_NAME);
        std::fs::write(&path, "Amberline\nMireth\n").unwrap();
        let before = identity(&path);
        assert_eq!(
            maintain(tmp.path(), words(&["Mireth", "Amberline"])),
            Outcome::Adopted
        );
        assert_eq!(identity(&path), before);
        assert_eq!(list(tmp.path()), "Amberline\nMireth\n");
    }

    #[cfg(unix)]
    #[test]
    fn wordlist_crash_between_content_and_record_recovers() {
        let tmp = tempfile::tempdir().unwrap();
        maintain(tmp.path(), words(&["Mireth"]));
        // The content of the next pass landed; its record did not.
        write_atomically(tmp.path(), WORDLIST_NAME, b"Kethrani\nMireth\n").unwrap();
        let before = identity(&tmp.path().join(WORDLIST_NAME));
        assert_eq!(
            maintain(tmp.path(), words(&["Mireth", "Kethrani"])),
            Outcome::Adopted
        );
        assert_eq!(identity(&tmp.path().join(WORDLIST_NAME)), before);
        assert_eq!(maintain(tmp.path(), words(&["Kethrani"])), Outcome::Written);
        assert_eq!(list(tmp.path()), "Kethrani\n");
    }

    #[test]
    fn wordlist_crash_after_the_rename_survives_a_dictionary_change() {
        let tmp = tempfile::tempdir().unwrap();
        maintain(tmp.path(), words(&["Mireth"]));
        // A pass announced and renamed its list, then died before settling.
        let landed = b"Kethrani\nMireth\n";
        write_owner(
            tmp.path(),
            &Ownership::intent(Baseline::of(b"Mireth\n"), landed),
        )
        .unwrap();
        write_atomically(tmp.path(), WORDLIST_NAME, landed).unwrap();
        // The dictionary moved again before the next pass.
        assert_eq!(
            maintain(tmp.path(), words(&["Amberline"])),
            Outcome::Written
        );
        assert_eq!(list(tmp.path()), "Amberline\n");
        assert_eq!(
            maintain(tmp.path(), words(&["Amberline"])),
            Outcome::Unchanged
        );
    }

    #[test]
    fn wordlist_crash_before_the_rename_survives_a_dictionary_change() {
        let tmp = tempfile::tempdir().unwrap();
        maintain(tmp.path(), words(&["Mireth"]));
        write_owner(
            tmp.path(),
            &Ownership::intent(Baseline::of(b"Mireth\n"), b"Kethrani\nMireth\n"),
        )
        .unwrap();
        assert_eq!(
            maintain(tmp.path(), words(&["Amberline"])),
            Outcome::Written
        );
        assert_eq!(list(tmp.path()), "Amberline\n");
    }

    #[test]
    fn wordlist_an_unsettled_intent_is_settled_without_a_rewrite() {
        let tmp = tempfile::tempdir().unwrap();
        maintain(tmp.path(), words(&["Mireth"]));
        let landed = b"Kethrani\nMireth\n";
        write_owner(
            tmp.path(),
            &Ownership::intent(Baseline::of(b"Mireth\n"), landed),
        )
        .unwrap();
        write_atomically(tmp.path(), WORDLIST_NAME, landed).unwrap();
        assert_eq!(
            maintain(tmp.path(), words(&["Mireth", "Kethrani"])),
            Outcome::Adopted
        );
        // Settled: the old baseline no longer protects a file put back to it.
        std::fs::write(tmp.path().join(WORDLIST_NAME), "Mireth\n").unwrap();
        assert!(matches!(
            maintain(tmp.path(), words(&["Mireth", "Kethrani"])),
            Outcome::Conflict(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn wordlist_reaps_only_its_own_crash_debris() {
        let tmp = tempfile::tempdir().unwrap();
        let debris = tmp.path().join(".readable-mirror-wordlist.4242.7.tmp");
        std::fs::write(&debris, "half").unwrap();
        let unlike = tmp.path().join(".readable-mirror-wordlist.x.7.tmp");
        std::fs::write(&unlike, "not ours").unwrap();
        let target = tmp.path().join("kept.txt");
        std::fs::write(&target, "kept").unwrap();
        let linked = tmp.path().join(".readable-mirror-wordlist.4242.8.tmp");
        std::os::unix::fs::symlink(&target, &linked).unwrap();

        assert_eq!(maintain(tmp.path(), words(&["Mireth"])), Outcome::Written);
        assert!(!debris.exists());
        assert!(unlike.is_file());
        assert!(std::fs::symlink_metadata(&linked)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "kept");
    }

    #[test]
    fn wordlist_held_messages_name_the_way_out() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(WORDLIST_NAME), "mine\n").unwrap();
        let held = maintain(tmp.path(), words(&["Mireth"]));
        assert!(
            held.problem().unwrap().contains("Delete wordlist.txt"),
            "{held:?}"
        );
        std::fs::write(tmp.path().join(OWNER_NAME), "{").unwrap();
        let broken = maintain(tmp.path(), words(&["Mireth"]));
        assert!(
            broken
                .problem()
                .unwrap()
                .contains("delete it and wordlist.txt"),
            "{broken:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn wordlist_unchanged_is_not_rewritten() {
        let tmp = tempfile::tempdir().unwrap();
        maintain(tmp.path(), words(&["Mireth"]));
        let content = identity(&tmp.path().join(WORDLIST_NAME));
        let record = identity(&tmp.path().join(OWNER_NAME));
        assert_eq!(maintain(tmp.path(), words(&["Mireth"])), Outcome::Unchanged);
        assert_eq!(identity(&tmp.path().join(WORDLIST_NAME)), content);
        assert_eq!(identity(&tmp.path().join(OWNER_NAME)), record);
    }

    #[test]
    fn wordlist_refuses_a_word_with_a_line_break() {
        let tmp = tempfile::tempdir().unwrap();
        maintain(tmp.path(), words(&["Mireth"]));
        for broken in [
            "Two\nWords",
            "Carriage\rReturn",
            "Vertical\u{0B}Tab",
            "Form\u{0C}Feed",
            "Next\u{85}Line",
            "Line\u{2028}Separator",
            "Paragraph\u{2029}Separator",
        ] {
            let outcome = maintain(tmp.path(), words(&["Mireth", broken]));
            assert!(matches!(outcome, Outcome::Failed(_)), "{outcome:?}");
            assert_eq!(list(tmp.path()), "Mireth\n");
        }
    }

    #[cfg(unix)]
    #[test]
    fn wordlist_refuses_symlinks_and_other_non_files() {
        for name in [WORDLIST_NAME, OWNER_NAME] {
            let tmp = tempfile::tempdir().unwrap();
            let target = tmp.path().join("elsewhere.txt");
            std::fs::write(&target, "untouched\n").unwrap();
            std::os::unix::fs::symlink(&target, tmp.path().join(name)).unwrap();
            let outcome = maintain(tmp.path(), words(&["Mireth"]));
            assert!(matches!(outcome, Outcome::Failed(_)), "{name}: {outcome:?}");
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "untouched\n");
            assert!(std::fs::symlink_metadata(tmp.path().join(name))
                .unwrap()
                .file_type()
                .is_symlink());
        }
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(WORDLIST_NAME)).unwrap();
        assert!(matches!(
            maintain(tmp.path(), words(&["Mireth"])),
            Outcome::Failed(_)
        ));
        assert!(tmp.path().join(WORDLIST_NAME).is_dir());
    }

    #[test]
    fn wordlist_names_are_reserved_and_nothing_else_is() {
        assert!(is_reserved(WORDLIST_NAME));
        assert!(is_reserved(OWNER_NAME));
        assert!(is_reserved(".readable-mirror-wordlist.123.4.tmp"));
        for other in [
            "Part/wordlist.txt",
            "wordlist.md",
            ".readable-mirror-wordlist.x.4.tmp",
            ".readable-mirror-wordlist.123.tmp",
        ] {
            assert!(!is_reserved(other), "{other}");
        }
    }
}
