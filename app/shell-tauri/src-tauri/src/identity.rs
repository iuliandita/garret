// app/shell-tauri/src-tauri/src/identity.rs
// WHO THE BOOK IS BY, and the one guarantee this application makes about it: a
// legal name cannot travel inside a project file, because the structure that
// travels has no field for one.
//
// TWO HALVES, DELIBERATELY NOT KEPT IN SYNC.
//
// THE VAULT is library-level, at `<data_home>/garret/identities.json`, a
// sibling of `settings.json`. Reusable across projects means it cannot live
// inside one of them. It is NOT in `settings.json`, and the reason is the one
// `read_settings` states about itself: every field there must deserialize
// LENIENTLY, because a failed parse of the whole file maps to the default and a
// strict field anywhere in it would cost `last_project`. Lenient is right for a
// theme and wrong for an identity -- **a vault that reads as empty because it
// could not be parsed makes the cross-identity check pass by failing**, which is
// exactly the machine that has something to hide. So the two are different files
// with opposite rules: `settings.json` fails soft, this fails LOUD.
//
// THE PIN is project-level, one row in the store's `meta` table. `meta` is per
// project, survives a rename of the file, answers "absent" cleanly and needs no
// migration -- 040's argument for the design rows and 042's for the covers, met
// a third time. NO SCHEMA STEP: `Store::open` refuses a file newer than the
// build, so a version bump would make every project a pen-name build touched
// unopenable by the distributables the test group runs.
//
// THE PRIVATE TIER IS STRUCTURALLY ABSENT FROM THE PIN, and that is the whole
// feature rather than a detail of it. `Pin` holds a `Public` and a `Publishing`
// and there is no `Private` in it -- not filtered, not `#[serde(skip)]`ed, not
// there. This matters BECAUSE OF 050: salvage sweeps every `meta` row verbatim
// into `manifest.json`, with no field-level knowledge of what it is copying, and
// the amendment decided the sweep is right and the pin is what gets constrained.
// Everything in a pin is data intended to travel in a published book, so a sweep
// that copies all of it is safe. `the_pin_has_exactly_these_keys` is the
// tripwire: adding a field is a deliberate act with a failing test attached.
//
// WHAT THIS IS NOT. `identities.json` is plaintext on a disk whose whole
// manuscript library is also plaintext. The private tier is protected against
// TRAVELLING, not against being read by somebody at this machine, and no string
// in this application may imply otherwise.
use std::path::{Path, PathBuf};

/// The `meta` key the pin lives under. `identity.` rather than `design.`: a pen
/// name is not how the book is set, it is who it is by, and a later series or
/// universe pin is a sibling of this key rather than of `design`'s three.
pub use crate::core_constants::PIN_KEY;

/// The vault's own file, beside `settings.json`.
pub fn vault_path(data_home: &Path) -> PathBuf {
    data_home.join(crate::APP_DIR).join("identities.json")
}

/// The envelope. A version and a list, which is the shape the series and
/// universe files named as this design's precedent will copy.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Vault {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub identities: Vec<Identity>,
}

/// The version this build writes.
pub const VAULT_VERSION: u32 = 1;

/// One pen name, whole: everything the writer keeps about it, in three tiers.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Identity {
    pub id: String,
    /// Bumped on every edit to THIS identity. A project whose pin names an older
    /// `rev` than the vault holds is stale; staleness is surfaced and never
    /// repaired automatically, because a pin that followed the vault would
    /// rewrite the front matter of a book already on a shelf from a text field
    /// edit.
    #[serde(default)]
    pub rev: u64,
    /// Other literal bylines belonging to this identity. Vault-only: never in a Pin.
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub public: Public,
    #[serde(default)]
    pub publishing: Publishing,
    /// LEGAL, CONTACT AND ADMINISTRATIVE. This tier exists in the vault and in
    /// nothing else. There is no path from here into a `Pin`, because `Pin` has
    /// no field of this type.
    #[serde(default)]
    pub private: Private,
}

/// Reaches exports, is displayed by the preflight, is copied into the pin.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Public {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sort_name: String,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub links: Vec<String>,
}

/// Export-facing, copied into the pin, carried only by formats that ask for it.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Publishing {
    #[serde(default)]
    pub imprint: String,
    #[serde(default)]
    pub rights: String,
}

/// The tier that never leaves this file.
///
/// IT HAS NO `Serialize` INTO A PIN BECAUSE IT HAS NO PLACE IN ONE. The type is
/// serializable -- the vault is a JSON file and this is part of it -- and the
/// guarantee is not "it cannot be serialized", it is "the structure that travels
/// has no field of this type". Those are different claims and only the second is
/// true, so only the second is made.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Private {
    #[serde(default)]
    pub legal_name: String,
    #[serde(default)]
    pub contact: String,
    #[serde(default)]
    pub admin: String,
}

/// The copy a project keeps of the identity it was written under.
///
/// EVERY FIELD HERE TRAVELS, and that is the invariant. It goes into the project
/// file, therefore into a backup, a recovery archive, a readable mirror and
/// salvage's `manifest.json`. There is no `private` field and there must never
/// be one; `the_pin_has_exactly_these_keys` fails if anything is added.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Pin {
    pub identity_id: String,
    /// The vault `rev` this copy was taken at. What makes staleness detectable
    /// without making it automatic.
    #[serde(default)]
    pub rev: u64,
    /// The epoch second the copy was taken.
    #[serde(default)]
    pub pinned_at: i64,
    #[serde(default)]
    pub public: Public,
    #[serde(default)]
    pub publishing: Publishing,
}

/// Every key a pin serializes, sorted.
///
/// STATED HERE AND ASSERTED IN A TEST, `cli::salvage_json_keys`' own shape --
/// the test that has now caught four slices growing a contract. A field added to
/// `Pin` without a line here is a field that reaches `manifest.json` with nobody
/// having decided it should.
#[cfg(test)]
pub const PIN_KEYS: [&str; 5] = ["identity_id", "pinned_at", "public", "publishing", "rev"];

/// Take a pin from an identity, at this instant.
///
/// THE CONVERSION IS WHERE THE TIER BOUNDARY IS ENFORCED, and it enforces it by
/// having nothing to enforce: there is no private field to drop because `Pin`
/// has nowhere to put one.
pub fn pin_of(identity: &Identity, at: i64) -> Pin {
    Pin {
        identity_id: identity.id.clone(),
        rev: identity.rev,
        pinned_at: at,
        public: identity.public.clone(),
        publishing: identity.publishing.clone(),
    }
}

/// Parse a raw `meta[PIN_KEY]` value into `(identity_id, public name)`,
/// leniently.
///
/// 040's PER-KEY RULE, met again for the library overview: a pin row this
/// build cannot read costs that book its byline on the shelf and nothing
/// else -- the cover, the dates and the listing itself must survive a
/// damaged row exactly as `pin_of_project` already lets them survive one for
/// an open book. The overview needs only the two fields it displays, so this
/// stops short of handing back a whole `Pin`.
pub fn pin_summary(raw: &str) -> Option<(String, String)> {
    serde_json::from_str::<Pin>(raw)
        .ok()
        .map(|pin| (pin.identity_id, pin.public.name))
}

/// A free id for a new identity.
///
/// A COUNTER AND NOT A UUID, and the reason is what an id is FOR here: it is
/// the join between a pin and a vault entry, it lands in every project file that
/// pins it, and it is read by a person looking at `manifest.json` after
/// something went wrong. `i1` is legible there and a uuid is not. It carries no
/// meaning a writer typed, so a renamed pen name does not orphan its own books.
pub fn new_id(vault: &Vault) -> String {
    let mut n = vault.identities.len() as u64 + 1;
    loop {
        let candidate = format!("i{n}");
        if !vault.identities.iter().any(|i| i.id == candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Why a vault could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    /// The file is there and does not parse. **Never an empty vault.**
    Unreadable(String),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::Unreadable(detail) => write!(
                f,
                "the identity vault could not be read ({detail}); \
                 no export can be checked against it until it is repaired or removed"
            ),
        }
    }
}

/// The vault, or a loud failure.
///
/// A MISSING FILE IS AN EMPTY VAULT AND IS NORMAL -- it is the state of every
/// installation today. **A file that will not parse is an ERROR**, and this is
/// the one rule in this module that everything else rests on: an unparseable
/// vault read as empty makes every cross-identity check report that it found
/// nothing, on the one machine where there was something to find. An IO error
/// that is not `NotFound` is the same answer for the same reason: "I could not
/// look" and "there is nothing there" must never be one word.
pub fn read_vault(data_home: &Path) -> Result<Vault, VaultError> {
    let path = vault_path(data_home);
    match std::fs::read_to_string(&path) {
        Ok(body) => {
            let vault: Vault = serde_json::from_str(&body)
                .map_err(|e| VaultError::Unreadable(format!("{}: {e}", path.display())))?;
            for identity in &vault.identities {
                normalize_aliases(identity.aliases.clone()).map_err(|error| {
                    VaultError::Unreadable(format!("{}: identity {:?}: {error}", path.display(), identity.id))
                })?;
            }
            Ok(vault)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vault::default()),
        Err(e) => Err(VaultError::Unreadable(format!("{}: {e}", path.display()))),
    }
}

/// Write the vault whole, through a temp file in the same directory and a
/// rename.
///
/// `write_settings`' discipline, restated rather than shared: that function
/// takes a `Settings` and is the ONLY permitted writer of that file, which is a
/// narrowness worth keeping. Widening it to a second concern is what this module
/// exists not to do.
pub fn write_vault(data_home: &Path, vault: &Vault) -> Result<(), String> {
    let path = vault_path(data_home);
    let dir = path
        .parent()
        .ok_or_else(|| format!("{}: no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let body = serde_json::to_vec(vault).map_err(|e| format!("cannot serialize the vault: {e}"))?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".identities-")
        .tempfile_in(dir)
        .map_err(|e| format!("cannot prepare the identity vault: {e}"))?;
    {
        use std::io::Write as _;
        tmp.write_all(&body)
            .map_err(|e| format!("cannot write the identity vault: {e}"))?;
        tmp.as_file()
            .sync_all()
            .map_err(|e| format!("cannot sync the identity vault: {e}"))?;
    }
    tmp.persist(&path)
        .map_err(|e| format!("cannot replace {}: {e}", path.display()))?;
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// This project's pin, or None.
///
/// PER-KEY LENIENCY, 040's rule: a pin this build cannot read costs the byline
/// and leaves the design, the covers and the daily goal beside it intact. It is
/// answered as absent rather than as an error, because a project whose pin row
/// is damaged is a project with no byline -- which is a state the whole product
/// already handles -- and refusing to export it would be the outage the design
/// refuses one level up.
pub fn pin_of_project(store: &crate::store::Store) -> Result<Option<Pin>, String> {
    Ok(store
        .get_meta(PIN_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::from_str::<Pin>(&v).ok()))
}

/// Record a pin, or take it off.
///
/// THE EMPTY ROW IS NEVER STORED, `covers::clear_cover`'s rule: "nobody has
/// pinned an identity" and "there was one and the writer unpinned it" are the
/// same fact about the book, so they are one state with one spelling.
pub fn set_pin(store: &crate::store::Store, pin: Option<&Pin>) -> Result<(), String> {
    match pin {
        Some(pin) => {
            let body = serde_json::to_string(pin).map_err(|e| e.to_string())?;
            store.set_meta(PIN_KEY, &body).map_err(|e| e.to_string())
        }
        None => store.delete_meta(PIN_KEY).map_err(|e| e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// The field map: ONE table, shared by the writer and the check.
// ---------------------------------------------------------------------------

/// A pin field a format emits.
///
/// AN ENUM AND NOT A STRING, so `value_of` is an exhaustive match and a field
/// added to the table without a value to read from is a compile error rather
/// than a row the check prints and the writer never emits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinField {
    Name,
    SortName,
    Imprint,
    Rights,
}

impl PinField {
    /// The machine word the page words its own sentence from. Never a display
    /// name: the host has no catalog.
    pub fn id(self) -> &'static str {
        match self {
            PinField::Name => "name",
            PinField::SortName => "sort_name",
            PinField::Imprint => "imprint",
            PinField::Rights => "rights",
        }
    }

    /// What this field holds in `pin`, or None when it is empty. An empty value
    /// is not written by any format, so it is not disclosed by any format
    /// either -- the check and the writer agree because they ask this one
    /// function.
    pub fn value_of(self, pin: &Pin) -> Option<&str> {
        let v = match self {
            PinField::Name => pin.public.name.as_str(),
            PinField::SortName => pin.public.sort_name.as_str(),
            PinField::Imprint => pin.publishing.imprint.as_str(),
            PinField::Rights => pin.publishing.rights.as_str(),
        };
        if v.trim().is_empty() {
            None
        } else {
            Some(v)
        }
    }
}

/// One row: which field, where in the file it lands, and what it hangs off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportField {
    pub field: PinField,
    /// Where it goes, as a machine word the page has a sentence for.
    pub at: &'static str,
    /// A field this row is attached to in the file, when it is attached to one.
    ///
    /// AN EPUB's `file-as` REFINES `dc:creator` BY ID. A refinement of a
    /// creator that is not there points at nothing, so the row must not be
    /// emitted -- and if the WRITER dropped it while the CHECK went on printing
    /// it, the two would be separate lists again and the check would be
    /// theatre. So the dependency lives in the table and `disclosed` applies it
    /// once, for both.
    pub requires: Option<PinField>,
}

/// The EPUB's rows. Every one of these is emitted by `epub::render`, which
/// iterates THIS SLICE and does not restate it.
const EPUB_FIELDS: [ExportField; 4] = [
    ExportField {
        field: PinField::Name,
        at: "dc:creator",
        requires: None,
    },
    ExportField {
        field: PinField::SortName,
        at: "file-as",
        requires: Some(PinField::Name),
    },
    ExportField {
        field: PinField::Imprint,
        at: "dc:publisher",
        requires: None,
    },
    ExportField {
        field: PinField::Rights,
        at: "dc:rights",
        requires: None,
    },
];

/// The PDF's row, and there is exactly one.
///
/// **THE PDF'S DOCUMENT METADATA IS NOT OURS AND IT WAS MEASURED, NOT ASSUMED.**
/// A proof copy is printed by WebKitGTK, and what lands in the file's info
/// dictionary is `/Title` (the book's name, from the document's `<title>`) and
/// `/Producer` (`Skia/PDF m145`), plus creation and modification dates. There is
/// no `/Author`, no `/Creator`, no `/Subject` and no XMP stream, and an
/// `<meta name="author">` in the head reaches NONE of them -- probed directly
/// against a real proof and reported in the write-back. So the only channel a
/// byline has into a PDF is the one a printed book has always used: ink on the
/// title page.
const PDF_FIELDS: [ExportField; 1] = [ExportField {
    field: PinField::Name,
    at: "title-page",
    requires: None,
}];

/// Markdown's rows, and the emptiness is the statement.
///
/// `export::manuscript` emits `# <project name>`, one heading per walked item
/// and its prose, and NOTHING ELSE. There is no front matter, no YAML header and
/// no byline, so disclosure for Markdown honestly reports "none" -- which tells
/// a writer that the byline they believe they are exporting is not in the file.
/// 042 refused to put a cover in this format and the argument holds here: an
/// image or a byline line breaks the graded round trip, because `import.rs` has
/// no syntax for either and would re-import it as prose.
const MARKDOWN_FIELDS: [ExportField; 0] = [];

/// DOCX's rows, and the emptiness is the statement -- the same one Markdown's
/// makes. `docx::render` writes no `docProps/` at all (092's recorded
/// reason: `core.xml`'s `dc:creator` is exactly the leak 053 enumerated and
/// 054 ruled out), so there is nowhere in the package identity metadata
/// could go.
const DOCX_FIELDS: [ExportField; 0] = [];

/// Which identity fields this format emits, and where.
///
/// **ONE TABLE, NOT TWO.** The writer iterates this and the disclosure check
/// prints this. That is the only construction under which "here is everything
/// that will leave" is a provable statement rather than a hand-maintained list
/// that drifts from the emitter on the first format change. The design's own
/// rule: if the two ever become separate lists, the check is theatre and should
/// be deleted rather than kept.
///
/// EXHAUSTIVE OVER `Format`, so a fourth format cannot be added without somebody
/// stating its rows.
pub fn fields_for(format: crate::export::Format) -> &'static [ExportField] {
    match format {
        crate::export::Format::Markdown => &MARKDOWN_FIELDS,
        crate::export::Format::Epub => &EPUB_FIELDS,
        crate::export::Format::Pdf => &PDF_FIELDS,
        crate::export::Format::Docx => &DOCX_FIELDS,
    }
}

/// The rows this format will actually emit for this pin, as `(where, value)`.
///
/// THE WRITERS CALL THIS AND SO DOES THE CHECK. `epub::render` looks its
/// metadata up here by `at`; `pdf::proof_document` looks its byline up here; the
/// disclosure check prints the whole list. Nobody restates it.
pub fn disclosed<'a>(
    format: crate::export::Format,
    pin: Option<&'a Pin>,
) -> Vec<(&'static str, &'a str)> {
    let Some(pin) = pin else {
        return Vec::new();
    };
    fields_for(format)
        .iter()
        .filter(|row| row.requires.is_none_or(|need| need.value_of(pin).is_some()))
        .filter_map(|row| row.field.value_of(pin).map(|v| (row.at, v)))
        .collect()
}

/// What a format emits at one place, or None. The writers' own accessor, so a
/// writer cannot emit a value the table does not carry.
pub fn emitted<'a>(
    format: crate::export::Format,
    pin: Option<&'a Pin>,
    at: &str,
) -> Option<&'a str> {
    disclosed(format, pin)
        .into_iter()
        .find(|(place, _)| *place == at)
        .map(|(_, value)| value)
}

// ---------------------------------------------------------------------------
// The preflight.
// ---------------------------------------------------------------------------

/// Every check by name, in the order the report prints them.
pub const CHECK_IDENTITY_DISCLOSURE: &str = "identity_disclosure";
pub const CHECK_CROSS_IDENTITY: &str = "cross_identity";
pub const CHECK_MISSING_METADATA: &str = "missing_metadata";
pub const CHECK_BROKEN_LINKS: &str = "broken_links";
pub const CHECK_VALIDATOR: &str = "validator";
pub const CHECK_ASSETS: &str = "assets";

/// What a check did.
pub const STATE_RAN: &str = "ran";
pub const STATE_VACUOUS: &str = "vacuous";
pub const STATE_NOT_APPLICABLE: &str = "not_applicable";

/// The surfaces the cross-identity check actually reads.
///
/// EVERY ONE OF THESE IS ALREADY IN MEMORY where the check runs, which is why
/// the check costs an export nothing when the vault is empty and one pass over
/// what the renderer already holds when it is not. A surface that needed a
/// second read of the store would be a surface that put a scan on the export
/// path, and this list is short for that reason rather than by oversight.
pub const SURFACES_CHECKED: [&str; 6] = ["project_name", "item_title", "document_body", "revision_pass_name", "revision_pass_purpose", "revision_task_body"];

/// The surfaces it does not read, named rather than omitted.
///
/// SECTION 8's OWN LIST, plus what this build has that it did not. A preflight
/// that showed six green rows and did not say which surfaces it never opened
/// would be the recorded failure mode this repository already has a name for.
pub const SURFACES_UNCHECKED: [&str; 11] = [
    "comment_body",
    "comment_quote",
    "snapshot_label",
    "synopsis",
    "cast",
    "export_directory",
    "window_title",
    "diagnostics",
    "readable_mirror",
    "series_name",
    "universe_name",
];

/// A finding's severity. A blocker cannot be dismissed and a warning is not one.
pub const SEVERITY_BLOCKER: &str = "blocker";
pub const SEVERITY_WARNING: &str = "warning";

/// Finding kinds.
pub const FINDING_IDENTITY_UNSET: &str = "identity_unset";
pub const FINDING_CROSS_IDENTITY: &str = "cross_identity";
pub const FINDING_CROSS_IDENTITY_UNPINNED: &str = "cross_identity_unpinned";
pub const FINDING_LINK_NOT_A_URL: &str = "link_not_a_url";

/// One check and what it did.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CheckState {
    pub name: &'static str,
    pub state: &'static str,
}

/// One thing found, with everything a writer needs to go and look at it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Finding {
    pub kind: &'static str,
    pub severity: &'static str,
    /// Which surface it was found in, from `SURFACES_CHECKED`.
    pub surface: &'static str,
    /// The item it is in, when the surface has one.
    pub item_id: Option<String>,
    /// The byte offset in the ORIGINAL text, so a later slice can reveal it.
    pub offset: Option<usize>,
    /// The matched text as the writer typed it, never as it was folded. Empty
    /// for a finding that is not about a match.
    pub matched: String,
}

/// One identity field this format will write.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DisclosedField {
    pub field: &'static str,
    pub at: &'static str,
    pub value: String,
}

/// Who the book says it is by, as the report states it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PinnedIdentity {
    pub identity_id: String,
    pub name: String,
    pub rev: u64,
    /// Whether the vault has moved on since the pin was taken. Reported and
    /// never repaired.
    pub stale: bool,
}

/// What one export was checked for.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Preflight {
    /// `export::Format::id`, so the page words the format from the same machine
    /// word `ExportResult.format` carries.
    pub format: &'static str,
    pub identity: Option<PinnedIdentity>,
    pub fields: Vec<DisclosedField>,
    pub checks: Vec<CheckState>,
    /// The names of every check whose state is not `ran`, again, under their own
    /// heading. A preflight that shows six green rows and hides that four of
    /// them checked nothing is the recorded failure mode.
    pub skipped: Vec<&'static str>,
    pub findings: Vec<Finding>,
    pub warning_tokens: Vec<crate::warning_history::WarningToken>,
    pub reason_history: crate::warning_history::ReasonHistoryView,
    pub surfaces_checked: Vec<&'static str>,
    pub surfaces_unchecked: Vec<&'static str>,
    pub blockers: usize,
}

/// What the preflight is given: everything already in memory where it runs.
pub struct Subject<'a> {
    pub format: crate::export::Format,
    pub project_name: &'a str,
    /// `(item_id, title)` for every walked item, in walk order.
    pub titles: &'a [(&'a str, &'a str)],
    /// `(item_id, prose)` for every walked item that has a readable body.
    pub bodies: &'a [(&'a str, String)],
    pub planning: &'a [PlanningText],
    pub pin: Option<&'a Pin>,
    pub vault: &'a Vault,
}

pub struct PlanningText {
    pub surface: &'static str,
    pub item_id: Option<String>,
    pub text: String,
}

/// Which strings count as another identity's name.
///
/// WITH A PIN: every identity in the vault except the pinned one. WITHOUT A PIN:
/// all of them -- the design's own rule, because a writer with two identities
/// and no pin on this project is the highest-risk state and not the lowest. What
/// changes without a pin is the SEVERITY, not the scan: see `check`.
fn needles(vault: &Vault, pin: Option<&Pin>) -> Vec<String> {
    let mine = pin.map(|p| p.identity_id.as_str());
    let mut out: Vec<String> = Vec::new();
    let owned: std::collections::HashSet<String> = vault
        .identities
        .iter()
        .filter(|identity| Some(identity.id.as_str()) == mine)
        .flat_map(|identity| {
            [&identity.public.name, &identity.public.sort_name]
                .into_iter()
                .chain(identity.aliases.iter())
        })
        .map(|name| crate::find::fold_with_offsets(name.trim()).0)
        .collect();
    let mut seen = std::collections::HashSet::new();
    for identity in &vault.identities {
        if Some(identity.id.as_str()) == mine {
            continue;
        }
        for candidate in [&identity.public.name, &identity.public.sort_name]
            .into_iter()
            .chain(identity.aliases.iter())
        {
            let trimmed = candidate.trim();
            // A one-character name would match half the manuscript. Two is the
            // shortest thing a person is called; below it the check would be
            // noise a writer learns to ignore, which is worse than no check.
            let folded = crate::find::fold_with_offsets(trimmed).0;
            if trimmed.chars().count() >= 2 && !owned.contains(&folded) && seen.insert(folded) {
                out.push(trimmed.to_string());
            }
        }
    }
    out
}

/// Keep aliases literal and usable by the checker. A malformed entry is an
/// error, never silently omitted from a check that claims to have scanned it.
pub fn normalize_aliases(aliases: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for alias in aliases {
        let trimmed = alias.trim();
        if trimmed.chars().count() < 2 || trimmed.chars().any(char::is_control) {
            return Err(format!("alias {alias:?} needs at least two visible characters on one line"));
        }
        let folded = crate::find::fold_with_offsets(trimmed).0;
        if seen.insert(folded) {
            out.push(trimmed.to_string());
        }
    }
    Ok(out)
}

/// Whether the cross-identity check has anything at all to look for.
///
/// THE CALLER'S LICENCE NOT TO PROJECT THE PROSE. With an empty vault -- which
/// is every installation today -- there are no needles, the check reports
/// `not_applicable`, and an export must not pay for a walk whose answer is
/// already known. `check` decides the answer either way; this only lets the
/// renderer avoid building an input nothing will read.
pub fn has_needles(vault: &Vault, pin: Option<&Pin>) -> bool {
    !needles(vault, pin).is_empty()
}

/// Every occurrence of `needle` in `text`, as `(offset in text, matched text)`.
///
/// FOLDED WITH `find::fold_with_offsets`, SHARED AND NOT RESTATED, for that
/// function's own recorded reason: a check folding differently from the search
/// would report a match at an offset the writer cannot find, and slicing the
/// original at an offset the folding does not have is a PANIC that poisons the
/// store mutex and closes the window.
fn occurrences(text: &str, needle_folded: &str) -> Vec<(usize, String)> {
    if needle_folded.is_empty() {
        return Vec::new();
    }
    let (folded, map) = crate::find::fold_with_offsets(text);
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(at) = folded[from..].find(needle_folded) {
        let start = from + at;
        let end = start + needle_folded.len();
        // Both ends map through `map`, which holds one entry per folded byte
        // plus the original's length, so every value is a character boundary of
        // the original by construction.
        let (a, b) = (map[start], map[end]);
        out.push((a, text[a..b].to_string()));
        from = end;
    }
    out
}

/// Check one export.
///
/// PURE. It takes what the renderer already holds and answers; it opens nothing,
/// writes nothing and needs neither a command nor a display. That is what makes
/// it unit-testable at `render_project_with`'s convergence point, and it is also
/// why the override log is not in this slice: the store there is open READ-ONLY.
pub fn check(subject: &Subject<'_>) -> Preflight {
    let mut checks: Vec<CheckState> = Vec::new();
    let mut findings: Vec<Finding> = Vec::new();

    // 1. Identity disclosure. Reads the pin and the format's rows; proves
    //    exactly the set of fields this build's writer for this format will
    //    emit, and their values. It proves nothing about what the manuscript
    //    body happens to contain.
    let fields: Vec<DisclosedField> = disclosed(subject.format, subject.pin)
        .into_iter()
        .map(|(at, value)| DisclosedField {
            field: fields_for(subject.format)
                .iter()
                .find(|row| row.at == at)
                .map(|row| row.field.id())
                .unwrap_or(at),
            at,
            value: value.to_string(),
        })
        .collect();
    checks.push(CheckState {
        name: CHECK_IDENTITY_DISCLOSURE,
        state: STATE_RAN,
    });

    // The no-pin case. A WARNING, and the export proceeds: every project in
    // every library today is in this state, and a feature whose first act is to
    // break export for all existing work is not a safety feature, it is an
    // outage.
    if subject.pin.is_none() {
        findings.push(Finding {
            kind: FINDING_IDENTITY_UNSET,
            severity: SEVERITY_WARNING,
            surface: "project",
            item_id: None,
            offset: None,
            matched: String::new(),
        });
    }

    // 2. Cross-identity leak. Reads the vault, NOT the pin, so it runs on a
    //    project with no pin -- and with an empty vault it reports that it had
    //    nothing to compare against, which is a different answer from "there is
    //    nothing to find" and must never be spelled the same way.
    let needles = needles(subject.vault, subject.pin);
    let nothing_to_scan = subject.project_name.trim().is_empty()
        && subject.titles.is_empty()
        && subject.bodies.is_empty()
        && subject.planning.is_empty();
    if needles.is_empty() {
        checks.push(CheckState {
            name: CHECK_CROSS_IDENTITY,
            state: STATE_NOT_APPLICABLE,
        });
    } else if nothing_to_scan {
        // Needles and NOTHING TO LOOK IN: an empty project. `ran` here would
        // be the recorded failure mode -- a green row for a check that read
        // nothing -- and 107's sabotage of the caller's prose walk showed
        // this arm reporting `ran` over an empty subject.
        checks.push(CheckState {
            name: CHECK_CROSS_IDENTITY,
            state: STATE_VACUOUS,
        });
    } else {
        checks.push(CheckState {
            name: CHECK_CROSS_IDENTITY,
            state: STATE_RAN,
        });
        // A LITERAL MATCH HAS A LOCATION BY DEFINITION, which is the only
        // reason this check is allowed to block. With no pin it cannot say
        // which identity is this book's, so it cannot honestly call an
        // occurrence another identity's -- it says what it found and warns.
        let severity = if subject.pin.is_some() {
            SEVERITY_BLOCKER
        } else {
            SEVERITY_WARNING
        };
        let kind = if subject.pin.is_some() {
            FINDING_CROSS_IDENTITY
        } else {
            FINDING_CROSS_IDENTITY_UNPINNED
        };
        for needle in &needles {
            let folded = crate::find::fold_with_offsets(needle).0;
            for (offset, matched) in occurrences(subject.project_name, &folded) {
                findings.push(Finding {
                    kind,
                    severity,
                    surface: "project_name",
                    item_id: None,
                    offset: Some(offset),
                    matched,
                });
            }
            for (item_id, title) in subject.titles {
                for (offset, matched) in occurrences(title, &folded) {
                    findings.push(Finding {
                        kind,
                        severity,
                        surface: "item_title",
                        item_id: Some((*item_id).to_string()),
                        offset: Some(offset),
                        matched,
                    });
                }
            }
            for (item_id, prose) in subject.bodies {
                for (offset, matched) in occurrences(prose, &folded) {
                    findings.push(Finding {
                        kind,
                        severity,
                        surface: "document_body",
                        item_id: Some((*item_id).to_string()),
                        offset: Some(offset),
                        matched,
                    });
                }
            }
            for entry in subject.planning {
                for (offset, matched) in occurrences(&entry.text, &folded) {
                    findings.push(Finding {
                        kind,
                        severity,
                        surface: entry.surface,
                        item_id: entry.item_id.clone(),
                        offset: Some(offset),
                        matched,
                    });
                }
            }
        }
    }

    // 3. Missing metadata. No format this build writes requires an identity
    //    field, so the check is VACUOUS and says so rather than painting a
    //    green row a reader would mistake for a verified one.
    checks.push(CheckState {
        name: CHECK_MISSING_METADATA,
        state: STATE_VACUOUS,
    });

    // 4. Broken links. The editor's mark set is `strong`, `em` and `underline`;
    //    there is no link mark, so the only links that exist are the pin's.
    //    NOTHING IS FETCHED: section 13 gives this product zero silent egress,
    //    and a convenience check that made a request would be the first egress
    //    it ever had.
    let links: Vec<&String> = subject
        .pin
        .map(|p| {
            p.public
                .links
                .iter()
                .filter(|l| !l.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();
    if links.is_empty() {
        checks.push(CheckState {
            name: CHECK_BROKEN_LINKS,
            state: STATE_VACUOUS,
        });
    } else {
        checks.push(CheckState {
            name: CHECK_BROKEN_LINKS,
            state: STATE_RAN,
        });
        for link in links {
            if !is_web_url(link) {
                findings.push(Finding {
                    kind: FINDING_LINK_NOT_A_URL,
                    severity: SEVERITY_WARNING,
                    surface: "identity_links",
                    item_id: None,
                    offset: None,
                    matched: link.clone(),
                });
            }
        }
    }

    // 5. Validators. EPUBCheck and Ace are not in this build and no validator
    //    applies to Markdown or to a proof copy. NOT a pass.
    checks.push(CheckState {
        name: CHECK_VALIDATOR,
        state: STATE_NOT_APPLICABLE,
    });

    // 6. Alt text, fonts and images. No asset model exists inside a manuscript;
    //    a cover is checked by its own panel against the page it is printed on,
    //    which is 042's decision and not this one's. Named so the list of
    //    section 12's checks is visibly complete rather than quietly short.
    checks.push(CheckState {
        name: CHECK_ASSETS,
        state: STATE_NOT_APPLICABLE,
    });

    let skipped: Vec<&'static str> = checks
        .iter()
        .filter(|c| c.state != STATE_RAN)
        .map(|c| c.name)
        .collect();
    let blockers = findings
        .iter()
        .filter(|f| f.severity == SEVERITY_BLOCKER)
        .count();

    let mut report = Preflight {
        format: subject.format.id(),
        identity: subject.pin.map(|pin| PinnedIdentity {
            identity_id: pin.identity_id.clone(),
            name: pin.public.name.clone(),
            rev: pin.rev,
            stale: subject
                .vault
                .identities
                .iter()
                .find(|i| i.id == pin.identity_id)
                .is_some_and(|i| i.rev > pin.rev),
        }),
        fields,
        checks,
        skipped,
        findings,
        warning_tokens: Vec::new(),
        reason_history: crate::warning_history::ReasonHistoryView::default(),
        surfaces_checked: SURFACES_CHECKED.to_vec(),
        surfaces_unchecked: SURFACES_UNCHECKED.to_vec(),
        blockers,
    };
    report.warning_tokens = crate::warning_history::current_tokens(&report);
    report
}

/// Whether a link parses as a web URL.
///
/// PARSED AND NEVER FETCHED. It proves the string is shaped like an `http` or
/// `https` address with a host after it; it proves nothing about whether it
/// resolves, whether it is the writer's, or whether it still is.
pub fn is_web_url(raw: &str) -> bool {
    let s = raw.trim();
    let rest = match s.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("http") => rest,
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("https") => rest,
        _ => return false,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty() && !host.contains(' ')
}

/// The one English sentence this slice puts in front of a writer from the HOST,
/// and it is an export failure rather than a report line.
///
/// **THE THIRD ENGLISH FACT THE HOST WRITES, AND IT IS SAID RATHER THAN
/// SLIPPED IN.** 041's contents heading was the first and 043's `dc:language`
/// the second. The report itself carries only machine words and the page words
/// every one of them from the catalog, exactly as `covers.rs` and `covers.ts`
/// divide the work -- but an export that REFUSES has to say why in the surface
/// that shows an error, and that surface takes a string. Every other host
/// refusal in this crate is English for the same reason.
pub fn blocked_message(findings: &[Finding]) -> String {
    let blocking: Vec<&Finding> = findings
        .iter()
        .filter(|f| f.severity == SEVERITY_BLOCKER)
        .collect();
    let first = match blocking.first() {
        Some(f) => f,
        None => return String::new(),
    };
    // THE LOCATION IS THE WHOLE LICENCE TO BLOCK. A check that could only say
    // "something is wrong somewhere" raises a warning; this one names the
    // surface, the item and the byte offset, which is why it is allowed to stop
    // an export at all.
    let where_ = match (&first.item_id, first.offset) {
        (Some(id), Some(offset)) => {
            format!("in the {} of item {id}, at byte {offset}", first.surface)
        }
        (None, Some(offset)) => format!("in the {}, at byte {offset}", first.surface),
        _ => format!("in the {}", first.surface),
    };
    format!(
        "this export was stopped: {} occurs {where_}. \
         That name belongs to another identity in this vault. \
         No occurrence of a known other-identity name may be exported under a \
         different pen name; edit the manuscript at that place, or pin the \
         identity the name belongs to. {} occurrence(s) were found.",
        quoted(&first.matched),
        blocking.len()
    )
}

fn quoted(s: &str) -> String {
    format!("{s:?}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn identity(id: &str, name: &str) -> Identity {
        Identity {
            id: id.to_string(),
            rev: 1,
            public: Public {
                name: name.to_string(),
                ..Public::default()
            },
            ..Identity::default()
        }
    }

    #[test]
    fn aliases_are_trimmed_folded_and_reject_unusable_names() {
        assert_eq!(
            normalize_aliases(vec!["  Anne Grey ".into(), "ANNE GREY".into(), "B. Grey".into()]).unwrap(),
            vec!["Anne Grey", "B. Grey"]
        );
        assert!(normalize_aliases(vec!["A".into()]).is_err());
        assert!(normalize_aliases(vec!["A\nB".into()]).is_err());
        assert!(normalize_aliases(vec!["   ".into()]).is_err());
    }

    #[test]
    fn an_alias_clears_only_its_literal_from_other_identity_needles() {
        let mut mine = identity("i1", "Ada Vane");
        mine.aliases = vec!["Bram Kell".into()];
        let mut other = identity("i2", "Bram Kell");
        other.aliases = vec!["Cal Dorn".into()];
        let vault = Vault { version: VAULT_VERSION, identities: vec![mine.clone(), other] };
        let pin = pin_of(&mine, 10);
        assert_eq!(needles(&vault, Some(&pin)), vec!["Cal Dorn"]);
        let bodies = vec![("s1", "Bram Kell and Cal Dorn".to_string())];
        let report = check(&subject(Some(&pin), &vault, &[], &bodies));
        assert_eq!(report.blockers, 1);
        assert_eq!(report.findings[0].matched, "Cal Dorn");
        assert_eq!(needles(&vault, None), vec!["Ada Vane", "Bram Kell", "Cal Dorn"]);
    }

    #[test]
    fn a_missing_vault_is_an_empty_vault_and_is_not_an_error() {
        // The state of every installation today. A missing file must not be a
        // failure, or the first act of this feature is an outage.
        let dir = tempdir().unwrap();
        assert_eq!(read_vault(dir.path()).unwrap(), Vault::default());
    }

    #[test]
    fn a_vault_that_does_not_parse_is_an_error_and_never_an_empty_vault() {
        // THE LOAD-BEARING TEST OF THIS MODULE. An unparseable vault read as
        // empty makes the cross-identity check report that it found nothing, on
        // the one machine where there was something to find.
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(crate::APP_DIR)).unwrap();
        std::fs::write(vault_path(dir.path()), b"{ not json").unwrap();
        match read_vault(dir.path()) {
            Err(VaultError::Unreadable(detail)) => {
                assert!(detail.contains("identities.json"), "{detail}");
            }
            other => panic!("an unparseable vault must fail loud, got {other:?}"),
        }
    }

    #[test]
    fn a_vault_with_an_unusable_alias_fails_loud() {
        let dir = tempdir().unwrap();
        let mut vault = Vault { version: VAULT_VERSION, identities: vec![identity("i1", "Ada Vane")] };
        vault.identities[0].aliases = vec!["A".into()];
        write_vault(dir.path(), &vault).unwrap();
        assert!(matches!(read_vault(dir.path()), Err(VaultError::Unreadable(_))));
    }

    #[test]
    fn a_vault_survives_a_round_trip_with_every_tier_intact() {
        let dir = tempdir().unwrap();
        let mut vault = Vault {
            version: VAULT_VERSION,
            identities: vec![identity("i1", "Ada Vane")],
        };
        vault.identities[0].publishing.imprint = "Vane Press".into();
        vault.identities[0].aliases = vec!["Anne Grey".into()];
        vault.identities[0].private.legal_name = "Margaret Hollis".into();
        write_vault(dir.path(), &vault).unwrap();
        assert_eq!(read_vault(dir.path()).unwrap(), vault);
    }

    #[cfg(unix)]
    #[test]
    fn vault_writes_are_private_and_leave_existing_temporary_links_untouched() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempdir().unwrap();
        let path = vault_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let other = dir.path().join("other-file");
        std::fs::write(&other, b"keep these bytes").unwrap();
        symlink(&other, path.with_extension("json.tmp")).unwrap();
        write_vault(dir.path(), &Vault::default()).unwrap();
        assert_eq!(std::fs::read(&other).unwrap(), b"keep these bytes");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        write_vault(dir.path(), &Vault::default()).unwrap();
        assert_eq!(std::fs::read(&other).unwrap(), b"keep these bytes");
        assert_eq!(read_vault(dir.path()).unwrap(), Vault::default());
    }

    #[test]
    fn the_pin_has_exactly_these_keys() {
        // THE TRIPWIRE. Salvage has a `meta` SWEEP that copies every row
        // verbatim into `manifest.json`, so whatever a pin holds is serialized
        // into plain text forever with no field-level knowledge of what it is.
        // Adding a field to `Pin` must be a deliberate act with a failing test
        // attached -- and in particular, there is no private tier here to add.
        let pin = pin_of(&identity("i1", "Ada Vane"), 10);
        let value = serde_json::to_value(&pin).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, PIN_KEYS.to_vec());
    }

    #[test]
    fn a_pin_taken_from_an_identity_with_a_legal_name_carries_no_trace_of_it() {
        // The guarantee stated as data rather than as a type argument: the
        // serialized pin of an identity whose private tier is fully populated
        // contains none of it, anywhere, at any depth.
        let mut source = identity("i1", "Ada Vane");
        source.aliases = vec!["Anne Grey".into()];
        source.private = Private {
            legal_name: "Margaret Hollis".into(),
            contact: "margaret@example.invalid".into(),
            admin: "VAT 12345".into(),
        };
        let body = serde_json::to_string(&pin_of(&source, 10)).unwrap();
        for secret in ["Margaret Hollis", "example.invalid", "VAT 12345", "private", "Anne Grey", "aliases"] {
            assert!(!body.contains(secret), "{secret} reached the pin: {body}");
        }
        // A positive control, so this cannot pass against a pin that carries
        // nothing at all.
        assert!(body.contains("Ada Vane"), "{body}");
    }

    #[test]
    fn a_pin_round_trips_through_the_meta_row() {
        let dir = tempdir().unwrap();
        let store = crate::store::Store::open(&dir.path().join("p.db")).unwrap();
        assert_eq!(pin_of_project(&store).unwrap(), None);
        let pin = pin_of(&identity("i1", "Ada Vane"), 99);
        set_pin(&store, Some(&pin)).unwrap();
        assert_eq!(pin_of_project(&store).unwrap(), Some(pin));
        set_pin(&store, None).unwrap();
        assert_eq!(pin_of_project(&store).unwrap(), None);
        // The row is REMOVED and the empty string is never stored:
        // `covers::clear_cover`'s rule, so "nobody pinned" and "the writer
        // unpinned" are one state with one spelling.
        assert_eq!(store.get_meta(PIN_KEY).unwrap(), None);
    }

    #[test]
    fn pin_summary_reads_the_id_and_the_public_name() {
        let pin = pin_of(&identity("i1", "Ada Vane"), 10);
        let raw = serde_json::to_string(&pin).unwrap();
        assert_eq!(pin_summary(&raw), Some(("i1".to_string(), "Ada Vane".to_string())));
    }

    #[test]
    fn pin_summary_of_a_damaged_row_is_none_rather_than_a_panic() {
        // 040's per-key rule: a book with a corrupt pin row must still list,
        // with no byline rather than a failed overview.
        assert_eq!(pin_summary("{{{"), None);
        assert_eq!(pin_summary(""), None);
    }

    #[test]
    fn a_new_id_is_free_even_when_the_vault_has_holes_in_it() {
        // Removing an identity leaves a gap, and a counter that only counted
        // would hand the next new one an id a project may still be pinned to --
        // which would silently make an old book claim the new name.
        let vault = Vault {
            version: VAULT_VERSION,
            identities: vec![identity("i2", "B"), identity("i3", "C")],
        };
        assert_eq!(new_id(&vault), "i4");
        assert_eq!(new_id(&Vault::default()), "i1");
    }

    #[test]
    fn editing_the_vault_does_not_touch_any_projects_pin() {
        // THE TWO HALVES ARE DELIBERATELY NOT KEPT IN SYNC, and that is the
        // feature rather than a limitation. An old book keeps an old biography
        // until somebody says otherwise; the alternative rewrites the front
        // matter of a book already on a retailer's shelf, from a text field
        // edit, with no prompt.
        let dir = tempdir().unwrap();
        let store = crate::store::Store::open(&dir.path().join("p.db")).unwrap();
        let mut source = identity("i1", "Ada Vane");
        set_pin(&store, Some(&pin_of(&source, 10))).unwrap();
        source.rev = 2;
        source.public.name = "Ada Vane-Hollis".into();
        write_vault(
            dir.path(),
            &Vault {
                version: VAULT_VERSION,
                identities: vec![source],
            },
        )
        .unwrap();
        let pin = pin_of_project(&store).unwrap().unwrap();
        assert_eq!(pin.public.name, "Ada Vane");
        assert_eq!(pin.rev, 1);
    }

    // ------------------------------------------------------- the field map

    #[test]
    fn markdown_writes_no_identity_field_and_that_is_the_answer() {
        // `export::manuscript` emits `# <project name>`, one heading per walked
        // item and its prose. There is no front matter and no byline, so
        // disclosure honestly reports "none" -- which tells a writer that the
        // byline they believe they are exporting is not in the file.
        let pin = full_pin();
        assert!(disclosed(crate::export::Format::Markdown, Some(&pin)).is_empty());
        assert!(fields_for(crate::export::Format::Markdown).is_empty());
    }

    #[test]
    fn docx_writes_no_identity_field_and_that_is_the_answer() {
        // 092: `docx::render` writes no `docProps/` at all, so there is
        // nowhere in the package a byline could go -- the same honest "none"
        // Markdown's table states.
        let pin = full_pin();
        assert!(disclosed(crate::export::Format::Docx, Some(&pin)).is_empty());
        assert!(fields_for(crate::export::Format::Docx).is_empty());
    }

    #[test]
    fn a_full_pin_discloses_every_row_the_epub_table_names() {
        let pin = full_pin();
        let rows = disclosed(crate::export::Format::Epub, Some(&pin));
        let places: Vec<&str> = rows.iter().map(|(at, _)| *at).collect();
        assert_eq!(
            places,
            vec!["dc:creator", "file-as", "dc:publisher", "dc:rights"]
        );
        assert_eq!(rows[0].1, "Ada Vane");
        assert_eq!(rows[1].1, "Vane, Ada");
    }

    #[test]
    fn a_refinement_is_not_disclosed_without_the_field_it_refines() {
        // `file-as` refines `dc:creator` BY ID. Emitted without one it points at
        // nothing -- and if the WRITER dropped it while the CHECK went on
        // printing it, the two would be separate lists and the check would be
        // theatre. The dependency is in the table so both obey it.
        let mut pin = full_pin();
        pin.public.name = String::new();
        let places: Vec<&str> = disclosed(crate::export::Format::Epub, Some(&pin))
            .iter()
            .map(|(at, _)| *at)
            .collect();
        assert_eq!(places, vec!["dc:publisher", "dc:rights"]);
    }

    #[test]
    fn an_empty_field_is_not_disclosed_and_a_whitespace_one_is_empty() {
        let mut pin = full_pin();
        pin.publishing.rights = "   ".into();
        pin.publishing.imprint = String::new();
        let places: Vec<&str> = disclosed(crate::export::Format::Epub, Some(&pin))
            .iter()
            .map(|(at, _)| *at)
            .collect();
        assert_eq!(places, vec!["dc:creator", "file-as"]);
    }

    #[test]
    fn a_pdf_discloses_the_byline_and_nothing_else() {
        // Measured, not assumed: WebKitGTK's printer writes `/Title` and
        // `/Producer` into a PDF and no author field at all, so ink on the title
        // page is the only identity channel a proof copy has.
        let pin = full_pin();
        let rows = disclosed(crate::export::Format::Pdf, Some(&pin));
        assert_eq!(rows, vec![("title-page", "Ada Vane")]);
        assert_eq!(
            emitted(crate::export::Format::Pdf, Some(&pin), "title-page"),
            Some("Ada Vane")
        );
        assert_eq!(
            emitted(crate::export::Format::Pdf, None, "title-page"),
            None
        );
    }

    // -------------------------------------------------------- the preflight

    fn full_pin() -> Pin {
        let mut source = identity("i1", "Ada Vane");
        source.public.sort_name = "Vane, Ada".into();
        source.public.links = vec!["https://example.invalid/ada".into()];
        source.publishing.imprint = "Vane Press".into();
        source.publishing.rights = "(c) Ada Vane".into();
        source.private.legal_name = "Margaret Hollis".into();
        pin_of(&source, 10)
    }

    fn subject<'a>(
        pin: Option<&'a Pin>,
        vault: &'a Vault,
        titles: &'a [(&'a str, &'a str)],
        bodies: &'a [(&'a str, String)],
    ) -> Subject<'a> {
        Subject {
            format: crate::export::Format::Markdown,
            project_name: "The Harbour",
            titles,
            bodies,
            planning: &[],
            pin,
            vault,
        }
    }

    #[test]
    fn preflight_names_revision_text_and_its_location() {
        let vault = Vault {
            version: VAULT_VERSION,
            identities: vec![identity("i1", "Ada Vane"), identity("i2", "Bram Kell")],
        };
        let pin = full_pin();
        let planning = [
            PlanningText { surface: "revision_pass_name", item_id: None, text: "Bram Kell pass".into() },
            PlanningText { surface: "revision_pass_purpose", item_id: None, text: "Ask Bram Kell".into() },
            PlanningText { surface: "revision_task_body", item_id: Some("scene-1".into()), text: "Remove Bram Kell".into() },
        ];
        let mut input = subject(Some(&pin), &vault, &[], &[]);
        input.planning = &planning;
        let report = check(&input);
        let surfaces: Vec<_> = report.findings.iter().map(|f| f.surface).collect();
        assert!(surfaces.contains(&"revision_pass_name"));
        assert!(surfaces.contains(&"revision_pass_purpose"));
        assert!(surfaces.contains(&"revision_task_body"));
        assert!(report.findings.iter().any(|f| f.surface == "revision_task_body" && f.item_id.as_deref() == Some("scene-1")));
    }

    #[test]
    fn with_nothing_pinned_the_export_proceeds_with_exactly_one_warning() {
        // Every project in every library today is in this state. A feature whose
        // first act is to break export for all existing work is not a safety
        // feature, it is an outage -- so this warns, and it does warn: a byline
        // a writer never sees the absence of is worse than one they see flagged.
        let vault = Vault::default();
        let report = check(&subject(None, &vault, &[], &[]));
        assert_eq!(report.blockers, 0);
        assert_eq!(report.findings.len(), 1);
        assert_eq!(report.findings[0].kind, FINDING_IDENTITY_UNSET);
        assert_eq!(report.findings[0].severity, SEVERITY_WARNING);
        assert!(report.identity.is_none());
    }

    #[test]
    fn a_pinned_book_raises_no_identity_unset_warning() {
        // The control for the test above: it must be about the PIN and not a
        // warning this build raises unconditionally.
        let vault = Vault::default();
        let pin = full_pin();
        let report = check(&subject(Some(&pin), &vault, &[], &[]));
        assert!(!report
            .findings
            .iter()
            .any(|f| f.kind == FINDING_IDENTITY_UNSET));
        assert_eq!(report.identity.unwrap().name, "Ada Vane");
    }

    #[test]
    fn an_empty_vault_makes_the_cross_identity_check_not_applicable_and_never_a_pass() {
        // "I had nothing to compare against" and "there is nothing to find" are
        // different answers and must never be spelled the same way.
        let vault = Vault::default();
        let pin = full_pin();
        let report = check(&subject(Some(&pin), &vault, &[], &[]));
        let state = report
            .checks
            .iter()
            .find(|c| c.name == CHECK_CROSS_IDENTITY)
            .unwrap();
        assert_eq!(state.state, STATE_NOT_APPLICABLE);
        assert!(report.skipped.contains(&CHECK_CROSS_IDENTITY));
    }

    #[test]
    fn needles_over_an_empty_subject_make_the_cross_identity_check_vacuous_not_ran() {
        // A vault with something to look for and a project with nothing to
        // look in: the check read nothing, and must not say it ran.
        let vault = Vault {
            version: VAULT_VERSION,
            identities: vec![identity("i1", "Ada Vane"), identity("i2", "Bram Kell")],
        };
        let pin = full_pin();
        let empty = Subject {
            format: crate::export::Format::Markdown,
            project_name: "",
            titles: &[],
            bodies: &[],
            planning: &[],
            pin: Some(&pin),
            vault: &vault,
        };
        let report = check(&empty);
        let state = report
            .checks
            .iter()
            .find(|c| c.name == CHECK_CROSS_IDENTITY)
            .unwrap();
        assert_eq!(state.state, STATE_VACUOUS);
        assert!(report.skipped.contains(&CHECK_CROSS_IDENTITY));
        assert_eq!(report.blockers, 0);
        // The same vault over a subject with only a project name is a scan.
        let named = Subject {
            project_name: "The Harbour",
            ..empty
        };
        let ran = check(&named)
            .checks
            .into_iter()
            .find(|c| c.name == CHECK_CROSS_IDENTITY)
            .unwrap();
        assert_eq!(ran.state, STATE_RAN);
    }

    #[test]
    fn a_known_other_identity_name_in_the_prose_blocks_and_names_where_it_is() {
        // A LITERAL MATCH HAS A LOCATION BY DEFINITION, which is the only reason
        // this check is allowed to block at all.
        let vault = Vault {
            version: VAULT_VERSION,
            identities: vec![identity("i1", "Ada Vane"), identity("i2", "Bram Kell")],
        };
        let pin = full_pin();
        let bodies = vec![("s2", "and then Bram Kell walked in".to_string())];
        let report = check(&subject(Some(&pin), &vault, &[], &bodies));
        assert_eq!(report.blockers, 1);
        let f = &report.findings[0];
        assert_eq!(f.kind, FINDING_CROSS_IDENTITY);
        assert_eq!(f.severity, SEVERITY_BLOCKER);
        assert_eq!(f.surface, "document_body");
        assert_eq!(f.item_id.as_deref(), Some("s2"));
        assert_eq!(f.offset, Some(9));
        assert_eq!(f.matched, "Bram Kell");
    }

    #[test]
    fn the_pinned_identitys_own_name_is_not_a_finding() {
        // The control that makes the test above about OTHER identities rather
        // than about any name in the vault at all.
        let vault = Vault {
            version: VAULT_VERSION,
            identities: vec![identity("i1", "Ada Vane"), identity("i2", "Bram Kell")],
        };
        let pin = full_pin();
        let bodies = vec![("s2", "for Ada Vane, with thanks".to_string())];
        let report = check(&subject(Some(&pin), &vault, &[], &bodies));
        assert_eq!(report.blockers, 0, "{:?}", report.findings);
        assert!(report
            .findings
            .iter()
            .all(|f| f.kind != FINDING_CROSS_IDENTITY));
    }

    #[test]
    fn without_a_pin_a_match_warns_rather_than_blocks_and_says_which_it_is() {
        // With nothing pinned this build cannot say which identity is THIS
        // book's, so it cannot honestly call an occurrence another identity's.
        // It reports what it found, with its location, and does not stop the
        // export.
        let vault = Vault {
            version: VAULT_VERSION,
            identities: vec![identity("i2", "Bram Kell")],
        };
        let bodies = vec![("s2", "Bram Kell".to_string())];
        let report = check(&subject(None, &vault, &[], &bodies));
        assert_eq!(report.blockers, 0);
        let f = report
            .findings
            .iter()
            .find(|f| f.kind == FINDING_CROSS_IDENTITY_UNPINNED)
            .expect("the unpinned kind");
        assert_eq!(f.severity, SEVERITY_WARNING);
        assert_eq!(f.offset, Some(0));
    }

    #[test]
    fn the_match_is_case_folded_and_the_finding_carries_the_writers_own_bytes() {
        // `find::fold_with_offsets`, shared and not restated: a check folding
        // differently from the search reports a match at an offset the writer
        // cannot find, and slicing the original at an offset the folding does
        // not have is a panic that closes the window.
        let vault = Vault {
            version: VAULT_VERSION,
            identities: vec![identity("i2", "bram kell")],
        };
        let pin = full_pin();
        // FOLDING IS NOT LENGTH-PRESERVING, AND THE FIXTURE HAS TO PROVE IT.
        // `\u{e9}` was the first draft and it could not: it folds to itself, so
        // the folded offset and the original offset are the same number and a
        // mutation reporting the folded one SURVIVED. Turkish dotted capital I
        // is `find::fold_with_offsets`' own recorded example -- two bytes that
        // fold to three -- so the two offsets are 5 and 7 and only the mapped
        // one is a valid index into what the writer typed.
        let bodies = vec![("s2", "\u{130}\u{130} BRAM KELL".to_string())];
        let (folded, _) = crate::find::fold_with_offsets(&bodies[0].1);
        assert_ne!(
            folded.find("bram"),
            bodies[0].1.find("BRAM"),
            "the fixture must fold to a DIFFERENT offset or this test is about \
             the fixture"
        );
        let report = check(&subject(Some(&pin), &vault, &[], &bodies));
        assert_eq!(report.findings.len(), 1);
        assert_eq!(report.findings[0].matched, "BRAM KELL");
        assert_eq!(report.findings[0].offset, Some(5));
    }

    #[test]
    fn a_name_in_the_project_name_and_in_a_title_are_separate_findings_by_surface() {
        let vault = Vault {
            version: VAULT_VERSION,
            identities: vec![identity("i2", "Harbour")],
        };
        let pin = full_pin();
        let titles: Vec<(&str, &str)> = vec![("c1", "The Harbour Light")];
        let report = check(&subject(Some(&pin), &vault, &titles, &[]));
        let surfaces: Vec<&str> = report.findings.iter().map(|f| f.surface).collect();
        assert_eq!(surfaces, vec!["project_name", "item_title"]);
        assert_eq!(report.findings[0].item_id, None);
        assert_eq!(report.findings[1].item_id.as_deref(), Some("c1"));
        assert_eq!(report.blockers, 2);
    }

    #[test]
    fn a_one_character_identity_name_is_not_a_needle() {
        // A one-character name matches half a manuscript. Two is the shortest
        // thing a person is called; below it the check would be noise a writer
        // learns to ignore, which is worse than no check at all.
        let vault = Vault {
            version: VAULT_VERSION,
            identities: vec![identity("i2", "K")],
        };
        let pin = full_pin();
        let bodies = vec![("s2", "K walked in and King Kell knocked".to_string())];
        let report = check(&subject(Some(&pin), &vault, &[], &bodies));
        assert_eq!(report.blockers, 0);
        assert!(!has_needles(&vault, Some(&pin)));
    }

    #[test]
    fn a_sort_name_is_a_needle_too() {
        // A catalogue name is as identifying as the printed one, and it is the
        // form that appears in an acknowledgement.
        let mut other = identity("i2", "Bram Kell");
        other.public.sort_name = "Kell, Bram".into();
        let vault = Vault {
            version: VAULT_VERSION,
            identities: vec![other],
        };
        let pin = full_pin();
        let bodies = vec![("s2", "see also Kell, Bram".to_string())];
        let report = check(&subject(Some(&pin), &vault, &[], &bodies));
        assert_eq!(report.blockers, 1);
        assert_eq!(report.findings[0].matched, "Kell, Bram");
    }

    #[test]
    fn every_check_that_did_not_run_is_listed_again_under_skipped() {
        // A preflight that shows six green rows and hides that four of them
        // checked nothing is the recorded failure mode this repository already
        // has a name for.
        let vault = Vault::default();
        let report = check(&subject(None, &vault, &[], &[]));
        let expected: Vec<&str> = report
            .checks
            .iter()
            .filter(|c| c.state != STATE_RAN)
            .map(|c| c.name)
            .collect();
        assert_eq!(report.skipped, expected);
        assert_eq!(
            report.skipped,
            vec![
                CHECK_CROSS_IDENTITY,
                CHECK_MISSING_METADATA,
                CHECK_BROKEN_LINKS,
                CHECK_VALIDATOR,
                CHECK_ASSETS,
            ]
        );
        // And the one that DID run is not in it, or the heading would be a list
        // of every check there is.
        assert!(!report.skipped.contains(&CHECK_IDENTITY_DISCLOSURE));
    }

    #[test]
    fn the_surfaces_it_did_not_read_are_named_rather_than_omitted() {
        let vault = Vault::default();
        let report = check(&subject(None, &vault, &[], &[]));
        assert_eq!(report.surfaces_checked, SURFACES_CHECKED.to_vec());
        assert!(report.surfaces_unchecked.contains(&"comment_body"));
        assert!(report.surfaces_unchecked.contains(&"readable_mirror"));
        // No surface may be in both lists, or the report contradicts itself.
        for surface in &report.surfaces_unchecked {
            assert!(!report.surfaces_checked.contains(surface), "{surface}");
        }
    }

    #[test]
    fn a_link_that_is_not_a_web_address_warns_and_nothing_is_fetched() {
        // Section 13 gives this product zero silent egress. A link is PARSED and
        // never fetched: the check proves the string is shaped like an address,
        // and proves nothing about whether it resolves or whose it is.
        let mut pin = full_pin();
        pin.public.links = vec![
            "https://example.invalid/ada".into(),
            "ada.example.invalid".into(),
            "javascript:alert(1)".into(),
            "http:// spaced.invalid".into(),
            // A SCHEME THAT IS NOT http, WITH A `://` AFTER IT. Without this
            // every bad link above is refused for the ABSENCE of `://` and the
            // scheme clause is never reached -- two rules covering for each
            // other, which is the shape only a mutation finds.
            "ftp://example.invalid/ada".into(),
        ];
        let vault = Vault::default();
        let report = check(&subject(Some(&pin), &vault, &[], &[]));
        let bad: Vec<&str> = report
            .findings
            .iter()
            .filter(|f| f.kind == FINDING_LINK_NOT_A_URL)
            .map(|f| f.matched.as_str())
            .collect();
        assert_eq!(
            bad,
            vec![
                "ada.example.invalid",
                "javascript:alert(1)",
                "http:// spaced.invalid",
                "ftp://example.invalid/ada"
            ]
        );
        assert!(report
            .findings
            .iter()
            .all(|f| f.severity == SEVERITY_WARNING));
        assert_eq!(report.blockers, 0);
    }

    #[test]
    fn a_pin_with_no_links_makes_the_link_check_vacuous_rather_than_green() {
        let mut pin = full_pin();
        pin.public.links.clear();
        let vault = Vault::default();
        let report = check(&subject(Some(&pin), &vault, &[], &[]));
        assert_eq!(
            report
                .checks
                .iter()
                .find(|c| c.name == CHECK_BROKEN_LINKS)
                .unwrap()
                .state,
            STATE_VACUOUS
        );
    }

    #[test]
    fn a_pin_the_vault_has_moved_past_is_reported_stale_and_never_repaired() {
        let mut current = identity("i1", "Ada Vane");
        current.rev = 7;
        let vault = Vault {
            version: VAULT_VERSION,
            identities: vec![current],
        };
        let pin = full_pin();
        assert_eq!(pin.rev, 1);
        let report = check(&subject(Some(&pin), &vault, &[], &[]));
        let stated = report.identity.as_ref().unwrap();
        assert!(stated.stale);
        assert_eq!(
            stated.rev, 1,
            "the report states the PIN's rev, not the vault's"
        );
        // And a pin at the vault's own rev is not stale, or every book would be.
        let fresh = pin_of(&vault.identities[0], 10);
        let report = check(&subject(Some(&fresh), &vault, &[], &[]));
        assert!(!report.identity.as_ref().unwrap().stale);
    }

    #[test]
    fn the_report_states_the_fields_the_format_will_write() {
        let pin = full_pin();
        let vault = Vault::default();
        let mut s = subject(Some(&pin), &vault, &[], &[]);
        s.format = crate::export::Format::Epub;
        let report = check(&s);
        assert_eq!(report.format, "epub");
        let named: Vec<(&str, &str)> = report
            .fields
            .iter()
            .map(|f| (f.field, f.at.as_ref()))
            .collect();
        assert_eq!(
            named,
            vec![
                ("name", "dc:creator"),
                ("sort_name", "file-as"),
                ("imprint", "dc:publisher"),
                ("rights", "dc:rights"),
            ]
        );
        // The values are the pin's own, so the report says what will actually be
        // in the file rather than which fields exist.
        assert_eq!(report.fields[0].value, "Ada Vane");
    }

    #[test]
    fn the_blocked_sentence_names_the_match_and_where_it_is() {
        // The one English sentence this slice puts in front of a writer from the
        // host, and it must carry the location or the blocker is a trap.
        let findings = vec![Finding {
            kind: FINDING_CROSS_IDENTITY,
            severity: SEVERITY_BLOCKER,
            surface: "document_body",
            item_id: Some("s2".into()),
            offset: Some(9),
            matched: "Bram Kell".into(),
        }];
        let message = blocked_message(&findings);
        assert!(message.contains("Bram Kell"), "{message}");
        assert!(message.contains("document_body"), "{message}");
        assert!(message.contains("s2"), "{message}");
        assert!(message.contains("byte 9"), "{message}");
        // AND IT NEVER SAYS "no leaks", in either direction. The sentence the
        // design fixes is about occurrences of a known name, never about leaks.
        assert!(!message.to_lowercase().contains("leak"), "{message}");
    }

    #[test]
    fn a_pin_this_build_cannot_read_costs_the_byline_and_nothing_else() {
        // 040's per-key leniency, met in `meta` again. A corrupt pin must not
        // take the design, the covers or the daily goal down with it, and must
        // not refuse the export.
        let dir = tempdir().unwrap();
        let store = crate::store::Store::open(&dir.path().join("p.db")).unwrap();
        store.set_meta(PIN_KEY, "{{{").unwrap();
        store
            .set_meta(crate::design::FONT_KEY, "EB Garamond")
            .unwrap();
        assert_eq!(pin_of_project(&store).unwrap(), None);
        assert_eq!(
            crate::design::design_of(&store).unwrap().font,
            "EB Garamond"
        );
    }
}
