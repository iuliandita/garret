// app/shell-tauri/src-tauri/src/recovery.rs
// Same-device recovery points: a VACUUM INTO snapshot with referenced original
// pictures, verified as one directory and described by the shared manifest.
//
// NOTHING HERE IS ON THE KEYSTROKE PATH and nothing here holds the store mutex
// across the copy -- see `tick`.

use crate::store::history::hash64;
use std::path::{Path, PathBuf};

/// Serializes whole recovery attempts at their callers. Low-level copy helpers
/// deliberately do not take it so tests and legacy callers retain their shape.
pub(crate) static PASSING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The civil date, in UTC, from a count of days since 1970-01-01.
///
/// Howard Hinnant's `civil_from_days`, transcribed. The host has never carried
/// calendar arithmetic -- `project_progress` takes `today` from the page for
/// exactly that reason -- and this is the smallest amount that answers "what
/// should this file be called". UTC ONLY: a recovery point named in local time
/// would change what it is called when a writer travels, and the `Z` says which
/// clock it is in.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `2026-08-19T21-14-02Z`. Colons are hyphens: a colon is legal on ext4 and a
/// nuisance everywhere a writer might carry the file, and this name is meant to
/// be copied onto a USB stick.
///
/// `div_euclid`/`rem_euclid`, never `/` and `%`: integer division truncates
/// toward zero, so a timestamp before the epoch would land on the wrong day at
/// the wrong hour rather than failing visibly.
pub fn point_id(now_ms: i64) -> String {
    let secs = now_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// How many recovery points a project keeps at most.
///
/// 48, and the arithmetic is the argument: at one point every 15 minutes the
/// last hour holds 4, the hour buckets from there to a day hold 23, and the
/// remaining 21 are day buckets -- three weeks of daily floors behind a dense
/// afternoon. A flat cap of N would spend the whole budget on the last hour,
/// which is the failure `store::history`'s own thinning was written against.
pub const MAX_POINTS: usize = 48;

/// One recovery point, as the manifest describes it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Point {
    /// `2026-08-19T21-14-02Z`. New points use `<id>.point/`; legacy points use `<id>.db`.
    pub id: String,
    #[serde(rename = "mtime_ms")]
    pub at_ms: i64,
    /// New points count all regular payload files; legacy points retain their
    /// original database-only byte count.
    pub bytes: u64,
    /// FNV-64 over the snapshot database's bytes; bitrot detection, not authentication.
    pub hash: String,
    /// The database read passed. For new points, the inventory and every
    /// referenced original also verified.
    pub verified: bool,
    /// A new point's database and inventory bind cleanly even if pictures did
    /// not. Legacy points use `verified` for their database-only claim.
    #[serde(default, skip_serializing_if = "bool_is_false")]
    pub database_verified: bool,
    pub verified_at: Option<i64>,
    /// Absent on older, database-only points.
    #[serde(default, skip_serializing_if = "bool_is_false")]
    pub bundle: bool,
    /// Relative asset names and error classes only; never source paths.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

fn bool_is_false(value: &bool) -> bool {
    !*value
}

/// Which points to DELETE, `points` newest first.
///
/// The bucket policy is `store::history::thin_with_cap` -- ONE rule, two
/// callers. Restating it here would be a second description of a policy that
/// drifts on the first change; what differs between a document's version
/// history and a project's recovery points is the cap, and that is now a
/// parameter.
///
/// On top of it, the floor: THE MOST RECENTLY VERIFIED POINT IS NEVER
/// ELIGIBLE, whatever the bucket math or the cap says. That is the spec's
/// "retention cannot delete the last verified recovery point" made concrete.
/// An UNVERIFIED point carries no such protection -- it is worth keeping until
/// a later backup supersedes it, but it is not the floor.
pub fn prune(now_ms: i64, points: &[Point], cap: usize) -> Vec<usize> {
    let ats: Vec<i64> = points.iter().map(|p| p.at_ms).collect();
    let mut drop = crate::store::history::thin_with_cap(now_ms, &ats, cap);
    // `points` is newest first, so the first verified entry IS the most
    // recently verified one.
    if let Some(floor) = points.iter().position(|p| p.verified) {
        drop.retain(|i| *i != floor);
    }
    // One incomplete point remains useful for diagnosis, but repeated failures
    // must not grow the recovery store without bound.
    let newest_incomplete = points
        .iter()
        .position(|p| !p.verified && !p.database_verified);
    for (i, point) in points.iter().enumerate() {
        if !point.verified
            && !point.database_verified
            && Some(i) != newest_incomplete
            && !drop.contains(&i)
        {
            drop.push(i);
        }
    }
    drop.retain(|i| Some(*i) != newest_incomplete);
    drop.sort_unstable();
    drop
}

/// The manifest envelope, `kind: "recovery"` form.
///
/// ONE ENVELOPE WITH TWO FORMS, shared with the form that
/// produces the `kind: "mirror"` form. Same field names, same semantics, one
/// reader. DO NOT RENAME A FIELD HERE without amending both documents.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Manifest<E = Point> {
    /// The ENVELOPE's version, separate from `generator.format_version`, which
    /// is the artifact's. A snapshot's format is the store's `SCHEMA_VERSION`
    /// and a mirror file's is its Markdown dialect; neither is the shape of
    /// this file. Spec section 12 asks every advertised format for a versioned
    /// contract, and that is two contracts here.
    pub manifest_version: u32,
    /// The discriminator, and the only thing a reader branches on.
    pub kind: String,
    pub project: ProjectRef,
    pub generated_at: i64,
    pub generator: Generator,
    pub completeness: Completeness,
    /// WHAT THIS ARTIFACT DOES NOT CONTAIN, and the list is only worth anything
    /// if an EMPTY one means "nothing is left out".
    ///
    /// Legacy database-only points name the picture gap. New bundle points
    /// leave this empty only when every referenced original verifies.
    ///
    /// **The mirror form carries FOUR**: pictures, then
    /// notes, history and synopsis, in that order. A projection into Markdown
    /// genuinely cannot carry a comment anchor or a past revision, and until
    /// this was added the manifest said nothing about it -- which read as
    /// completeness rather than as the gap it was.
    pub exclusions: Vec<String>,
    /// Newest first for a recovery or archive manifest, because `point_id`
    /// sorts lexicographically in time order and the directory listing agrees.
    ///
    /// **GENERIC OVER THE ENTRY TYPE, which is how one envelope serves two
    /// producers** -- settled 2026-08-23 with both of them in the tree, after
    /// 016 and 018 each deferred it for having only one. `Manifest<Point>` is
    /// the recovery and archive form; `Manifest<mirror::Entry>` is the mirror
    /// form.
    ///
    /// The two rejected shapes and why. **`Option` fields on one flat struct**
    /// admit impossible states: nothing in the type stops a mirror entry
    /// carrying `verified`, and every consumer unwraps. **An enum per kind**
    /// cannot be deserialized without a hand-written `Deserialize`, because
    /// which variant an entry is depends on the PARENT's `kind` field, which
    /// serde has no way to express. The generic has neither problem and adds no
    /// runtime branch at all: the producer picks the type, and `kind` stays the
    /// only thing a dynamic reader branches on.
    pub entries: Vec<E>,
    /// Empty for a recovery manifest; present so ONE reader parses both forms.
    pub conflicts: Vec<String>,
    /// The same.
    pub unmatched: Vec<String>,
    /// BITROT DETECTION ON THIS FILE, NEVER AUTHENTICATION.
    ///
    /// Every entry already carries its own `hash` over its own `.db`, so the
    /// only resting copy left without one is this manifest. Design section 4a
    /// defines the field's ROLE and not its subject; this is a reading of an
    /// underspecified field and the readable mirror shares it -- see the
    /// write-back.
    ///
    /// What authenticates a recovery point is the structural read
    /// (`Store::open_readonly` plus `cli::validate`'s walk). A point whose hash
    /// still matches and whose structural read fails is reported as FAILED.
    pub checksum: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ProjectRef {
    pub slug: String,
    pub name: String,
    pub schema_version: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Generator {
    pub app_version: String,
    /// The ARTIFACT format's version, not the envelope's.
    pub format_version: u32,
}

/// A COUNTABLE CLAIM, NOT AN ADJECTIVE, so "complete" can be checked rather
/// than believed.
///
/// SETTLED 2026-08-22 (`decisions/2026-08-22-manifest-semantics.md`), after
/// three slices consumed it unstated: **`completeness` describes the state the
/// manifest currently CLAIMS.** For a mirror manifest that is the one
/// projection; for a recovery or archive manifest it is **the newest entry**.
///
/// `entries_written` is the length of `entries` and is the only one of the four
/// that is about the directory at all. The other three are read out of the
/// newest entry's snapshot.
///
/// The subject differs by form because the entries do: a mirror's N entries are
/// PARTS OF ONE STATE of the book (`entries` is 1:1 with the store's walk), and
/// a recovery directory's N entries are each a WHOLE STATE. Summing items
/// across N snapshots of one manuscript counts it N times, so the directory was
/// never an available reading here.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Completeness {
    pub items_total: u64,
    pub entries_written: u64,
    pub documents_with_prose: u64,
    pub unreadable_bodies: u64,
    /// How many cast pictures the newest snapshot names. New points include
    /// their distinct originals; legacy database-only points do not.
    ///
    /// `#[serde(default)]` so a manifest written before this field existed still parses:
    /// `read_manifest` treats a manifest that will not parse as ABSENT, so a
    /// strictly-required field here would make every existing recovery
    /// directory look like a project that had never been backed up. Same
    /// leniency, and the same reason, as `read_settings`'.
    #[serde(default)]
    pub pictures: u64,
    /// How many COVERS the newest snapshot names.
    ///
    /// A SECOND FIGURE AND NOT A WIDER FIRST ONE. A cast photograph is a column
    /// on a row a writer can delete; a cover is a `meta` row that outlives every
    /// character in the book. One number would tell a person that three pictures
    /// are missing from this copy without saying whether one of them is the
    /// thing on the front of their book -- which is the one they cannot redraw
    /// from memory.
    ///
    /// `#[serde(default)]` for `pictures`' reason exactly: every recovery
    /// directory this build has already written must go on parsing, or
    /// `read_manifest` reads it as ABSENT and a writer is told they have no
    /// backup.
    #[serde(default)]
    pub covers: u64,
}

/// The picture gap in legacy database-only points and readable mirrors.
///
/// A SENTENCE AND NOT A TOKEN, unlike a `Loss.kind`. Nothing branches on this --
/// it exists to be READ, by a person opening a manifest beside a snapshot they
/// are about to restore from, and a machine token would need a second table
/// somewhere to say what it meant.
pub const EXCLUSION_PICTURES: &str =
    "pictures: a cast member's photograph and the book's front and back covers are files beside the project, not rows inside it, so they are not in this copy. The pictures are in <project>.pictures/ next to the project file.";

/// THE MIRROR'S FIRST NAMED GAP. A `.md` file has no
/// place to hold a comment anchor, so a note never reached the folder at all --
/// and until this constant the manifest said nothing about it, which read as
/// completeness rather than as the omission it was.
pub const EXCLUSION_NOTES: &str =
    "notes: a note on a passage, and where it anchors, are not in this copy; they live in the project file, in recovery points and in archives. Taking a file back in through the change set replaces the scene's prose, and a note whose passage is gone is reported as orphaned in the notes panel.";

/// SAME GAP, DIFFERENT ARTIFACT. A `.md` file is one resting state of a scene;
/// the revisions that led to it are rows the mirror never walks.
pub const EXCLUSION_HISTORY: &str =
    "history: the version history of each scene is not in this copy; it is in the project file, in recovery points and in archives.";

/// THE ONLY EXCLUSION HERE THAT IS A CHOICE, NOT A LIMIT OF THE FORMAT.
/// `2026-08-28-synopsis.md` settled that a `synopsis:` front-matter key would
/// make every outside edit unacceptable until the reader learned it, so this
/// sentence says the omission is deliberate rather than a thing to file
/// against.
pub const EXCLUSION_SYNOPSIS: &str =
    "synopsis: a scene's synopsis is not in this copy, by design -- a synopsis key would make every outside edit unacceptable.";

const MANIFEST_VERSION: u32 = 1;
const FORMAT_VERSION: u32 = 1;
const KIND_RECOVERY: &str = "recovery";
/// The third form of the envelope, beside `recovery` and the mirror's.
///
/// It shares the RECOVERY form's entry shape rather than needing a new one:
/// `verified` and `verified_at` mean exactly what they mean for a recovery
/// point, because an archive is verified by the same `cli::validate` walk. That
/// is what keeps this slice out of plan 006's open question -- whether the
/// entry becomes an enum or its fields become `Option` -- which is an owner
/// call and not a thing to settle in passing.
const KIND_ARCHIVE: &str = "archive";
/// The readable mirror's form, produced by `crate::mirror`.
///
/// The envelope lives here rather than in its own module only because it was
/// born here; it is now shared by two producers and the file it sits in is
/// cosmetic. Moving it is tracked, and moves no bytes on disk.
pub(crate) const KIND_MIRROR: &str = "mirror";

impl Manifest<Point> {
    pub fn recovery(
        project: ProjectRef,
        generated_at: i64,
        completeness: Completeness,
        entries: Vec<Point>,
    ) -> Manifest {
        let exclusions = point_exclusions(&entries);
        Manifest::sealed(
            KIND_RECOVERY,
            project,
            generated_at,
            completeness,
            entries,
            exclusions,
        )
    }

    /// The `kind: "archive"` form: one entry, the folder the writer moves off
    /// this computer themselves.
    ///
    /// SAME ENVELOPE, SAME READER. The design's section 4a is explicit that
    /// there is one envelope discriminated by `kind`, and a second struct with
    /// the same field names in a different file is the thing 013's maintenance
    /// note says must not happen.
    pub fn archive(
        project: ProjectRef,
        generated_at: i64,
        completeness: Completeness,
        entries: Vec<Point>,
    ) -> Manifest {
        // An incomplete archive must name its gap because this may become the
        // only copy the writer carries off the machine.
        let exclusions = point_exclusions(&entries);
        Manifest::sealed(
            KIND_ARCHIVE,
            project,
            generated_at,
            completeness,
            entries,
            exclusions,
        )
    }
}

fn point_exclusions(entries: &[Point]) -> Vec<String> {
    match entries.iter().max_by(|a, b| a.at_ms.cmp(&b.at_ms).then_with(|| a.id.cmp(&b.id))) {
        Some(point) if point.bundle && point.verified => Vec::new(),
        Some(point) if point.bundle => vec!["pictures: this point could not copy or verify every referenced original; see its entry errors".into()],
        _ => vec![EXCLUSION_PICTURES.to_string()],
    }
}

impl<E: serde::Serialize> Manifest<E> {
    /// The `kind: "mirror"` form: one entry per item in the writer's walk.
    ///
    /// SAME ENVELOPE, SAME READER, and the entry type is what differs -- see
    /// `entries`. A second envelope struct with the same field names in a
    /// different file is the thing 013's maintenance note says must not happen,
    /// and it is what this constructor exists to make unnecessary.
    pub fn mirror(
        project: ProjectRef,
        generated_at: i64,
        completeness: Completeness,
        entries: Vec<E>,
    ) -> Manifest<E> {
        // FOUR. Pictures first, because that exclusion is
        // shared with the recovery and archive forms; then notes, history and
        // synopsis, which belong to the mirror alone -- a `.md` file has no
        // slot for a comment anchor, no row for a past revision, and by design
        // no `synopsis:` key at all.
        Manifest::sealed(
            KIND_MIRROR,
            project,
            generated_at,
            completeness,
            entries,
            vec![
                EXCLUSION_PICTURES.to_string(),
                EXCLUSION_NOTES.to_string(),
                EXCLUSION_HISTORY.to_string(),
                EXCLUSION_SYNOPSIS.to_string(),
            ],
        )
    }

    fn sealed(
        kind: &str,
        project: ProjectRef,
        generated_at: i64,
        completeness: Completeness,
        entries: Vec<E>,
        exclusions: Vec<String>,
    ) -> Manifest<E> {
        let mut m = Manifest {
            manifest_version: MANIFEST_VERSION,
            kind: kind.to_string(),
            project,
            generated_at,
            generator: Generator {
                app_version: env!("CARGO_PKG_VERSION").to_string(),
                format_version: FORMAT_VERSION,
            },
            completeness,
            exclusions,
            entries,
            conflicts: Vec::new(),
            unmatched: Vec::new(),
            checksum: String::new(),
        };
        // THE MANIFEST'S OWN INTEGRITY, not the snapshots' -- settled
        // 2026-08-22. Per-artifact bitrot detection is `entry.hash`, which
        // already covers every file this manifest names; a second hash of the
        // same bytes would be the redundant reading.
        //
        // Over the serialization with `checksum` EMPTY, so the figure is
        // reproducible by any reader that clears the field and re-serializes.
        // `the_checksum_is_what_a_reader_recomputes_by_blanking_the_field`
        // pins that contract; determinism alone does not imply it.
        let body = serde_json::to_vec(&m).unwrap_or_default();
        m.checksum = format!("{:016x}", hash64(&body));
        m
    }
}

/// The first free `<id>.point/`, `<id>-2.point/`, ... in `dir`.
///
/// This picks a name worth trying; the writer lock serializes application
/// writers, and publication checks the destination again. Two points inside
/// one second can come from a manual backup landing beside a tick.
fn pick_point_path(dir: &Path, id: &str) -> (String, PathBuf) {
    for probe in 1u32.. {
        let name = if probe == 1 {
            id.to_string()
        } else {
            format!("{id}-{probe}")
        };
        let path = crate::backup_bundle::path_for(dir, &name);
        if std::fs::symlink_metadata(&path).is_err()
            && std::fs::symlink_metadata(dir.join(format!("{name}.db"))).is_err()
        {
            return (name, path);
        }
    }
    unreachable!("u32 range is exhausted only by 4 billion points in one second")
}

/// The completeness figures, read out of the snapshot itself so "complete" is
/// checkable rather than believed. An unreadable snapshot cannot support a
/// completeness claim, even if its point is retained as unverified.
fn counts(path: &Path) -> Result<Counts, String> {
    let store = crate::store::Store::open_readonly(path)
        .map_err(|e| format!("cannot open the newest snapshot: {e}"))?;
    let schema_version = store
        .user_version()
        .map_err(|e| format!("cannot read the newest snapshot's schema version: {e}"))?;
    let items = store
        .items()
        .map_err(|e| format!("cannot read the newest snapshot's items: {e}"))?;
    let items_total = items.len() as u64;
    // A TIMELINE'S BODY IS NEVER "PROSE" AND NEVER "UNREADABLE" -- MAJOR
    // review finding, item 8, `validate`'s own reason (cli.rs): it is not a
    // document at all, by design, so counting it as damage or as a document
    // that carries no words a writer wrote would misreport a healthy file.
    let timeline_ids: std::collections::HashSet<&str> = items
        .iter()
        .filter(|i| i.item_type == crate::store::TIMELINE_TYPE)
        .map(|i| i.id.as_str())
        .collect();
    let bodies = store
        .documents()
        .map_err(|e| format!("cannot read the newest snapshot's documents: {e}"))?;
    let prose_bodies = bodies
        .iter()
        .filter(|(id, _)| !timeline_ids.contains(id.as_str()));
    let documents_with_prose = prose_bodies.clone().count() as u64;
    let unreadable = prose_bodies
        .filter(|(_, b)| crate::export::document_markdown(b).is_none())
        .count() as u64;
    // GUARDED ON THE VERSION, `missing_blobs`' rule: a file behind v8 has no
    // `picture_path` column and is not thereby
    // damaged, so it is not asked about a column the pragma would have said does
    // not exist.
    let pictures = if schema_version >= 8 {
        store
            .pictures_named()
            .map_err(|e| format!("cannot read the newest snapshot's pictures: {e}"))?
    } else {
        0
    };
    // NO VERSION GUARD, and the asymmetry with the line above is the point:
    // `meta` has existed since v1, so there is no version at which asking a file
    // for its covers is asking it about a column it does not have. A guard here
    // would be a refusal nothing could reach.
    let covers = crate::covers::covers_named(&store)
        .map_err(|e| format!("cannot read the newest snapshot's covers: {e}"))?;
    Ok(Counts {
        items_total,
        documents_with_prose,
        unreadable,
        pictures,
        covers,
        schema_version,
    })
}

/// What `counts` reads out of one snapshot.
///
/// A STRUCT AND NOT A TUPLE, and the fifth element was why: four
/// bare `u64`s in a row destructured at two call sites is four chances to swap
/// two of them, and nothing about the types would notice. A later addition made
/// it six, which is that argument holding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Counts {
    items_total: u64,
    documents_with_prose: u64,
    unreadable: u64,
    pictures: u64,
    covers: u64,
    schema_version: i64,
}

/// The completeness figures, read from THE NEWEST ENTRY the manifest will
/// carry -- which is what those three fields are ABOUT, settled 2026-08-22.
///
/// `max_by`, NEVER `entries[0]`, even though every writer in this module sorts
/// immediately before calling it. `describe_dir` and `describe_archives` both
/// take `max` rather than `first` and both record the reason: a manifest is a
/// file the application does not own between runs, and a reader that depended
/// on the ordering starts lying the day a hand-edited or partially-restored one
/// arrives out of order. A WRITER that depended on it is the same defect facing
/// the other way.
///
/// The key is `(at_ms, id)` because that is the sort's key, so "newest" has one
/// definition in this module rather than two that agree only by inspection.
fn newest_counts(dir: &Path, entries: &[Point]) -> Result<Counts, String> {
    let newest = entries
        .iter()
        .max_by(|a, b| a.at_ms.cmp(&b.at_ms).then_with(|| a.id.cmp(&b.id)))
        .ok_or_else(|| "cannot describe a manifest with no recovery entries".to_string())?;
    counts(&crate::backup_bundle::point_db(
        dir,
        &newest.id,
        newest.bundle,
    ))
}

fn preflight_counts(
    source: &Path,
    dir: &Path,
    entries: &[Point],
    at_ms: i64,
    id: &str,
) -> Result<(), String> {
    // Refuse persistent read failures before another full copy is made. The
    // snapshot is still counted after copying: this is not its measured claim.
    counts(source).map_err(|e| format!("cannot prepare a snapshot: {e}"))?;
    if entries
        .iter()
        .any(|p| (p.at_ms, p.id.as_str()) > (at_ms, id))
    {
        newest_counts(dir, entries)?;
    }
    Ok(())
}

/// The describing file's name, and the temp file it is written through.
///
/// NAMED rather than repeated: the mirror's stage-1 scan must skip both, and a
/// second literal there would drift from this one silently -- the symptom being
/// the application reporting its own bookkeeping as the writer's stray file.
pub(crate) const MANIFEST_NAME: &str = "manifest.json";
pub(crate) const MANIFEST_TMP_NAME: &str = ".manifest.json.tmp";

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(MANIFEST_NAME)
}

/// A manifest that will not parse is treated as ABSENT rather than fatal, the
/// same leniency `read_settings` applies for the same reason: one unreadable
/// describing file must not stop the application producing the next good
/// recovery point. The points themselves are still on disk and still readable
/// by `cli::validate`.
pub(crate) fn read_manifest<E: serde::de::DeserializeOwned>(dir: &Path) -> Option<Manifest<E>> {
    let text = std::fs::read(manifest_path(dir)).ok()?;
    serde_json::from_slice(&text).ok()
}

fn point_id_safe(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('.')
        && !id.ends_with('.')
        && !id.ends_with(' ')
        && !id.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
}

fn read_point_manifest(dir: &Path) -> Result<Option<Manifest<Point>>, String> {
    let manifest = read_manifest::<Point>(dir);
    if manifest
        .as_ref()
        .is_some_and(|m| m.entries.iter().any(|p| !point_id_safe(&p.id)))
    {
        return Err("recovery manifest contains an unsafe point id".into());
    }
    Ok(manifest)
}

fn refuse_unlisted_bundles(dir: &Path, entries: &[Point]) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("backup directory unreadable: {e}"))? {
        let entry = entry.map_err(|e| format!("backup directory entry unreadable: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(crate::backup_bundle::SUFFIX) {
            if !entries.iter().any(|p| p.bundle && p.id == id) {
                return Err(format!(
                    "unlisted backup point {name}; inspect it before another backup"
                ));
            }
        }
    }
    Ok(())
}

/// Write-temp then rename, which is `write_settings`' discipline: a manifest
/// truncated by a crash mid-write would describe recovery points that are fine
/// as though they were not.
pub(crate) fn write_manifest<E: serde::Serialize>(
    dir: &Path,
    m: &Manifest<E>,
) -> Result<(), String> {
    let dest = manifest_path(dir);
    let tmp = dir.join(MANIFEST_TMP_NAME);
    let text = serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    use std::io::Write as _;
    file.write_all(&text)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    crate::backup_bundle::sync_directory(dir)
}

fn lock_manifest(dir: &Path) -> Result<std::fs::File, String> {
    let path = dir.join(".backup.lock");
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .open(&path)
        .map_err(|e| format!("backup lock unavailable: {e}"))?;
    file.try_lock()
        .map_err(|_| "another backup writer is active".to_string())?;
    Ok(file)
}

/// Take one recovery point: copy, verify, describe, prune.
///
/// NOTHING HERE HOLDS THE STORE MUTEX -- the caller reads the path off it and
/// drops the guard, exactly as `export_open_project` does, and this function
/// takes a PATH so it structurally cannot take the lock. `word_count_at`
/// established the shape; the recorded deadlock it was written after is what
/// makes it a rule rather than a preference.
#[cfg(test)]
pub fn take_point(
    source: &Path,
    slug: &str,
    name: &str,
    dir: &Path,
    now_ms: i64,
) -> Result<Point, String> {
    take_point_inner(source, None, slug, name, dir, now_ms)
}

pub fn take_point_for_book(
    source: &Path,
    book_id: &str,
    slug: &str,
    name: &str,
    dir: &Path,
    now_ms: i64,
) -> Result<Point, String> {
    take_point_inner(source, Some(book_id), slug, name, dir, now_ms)
}

fn take_point_inner(
    source: &Path,
    expected_book_id: Option<&str>,
    slug: &str,
    name: &str,
    dir: &Path,
    now_ms: i64,
) -> Result<Point, String> {
    // `open_readonly`, never `open`: `open` migrates, and a backup that
    // upgraded the schema of the file it was copying would close the
    // writer's project to the build they are running.
    let reader = crate::store::Store::open_readonly(source).map_err(|e| e.to_string())?;
    if let Some(expected) = expected_book_id {
        if reader.book_id().map_err(|e| e.to_string())?.as_deref() != Some(expected) {
            return Err("the book identity changed before recovery could run".to_string());
        }
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let _lock = lock_manifest(dir)?;
    let (id, path) = pick_point_path(dir, &point_id(now_ms));

    let mut entries = read_point_manifest(dir)?
        .map(|m| m.entries)
        .unwrap_or_default();
    refuse_unlisted_bundles(dir, &entries)?;
    preflight_counts(source, dir, &entries, now_ms, &id)?;

    let written = crate::backup_bundle::write(source, &reader, &path)?;
    let verified = written.verified;

    let point = Point {
        id,
        at_ms: now_ms,
        bytes: written.bytes,
        hash: written.hash,
        verified,
        database_verified: written.database_verified,
        verified_at: if verified { Some(now_ms) } else { None },
        bundle: true,
        errors: written.errors,
    };

    entries.push(point.clone());
    entries.sort_by(|a, b| b.at_ms.cmp(&a.at_ms).then_with(|| b.id.cmp(&a.id)));

    // ONE call. The file deletion and the manifest filter must read the same
    // answer: a second call with the same arguments is not wrong today and is
    // exactly the shape that diverges the day someone gives `prune` a clock.
    let drop: std::collections::HashSet<usize> =
        prune(now_ms, &entries, MAX_POINTS).into_iter().collect();
    let entries_before_prune = entries.clone();
    let retained: Vec<Point> = entries
        .iter()
        .enumerate()
        .filter(|(i, _)| !drop.contains(i))
        .map(|(_, p)| p.clone())
        .collect();

    // Read the planned retained set before deleting anything. If its newest
    // snapshot cannot be counted, leave both the old manifest and every
    // snapshot in place, including the one just copied.
    let read = newest_counts(dir, &retained)?;
    let entries = retained;

    let manifest = Manifest::recovery(
        ProjectRef {
            slug: slug.to_string(),
            name: name.to_string(),
            schema_version: read.schema_version,
        },
        now_ms,
        Completeness {
            items_total: read.items_total,
            entries_written: entries.len() as u64,
            documents_with_prose: read.documents_with_prose,
            unreadable_bodies: read.unreadable,
            pictures: read.pictures,
            covers: read.covers,
        },
        entries,
    );
    write_manifest(dir, &manifest)?;
    for i in &drop {
        let old = &entries_before_prune[*i];
        let stale = if old.bundle {
            crate::backup_bundle::path_for(dir, &old.id)
        } else {
            dir.join(format!("{}.db", old.id))
        };
        let removed = if old.bundle {
            std::fs::remove_dir_all(&stale)
        } else {
            std::fs::remove_file(&stale)
        };
        if let Err(e) = removed {
            eprintln!("recovery: could not prune {}: {e}", stale.display());
        }
    }
    Ok(point)
}

/// One archive: the portable point directory and its inventory.
///
/// `file` is the portable folder name for new archives; `manifest` is its
/// inventory name. Both are relative names, never paths.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Archive {
    /// The entry id in the manifest, and the snapshot's stem:
    /// `my-book-2026-08-19T21-14-02Z`.
    pub id: String,
    pub file: String,
    pub manifest: String,
    /// Total payload bytes for a new folder, database bytes for a legacy file.
    pub bytes: u64,
    pub at_ms: i64,
    /// Whether the database and referenced originals verified. An unverified
    /// archive is retained and is not reported as an off-device copy.
    pub verified: bool,
    pub verified_at: Option<i64>,
}

/// Take one archive: copy, verify, describe. No prune, ever.
///
/// `take_point`'s shape minus the retention rule, and the missing prune is the
/// decision rather than an omission: deleting an archive the writer has not
/// carried off the machine yet destroys the only off-device candidate that
/// existed. `exports/` is the shipped precedent for a directory the
/// application writes to and never deletes from, and the writer deletes
/// archives with the same file manager they were told to move them with.
///
/// NOTHING HERE HOLDS THE STORE MUTEX, for `take_point`'s reason and by
/// `take_point`'s means: it takes a PATH, so it structurally cannot take the
/// lock.
///
/// ONE RULE FOR THE DESTINATION, not two. `pick_point_path`'s probe picks a
/// name worth trying and `vacuum_into`'s own refusal is the real guard. A
/// `create_new` claim in front of it would be a second rule refusing the same
/// input, and the repo's record is that two such rules cover for each other and
/// neither can be killed by a mutation.
#[cfg(test)]
pub fn take_archive(
    source: &Path,
    slug: &str,
    name: &str,
    dir: &Path,
    now_ms: i64,
) -> Result<Archive, String> {
    take_archive_inner(source, None, slug, name, dir, now_ms)
}

pub fn take_archive_for_book(
    source: &Path,
    book_id: &str,
    slug: &str,
    name: &str,
    dir: &Path,
    now_ms: i64,
) -> Result<Archive, String> {
    take_archive_inner(source, Some(book_id), slug, name, dir, now_ms)
}

fn take_archive_inner(
    source: &Path,
    expected_book_id: Option<&str>,
    slug: &str,
    name: &str,
    dir: &Path,
    now_ms: i64,
) -> Result<Archive, String> {
    // `open_readonly`, never `open`: `open` migrates, and an archive that
    // upgraded the schema of the project it was copying would close the
    // writer's project to the build they are running.
    let reader = crate::store::Store::open_readonly(source).map_err(|e| e.to_string())?;
    if let Some(expected) = expected_book_id {
        if reader.book_id().map_err(|e| e.to_string())?.as_deref() != Some(expected) {
            return Err("the book identity changed before archive could run".to_string());
        }
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let _lock = lock_manifest(dir)?;
    // The project name comes before the timestamp so the writer can identify
    // its archive folder in a file manager.
    let (id, path) = pick_point_path(dir, &format!("{slug}-{}", point_id(now_ms)));

    let mut entries = read_point_manifest(dir)?
        .map(|m| m.entries)
        .unwrap_or_default();
    refuse_unlisted_bundles(dir, &entries)?;
    preflight_counts(source, dir, &entries, now_ms, &id)?;

    let written = crate::backup_bundle::write(source, &reader, &path)?;
    let verified = written.verified;

    let entry = Point {
        id: id.clone(),
        at_ms: now_ms,
        bytes: written.bytes,
        hash: written.hash,
        verified,
        database_verified: written.database_verified,
        verified_at: if verified { Some(now_ms) } else { None },
        bundle: true,
        errors: written.errors,
    };

    entries.push(entry.clone());
    entries.sort_by(|a, b| b.at_ms.cmp(&a.at_ms).then_with(|| b.id.cmp(&a.id)));

    // The recovery path's rule, and archives need it MORE: they are never
    // pruned, so this manifest accumulates entries for the life of the project
    // and meets more clock corrections than a capped directory does.
    let read = newest_counts(dir, &entries)?;

    let manifest = Manifest::archive(
        ProjectRef {
            slug: slug.to_string(),
            name: name.to_string(),
            schema_version: read.schema_version,
        },
        now_ms,
        Completeness {
            items_total: read.items_total,
            entries_written: entries.len() as u64,
            documents_with_prose: read.documents_with_prose,
            unreadable_bodies: read.unreadable,
            pictures: read.pictures,
            covers: read.covers,
        },
        entries,
    );
    // BEFORE the archive is returned, never after: the caller's return is the
    // "file is handed to the writer" half of the encryption seam.
    write_manifest(dir, &manifest)?;

    let result = Archive {
        file: format!("{id}{}", crate::backup_bundle::SUFFIX),
        manifest: "inventory.json".to_string(),
        id: entry.id,
        bytes: entry.bytes,
        at_ms: entry.at_ms,
        verified: entry.verified,
        verified_at: entry.verified_at,
    };
    if !result.verified {
        return Err(format!(
            "archive retained but incomplete: {}",
            entry.errors.join(", ")
        ));
    }
    Ok(result)
}

/// What the device-loss surfaces read: how old the off-device copy is, how
/// many exist, and where the writer has to go to get one.
///
/// NO ENTRIES, for `Report`'s reason: the bar asks a question with a number
/// for an answer and the panel asks a different one. `verified_archives` is
/// the list.
///
/// `dir` IS A PATH, AND IT IS THE ONE PLACE THAT IS CORRECT. Everywhere else
/// in this feature the page names an artifact by id and the host resolves it.
/// Here the whole promise is "the folder is at this place, move it off this
/// computer yourself" -- a sentence that needs the place. It goes OUT for a
/// writer to read; nothing takes it back in, and no page may hand it to a
/// command.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ArchiveReport {
    pub slug: Option<String>,
    pub dir: String,
    /// The newest entry with `verified == true`, read from the manifest.
    pub newest_verified_ms: Option<i64>,
    /// Every archive on record, verified or not -- an unverified one is still
    /// a file taking up space that the writer may want to deal with.
    pub archives: u64,
}

/// Read-only. A directory that is not there, a manifest that will not parse
/// and a project that has never been archived are all the same empty answer.
pub fn describe_archives(dir: &Path, slug: &str) -> ArchiveReport {
    let entries = read_point_manifest(dir)
        .ok()
        .flatten()
        .map(|m| m.entries)
        .unwrap_or_default();
    ArchiveReport {
        slug: Some(slug.to_string()),
        dir: dir.display().to_string(),
        // `max`, not `first`, for `describe_dir`'s reason: every writer of a
        // manifest sorts, and a reader that depended on that would start lying
        // the day a hand-edited one arrives out of order.
        newest_verified_ms: entries.iter().filter(|p| p.verified).map(|p| p.at_ms).max(),
        archives: entries.len() as u64,
    }
}

/// The verified archives, newest first.
///
/// VERIFIED ONLY, like `verified_points` and for the same reason: this is the
/// list a writer is invited to carry off the machine, and an archive the
/// application could not vouch for is not something to hand them as protection.
pub fn verified_archives(dir: &Path) -> Vec<Archive> {
    let mut entries: Vec<Point> = read_point_manifest(dir)
        .ok()
        .flatten()
        .map(|m| m.entries)
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.verified)
        .collect();
    entries.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    entries
        .into_iter()
        .map(|p| Archive {
            file: if p.bundle {
                format!("{}{}", p.id, crate::backup_bundle::SUFFIX)
            } else {
                format!("{}.db", p.id)
            },
            manifest: if p.bundle {
                "inventory.json"
            } else {
                "manifest.json"
            }
            .to_string(),
            id: p.id,
            bytes: p.bytes,
            at_ms: p.at_ms,
            verified: p.verified,
            verified_at: p.verified_at,
        })
        .collect()
}

/// The last attempt's outcome, beside the manifest.
///
/// SEPARATE FROM THE MANIFEST, deliberately: the manifest is an envelope shared
/// with the readable mirror and defined in a document this slice must not
/// amend. A failed attempt produces no entry and therefore has nowhere to live
/// in that shape.
///
/// `last_attempt_ms` and `last_verified_ms` are DIFFERENT FACTS and a surface
/// that collapses them is the silent-staleness failure this file exists to
/// prevent.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Status {
    pub last_attempt_ms: i64,
    pub last_attempt_ok: bool,
    pub last_error: Option<String>,
    /// When the most recent VERIFIED point was taken. Unmoved by an attempt
    /// that produced an unverified point.
    pub last_verified_ms: Option<i64>,
    /// Consecutive failed attempts. A COUNT, not a threshold: nothing in this
    /// slice reads it, and the surface that escalates on it (design section 7)
    /// chooses the number beside the thing it renders.
    pub consecutive_failures: u32,
}

pub fn next_status(prev: Option<Status>, now_ms: i64, outcome: Result<Point, String>) -> Status {
    let last_verified_ms = prev.as_ref().and_then(|p| p.last_verified_ms);
    match outcome {
        Ok(point) => Status {
            last_attempt_ms: now_ms,
            last_attempt_ok: true,
            last_error: None,
            last_verified_ms: if point.verified {
                point.verified_at.or(Some(now_ms))
            } else {
                last_verified_ms
            },
            consecutive_failures: 0,
        },
        Err(e) => Status {
            last_attempt_ms: now_ms,
            last_attempt_ok: false,
            last_error: Some(e),
            last_verified_ms,
            consecutive_failures: prev.map(|p| p.consecutive_failures).unwrap_or(0) + 1,
        },
    }
}

fn status_path(dir: &Path) -> PathBuf {
    dir.join("status.json")
}

pub fn read_status(dir: &Path) -> Option<Status> {
    serde_json::from_slice(&std::fs::read(status_path(dir)).ok()?).ok()
}

fn write_status(dir: &Path, s: &Status) -> Result<(), String> {
    let dest = status_path(dir);
    let tmp = dir.join(".status.json.tmp");
    let text = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, &text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &dest).map_err(|e| format!("{}: {e}", dest.display()))
}

/// Whose recovery directory a status question is about, in priority order.
///
/// PURE, AND IT ANSWERS WITH NO PROJECT OPEN. The surface that most needs this
/// is the startup-failure screen, which runs precisely because the mount
/// failed, so a rule that could only see an open project would be absent from
/// the one place it is required.
///
/// The order is most-specific-first: what is open now beats what this launch
/// was told to open, which beats what the last launch left recorded. Only the
/// FIRST candidate present is consulted -- a path with no usable file stem is
/// no answer rather than a reason to describe a different book, which is
/// `tick`'s rule for the same input.
pub fn target_slug(open: Option<&Path>, env: Option<&Path>, last: Option<&Path>) -> Option<String> {
    let path = open.or(env).or(last)?;
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
}

/// What a recovery directory currently holds, for a surface to render.
///
/// THREE TIMES, NOT ONE, and that is the point of the type. `status` carries
/// the last attempt and the last verified time the ATTEMPTS knew about;
/// `newest_verified_ms` is what the manifest on disk says. They can disagree --
/// a manual prune moves the directory and not the status file -- and a surface
/// that collapses them tells a writer they are protected by a file that is no
/// longer there.
///
/// `slug` is an Option because the target may not resolve at all: with no
/// project open, no `APP_PROJECT` and no recorded `last_project`, there is
/// nothing to describe, and that is an answer rather than an error.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Report {
    pub slug: Option<String>,
    pub status: Option<Status>,
    /// The newest entry with `verified == true`, READ FROM THE MANIFEST.
    /// The manifest is the artifact on disk; the status file is a memory of
    /// what happened.
    pub newest_verified_ms: Option<i64>,
    pub verified_points: u64,
}

/// Describe `dir` without taking anything, opening anything, or writing
/// anything.
///
/// A missing directory, an absent manifest and an unparseable one are all the
/// same answer -- empty -- for `read_manifest`'s recorded reason: one
/// unreadable describing file must not turn a status surface into an error
/// screen.
pub fn describe_dir(dir: &Path, slug: &str) -> Report {
    let entries = read_point_manifest(dir)
        .ok()
        .flatten()
        .map(|m| m.entries)
        .unwrap_or_default();
    let verified: Vec<&Point> = entries.iter().filter(|p| p.verified).collect();
    Report {
        slug: Some(slug.to_string()),
        status: read_status(dir),
        // `max`, not `first`: the manifest is written newest-first and every
        // writer of it sorts, but a report that depended on that ordering would
        // start lying the day a hand-edited or partially-restored manifest
        // arrives out of order.
        newest_verified_ms: verified.iter().map(|p| p.at_ms).max(),
        verified_points: verified.len() as u64,
    }
}

/// Whose recovery directory a question is about, and where it is.
///
/// `target_slug` picks the subject and `projects::recovery_dir` locates it.
/// Composed here because three commands ask the same question -- what the
/// status is, what points exist, and which directory a restore reads from --
/// and a third restatement of the pair is a third thing to get wrong.
#[cfg(test)]
pub fn target_dir(
    open: Option<&Path>,
    env: Option<&Path>,
    last: Option<&Path>,
    data_home: &Path,
) -> Option<(String, PathBuf)> {
    let slug = target_slug(open, env, last)?;
    let dir = crate::projects::recovery_dir(data_home, &slug);
    Some((slug, dir))
}

/// The verified points in `dir`, newest first -- what a writer may be offered
/// as a copy of their book.
///
/// SEPARATE FROM `Report`, and deliberately. A `Report` carries COUNTS because
/// it is polled by the project bar on every `app://recovery-changed`; putting
/// the entries in it would re-serialize the whole manifest into the page for a
/// surface that renders one sentence. This is the read the restore panel makes,
/// when it is open.
///
/// VERIFIED ONLY. A point that failed its structural read is on disk and is not
/// a manuscript to hand back. The flag records that a read passed when the
/// point was TAKEN; a restore re-reads before it copies, because what a restore
/// needs to know is whether the bytes are sound now.
///
/// A missing directory, an absent manifest and an unparseable one are all the
/// same answer -- empty -- for `read_manifest`'s recorded reason.
#[cfg(test)]
pub fn verified_points(dir: &Path) -> Vec<Point> {
    let mut points: Vec<Point> = read_point_manifest(dir)
        .ok()
        .flatten()
        .map(|m| m.entries)
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.verified)
        .collect();
    // Sorted here rather than trusted from the file: every current writer of a
    // manifest sorts, and a reader that depended on that would start lying the
    // day a hand-edited or partially-restored one arrives out of order. Same
    // argument as `describe_dir`'s `max`.
    points.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    points
}

/// Points with a sound database, including those that need explicit recovery
/// with picture gaps. The status count still uses fully verified points only.
pub fn restorable_points(dir: &Path) -> Vec<Point> {
    let mut points: Vec<Point> = read_point_manifest(dir)
        .ok()
        .flatten()
        .map(|m| m.entries)
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.verified || p.database_verified)
        .collect();
    points.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    points
}

/// The file a verified point with this id lives in, or None.
///
/// THE PAGE NAMES A POINT BY ID, NEVER BY PATH. That is `project_import`'s rule
/// (a bare filename, refused on the name before any filesystem call) and
/// `project_export`'s (no path argument at all): a path chosen by the webview
/// holding the manuscript is the crossing neither of those would make.
///
/// The manifest reader rejects any unsafe id before an entry can be resolved
/// or pruned. Membership then requires this id to name a verified entry.
#[cfg(test)]
pub fn verified_point_path(dir: &Path, id: &str) -> Option<PathBuf> {
    if !point_id_safe(id) {
        return None;
    }
    verified_points(dir)
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| {
            if p.bundle {
                crate::backup_bundle::path_for(dir, &p.id)
            } else {
                dir.join(format!("{}.db", p.id))
            }
        })
}

pub fn restorable_point_path(dir: &Path, id: &str, allow_picture_gaps: bool) -> Option<PathBuf> {
    if !point_id_safe(id) {
        return None;
    }
    let point = restorable_points(dir).into_iter().find(|p| p.id == id)?;
    if !point.verified && !allow_picture_gaps {
        return None;
    }
    Some(if point.bundle {
        crate::backup_bundle::path_for(dir, id)
    } else {
        dir.join(format!("{id}.db"))
    })
}

/// One scheduled attempt.
///
/// THE LOCK DISCIPLINE IS HERE AND IT IS ASSERTED, NOT ASSERTED ABOUT: the path
/// and name come out under the guard, the guard drops with that block, and the
/// copy runs off-mutex. `take` is injected for exactly that reason --
/// `the_tick_runs_off_the_store_mutex` probes `try_lock` at the instant the
/// copy would begin, so widening the guard's scope turns the probe red on the
/// same thread, with no timing and no second thread.
///
/// Returns the status now recorded for the project, or None when there was
/// nothing to back up. A failed backup NEVER blocks the writer and never
/// reaches the save-failure banner: a save failure means the manuscript is not durably
/// written and must interrupt; a backup failure means the second copy is stale
/// and the manuscript is untouched.
#[derive(Clone)]
pub struct Source {
    pub path: PathBuf,
    pub name: String,
    pub book_id: String,
    pub registry_home: Option<PathBuf>,
}

impl Source {
    pub fn capture(state: &crate::StoreState) -> Option<Self> {
        let guard = crate::locked(state);
        guard.as_ref().map(|project| Self {
            path: project.path.clone(),
            name: project.name.clone(),
            book_id: project.book_id.clone(),
            registry_home: project.registry_home.clone(),
        })
    }

    /// Caller holds PASSING. Validate before creating even a status directory.
    pub fn destination(&self, data_home: &Path) -> Result<(String, PathBuf), String> {
        let settings = crate::projects::read_settings_checked(data_home)?;
        if self.registry_home.is_some() {
            crate::book_open::require_canonical(&settings, &self.book_id, &self.path)?;
        }
        let reader =
            crate::store::Store::open_readonly(&self.path).map_err(|error| error.to_string())?;
        if reader
            .book_id()
            .map_err(|error| error.to_string())?
            .as_deref()
            != Some(&self.book_id)
        {
            return Err("the recovery source identity changed; reopen the book".into());
        }
        let slug = target_slug(Some(&self.path), None, None)
            .ok_or("the recovery source has no usable file name")?;
        let key = crate::protection::key_for(
            &settings,
            &self.book_id,
            crate::protection::Surface::Recovery,
        )?;
        Ok((slug, crate::projects::recovery_dir(data_home, &key)))
    }
}

pub fn tick(
    state: &crate::StoreState,
    data_home: &Path,
    now_ms: i64,
    take: impl FnOnce(&Path, &str, &str, &str, &Path, i64) -> Result<Point, String>,
) -> Option<Status> {
    let source = Source::capture(state)?;
    let _passing = match PASSING.lock() {
        Ok(guard) => guard,
        Err(_) => {
            eprintln!("recovery: a previous recovery operation failed unexpectedly; restart before taking another point");
            return None;
        }
    };
    let (slug, dir) = match source.destination(data_home) {
        Ok(target) => target,
        Err(error) => {
            eprintln!("recovery: {error}");
            return None;
        }
    };
    let _ = attempt_in_dir(
        &source.path,
        &source.name,
        &slug,
        &dir,
        now_ms,
        |path, slug, name, dir, now| take(path, &source.book_id, slug, name, dir, now),
    );
    read_status(&dir)
}

/// One attempt at a recovery point, whoever asked for it.
///
/// THE SCHEDULE AND THE WRITER'S OWN BUTTON SHARE THIS, so "when was this last
/// backed up" cannot have two answers depending on who asked. It takes a PATH
/// and never sees `StoreState`, which is what structurally keeps the copy off
/// the store mutex -- the caller reads the path out under the guard and drops
/// it, exactly as `export_open_project` does.
///
/// The status is written on BOTH outcomes. A failure that recorded nothing
/// would leave a stale success on disk describing an attempt that did not
/// happen, which is the silent staleness the surface exists to catch.
#[cfg(test)]
pub fn attempt(
    path: &Path,
    name: &str,
    slug: &str,
    data_home: &Path,
    now_ms: i64,
    take: impl FnOnce(&Path, &str, &str, &Path, i64) -> Result<Point, String>,
) -> Result<Point, String> {
    let dir = crate::projects::recovery_dir(data_home, slug);
    attempt_in_dir(path, name, slug, &dir, now_ms, take)
}

pub fn attempt_in_dir(
    path: &Path,
    name: &str,
    slug: &str,
    dir: &Path,
    now_ms: i64,
    take: impl FnOnce(&Path, &str, &str, &Path, i64) -> Result<Point, String>,
) -> Result<Point, String> {
    // Before `take`, because a directory that cannot be created has nowhere to
    // record the failure either; the error is returned rather than swallowed.
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    let outcome = take(path, slug, name, &dir, now_ms).and_then(|point| {
        if point.verified {
            Ok(point)
        } else {
            Err(format!(
                "recovery point retained but incomplete: {}",
                point.errors.join(", ")
            ))
        }
    });
    if let Err(e) = &outcome {
        eprintln!("recovery: {} was not backed up: {e}", path.display());
    }
    let status = next_status(read_status(&dir), now_ms, outcome.clone());
    if let Err(e) = write_status(&dir, &status) {
        eprintln!("recovery: cannot record the attempt: {e}");
    }
    outcome
}

/// One attempt at an archive, which only ever happens because a writer asked.
///
/// `attempt`'s shape with two deliberate differences, and both are the design's.
///
/// IT WRITES NO STATUS. `Status` and its `consecutive_failures` belong to the
/// SCHEDULE: they are how the project bar learns that the same-device copy has
/// been going stale unnoticed, which is the failure a background timer can have
/// and a button cannot. An archive the writer asked for and did not get is
/// answered synchronously, in front of them, through the notice channel -- and
/// never through the save-failure banner, because a backup failure is not a
/// save failure and the manuscript is completely unaffected.
///
/// IT IS NOT GATED ON `APP_RECOVERY_MODE`. That variable turns off the timer
/// so measurement runs are not measuring a copy; a writer pressing a button is
/// not a timer. `project_backup_now` made the same call for the same reason.
///
/// It takes a PATH and never sees `StoreState`, which is what structurally
/// keeps the copy off the store mutex.
#[cfg(test)]
pub fn attempt_archive(
    path: &Path,
    name: &str,
    slug: &str,
    data_home: &Path,
    now_ms: i64,
    take: impl FnOnce(&Path, &str, &str, &Path, i64) -> Result<Archive, String>,
) -> Result<Archive, String> {
    let dir = crate::projects::archives_dir(data_home, slug);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    let outcome = take(path, slug, name, &dir, now_ms);
    if let Err(e) = &outcome {
        // Recorded, because a failure nobody wrote down is one nobody looks
        // for the second time. The writer is told by the caller.
        eprintln!("archive: {} was not archived: {e}", path.display());
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(at_ms: i64, verified: bool) -> Point {
        Point {
            id: point_id(at_ms),
            at_ms,
            bytes: 1,
            hash: String::new(),
            verified,
            database_verified: false,
            verified_at: if verified { Some(at_ms) } else { None },
            bundle: false,
            errors: Vec::new(),
        }
    }

    fn generated_db(dir: &Path, id: &str) -> PathBuf {
        crate::backup_bundle::point_db(dir, id, true)
    }

    fn generated_bundle(dir: &Path, id: &str) -> PathBuf {
        crate::backup_bundle::path_for(dir, id)
    }

    fn plant_original(source: &Path, name: &str) {
        let dir = crate::pictures::dir_for(source);
        std::fs::create_dir_all(&dir).unwrap();
        let bytes: &[u8] = if name.ends_with(".jpg") {
            include_bytes!("../fixtures/two-halves.jpg")
        } else {
            include_bytes!("../fixtures/two-halves.png")
        };
        std::fs::write(dir.join(name), bytes).unwrap();
    }

    const NOW: i64 = 1_787_174_042_000;
    const HOUR: i64 = 3_600_000;
    const DAY: i64 = 24 * HOUR;

    #[test]
    fn a_second_backup_writer_gets_a_bounded_busy_refusal() {
        let root = tempfile::tempdir().unwrap();
        let first = lock_manifest(root.path()).unwrap();
        assert_eq!(
            lock_manifest(root.path()).unwrap_err(),
            "another backup writer is active"
        );
        drop(first);
        assert!(lock_manifest(root.path()).is_ok());
    }

    #[test]
    fn an_unsafe_manifest_id_cannot_prune_outside_the_backup_directory() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("book.db");
        drop(crate::test_support::seeded_project(&source));
        let out = root.path().join("points");
        let good = take_point(&source, "book", "Book", &out, NOW - 3 * HOUR).unwrap();
        let good_path = generated_bundle(&out, &good.id);
        let victim = root.path().join("victim.point");
        std::fs::create_dir(&victim).unwrap();
        std::fs::write(victim.join("sentinel"), b"untouched").unwrap();

        let mut manifest = read_point_manifest(&out).unwrap().unwrap();
        let mut safe_incomplete = pt(NOW - 2 * HOUR, false);
        safe_incomplete.id = "safe-incomplete".into();
        let mut unsafe_old = pt(NOW - 4 * HOUR, false);
        unsafe_old.id = "../victim".into();
        let new = pt(NOW, true);
        assert!(prune(
            NOW,
            &[
                new,
                safe_incomplete.clone(),
                good.clone(),
                unsafe_old.clone()
            ],
            MAX_POINTS
        )
        .contains(&3));
        manifest.entries.extend([safe_incomplete, unsafe_old]);
        write_manifest(&out, &manifest).unwrap();
        let old_manifest = std::fs::read(out.join(MANIFEST_NAME)).unwrap();

        assert!(take_point(&source, "book", "Book", &out, NOW)
            .unwrap_err()
            .contains("unsafe point id"));
        assert!(take_archive(&source, "book", "Book", &out, NOW)
            .unwrap_err()
            .contains("unsafe point id"));
        assert_eq!(
            std::fs::read(out.join(MANIFEST_NAME)).unwrap(),
            old_manifest
        );
        assert_eq!(
            std::fs::read(victim.join("sentinel")).unwrap(),
            b"untouched"
        );
        assert!(good_path.is_dir());
        assert!(!generated_bundle(&out, &point_id(NOW)).exists());
        assert!(verified_point_path(&out, "../victim").is_none());
    }

    #[test]
    fn a_manifest_write_failure_does_not_prune_an_existing_bundle() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("book.db");
        drop(crate::test_support::seeded_project(&source));
        let out = root.path().join("points");
        let bucket = (NOW - 3 * HOUR).div_euclid(HOUR) * HOUR;
        let first = take_point(&source, "book", "Book", &out, bucket + 1000).unwrap();
        let second = take_point(&source, "book", "Book", &out, bucket + 2000).unwrap();
        let first_path = crate::backup_bundle::path_for(&out, &first.id);
        let manifest_before = std::fs::read(out.join(MANIFEST_NAME)).unwrap();
        let later = NOW;
        let prospective = pt(later, true);
        assert!(prune(later, &[prospective, second, first.clone()], MAX_POINTS).contains(&2));
        std::fs::create_dir(out.join(MANIFEST_TMP_NAME)).unwrap();
        assert!(take_point(&source, "book", "Book", &out, later).is_err());
        assert_eq!(
            std::fs::read(out.join(MANIFEST_NAME)).unwrap(),
            manifest_before
        );
        assert!(first_path.is_dir());
        crate::backup_bundle::verify(&first_path).unwrap();
    }

    #[test]
    fn an_unlisted_published_point_blocks_repeated_full_copies_without_deleting_it() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("book.db");
        drop(crate::test_support::seeded_project(&source));
        let out = root.path().join("points");
        let good = take_point(&source, "book", "Book", &out, NOW - DAY).unwrap();
        let old_manifest = std::fs::read(out.join(MANIFEST_NAME)).unwrap();
        let orphan = out.join("unlisted.point");
        let reader = crate::store::Store::open_readonly(&source).unwrap();
        assert!(
            crate::backup_bundle::write(&source, &reader, &orphan)
                .unwrap()
                .verified
        );

        let error = take_point(&source, "book", "Book", &out, NOW).unwrap_err();
        assert!(error.contains("unlisted backup point"), "{error}");
        assert_eq!(
            std::fs::read(out.join(MANIFEST_NAME)).unwrap(),
            old_manifest
        );
        assert!(generated_bundle(&out, &good.id).is_dir());
        crate::backup_bundle::verify(&orphan).unwrap();
        assert!(!generated_bundle(&out, &point_id(NOW)).exists());
    }

    #[test]
    fn missing_originals_keep_database_history_and_allow_explicit_gap_restore() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("book.db");
        let store = crate::test_support::seeded_project(&source);
        let member = store.cast_create("character", "Ada").unwrap();
        store
            .cast_set_picture(&member.id, Some("face.png"))
            .unwrap();
        drop(store);
        plant_original(&source, "face.png");
        let out = root.path().join("points");
        let floor = take_point(&source, "book", "Book", &out, NOW - 4 * DAY).unwrap();
        assert!(floor.verified);
        std::fs::remove_file(crate::pictures::dir_for(&source).join("face.png")).unwrap();

        let mut incomplete = Vec::new();
        for at in [NOW - 3 * DAY, NOW - 2 * DAY, NOW - DAY] {
            let point = take_point(&source, "book", "Book", &out, at).unwrap();
            assert!(!point.verified);
            assert!(point.database_verified);
            incomplete.push(point);
        }
        let listed = restorable_points(&out);
        assert_eq!(listed.len(), 4);
        assert_eq!(verified_points(&out).len(), 1);
        assert!(generated_bundle(&out, &floor.id).is_dir());
        for point in &incomplete {
            assert!(generated_bundle(&out, &point.id).is_dir());
        }

        let bundle = restorable_point_path(&out, &incomplete[2].id, true).unwrap();
        assert!(restorable_point_path(&out, &incomplete[2].id, false).is_none());
        let library = root.path().join("library");
        assert!(crate::projects::restore_point_into(&bundle, &library, "book", NOW).is_err());
        assert!(!library.exists());
        let (restored, gaps) =
            crate::projects::restore_point_with_picture_gaps(&bundle, &library, "book", NOW)
                .unwrap();
        assert!(gaps.iter().any(|gap| gap.contains("face.png")), "{gaps:?}");
        let restored_db = Path::new(&restored.path);
        let recovered = crate::store::Store::open_readonly(restored_db).unwrap();
        assert_eq!(
            recovered.cast_list().unwrap()[0].picture_path.as_deref(),
            Some("face.png")
        );
        assert!(!crate::pictures::dir_for(restored_db)
            .join("face.png")
            .exists());
        assert!(generated_bundle(&out, &floor.id).is_dir());
    }

    #[test]
    fn recovery_uses_identity_even_when_two_books_share_a_file_name() {
        let home = tempfile::tempdir().unwrap();
        let first = home.path().join("first/book.db");
        let second = home.path().join("second/book.db");
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::create_dir_all(second.parent().unwrap()).unwrap();
        let a = crate::StoreState(std::sync::Mutex::new(Some(crate::test_support::opened(
            &first,
        ))));
        let b = crate::StoreState(std::sync::Mutex::new(Some(crate::test_support::opened(
            &second,
        ))));
        let a_source = Source::capture(&a).unwrap();
        let b_source = Source::capture(&b).unwrap();
        let (_, a_dir) = a_source.destination(home.path()).unwrap();
        let (_, b_dir) = b_source.destination(home.path()).unwrap();
        assert_ne!(a_dir, b_dir);
        assert!(tick(&a, home.path(), NOW, take_point_for_book).is_some());
        assert!(tick(&b, home.path(), NOW, take_point_for_book).is_some());
        assert_eq!(verified_points(&a_dir).len(), 1);
        assert_eq!(verified_points(&b_dir).len(), 1);
    }

    #[test]
    fn recovery_refuses_a_source_after_the_same_book_selects_another_copy() {
        let home = tempfile::tempdir().unwrap();
        let original = home.path().join("original.db");
        let copy = home.path().join("copy.db");
        let mut project = crate::test_support::opened(&original);
        project.registry_home = Some(home.path().to_path_buf());
        let id = project.book_id.clone();
        project.store.checkpoint().unwrap();
        std::fs::copy(&original, &copy).unwrap();
        let state = crate::StoreState(std::sync::Mutex::new(Some(project)));
        let source = Source::capture(&state).unwrap();
        crate::projects::update_settings(home.path(), |settings| {
            crate::projects::record_book_location(settings, &id, &original);
        })
        .unwrap();
        assert!(source.destination(home.path()).is_ok());
        crate::projects::update_settings(home.path(), |settings| {
            crate::projects::record_book_location(settings, &id, &copy);
        })
        .unwrap();
        let called = std::cell::Cell::new(false);
        assert!(tick(&state, home.path(), NOW, |_, _, _, _, _, _| {
            called.set(true);
            Ok(pt(NOW, true))
        })
        .is_none());
        assert!(!called.get());
        assert!(!crate::projects::recovery_dir(home.path(), &format!("by-id/{id}")).exists());
    }

    #[test]
    fn the_tick_runs_off_the_store_mutex() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("my-book.db");
        let state = crate::StoreState(std::sync::Mutex::new(Some(crate::test_support::opened(
            &db,
        ))));
        let free = std::sync::Mutex::new(None);

        tick(&state, dir.path(), NOW, |_, _, _, _, _, _| {
            // `try_lock`, not `lock`: std's Mutex is not re-entrant and `lock`
            // would hang the suite instead of failing it.
            *free.lock().unwrap() = Some(state.0.try_lock().is_ok());
            Ok(pt(NOW, true))
        });

        assert_eq!(
            *free.lock().unwrap(),
            Some(true),
            "the tick held the store mutex across the copy; a doc_flush would have waited on it"
        );
    }

    #[test]
    fn a_manual_attempt_and_a_scheduled_attempt_write_the_same_status() {
        // ONE attempt with two callers. The schedule and the writer's own
        // button must leave the directory in states a surface cannot tell
        // apart, or "when was this last backed up" has two answers depending on
        // who asked for it.
        let take = |_: &Path, _: &str, _: &str, _: &Path, _: i64| Err("disk full".to_string());

        let scheduled_home = tempfile::tempdir().unwrap();
        let db = scheduled_home.path().join("my-book.db");
        let state = crate::StoreState(std::sync::Mutex::new(Some(crate::test_support::opened(
            &db,
        ))));
        let returned = tick(
            &state,
            scheduled_home.path(),
            NOW,
            |path, _, slug, name, dir, now| take(path, slug, name, dir, now),
        );
        let scheduled = read_status(&crate::projects::recovery_dir(
            scheduled_home.path(),
            &format!("by-id/{}", Source::capture(&state).unwrap().book_id),
        ))
        .expect("the scheduled attempt recorded no status");

        let manual_home = tempfile::tempdir().unwrap();
        let e = attempt(&db, "counted", "my-book", manual_home.path(), NOW, take).unwrap_err();
        assert_eq!(e, "disk full");
        let manual = read_status(&crate::projects::recovery_dir(
            manual_home.path(),
            "my-book",
        ))
        .expect("the manual attempt recorded no status");

        assert_eq!(manual, scheduled);
        assert_eq!(
            returned.as_ref(),
            Some(&scheduled),
            "the tick withheld the status it wrote"
        );
        // Asserted by CONTENT as well: two attempts that both recorded nothing
        // would be equal too, and that is the mutation this test exists for.
        assert!(!manual.last_attempt_ok);
        assert_eq!(manual.last_attempt_ms, NOW);
        assert_eq!(manual.consecutive_failures, 1);
        assert_eq!(manual.last_error.as_deref(), Some("disk full"));
    }

    #[test]
    fn a_tick_with_no_project_open_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::StoreState(std::sync::Mutex::new(None));
        let called = std::sync::Mutex::new(false);
        tick(&state, dir.path(), NOW, |_, _, _, _, _, _| {
            *called.lock().unwrap() = true;
            Ok(pt(NOW, true))
        });
        assert!(!*called.lock().unwrap());
        assert!(
            read_status(dir.path()).is_none(),
            "a no-op tick recorded an attempt"
        );
    }

    #[test]
    fn a_tick_records_its_outcome_either_way() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("my-book.db");
        let state = crate::StoreState(std::sync::Mutex::new(Some(crate::test_support::opened(
            &db,
        ))));

        tick(&state, dir.path(), NOW, |_, _, _, _, _, _| {
            Err("no space left on device".into())
        });
        let recovery = crate::projects::recovery_dir(
            dir.path(),
            &format!("by-id/{}", Source::capture(&state).unwrap().book_id),
        );
        let s = read_status(&recovery).unwrap();
        assert!(!s.last_attempt_ok);
        assert_eq!(s.consecutive_failures, 1);
        assert_eq!(s.last_error.as_deref(), Some("no space left on device"));

        tick(&state, dir.path(), NOW + HOUR, |_, _, _, _, _, _| {
            Ok(pt(NOW + HOUR, true))
        });
        let s = read_status(&recovery).unwrap();
        assert!(s.last_attempt_ok);
        assert_eq!(s.consecutive_failures, 0);
    }

    #[test]
    fn the_recovery_manifest_keeps_the_file_stem_as_its_label() {
        // `test_support::opened` names the project "counted" over a file called
        // `my-book.db`. A project opened through APP_PROJECT has no library
        // slug at all, and two files could carry one typed name.
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("my-book.db");
        let state = crate::StoreState(std::sync::Mutex::new(Some(crate::test_support::opened(
            &db,
        ))));
        let seen = std::sync::Mutex::new(String::new());
        tick(&state, dir.path(), NOW, |_, _, slug, _, _, _| {
            *seen.lock().unwrap() = slug.to_string();
            Ok(pt(NOW, true))
        });
        assert_eq!(*seen.lock().unwrap(), "my-book");
    }

    #[test]
    fn a_failure_increments_the_consecutive_count() {
        let s = next_status(None, NOW, Err("disk full".into()));
        assert_eq!(s.consecutive_failures, 1);
        assert_eq!(s.last_error.as_deref(), Some("disk full"));
        assert_eq!(s.last_attempt_ms, NOW);
        assert!(!s.last_attempt_ok);
        assert_eq!(s.last_verified_ms, None);

        let s = next_status(Some(s), NOW + HOUR, Err("disk full".into()));
        assert_eq!(s.consecutive_failures, 2);
    }

    #[test]
    fn a_success_resets_the_count_and_moves_the_verified_time() {
        let failed = next_status(None, NOW, Err("x".into()));
        let s = next_status(Some(failed), NOW + HOUR, Ok(pt(NOW + HOUR, true)));
        assert_eq!(s.consecutive_failures, 0);
        assert_eq!(s.last_error, None);
        assert_eq!(s.last_verified_ms, Some(NOW + HOUR));
    }

    #[test]
    fn an_unverified_success_does_not_move_the_verified_time() {
        // The distinction the retention floor and any status surface both read:
        // a point was WRITTEN, and it did not pass the structural read, so the
        // floor under the writer has not moved.
        let good = next_status(None, NOW, Ok(pt(NOW, true)));
        let s = next_status(Some(good), NOW + HOUR, Ok(pt(NOW + HOUR, false)));
        assert!(s.last_attempt_ok, "the attempt did produce a point");
        assert_eq!(
            s.last_verified_ms,
            Some(NOW),
            "an unverified point moved the floor"
        );
        assert_eq!(s.consecutive_failures, 0);
    }

    #[test]
    fn taking_a_point_writes_a_verified_snapshot_and_a_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        let out = dir.path().join("recovery");

        let point = take_point(&src, "my-book", "My Book", &out, NOW).unwrap();

        assert!(
            point.verified,
            "a healthy project produced an unverified point"
        );
        assert_eq!(point.verified_at, Some(NOW));
        let snapshot = generated_db(&out, &point.id);
        assert!(snapshot.is_file());
        assert!(generated_bundle(&out, &point.id).is_dir());
        // It is an ORDINARY project file: every reader this codebase has reads
        // it, which is what makes verification free.
        assert!(crate::cli::validate(&snapshot).unwrap().ok);

        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(m.entries.len(), 1);
        assert_eq!(m.completeness.entries_written, 1);
        assert_eq!(m.completeness.items_total, 1);
        assert_eq!(m.completeness.documents_with_prose, 1);
        assert_eq!(m.completeness.unreadable_bodies, 0);
        assert_eq!(m.completeness.pictures, 0);
    }

    #[test]
    fn empty_project_counts_are_real_but_unreadable_snapshots_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty.db");
        drop(crate::store::Store::open(&empty).unwrap());
        let read = counts(&empty).unwrap();
        assert_eq!(read.items_total, 0);
        assert_eq!(read.documents_with_prose, 0);
        assert_eq!(read.pictures, 0);
        assert_eq!(read.covers, 0);
        assert_eq!(read.schema_version, crate::store::SCHEMA_VERSION);

        let missing = dir.path().join("missing.db");
        assert!(counts(&missing).unwrap_err().contains("cannot open"));
        assert!(newest_counts(dir.path(), &[])
            .unwrap_err()
            .contains("no recovery entries"));
    }

    #[test]
    fn dependent_count_reads_fail_instead_of_claiming_zero() {
        for (table, field) in [
            ("item", "items"),
            ("doc", "documents"),
            ("cast_member", "pictures"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("damaged.db");
            drop(crate::test_support::seeded_project(&path));
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(&format!("DROP TABLE {table}")).unwrap();
            drop(conn);
            assert!(
                counts(&path).unwrap_err().contains(field),
                "losing {table} did not fail its {field} count"
            );
        }

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("damaged-cover.db");
        drop(crate::test_support::seeded_project(&path));
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, x'FF')",
            [crate::covers::FRONT_KEY],
        )
        .unwrap();
        drop(conn);
        assert!(counts(&path).unwrap_err().contains("covers"));
    }

    #[test]
    fn missing_newest_point_does_not_replace_the_recovery_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        drop(crate::test_support::seeded_project(&src));
        let out = dir.path().join("recovery");
        let older = take_point(&src, "my-book", "My Book", &out, NOW - 2 * HOUR).unwrap();
        let older_file = generated_db(&out, &older.id);
        let older_bytes = std::fs::read(&older_file).unwrap();
        let first = take_point(&src, "my-book", "My Book", &out, NOW).unwrap();
        let mut stale = older.clone();
        stale.at_ms -= 60_000;
        stale.id = point_id(stale.at_ms);
        stale.bundle = false;
        let stale_file = out.join(format!("{}.db", stale.id));
        std::fs::copy(&older_file, &stale_file).unwrap();
        let mut existing = read_manifest::<Point>(&out).unwrap();
        existing.entries.push(stale.clone());
        write_manifest(&out, &existing).unwrap();
        let manifest = out.join(MANIFEST_NAME);
        let before = std::fs::read(&manifest).unwrap();
        std::fs::remove_dir_all(generated_bundle(&out, &first.id)).unwrap();

        let backward_time = NOW - HOUR / 2;
        let mut planned = existing.entries;
        planned.push(pt(backward_time, true));
        planned.sort_by(|a, b| b.at_ms.cmp(&a.at_ms).then_with(|| b.id.cmp(&a.id)));
        let stale_index = planned.iter().position(|p| p.id == stale.id).unwrap();
        assert!(prune(backward_time, &planned, MAX_POINTS).contains(&stale_index));

        let error = take_point(&src, "my-book", "My Book", &out, backward_time).unwrap_err();

        assert!(error.contains("cannot open the newest snapshot"), "{error}");
        assert_eq!(std::fs::read(&manifest).unwrap(), before);
        assert_eq!(std::fs::read(&older_file).unwrap(), older_bytes);
        assert!(stale_file.is_file(), "count failure pruned an older point");
        assert!(!generated_bundle(&out, &point_id(backward_time)).exists());
        let file_count = std::fs::read_dir(&out).unwrap().count();
        assert!(take_point(&src, "my-book", "My Book", &out, backward_time + 1).is_err());
        assert_eq!(std::fs::read_dir(&out).unwrap().count(), file_count);
    }

    #[test]
    fn guarded_recovery_refuses_a_replaced_book_without_touching_its_destination() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        let first = crate::test_support::seeded_project(&src);
        let captured = first.book_id().unwrap().unwrap();
        drop(first);
        std::fs::rename(&src, dir.path().join("original.db")).unwrap();
        crate::test_support::seeded_project(&src);
        let current = crate::store::Store::open_readonly(&src)
            .unwrap()
            .book_id()
            .unwrap()
            .unwrap();
        let missing = dir.path().join("missing-recovery");
        assert!(take_point_for_book(&src, &captured, "my-book", "My Book", &missing, NOW).is_err());
        assert!(!missing.exists());

        let out = dir.path().join("recovery");
        std::fs::create_dir_all(&out).unwrap();
        let file = out.join("kept.db");
        let manifest = out.join("manifest.json");
        std::fs::write(&file, b"kept point").unwrap();
        std::fs::write(&manifest, b"kept manifest").unwrap();
        let before = (
            std::fs::read(&file).unwrap(),
            std::fs::read(&manifest).unwrap(),
        );
        assert!(take_point_for_book(&src, &captured, "my-book", "My Book", &out, NOW).is_err());
        assert_eq!(before.0, std::fs::read(&file).unwrap());
        assert_eq!(before.1, std::fs::read(&manifest).unwrap());

        let point = take_point_for_book(&src, &current, "my-book", "My Book", &out, NOW).unwrap();
        assert!(point.verified);
        assert_eq!(
            crate::store::Store::open_readonly(&generated_db(&out, &point.id))
                .unwrap()
                .book_id()
                .unwrap()
                .as_deref(),
            Some(current.as_str())
        );
    }

    #[test]
    fn guarded_archive_refuses_a_replaced_book_without_touching_its_destination() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        let first = crate::test_support::seeded_project(&src);
        let captured = first.book_id().unwrap().unwrap();
        drop(first);
        std::fs::rename(&src, dir.path().join("original.db")).unwrap();
        crate::test_support::seeded_project(&src);
        let current = crate::store::Store::open_readonly(&src)
            .unwrap()
            .book_id()
            .unwrap()
            .unwrap();
        let missing = dir.path().join("missing-archives");
        assert!(
            take_archive_for_book(&src, &captured, "my-book", "My Book", &missing, NOW).is_err()
        );
        assert!(!missing.exists());

        let out = dir.path().join("archives");
        std::fs::create_dir_all(&out).unwrap();
        let file = out.join("kept.db");
        let manifest = out.join("manifest.json");
        std::fs::write(&file, b"kept archive").unwrap();
        std::fs::write(&manifest, b"kept manifest").unwrap();
        let before = (
            std::fs::read(&file).unwrap(),
            std::fs::read(&manifest).unwrap(),
        );
        assert!(take_archive_for_book(&src, &captured, "my-book", "My Book", &out, NOW).is_err());
        assert_eq!(before.0, std::fs::read(&file).unwrap());
        assert_eq!(before.1, std::fs::read(&manifest).unwrap());

        let archive =
            take_archive_for_book(&src, &current, "my-book", "My Book", &out, NOW).unwrap();
        assert!(archive.verified);
        assert_eq!(
            crate::store::Store::open_readonly(&crate::backup_bundle::db_path(
                &out.join(&archive.file)
            ))
            .unwrap()
            .book_id()
            .unwrap()
            .as_deref(),
            Some(current.as_str())
        );
    }

    /// MAJOR review finding 8, `validate`'s own defect (cli.rs) at a second
    /// call site: a healthy timeline's opaque body is not a document
    /// `document_markdown` can read, and counting it into `unreadable_bodies`
    /// or `documents_with_prose` would report a healthy recovery point as
    /// damaged, or credit it with words nobody wrote.
    #[test]
    fn a_healthy_timeline_does_not_count_as_prose_or_as_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        let store = crate::test_support::seeded_project(&src);
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
        let out = dir.path().join("recovery");

        take_point(&src, "my-book", "My Book", &out, NOW).unwrap();
        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        // items_total is a FILE fact and rightly counts the bible root and
        // the timeline as items; documents_with_prose and unreadable_bodies
        // are not, and must not see the timeline at all.
        assert_eq!(
            m.completeness.items_total, 3,
            "the scene, the bible root, the timeline"
        );
        assert_eq!(
            m.completeness.documents_with_prose, 1,
            "only the seeded scene carries prose"
        );
        assert_eq!(
            m.completeness.unreadable_bodies, 0,
            "the timeline is not damage"
        );
    }

    #[test]
    fn an_empty_recovery_point_has_a_complete_asset_inventory() {
        // THE HEADLINE OF SLICE 038. `exclusions` was empty and THE EMPTINESS
        // WAS THE CLAIM: this snapshot is the whole project file and nothing is
        // left out. `VACUUM INTO` copies the database and the pictures are
        // FILES beside it, so that claim stopped being true the day a picture
        // could exist -- and this repo has already shipped one sentence
        // promising a backup it had never made.
        //
        // UNCONDITIONAL, and a book with NO pictures is the case that says so.
        // The exclusion is structural: a recovery point never contains one,
        // whether or not this book has any. A line that appeared only when it
        // cost something would make its absence readable as "nothing is left
        // out", which is the lie being withdrawn.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        let out = dir.path().join("recovery");

        let point = take_point(&src, "my-book", "My Book", &out, NOW).unwrap();

        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert!(m.exclusions.is_empty());
        assert_eq!(m.completeness.pictures, 0);
        crate::backup_bundle::verify(&generated_bundle(&out, &point.id)).unwrap();
    }

    #[test]
    fn the_picture_count_is_how_many_the_newest_snapshot_names_and_bundles() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        {
            let store = crate::store::Store::open(&src).unwrap();
            let a = store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            store.cast_set_picture(&a.id, Some("face.jpg")).unwrap();
            // A SECOND MEMBER WITH NO PICTURE, so the figure cannot be the
            // member count wearing a different name.
            store
                .cast_create(crate::store::cast::KIND_PLACE, "The Quay")
                .unwrap();
        }
        plant_original(&src, "face.jpg");
        let out = dir.path().join("recovery");

        let point = take_point(&src, "my-book", "My Book", &out, NOW).unwrap();

        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(m.completeness.pictures, 1);
        assert!(m.exclusions.is_empty());
        assert!(point.verified, "{:?}", point.errors);
        assert_eq!(
            std::fs::read(generated_bundle(&out, &point.id).join("project.pictures/face.jpg"))
                .unwrap(),
            include_bytes!("../fixtures/two-halves.jpg")
        );
    }

    #[test]
    fn an_archive_manifest_counts_and_carries_the_original_picture() {
        // THE ARCHIVE IS THE WORSE CASE, not the same one: it is the copy a
        // writer carries off this computer, so a picture missing from it is
        // missing from the only copy that survives losing the machine. It is
        // also never pruned, so the claim sits in that directory forever.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        {
            let store = crate::store::Store::open(&src).unwrap();
            let a = store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            store.cast_set_picture(&a.id, Some("face.jpg")).unwrap();
        }
        plant_original(&src, "face.jpg");
        let out = dir.path().join("archives");

        let archive = take_archive(&src, "my-book", "My Book", &out, NOW).unwrap();

        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert!(m.exclusions.is_empty());
        assert_eq!(m.completeness.pictures, 1);
        crate::backup_bundle::verify(&out.join(&archive.file)).unwrap();
    }

    #[test]
    fn a_snapshot_of_a_file_older_than_the_picture_column_reports_no_pictures() {
        // A v7 file has no `picture_path` column, and that is AGE, not damage --
        // `missing_blobs`' rule, including the `unwrap_or(0)`. The exclusion
        // sentence still stands, because it is about what a recovery point IS
        // rather than about what this book happens to hold.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("v7.db");
        crate::test_support::seeded_project(&src);
        {
            let conn = rusqlite::Connection::open(&src).unwrap();
            conn.execute_batch(
                "ALTER TABLE cast_member DROP COLUMN picture_path; PRAGMA user_version = 7;",
            )
            .unwrap();
        }
        let out = dir.path().join("recovery");

        take_point(&src, "v7", "V7", &out, NOW).unwrap();

        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(m.project.schema_version, 7);
        assert_eq!(m.completeness.pictures, 0);
        assert!(m.exclusions.is_empty());
    }

    #[test]
    fn the_cover_count_is_its_own_figure_and_not_the_picture_one_widened() {
        // TWO FIGURES BECAUSE THEY ARE TWO THINGS. A cast photograph is a
        // column on a row that can be deleted; a cover is a `meta` row that
        // outlives everything in the book. The fixture is a book with covers
        // and NO cast photograph, which is the only shape that can tell a
        // second figure from a widened first one.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        {
            let store = crate::store::Store::open(&src).unwrap();
            store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            crate::covers::set_cover(&store, crate::covers::SIDE_FRONT, "front.jpg").unwrap();
            crate::covers::set_cover(&store, crate::covers::SIDE_BACK, "back.png").unwrap();
        }
        plant_original(&src, "front.jpg");
        plant_original(&src, "back.png");
        let out = dir.path().join("recovery");

        take_point(&src, "my-book", "My Book", &out, NOW).unwrap();

        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(m.completeness.covers, 2);
        assert_eq!(m.completeness.pictures, 0);
        assert!(m.exclusions.is_empty());
    }

    #[test]
    fn an_archive_carries_the_cover_count_too() {
        // The archive is the worse case for the same reason it is for a
        // photograph: it is the copy that leaves the machine and it is never
        // pruned, so a cover missing from it is missing from the only copy that
        // survives losing the computer.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        {
            let store = crate::store::Store::open(&src).unwrap();
            crate::covers::set_cover(&store, crate::covers::SIDE_FRONT, "front.jpg").unwrap();
        }
        plant_original(&src, "front.jpg");
        let out = dir.path().join("archives");

        take_archive(&src, "my-book", "My Book", &out, NOW).unwrap();

        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(m.completeness.covers, 1);
        assert!(m.exclusions.is_empty());
    }

    #[test]
    fn the_exclusion_sentence_names_the_covers_and_not_only_the_cast() {
        // 038 WITHDREW A FALSE CLAIM AND LEFT A NARROW SENTENCE. It said a CAST
        // MEMBER's photograph is beside the project, which was the whole truth
        // when it was written and stopped being so the day a book could hold a
        // cover -- and a reader of a manifest counting on that sentence would
        // conclude their covers WERE in the snapshot. The emptiness was the
        // claim once; the wording is the claim now.
        assert!(EXCLUSION_PICTURES.contains("cover"), "{EXCLUSION_PICTURES}");
        // And it still names the cast photograph and where to look, which is
        // what it was for.
        assert!(
            EXCLUSION_PICTURES.contains("photograph"),
            "{EXCLUSION_PICTURES}"
        );
        assert!(
            EXCLUSION_PICTURES.contains(".pictures/"),
            "{EXCLUSION_PICTURES}"
        );
    }

    #[test]
    fn a_mirror_manifest_names_all_four_things_it_leaves_out_in_order() {
        // SLICE 081. Pictures first (shared with recovery and archive), then
        // notes, history and synopsis, which belong to the mirror alone.
        let m: Manifest = Manifest::mirror(
            ProjectRef {
                slug: "my-book".into(),
                name: "My Book".into(),
                schema_version: 5,
            },
            NOW,
            Completeness {
                items_total: 1,
                entries_written: 1,
                documents_with_prose: 1,
                unreadable_bodies: 0,
                pictures: 0,
                covers: 0,
            },
            Vec::new(),
        );
        assert_eq!(m.kind, "mirror");
        assert_eq!(
            m.exclusions,
            vec![
                EXCLUSION_PICTURES.to_string(),
                EXCLUSION_NOTES.to_string(),
                EXCLUSION_HISTORY.to_string(),
                EXCLUSION_SYNOPSIS.to_string(),
            ]
        );
    }

    #[test]
    fn the_new_exclusion_sentences_name_their_own_noun_and_where_things_live() {
        assert!(EXCLUSION_NOTES.contains("note"), "{EXCLUSION_NOTES}");
        assert!(
            EXCLUSION_NOTES.contains("project file"),
            "{EXCLUSION_NOTES}"
        );
        assert!(EXCLUSION_NOTES.contains("orphan"), "{EXCLUSION_NOTES}");

        assert!(EXCLUSION_HISTORY.contains("history"), "{EXCLUSION_HISTORY}");
        assert!(
            EXCLUSION_HISTORY.contains("project file"),
            "{EXCLUSION_HISTORY}"
        );

        assert!(
            EXCLUSION_SYNOPSIS.contains("synopsis"),
            "{EXCLUSION_SYNOPSIS}"
        );
    }

    #[test]
    fn the_new_exclusion_sentences_are_plain_ascii_and_end_with_a_period() {
        // The manifest is read by a person in a file manager, not only by
        // code -- the same reason `EXCLUSION_PICTURES` was held to this bar.
        for sentence in [EXCLUSION_NOTES, EXCLUSION_HISTORY, EXCLUSION_SYNOPSIS] {
            assert!(sentence.is_ascii(), "{sentence}");
            assert!(sentence.ends_with('.'), "{sentence}");
        }
    }

    #[test]
    fn a_recovery_manifest_still_names_only_the_pictures() {
        // THE NEGATIVE HALF. A shared vec between the two constructors would
        // be a lie about a recovery point: it is a whole-file copy and carries
        // notes and history, so `EXCLUSION_NOTES` and `EXCLUSION_HISTORY` in
        // its manifest would tell a writer their notes did not survive when
        // they did.
        let m: Manifest = Manifest::recovery(
            ProjectRef {
                slug: "my-book".into(),
                name: "My Book".into(),
                schema_version: 5,
            },
            NOW,
            Completeness {
                items_total: 1,
                entries_written: 1,
                documents_with_prose: 1,
                unreadable_bodies: 0,
                pictures: 0,
                covers: 0,
            },
            vec![pt(NOW, true)],
        );
        assert_eq!(m.exclusions, vec![EXCLUSION_PICTURES.to_string()]);
    }

    #[test]
    fn an_archive_manifest_still_names_only_the_pictures() {
        let m: Manifest = Manifest::archive(
            ProjectRef {
                slug: "my-book".into(),
                name: "My Book".into(),
                schema_version: 5,
            },
            NOW,
            Completeness {
                items_total: 1,
                entries_written: 1,
                documents_with_prose: 1,
                unreadable_bodies: 0,
                pictures: 0,
                covers: 0,
            },
            vec![pt(NOW, true)],
        );
        assert_eq!(m.exclusions, vec![EXCLUSION_PICTURES.to_string()]);
    }

    #[test]
    fn a_manifest_written_before_covers_existed_still_parses_and_reads_none() {
        // `#[serde(default)]`, and `Completeness.pictures`' recorded reason:
        // `read_manifest` treats a manifest that will not parse as ABSENT, so a
        // required field here would make every recovery directory this build has
        // ever written look like a project that had never been backed up.
        let json = serde_json::json!({
            "items_total": 3,
            "entries_written": 1,
            "documents_with_prose": 2,
            "unreadable_bodies": 0,
            "pictures": 1
        });
        let read: Completeness = serde_json::from_value(json).unwrap();
        assert_eq!(read.pictures, 1);
        assert_eq!(read.covers, 0);
    }

    /// Add a scene WITH prose, so `items_total` and `documents_with_prose` both
    /// move. A helper that only created the item would leave the second figure
    /// equal in both snapshots, and half of every assertion below would be
    /// satisfied by the fixture rather than by the code.
    fn grow(path: &Path, title: &str, text: &str) {
        let store = crate::store::Store::open(path).unwrap();
        let created = store.item_create(None, "scene", title).unwrap();
        store
            .flush(&[crate::store::FlushEntry {
                item_id: created.id,
                body: crate::test_support::body(text),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
    }

    #[test]
    fn the_totals_describe_the_newest_point_and_not_the_first_one_taken() {
        // EVERY OTHER `completeness` assertion in this file uses a one-entry
        // fixture, where "the newest entry", "the directory" and "the only
        // entry" are the same answer. The subject of these three fields was
        // settled on 2026-08-22 (see the write-back) as THE NEWEST ENTRY, and
        // until this test existed nothing in the suite could tell the readings
        // apart.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        drop(crate::test_support::seeded_project(&src));
        let out = dir.path().join("recovery").join("my-book");

        take_point(&src, "my-book", "My Book", &out, NOW - HOUR).unwrap();
        grow(&src, "Second scene", "two more words");
        take_point(&src, "my-book", "My Book", &out, NOW).unwrap();

        let m = read_manifest::<Point>(&out).unwrap();
        // The DIRECTORY's figure, and the only one of the four that is about
        // the directory at all.
        assert_eq!(m.completeness.entries_written, 2);
        // The NEWEST entry's figures. The older point still has one scene, so
        // an implementation that described the directory, the oldest entry, or
        // an aggregate cannot produce these.
        assert_eq!(m.completeness.items_total, 2);
        assert_eq!(m.completeness.documents_with_prose, 2);
        assert_eq!(m.completeness.unreadable_bodies, 0);
        // The fixture proved something: the two snapshots genuinely differ.
        assert_eq!(m.entries.len(), 2);
    }

    #[test]
    fn a_point_whose_clock_went_backwards_leaves_the_newest_entry_described() {
        // THE INVARIANT HELD BY COINCIDENCE, not by construction. `counts` ran
        // on the file just written, and that file is the newest entry only
        // while the host clock moves forward. An NTP step backwards -- or a
        // writer correcting the clock -- gives the fresh point an `at_ms` below
        // an existing one, it sorts second, and the manifest then carries
        // totals for an entry it does not claim to describe. Every field stays
        // well-formed, which is why nothing else here catches it.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        drop(crate::test_support::seeded_project(&src));
        let out = dir.path().join("recovery").join("my-book");

        // The NEWEST point, and the one whose figures must survive: one scene.
        take_point(&src, "my-book", "My Book", &out, NOW).unwrap();
        // The project grows, and THEN the clock goes backwards.
        grow(&src, "Second scene", "two more words");
        take_point(&src, "my-book", "My Book", &out, NOW - HOUR).unwrap();

        let m = read_manifest::<Point>(&out).unwrap();
        assert_eq!(m.completeness.entries_written, 2);
        assert_eq!(
            m.completeness.items_total, 1,
            "the manifest describes the point it just wrote, not its newest one"
        );
        assert_eq!(m.completeness.documents_with_prose, 1);
    }

    #[test]
    fn an_archive_whose_clock_went_backwards_leaves_the_newest_entry_described() {
        // The archive twin. It is not redundant: archives are NEVER pruned, so
        // an archive manifest accumulates entries for as long as the project
        // exists and has more opportunities to meet a clock correction than a
        // recovery directory capped at `MAX_POINTS` does.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        drop(crate::test_support::seeded_project(&src));
        let out = dir.path().join("recovery").join("my-book").join("archives");

        take_archive(&src, "my-book", "My Book", &out, NOW).unwrap();
        grow(&src, "Second scene", "two more words");
        take_archive(&src, "my-book", "My Book", &out, NOW - HOUR).unwrap();

        let m = read_manifest::<Point>(&out).unwrap();
        assert_eq!(m.kind, "archive");
        assert_eq!(m.completeness.entries_written, 2);
        assert_eq!(m.completeness.items_total, 1);
        assert_eq!(m.completeness.documents_with_prose, 1);
    }

    #[test]
    fn corrupt_newest_archive_does_not_replace_its_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        drop(crate::test_support::seeded_project(&src));
        let out = dir.path().join("archives");
        let first = take_archive(&src, "my-book", "My Book", &out, NOW).unwrap();
        let manifest = out.join(MANIFEST_NAME);
        let before = std::fs::read(&manifest).unwrap();
        let damaged = crate::backup_bundle::db_path(&out.join(&first.file));
        std::fs::write(&damaged, b"not a SQLite database").unwrap();

        let error = take_archive(&src, "my-book", "My Book", &out, NOW - HOUR).unwrap_err();

        assert!(error.contains("cannot open the newest snapshot"), "{error}");
        assert_eq!(std::fs::read(&manifest).unwrap(), before);
        assert_eq!(std::fs::read(&damaged).unwrap(), b"not a SQLite database");
        assert!(!generated_bundle(&out, &format!("my-book-{}", point_id(NOW - HOUR))).exists());
        let file_count = std::fs::read_dir(&out).unwrap().count();
        assert!(take_archive(&src, "my-book", "My Book", &out, NOW - HOUR + 1).is_err());
        assert_eq!(std::fs::read_dir(&out).unwrap().count(), file_count);
    }

    #[test]
    fn repeated_source_count_failure_does_not_accumulate_unlisted_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        drop(crate::test_support::seeded_project(&src));
        let conn = rusqlite::Connection::open(&src).unwrap();
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, x'FF')",
            [crate::covers::FRONT_KEY],
        )
        .unwrap();
        drop(conn);
        for time in [NOW, NOW + 1] {
            let out = dir.path().join("recovery");
            assert!(take_point(&src, "my-book", "My Book", &out, time)
                .unwrap_err()
                .contains("covers"));
            assert_eq!(
                std::fs::read_dir(&out).unwrap().count(),
                1,
                "only the persistent writer lock may remain"
            );
            let out = dir.path().join("archives");
            assert!(take_archive(&src, "my-book", "My Book", &out, time)
                .unwrap_err()
                .contains("covers"));
            assert_eq!(
                std::fs::read_dir(&out).unwrap().count(),
                1,
                "only the persistent writer lock may remain"
            );
        }
    }

    #[test]
    fn the_newest_entry_is_found_by_comparison_and_not_by_position() {
        // WITHOUT THIS TEST the `max_by` in `newest_counts` is unfalsifiable:
        // every writer in this module sorts immediately before calling it, so
        // `entries[0]` returns the same answer on every path the application
        // takes, and the choice reads as preference rather than as a rule.
        //
        // It is a rule. `describe_dir:733` and `describe_archives:577` both
        // take `max` over `first` and both record the reason -- a manifest is a
        // file the application does not own between runs, and one that arrives
        // hand-edited or partially restored is out of order. This asserts the
        // writer survives the same input the readers were built for.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        drop(crate::test_support::seeded_project(&src));
        let out = dir.path().join("recovery").join("my-book");

        take_point(&src, "my-book", "My Book", &out, NOW - HOUR).unwrap();
        grow(&src, "Second scene", "two more words");
        take_point(&src, "my-book", "My Book", &out, NOW).unwrap();

        // OLDEST FIRST: the order no writer here produces and any reader may
        // meet.
        let mut entries = read_manifest::<Point>(&out).unwrap().entries;
        entries.sort_by_key(|p| p.at_ms);
        assert_eq!(entries.len(), 2);
        assert!(
            entries[0].at_ms < entries[1].at_ms,
            "the fixture is not out of order"
        );

        let read = newest_counts(&out, &entries).unwrap();
        let (items_total, documents_with_prose) = (read.items_total, read.documents_with_prose);
        assert_eq!(items_total, 2, "the newest entry was chosen by position");
        assert_eq!(documents_with_prose, 2);
    }

    #[test]
    fn the_checksum_is_what_a_reader_recomputes_by_blanking_the_field() {
        // THE CONTRACT, not the determinism. `the_checksum_covers_the_manifest`
        // asserts the constructor gives the same answer twice, which every
        // nonce-free hash over any input satisfies -- one over the entries
        // alone, or over the project name alone, passes it and breaks the
        // promise the spec makes. The promise is that an independent reader can
        // recompute the figure: clear the field, re-serialize, hash.
        let m = Manifest::recovery(
            ProjectRef {
                slug: "b".into(),
                name: "B".into(),
                schema_version: 5,
            },
            NOW,
            Completeness {
                items_total: 3,
                entries_written: 1,
                documents_with_prose: 2,
                unreadable_bodies: 0,
                pictures: 0,
                covers: 0,
            },
            vec![pt(NOW, true)],
        );

        // Through JSON, the way a reader that did not build this value gets it.
        let mut round: Manifest =
            serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        let claimed = std::mem::take(&mut round.checksum);
        let recomputed = format!("{:016x}", hash64(&serde_json::to_vec(&round).unwrap()));

        assert_eq!(claimed, recomputed);
        // Vacuity guard: two empty strings satisfy the equality above.
        assert_eq!(claimed.len(), 16);
    }

    #[test]
    fn taking_an_archive_writes_a_verified_snapshot_and_its_own_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        let out = dir.path().join("recovery").join("my-book").join("archives");

        let archive = take_archive(&src, "my-book", "My Book", &out, NOW).unwrap();

        assert!(
            archive.verified,
            "a healthy project produced an unverified archive"
        );
        assert_eq!(archive.verified_at, Some(NOW));
        assert_eq!(archive.at_ms, NOW);

        // THE NAME IS THE PROJECT'S FIRST. A writer looking for this in a file
        // manager sorted by name is looking for their book, not for a date, and
        // the date alone is what every OTHER file in the recovery area is
        // called.
        assert_eq!(archive.file, format!("my-book-{}.point", point_id(NOW)));
        let snapshot = out.join(&archive.file);
        assert!(snapshot.is_dir());
        // An ORDINARY project file, so `app-shell-tauri validate` and
        // `restore` on some OTHER machine read it with no new reader.
        assert!(
            crate::cli::validate(&crate::backup_bundle::db_path(&snapshot))
                .unwrap()
                .ok
        );
        crate::backup_bundle::verify(&snapshot).unwrap();

        // THE PAIR IS COMPLETE WHEN THIS FUNCTION RETURNS. The encrypted
        // archive attaches between "manifest is written" and "file is handed to
        // the writer"; a manifest written any later than this closes that seam.
        assert_eq!(archive.manifest, "inventory.json");
        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join(MANIFEST_NAME)).unwrap()).unwrap();
        assert!(snapshot.join(&archive.manifest).is_file());
        assert_eq!(m.kind, "archive");
        assert_eq!(m.entries.len(), 1);
        assert_eq!(m.entries[0].id, archive.id);
        assert_eq!(m.completeness.entries_written, 1);
        assert_eq!(m.completeness.items_total, 1);
        assert_eq!(m.completeness.documents_with_prose, 1);
        assert_eq!(m.project.name, "My Book");
    }

    #[test]
    fn a_damaged_archive_is_recorded_as_unverified_and_kept() {
        // KEPT, for the recovery point's reason and one more: this is the file
        // a writer is being asked to carry off the machine, and an application
        // that silently deleted the only candidate because it could not vouch
        // for it would leave them with nothing and no way to know.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        drop(crate::test_support::seeded_project(&src));
        // `cli.rs`'s own `damage` helper, copied rather than reached for
        // because it lives in that file's `mod tests` and is not importable.
        // DO NOT add an escape hatch to `Store` for this.
        {
            let conn = rusqlite::Connection::open(&src).unwrap();
            conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
            conn.execute_batch(
                "INSERT INTO doc VALUES ('nobody', '{\"type\":\"doc\",\"content\":[]}', 1, 0);",
            )
            .unwrap();
        }
        let out = dir.path().join("archives");

        let error = take_archive(&src, "my-book", "My Book", &out, NOW).unwrap_err();
        assert!(error.contains("incomplete"), "{error}");
        let manifest = read_manifest::<Point>(&out).unwrap();
        let entry = &manifest.entries[0];
        assert!(!entry.verified);
        assert_eq!(entry.verified_at, None);
        assert!(
            generated_bundle(&out, &entry.id).is_dir(),
            "an unverified archive was deleted rather than kept"
        );
    }

    #[test]
    fn two_archives_in_the_same_second_do_not_collide() {
        // A writer pressing the button twice can produce this, and `VACUUM
        // INTO` refuses an existing destination rather than overwriting, so an
        // unhandled collision is a hard failure in front of the writer.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        let out = dir.path().join("archives");

        let a = take_archive(&src, "my-book", "My Book", &out, NOW).unwrap();
        let b = take_archive(&src, "my-book", "My Book", &out, NOW).unwrap();

        assert_ne!(a.id, b.id);
        assert_ne!(a.file, b.file);
        assert!(out.join(&a.file).is_dir());
        assert!(out.join(&b.file).is_dir());
        // BOTH SURVIVE. There is no prune here and the second archive must not
        // become the reason the first one stopped existing.
        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(m.entries.len(), 2);
    }

    #[test]
    fn an_archive_leaves_the_recovery_manifest_byte_identical() {
        // THE GUARD THAT MAKES THE SEPARATE DIRECTORY LOAD-BEARING. An archive
        // described in the recovery manifest would be handed out by
        // `verified_points` as a restorable recovery point and counted by
        // `describe_dir` into the bar's same-device coverage -- an off-device
        // file claiming to be an on-device one, which is the blur the design's
        // section 6 exists to prevent.
        let home = tempfile::tempdir().unwrap();
        let src = home.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        let recovery = crate::projects::recovery_dir(home.path(), "my-book");
        let archives = crate::projects::archives_dir(home.path(), "my-book");

        take_point(&src, "my-book", "My Book", &recovery, NOW).unwrap();
        let before = std::fs::read(recovery.join("manifest.json")).unwrap();
        let points_before = verified_points(&recovery);
        let report_before = describe_dir(&recovery, "my-book");

        take_archive(&src, "my-book", "My Book", &archives, NOW + HOUR).unwrap();

        assert_eq!(
            std::fs::read(recovery.join("manifest.json")).unwrap(),
            before,
            "taking an archive rewrote the recovery manifest"
        );
        // Asserted through the READERS as well, not only on the bytes: the two
        // functions that would hand an archive to a writer as a recovery point
        // are the ones whose answers must not have moved.
        assert_eq!(verified_points(&recovery), points_before);
        assert_eq!(describe_dir(&recovery, "my-book"), report_before);
        assert_eq!(points_before.len(), 1, "the fixture proved nothing");
    }

    #[test]
    fn an_archive_manifest_claims_nothing_it_cannot_count() {
        // `exclusions` NAMES THE PICTURES, and until this field existed its emptiness
        // was the claim that a `VACUUM INTO` snapshot is the whole project
        // file. `conflicts` and `unmatched` exist in the envelope for the
        // readable mirror's sake -- a resting `.db` has no file the application
        // did not write.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        let out = dir.path().join("archives");

        take_archive(&src, "my-book", "My Book", &out, NOW).unwrap();

        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert!(m.exclusions.is_empty());
        assert!(m.conflicts.is_empty());
        assert!(m.unmatched.is_empty());
        assert_eq!(m.manifest_version, 1);
        assert_eq!(m.generator.format_version, 1);
        assert_eq!(m.project.schema_version, crate::store::SCHEMA_VERSION);
    }

    #[test]
    fn an_archive_report_answers_for_a_directory_that_is_not_there() {
        // NEVER AN ERROR. A panel offering a writer their way out of a damaged
        // project must not itself be able to fail to render, which is
        // `recovery_points`' recorded argument and applies here unchanged.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nothing").join("archives");

        let report = describe_archives(&missing, "my-book");

        assert_eq!(report.newest_verified_ms, None);
        assert_eq!(report.archives, 0);
        assert!(verified_archives(&missing).is_empty());
        // The DIRECTORY is still named, because the sentence the writer is owed
        // is "the file is here, move it off this computer yourself" and that
        // sentence needs a "here" even before the first archive exists.
        assert_eq!(report.dir, missing.display().to_string());
    }

    #[test]
    fn an_unverified_archive_is_never_reported_as_an_off_device_copy() {
        // The bar says how old the off-device copy is, and an archive the
        // application could not vouch for must not be what it counts. Same rule
        // as the recovery floor, and the same reason: a writer BELIEVING they
        // are protected when they are not is the failure this feature exists
        // to prevent.
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("archives");
        std::fs::create_dir_all(&out).unwrap();
        let mut good = pt(NOW - HOUR, true);
        good.id = format!("my-book-{}", point_id(NOW - HOUR));
        let mut bad = pt(NOW, false);
        bad.id = format!("my-book-{}", point_id(NOW));
        write_manifest(
            &out,
            &Manifest::archive(
                ProjectRef {
                    slug: "my-book".to_string(),
                    name: "My Book".to_string(),
                    schema_version: 4,
                },
                NOW,
                Completeness {
                    items_total: 1,
                    entries_written: 2,
                    documents_with_prose: 1,
                    unreadable_bodies: 0,
                    pictures: 0,
                    covers: 0,
                },
                vec![bad.clone(), good.clone()],
            ),
        )
        .unwrap();

        let report = describe_archives(&out, "my-book");

        // The NEWER entry is the unverified one, so a reader that took the
        // first row rather than the newest VERIFIED one would report `NOW`.
        assert_eq!(report.newest_verified_ms, Some(NOW - HOUR));
        assert_eq!(
            report.archives, 2,
            "an unverified archive is still on disk and still counted"
        );
        let listed = verified_archives(&out);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, good.id);
        assert_eq!(listed[0].file, format!("{}.db", good.id));
    }

    #[test]
    fn an_archive_attempt_runs_off_the_store_mutex() {
        // `try_lock`, not `lock`: std's Mutex is not re-entrant and `lock`
        // would hang the suite instead of failing it. The copy is a whole
        // database and a doc_flush waiting behind it is the keystroke path
        // waiting behind it.
        let home = tempfile::tempdir().unwrap();
        let db = home.path().join("my-book.db");
        let state = crate::StoreState(std::sync::Mutex::new(Some(crate::test_support::opened(
            &db,
        ))));
        let free = std::sync::Mutex::new(None);

        let path = {
            let guard = state.0.lock().unwrap();
            guard.as_ref().unwrap().path.clone()
        };
        attempt_archive(
            &path,
            "My Book",
            "my-book",
            home.path(),
            NOW,
            |_, _, _, _, _| {
                *free.lock().unwrap() = Some(state.0.try_lock().is_ok());
                Err("stop here".to_string())
            },
        )
        .unwrap_err();

        assert_eq!(
            *free.lock().unwrap(),
            Some(true),
            "the archive held the store mutex across the copy"
        );
    }

    #[test]
    fn an_archive_failure_does_not_touch_the_recovery_status() {
        // THE ESCALATION COUNTER BELONGS TO THE SCHEDULE. `consecutive_failures`
        // is what moves the project bar's same-device line from secondary ink
        // to full ink after three failed BACKUPS; an archive the writer asked
        // for and did not get is a different fact, answered synchronously
        // through the notice channel. Folding one into the other would report a
        // stale recovery point that is not stale.
        let home = tempfile::tempdir().unwrap();
        let db = home.path().join("my-book.db");
        crate::test_support::seeded_project(&db);
        let recovery = crate::projects::recovery_dir(home.path(), "my-book");

        attempt(&db, "My Book", "my-book", home.path(), NOW, take_point).unwrap();
        let before = read_status(&recovery).expect("the backup recorded no status");

        let e = attempt_archive(
            &db,
            "My Book",
            "my-book",
            home.path(),
            NOW + HOUR,
            |_, _, _, _, _| Err("disk full".to_string()),
        )
        .unwrap_err();

        assert_eq!(e, "disk full");
        assert_eq!(
            read_status(&recovery).as_ref(),
            Some(&before),
            "an archive failure rewrote the recovery status"
        );
        assert_eq!(before.consecutive_failures, 0, "the fixture proved nothing");
        // And it wrote no status of its own to be mistaken for one.
        assert_eq!(
            read_status(&crate::projects::archives_dir(home.path(), "my-book")),
            None
        );
    }

    #[test]
    fn an_archive_lands_in_the_archives_directory_and_the_writer_gets_its_name() {
        let home = tempfile::tempdir().unwrap();
        let db = home.path().join("my-book.db");
        crate::test_support::seeded_project(&db);

        let archive =
            attempt_archive(&db, "My Book", "my-book", home.path(), NOW, take_archive).unwrap();

        let expected = crate::projects::archives_dir(home.path(), "my-book").join(&archive.file);
        assert!(
            expected.is_dir(),
            "the archive did not land where the writer is told to look for it"
        );
        crate::backup_bundle::verify(&expected).unwrap();
    }

    #[test]
    fn a_second_point_is_appended_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        let out = dir.path().join("recovery");

        take_point(&src, "my-book", "My Book", &out, NOW - HOUR).unwrap();
        take_point(&src, "my-book", "My Book", &out, NOW).unwrap();

        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(m.entries.len(), 2);
        assert!(
            m.entries[0].at_ms > m.entries[1].at_ms,
            "entries are not newest first"
        );
    }

    #[test]
    fn two_points_in_the_same_second_do_not_collide() {
        // The timer cannot produce this; a manual backup beside a tick can, and
        // `VACUUM INTO` refuses an existing destination rather than
        // overwriting, so an unhandled collision would be a hard failure on the
        // day 014 lands the button.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        let out = dir.path().join("recovery");

        let a = take_point(&src, "my-book", "My Book", &out, NOW).unwrap();
        let b = take_point(&src, "my-book", "My Book", &out, NOW).unwrap();
        assert_ne!(a.id, b.id);
        assert!(generated_bundle(&out, &a.id).is_dir());
        assert!(generated_bundle(&out, &b.id).is_dir());
    }

    #[test]
    fn a_damaged_snapshot_is_recorded_as_unverified_and_kept() {
        // A point that fails verification is RETAINED -- it may still hold
        // something salvageable -- but is not promoted to the floor and is not
        // what a status surface may report as "backed up as of".
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        drop(crate::test_support::seeded_project(&src));
        // A `doc` row whose item is gone: exactly what `cli::validate` reports
        // as `orphan_doc`, and a defect that copies faithfully into a snapshot.
        //
        // Planted through a second connection with `foreign_keys` OFF, which is
        // `cli.rs`'s own `damage` helper -- copied rather than reached for,
        // because it lives in that file's `mod tests` and is not importable.
        // DO NOT add an escape hatch to `Store` for this.
        {
            let conn = rusqlite::Connection::open(&src).unwrap();
            conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
            conn.execute_batch(
                "INSERT INTO doc VALUES ('nobody', '{\"type\":\"doc\",\"content\":[]}', 1, 0);",
            )
            .unwrap();
        }

        let point = take_point(
            &src,
            "my-book",
            "My Book",
            &dir.path().join("recovery"),
            NOW,
        )
        .unwrap();
        assert!(
            !point.verified,
            "a project with an orphaned doc verified clean"
        );
        assert_eq!(point.verified_at, None);
        assert!(
            generated_bundle(&dir.path().join("recovery"), &point.id).is_dir(),
            "an unverified point was deleted rather than kept"
        );
    }

    #[test]
    fn taking_a_point_prunes_by_the_same_rule_prune_states() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my-book.db");
        crate::test_support::seeded_project(&src);
        let out = dir.path().join("recovery");

        // Three points in ONE hour bucket, all older than an hour: two must go.
        let bucket = (NOW - 3 * HOUR).div_euclid(HOUR) * HOUR;
        for at in [bucket + 1000, bucket + 2000, bucket + 3000, NOW] {
            take_point(&src, "my-book", "My Book", &out, at).unwrap();
        }

        let m: Manifest =
            serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(
            m.entries.len(),
            2,
            "entries: {:?}",
            m.entries.iter().map(|e| &e.id).collect::<Vec<_>>()
        );
        // And the FILES went with the rows: a manifest that stopped describing
        // a file still on disk is the divergence this whole envelope exists to
        // prevent.
        let on_disk = std::fs::read_dir(&out)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("point"))
            .count();
        assert_eq!(on_disk, 2);
    }

    #[test]
    fn a_recovery_manifest_carries_the_shared_envelope() {
        let m = Manifest::recovery(
            ProjectRef {
                slug: "my-book".into(),
                name: "My Book".into(),
                schema_version: 5,
            },
            NOW,
            Completeness {
                items_total: 20_000,
                entries_written: 1,
                documents_with_prose: 15_200,
                unreadable_bodies: 0,
                pictures: 0,
                covers: 0,
            },
            vec![pt(NOW, true)],
        );
        // The discriminator, and the only thing a reader branches on.
        assert_eq!(m.kind, "recovery");
        // Two contracts, not one: the envelope and the artifact format move
        // independently.
        assert_eq!(m.manifest_version, 1);
        assert_eq!(m.generator.format_version, 1);
        // `exclusions` NAMES THE PICTURES and is no longer empty. It said
        // "a VACUUM INTO snapshot is the whole project file" until this field was
        // added, and that claim died the day a project could hold a file beside the
        // store. `conflicts`/`unmatched` are still empty here and still exist
        // so ONE reader parses both forms.
        assert_eq!(m.exclusions, vec![EXCLUSION_PICTURES.to_string()]);
        assert!(m.conflicts.is_empty() && m.unmatched.is_empty());
    }

    #[test]
    fn a_manifest_round_trips_through_json_with_the_designed_field_names() {
        let m = Manifest::recovery(
            ProjectRef {
                slug: "b".into(),
                name: "B".into(),
                schema_version: 5,
            },
            NOW,
            Completeness {
                items_total: 3,
                entries_written: 1,
                documents_with_prose: 2,
                unreadable_bodies: 0,
                pictures: 0,
                covers: 0,
            },
            vec![pt(NOW, true)],
        );
        let text = serde_json::to_string(&m).unwrap();
        // Asserted by NAME, because these names are a contract shared with the
        // readable mirror's `kind: "mirror"` form. A rename here silently forks
        // one envelope into two.
        for key in [
            "manifest_version",
            "kind",
            "project",
            "generated_at",
            "generator",
            "completeness",
            "exclusions",
            "entries",
            "conflicts",
            "unmatched",
            "checksum",
        ] {
            assert!(
                text.contains(&format!("\"{key}\"")),
                "manifest is missing {key}: {text}"
            );
        }
        // The entry's own designed names, including the one `Point` renames.
        for key in [
            "\"id\"",
            "\"bytes\"",
            "\"hash\"",
            "\"mtime_ms\"",
            "\"verified\"",
            "\"verified_at\"",
        ] {
            assert!(text.contains(key), "entry is missing {key}: {text}");
        }
        assert_eq!(serde_json::from_str::<Manifest>(&text).unwrap(), m);
    }

    #[test]
    fn the_checksum_covers_the_manifest_and_changes_with_it() {
        fn built(items_total: u64) -> Manifest {
            Manifest::recovery(
                ProjectRef {
                    slug: "b".into(),
                    name: "B".into(),
                    schema_version: 5,
                },
                NOW,
                Completeness {
                    items_total,
                    entries_written: 1,
                    documents_with_prose: 2,
                    unreadable_bodies: 0,
                    pictures: 0,
                    covers: 0,
                },
                vec![pt(NOW, true)],
            )
        }
        // BUILT, not cloned-and-edited: the checksum is computed in the
        // constructor, so mutating a clone's field leaves the previous figure
        // in place and the assertion would compare a value with itself.
        assert_ne!(built(3).checksum, built(4).checksum);
        // And it is deterministic rather than a nonce: building the same
        // content twice gives the same answer. That is NOT the contract -- see
        // `the_checksum_is_what_a_reader_recomputes_by_blanking_the_field`,
        // which asserts an independent reader can recompute the figure. This
        // assertion alone is satisfied by a hash over any input.
        assert_eq!(built(3).checksum, built(3).checksum);
        // Vacuity guard: an implementation that left the field empty satisfies
        // the equality above and nothing else.
        assert_eq!(built(3).checksum.len(), 16);
    }

    #[test]
    fn everything_inside_the_last_hour_is_kept() {
        // The point AT the boundary, not near it: `age <= HOUR_MS` and
        // `age < HOUR_MS` agree on every other input.
        let points = vec![pt(NOW, true), pt(NOW - HOUR, false)];
        assert_eq!(prune(NOW, &points, 100), Vec::<usize>::new());
    }

    #[test]
    fn past_an_hour_one_point_per_hour_bucket_survives() {
        // Two points in the SAME absolute hour bucket, both older than an hour.
        let bucket = (NOW - 3 * HOUR).div_euclid(HOUR) * HOUR;
        let points = vec![
            pt(NOW, true),
            pt(bucket + 3000, false),
            pt(bucket + 1000, false),
        ];
        assert_eq!(
            prune(NOW, &points, 100),
            vec![2],
            "the older of the pair should go"
        );
    }

    #[test]
    fn past_a_day_one_point_per_day_bucket_survives() {
        let bucket = (NOW - 3 * DAY).div_euclid(DAY) * DAY;
        let points = vec![
            pt(NOW, true),
            pt(bucket + 5 * HOUR, false),
            pt(bucket + HOUR, false),
        ];
        assert_eq!(prune(NOW, &points, 100), vec![2]);
    }

    #[test]
    fn the_cap_cuts_the_survivors_oldest_first() {
        // A list where the survivor index and the raw index DIFFER: two points
        // share an hour bucket, so index 3 is survivor 2. Both recorded cap
        // tests in this repo used lists where the two coincide, and a mutation
        // applying the cap to the raw list survived them.
        let bucket = (NOW - 5 * HOUR).div_euclid(HOUR) * HOUR;
        let points = vec![
            pt(NOW, true),
            pt(NOW - 90 * 60_000, false),
            pt(bucket + 3000, false),
            pt(bucket + 1000, false),
            pt(NOW - 9 * HOUR, false),
        ];
        // cap 2: survivors are 0 and 1; 2 loses to the cap, 3 to its bucket, 4
        // to the cap.
        assert_eq!(prune(NOW, &points, 2), vec![2, 3, 4]);
    }

    #[test]
    fn the_most_recently_verified_point_is_never_deleted() {
        // The design's floor. The verified point is old enough that both the
        // bucket rule AND the cap would otherwise take it, so a mutation
        // deleting either half of the protection is visible.
        let points = vec![
            pt(NOW, false),
            pt(NOW - 30 * 60_000, false),
            pt(NOW - 40 * DAY, true),
        ];
        let drop = prune(NOW, &points, 2);
        assert!(
            !drop.contains(&2),
            "retention deleted the last verified recovery point: {drop:?}"
        );
    }

    #[test]
    fn the_newest_incomplete_point_is_retained_beside_the_verified_floor() {
        let points = vec![
            pt(NOW, false),
            pt(NOW - 30 * 60_000, true),
            pt(NOW - 40 * DAY, false),
        ];
        assert!(prune(NOW, &points, 2).contains(&2));
        assert_eq!(
            prune(NOW, &points, 0),
            vec![2],
            "the newest incomplete point or the last verified point was discarded"
        );
        assert!(
            !points[0].verified,
            "the diagnostic copy must remain unverified"
        );
    }

    #[test]
    fn the_floor_is_the_most_recent_verified_point_not_any_verified_point() {
        let points = vec![pt(NOW - 40 * DAY, true), pt(NOW - 41 * DAY, true)];
        // Both are verified; only index 0 is the floor. Index 1 is in its own
        // day bucket, so only the cap can reach it.
        assert_eq!(prune(NOW, &points, 1), vec![1]);
    }

    fn manifest_of(dir: &Path, entries: Vec<Point>) {
        std::fs::create_dir_all(dir).unwrap();
        let m = Manifest::recovery(
            ProjectRef {
                slug: "my-book".into(),
                name: "My Book".into(),
                schema_version: 5,
            },
            NOW,
            Completeness {
                items_total: 1,
                entries_written: entries.len() as u64,
                documents_with_prose: 1,
                unreadable_bodies: 0,
                pictures: 0,
                covers: 0,
            },
            entries,
        );
        write_manifest(dir, &m).unwrap();
    }

    #[test]
    fn the_open_project_wins_over_the_environment() {
        // A writer who switched projects mid-session is looking at the one that
        // is open, not at the one the launch named.
        assert_eq!(
            target_slug(
                Some(Path::new("/lib/open-book.db")),
                Some(Path::new("/lib/env-book.db")),
                Some(Path::new("/lib/last-book.db")),
            )
            .as_deref(),
            Some("open-book")
        );
    }

    #[test]
    fn the_environment_wins_over_the_last_project_setting() {
        // The mount failed, so nothing is open. APP_PROJECT names what this
        // launch was TOLD to open; `last_project` names what the previous one
        // happened to leave behind.
        assert_eq!(
            target_slug(
                None,
                Some(Path::new("/lib/env-book.db")),
                Some(Path::new("/lib/last.db"))
            )
            .as_deref(),
            Some("env-book")
        );
        assert_eq!(
            target_slug(None, None, Some(Path::new("/lib/last.db"))).as_deref(),
            Some("last")
        );
    }

    #[test]
    fn no_candidate_at_all_reports_no_slug() {
        // A first launch whose only project failed to open and whose settings
        // file is gone. There is nothing to describe, and that is an answer.
        assert_eq!(target_slug(None, None, None), None);
        // A path with no usable file stem is the same answer, not a panic:
        // `tick` already refuses one for the same reason.
        assert_eq!(target_slug(Some(Path::new("/")), None, None), None);
    }

    #[test]
    fn a_directory_with_no_manifest_describes_as_empty() {
        // The state a writer is in before the first tick, and the state the
        // startup-failure screen must be able to describe without promising
        // anything: the target is known, and there is nothing behind it.
        let dir = tempfile::tempdir().unwrap();
        let r = describe_dir(&dir.path().join("nothing-here"), "my-book");
        assert_eq!(r.slug.as_deref(), Some("my-book"));
        assert_eq!(r.status, None);
        assert_eq!(r.newest_verified_ms, None);
        assert_eq!(r.verified_points, 0);
    }

    #[test]
    fn a_report_carries_the_newest_VERIFIED_point_not_the_newest_point() {
        // The whole surface rests on this: the newest point on disk may have
        // failed its structural read, and reporting its time as the writer's
        // floor is the silent-staleness failure this feature exists to prevent.
        let dir = tempfile::tempdir().unwrap();
        manifest_of(
            dir.path(),
            vec![pt(NOW, false), pt(NOW - HOUR, true), pt(NOW - DAY, true)],
        );
        let r = describe_dir(dir.path(), "my-book");
        assert_eq!(r.newest_verified_ms, Some(NOW - HOUR));
        assert_eq!(r.verified_points, 2);
    }

    #[test]
    fn a_report_keeps_the_attempt_and_the_verified_time_apart() {
        // `last_attempt_ms` and `last_verified_ms` are different facts, and the
        // report carries a THIRD: what the manifest on disk actually holds.
        // They are allowed to disagree -- a manual prune moves the manifest and
        // not the status file -- so the report ships all three and the page
        // chooses.
        let dir = tempfile::tempdir().unwrap();
        manifest_of(dir.path(), vec![pt(NOW - 2 * HOUR, true)]);
        write_status(
            dir.path(),
            &Status {
                last_attempt_ms: NOW,
                last_attempt_ok: false,
                last_error: Some("no space left on device".into()),
                last_verified_ms: Some(NOW - HOUR),
                consecutive_failures: 3,
            },
        )
        .unwrap();

        let r = describe_dir(dir.path(), "my-book");
        let s = r.status.expect("the report dropped the status file");
        assert_eq!(s.last_attempt_ms, NOW);
        assert_eq!(s.last_verified_ms, Some(NOW - HOUR));
        assert_eq!(s.consecutive_failures, 3);
        assert_eq!(
            r.newest_verified_ms,
            Some(NOW - 2 * HOUR),
            "the report read the verified time out of the status file instead of the manifest"
        );
    }

    #[test]
    fn an_absent_manifest_lists_no_points() {
        // Same leniency `describe_dir` applies, for the same reason: the panel
        // offering a restore must be able to say "nothing here" rather than
        // become an error screen.
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(verified_points(&dir.path().join("nothing-here")), vec![]);
    }

    #[test]
    fn an_unparseable_manifest_lists_no_points() {
        // Not the same case as an absent one, and worth its own test: a file
        // that exists and will not parse is the one an `ok()?` on the READ
        // would let through.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(manifest_path(dir.path()), b"{not json").unwrap();
        assert_eq!(verified_points(dir.path()), vec![]);
    }

    #[test]
    fn only_verified_points_are_listed() {
        // A point that failed its structural read is on disk and is NOT
        // something to offer a writer as a copy of their book.
        let dir = tempfile::tempdir().unwrap();
        manifest_of(
            dir.path(),
            vec![pt(NOW, false), pt(NOW - HOUR, true), pt(NOW - DAY, true)],
        );
        let ids: Vec<String> = verified_points(dir.path())
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids, vec![point_id(NOW - HOUR), point_id(NOW - DAY)]);
    }

    #[test]
    fn a_recovery_target_is_a_slug_and_the_directory_it_names() {
        let home = Path::new("/home/w/.local/share");
        assert_eq!(
            target_dir(Some(Path::new("/lib/open-book.db")), None, None, home),
            Some((
                "open-book".to_string(),
                home.join("cc.local.app").join("recovery").join("open-book")
            ))
        );
    }

    #[test]
    fn no_candidate_at_all_has_no_recovery_target() {
        assert_eq!(target_dir(None, None, None, Path::new("/home/w")), None);
    }

    #[test]
    fn an_unlisted_point_id_resolves_to_nothing() {
        // The page names a point by ID and never by path. An id the manifest
        // does not carry is not a recovery point, whatever is on disk under
        // that name.
        let dir = tempfile::tempdir().unwrap();
        manifest_of(dir.path(), vec![pt(NOW, true)]);
        std::fs::write(dir.path().join("planted.db"), b"x").unwrap();
        assert_eq!(verified_point_path(dir.path(), "planted"), None);
    }

    #[test]
    fn an_unverified_point_id_resolves_to_nothing() {
        // Listed, on disk, and not something to hand a writer as their book.
        let dir = tempfile::tempdir().unwrap();
        manifest_of(dir.path(), vec![pt(NOW, false)]);
        assert_eq!(verified_point_path(dir.path(), &point_id(NOW)), None);
    }

    #[test]
    fn a_listed_point_resolves_to_the_file_in_its_own_directory() {
        let dir = tempfile::tempdir().unwrap();
        manifest_of(dir.path(), vec![pt(NOW, true)]);
        let id = point_id(NOW);
        assert_eq!(
            verified_point_path(dir.path(), &id),
            Some(dir.path().join(format!("{id}.db")))
        );
    }

    #[test]
    fn a_listed_id_that_is_not_a_bare_file_name_resolves_to_nothing() {
        // A manifest is read leniently and is an ordinary file on disk, so a
        // hand-edited one can carry anything. Membership alone would let a
        // traversing id through and the restore would copy an arbitrary file
        // into the library under a project's name.
        //
        // The two rules are BOTH REACHABLE and neither covers for the other: an
        // unlisted id is refused by membership above, and this one passes
        // membership and is refused by the name scan.
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        // A real, readable project exactly where the traversal points -- a
        // refusal test whose target does not exist proves nothing.
        crate::test_support::seeded_project(&outside.join("secret.db"));

        let escaping = "../outside/secret";
        let inner = dir.path().join("points");
        manifest_of(
            &inner,
            vec![Point {
                id: escaping.to_string(),
                ..pt(NOW, true)
            }],
        );
        assert!(
            inner.join(format!("{escaping}.db")).is_file(),
            "the fixture's traversal does not reach a real file, so it tests nothing"
        );

        assert_eq!(verified_point_path(&inner, escaping), None);
    }

    #[test]
    fn points_are_listed_newest_first() {
        // The fixture is written OLDEST first on purpose. A list that merely
        // echoed the manifest's own order would pass against a manifest every
        // current writer happens to sort, and start lying the day a
        // hand-edited one arrives -- `describe_dir` refuses to depend on that
        // ordering for the same reason.
        let dir = tempfile::tempdir().unwrap();
        manifest_of(
            dir.path(),
            vec![pt(NOW - DAY, true), pt(NOW - HOUR, true), pt(NOW, true)],
        );
        let times: Vec<i64> = verified_points(dir.path())
            .into_iter()
            .map(|p| p.at_ms)
            .collect();
        assert_eq!(times, vec![NOW, NOW - HOUR, NOW - DAY]);
    }

    #[test]
    fn a_point_id_is_a_utc_civil_timestamp() {
        assert_eq!(point_id(0), "1970-01-01T00-00-00Z");
        // 2026-08-19T21:14:02Z, the design document's own example. The epoch
        // value is 1_787_174_042_000 and not the 1_787_260_442_000 plan 013
        // carried, which is a day later -- checked against `date -u`, because a
        // constant nobody re-derived is how a calendar bug gets a test that
        // agrees with it.
        assert_eq!(point_id(1_787_174_042_000), "2026-08-19T21-14-02Z");
    }

    #[test]
    fn a_point_id_handles_a_leap_day() {
        // 2024-02-29T12:00:00Z. The civil conversion's era arithmetic is the
        // only thing standing between this and 2024-03-01.
        assert_eq!(point_id(1_709_208_000_000), "2024-02-29T12-00-00Z");
    }

    #[test]
    fn a_point_id_before_the_epoch_does_not_panic() {
        // Not reachable from a working clock, and a machine with a wrong one is
        // exactly when a recovery point matters. `div_euclid`, not `/`: integer
        // division truncates toward zero and would put 23:00 on the wrong day.
        assert_eq!(point_id(-1), "1969-12-31T23-59-59Z");
    }

    #[test]
    fn point_ids_sort_lexicographically_in_time_order() {
        // The directory listing IS the ordering. A format whose string order
        // disagreed with its time order would make the newest point unfindable
        // by the one tool a writer with a dead window has.
        const AT: [i64; 4] = [1_787_260_442_000, 0, 1_709_208_000_000, -1];
        let mut lexicographic: Vec<String> = AT.iter().map(|ms| point_id(*ms)).collect();
        lexicographic.sort();

        let mut pairs: Vec<(i64, String)> = AT.iter().map(|ms| (*ms, point_id(*ms))).collect();
        pairs.sort_by_key(|(ms, _)| *ms);
        let by_time: Vec<String> = pairs.into_iter().map(|(_, id)| id).collect();

        assert_eq!(lexicographic, by_time);
        // Vacuity guard: an input list already in time order would agree with
        // any format at all.
        assert_ne!(AT.to_vec(), {
            let mut sorted = AT.to_vec();
            sorted.sort();
            sorted
        });
    }
}
