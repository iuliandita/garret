// app/shell-tauri/src-tauri/src/cli.rs
// The noninteractive CLI: inspect, search, validate, export, history.
//
// SUBCOMMANDS ON THE EXISTING BINARY, not a second crate. `--seed` already set
// that precedent -- the host does non-window work when asked -- and a second
// crate would need the store extracted to a library, which is a restructure of
// every module path here for no capability this route does not give.
//
// NOTHING BELOW TOUCHES GTK. `main()` dispatches here BEFORE `tauri::Builder`,
// so every subcommand runs where there is no display, which is the whole point
// of having them.
//
// EVERY READ OPENS READ-ONLY. `Store::open` creates schema v1 on a blank file
// and MIGRATES an older one, so a CLI that inspected a project through it would
// silently upgrade a v1 file and close it to the build the writer is running --
// the recorded `projects::list` defect with a bigger blast radius. Every path
// into this module goes through `Store::open_readonly`, which does not migrate,
// or through `readonly_conn` below, which carries the same flag. A project too
// old or too new to read is REPORTED, never upgraded. An explicit `--migrate`
// is a separate writing subcommand if it is ever wanted; it is not here.
//
// THIS MODULE'S OUTPUT IS ENGLISH AND STAYS ENGLISH. The host has a
// catalog now and the words it writes into a WRITER'S FILE come from it; what
// is printed here is not one of those. Three reasons, and they are per-surface
// rather than a blanket:
//
//   - `--json` is a MACHINE CONTRACT. `inspect_json_keys`, `validate_json_keys`
//     and `salvage_json_keys` fail on a rename, four slices grew the last of
//     them deliberately with a failing test, and `Finding.kind` and
//     `salvage::Loss.kind` are stable tokens beside the sentences that explain
//     them. A key or a token that moved with a preference file would not be a
//     contract.
//   - THE HUMAN REPORT IS PARSED TOO. `salvage-read.ts` reads `salvage_report`
//     line by line and the graded rig grades what it finds, so those labels are
//     a second contract wearing prose. A report that read differently on two
//     machines would make the same command unparseable on one of them.
//   - The one part of it a person reads for MEANING rather than for a label is
//     a loss `detail`, which is most often a `rusqlite` or `io::Error` message
//     this crate did not write and cannot translate. Keying the half sentence
//     around it would produce a half-translated sentence, which is worse than
//     an English one.
//
// The recovery DIRECTORY is the opposite case and is localized: those files
// belong to the writer, not to whoever typed the command. `salvage` is where
// the line is drawn, and it is drawn in one place.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::export;
use crate::find;
use crate::projects;
use crate::salvage;
use crate::store;
use crate::validation::readonly_conn;
pub use crate::validation::{validate, Finding, Validation};
#[cfg(test)]
use crate::validation::{
    KIND_ORPHAN_APPEARANCE, KIND_ORPHAN_CAST_ALIAS, KIND_ORPHAN_CAST_FIELD, KIND_ORPHAN_DOC,
    KIND_ORPHAN_SYNOPSIS, KIND_MISSING_BLOB, KIND_STRUCTURE, KIND_UNREADABLE_BODY,
};

/// The command answered.
pub const EXIT_OK: i32 = 0;
/// Usage: an argument this build does not understand.
pub const EXIT_USAGE: i32 = 1;
/// The project could not be opened or read.
pub const EXIT_UNREADABLE: i32 = 2;
/// The command answered and the ANSWER is a failure: `validate` found a
/// problem, `search` found nothing.
///
/// SEPARATE FROM `EXIT_UNREADABLE` ON PURPOSE. "I could not look" and "I looked
/// and it is wrong" are different facts, and a script that conflates them
/// retries the wrong one -- reopening a file that is fine, or giving up on one
/// that is not.
pub const EXIT_ANSWER_IS_FAILURE: i32 = 3;

/// The names `main()` hands to this module. Anything else falls through to the
/// window, which is what makes "the window opens only when no subcommand is
/// given" one rule rather than two.
pub const SUBCOMMANDS: [&str; 21] = [
    "inspect", "search", "validate", "export", "history", "salvage", "restore", "import",
    "preflight", "keygen", "archive-encrypt", "archive-verify", "archive-restore",
    "archive-stage-list", "archive-stage-clean", "knowledge", "analytics", "mirror-preview",
    "design-export", "design-preview", "design-apply",
];

pub fn is_subcommand(arg: &str) -> bool {
    SUBCOMMANDS.contains(&arg)
}

const USAGE: &str = "\
usage:
  garret inspect   <project.db> [--json]
  garret analytics <project.db> [--json]
  garret search    <project.db> <query> [--limit N] [--json]
  garret validate  <project.db> [--json]
  garret export    <project.db> <dest> [--format markdown|epub|pdf]
                            (pdf is laid out by a web engine and needs a display)
  garret history   <project.db> [--item ID] [--json]
  garret knowledge <project.db> [--json]
  garret salvage   <project.db> <out-dir> [--json]
  garret restore   <point.point|legacy-point.db> <library-dir> [--allow-picture-gaps]
  garret import    <manuscript> <library-dir> [--json]
                            (manuscript is Markdown or DOCX, decided by content)
  garret preflight <project.db> [--json] [--format markdown|epub|pdf|docx]
                            (the export safety check, without writing a file)
  garret keygen <recovery-key.txt>
  garret archive-encrypt <project.db|complete.point> <dest.age> --key <file|->
  garret archive-verify <archive.age> --key <file|->
  garret archive-restore <archive.age> <library-dir> --key <file|->
                            (--key - reads one X25519 identity from non-TTY stdin)
  garret archive-stage-list <parent-dir>
  garret archive-stage-clean <parent-dir> <stage-name>
  garret mirror-preview <project.db> [--json]
                            (read-only disclosure; enabling requires GUI confirmation)
  garret design-export <project.db> <dest.book-design.json>
  garret design-preview <project.db> <design-file|salvage-manifest.json> [--json]
  garret design-apply <project.db> <design-file|salvage-manifest.json> <preview-token> [--json]
                            (close the project in the GUI first; applies only a fresh preview)

exit codes: 0 answered  1 usage  2 could not open/read  3 the answer is a failure";


fn count_of(conn: &rusqlite::Connection, sql: &str) -> Result<u64, String> {
    conn.query_row(sql, [], |r| r.get::<_, i64>(0))
        .map(|n| n as u64)
        .map_err(|e| e.to_string())
}

/// The project's name, by the rule `projects::summarize` already uses: the meta
/// row, falling back to the file stem when there is none. Restated rather than
/// reused because `summarize` answers about a library entry and returns a
/// `ProjectSummary` with an mtime and an error field, none of which a CLI
/// reading one named path has any use for.
fn project_name(store: &store::Store, path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    match store.get_meta(projects::NAME_KEY) {
        Ok(Some(n)) if !n.is_empty() => n,
        _ => stem,
    }
}

// ---------------------------------------------------------------- inspect

#[derive(Debug, Serialize)]
pub struct KnowledgeRead {
    pub resources: Vec<crate::store::knowledge::Resource>,
    pub links: Vec<crate::store::knowledge::Link>,
    pub watchlist: Vec<crate::store::watchlist::Term>,
    pub missing_originals: Vec<String>,
}

pub fn knowledge(path: &Path) -> Result<KnowledgeRead, String> {
    let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
    let version = store.user_version().map_err(|e| e.to_string())?;
    if version < 16 {
        return Ok(KnowledgeRead { resources: Vec::new(), links: Vec::new(), watchlist: Vec::new(), missing_originals: Vec::new() });
    }
    let resources = store.research_resources()?;
    let links = store.knowledge_links(None, true)?;
    let watchlist = store.craft_watchlist()?;
    let mut missing_originals = Vec::new();
    for resource in &resources {
        if crate::research::verify_original(path, &resource.sha256, resource.bytes).is_err() {
            missing_originals.push(resource.title.clone());
        }
    }
    Ok(KnowledgeRead { resources, links, watchlist, missing_originals })
}

fn print_knowledge(value: &KnowledgeRead) {
    println!("research   {} retained file(s), {} missing or changed original(s)", value.resources.len(), value.missing_originals.len());
    println!("links      {} retained relationship(s)", value.links.len());
    println!("watchlist  {} term(s)", value.watchlist.len());
    for title in &value.missing_originals { println!("unavailable {title}"); }
}

/// What `inspect` answers. The field names ARE the JSON keys and they are the
/// contract: `inspect_json_keys` fails on a rename, so a script reading this
/// breaks a test here rather than in production.
#[derive(Debug, Serialize)]
pub struct Inspection {
    pub path: String,
    pub schema_version: i64,
    pub book_id: Option<String>,
    pub series: Option<crate::store::series::Group>,
    pub universe: Option<crate::store::series::Group>,
    pub name: String,
    pub items: u64,
    /// Counted from the item ROWS, not from the walk, so the figure is what the
    /// file holds even when the walk cannot reach all of it. BTreeMap so the
    /// order is the type name's and two runs agree.
    pub items_by_type: BTreeMap<String, u64>,
    pub documents: u64,
    /// The manuscript's words: the bin's contents taken out, which is the total
    /// the application shows the writer.
    pub words: u64,
    /// Bodies that are not documents this build can read. Non-zero means `words`
    /// is an undercount and says by how many scenes.
    pub unreadable_documents: u64,
    pub trashed_items: u64,
    /// How many items carry a synopsis. A FILE FACT, like `documents`: a
    /// synopsis is not prose and is not in `words`, and this is the only place
    /// somebody reading a file can find out the table has anything in it.
    /// Guarded on the schema version, so a project written before v6 reports 0
    /// rather than "no such table".
    pub synopses: u64,
    /// How many characters, places and points of interest this project holds,
    /// and how many detail fields across all of them. TWO figures because they
    /// are two tables, and the second one exists for the reason the first does:
    /// a table nothing names is a table nobody can find. Both guarded on the
    /// schema version, so a project written before v7 reports 0 rather than
    /// "no such table".
    pub cast_members: u64,
    /// Retained entries still visible in the active Cast panel.
    pub cast_members_active: u64,
    /// Retained entries hidden from active writing surfaces.
    pub cast_members_deleted: u64,
    pub cast_fields: u64,
    /// How many members name a picture. A FILE FACT, exactly as `documents` and
    /// `cast_members` are, and the number a person checks against what is
    /// actually in `<project>.pictures/` when a face has gone missing.
    pub pictures: u64,
    /// How many of the book's two COVERS this file names: 0, 1 or 2.
    ///
    /// A SECOND FIGURE AND NOT `pictures` WIDENED. The two live in different
    /// places -- a column on `cast_member` and two rows in `meta` -- are lost by
    /// different damage, and mean different things to somebody looking at a
    /// file: three missing photographs is three character sheets to re-illustrate
    /// and a missing cover is the front of the book. What a person checks against
    /// `<project>.pictures/` is the two figures added, and this is the half that
    /// says which is which.
    ///
    /// NO SCHEMA GUARD, unlike every figure above it, and the asymmetry is
    /// exact: `meta` has existed since v1, so there is no version at which
    /// asking a file for its covers asks it about something it has never had.
    pub covers: u64,
    /// How many times a cast member is tagged as appearing on an item -- rows in
    /// the join table, not items and not members. A FILE FACT, exactly as
    /// `documents` and `synopses` are, and the only place somebody reading a
    /// file can find out the table has anything in it at all.
    ///
    /// ONE FIGURE AND NOT TWO, unlike `cast_members`/`cast_fields`: that pair
    /// exists because they are two TABLES, and this is one. Guarded on the
    /// schema version, so a project written before v9 reports 0 rather than "no
    /// such table".
    pub appearances: u64,
    pub snapshots: u64,
    pub versions: u64,
    pub review: crate::review_validation::Counts,
    pub revision_passes: u64,
    pub revision_tasks_open: u64,
    pub revision_tasks_done: u64,
    /// Set when the recursive walk failed -- an orphan, a cycle, or impossible
    /// nesting. `inspect` still ANSWERS: the row counts above are true of the
    /// file either way, and a project whose structure is broken is exactly the
    /// one somebody needs an inspection of. `validate` is what turns this into
    /// an exit code.
    pub structure_error: Option<String>,
}

pub fn inspect(path: &Path) -> Result<Inspection, String> {
    let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
    let schema_version = store.user_version().map_err(|e| e.to_string())?;
    let conn = readonly_conn(path)?;

    let mut items_by_type = BTreeMap::new();
    let mut stmt = conn
        .prepare("SELECT type, count(*) FROM item GROUP BY type")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (kind, n) = row.map_err(|e| e.to_string())?;
        items_by_type.insert(kind, n as u64);
    }
    drop(stmt);

    let words_index = store.word_index().map_err(|e| e.to_string())?;
    // The walk is allowed to fail here. Everything above it is a row count.
    let (trashed, excluded, structure_error) = match store.items() {
        Ok(walk) => (
            store::trashed_ids(&walk).len() as u64,
            store::excluded_from_book(&walk),
            None,
        ),
        Err(e) => (0, Default::default(), Some(e.to_string())),
    };
    // `words` is the MANUSCRIPT's, so the bible comes out of it with the bin.
    // `trashed_items` stays the bin's own count: it names one section and would
    // become unreadable the moment it named two.
    let counted = words_index.count_excluding(&excluded);

    // A v1 file has no history tables at all, so asking for them would report
    // "no such table" as though the project were damaged. It is not: it predates
    // the feature, and reading it must not migrate it.
    let (snapshots, versions) = if schema_version >= 2 {
        (
            count_of(&conn, "SELECT count(*) FROM snapshot")?,
            count_of(&conn, "SELECT count(*) FROM doc_version")?,
        )
    } else {
        (0, 0)
    };
    // Guarded for the same reason: the table arrived at v6, and a file behind
    // that is old rather than damaged.
    let synopses = if schema_version >= 6 {
        count_of(&conn, "SELECT count(*) FROM synopsis")?
    } else {
        0
    };
    // Guarded for the same reason once more: the two tables arrived at v7.
    let (cast_members, cast_fields) = if schema_version >= 7 {
        store.cast_counts().map_err(|e| e.to_string())?
    } else {
        (0, 0)
    };
    let cast_members_deleted = if schema_version >= 14 {
        count_of(&conn, "SELECT count(*) FROM cast_member WHERE deleted_at IS NOT NULL")?
    } else { 0 };
    let cast_members_active = cast_members - cast_members_deleted;
    // And once more for the column that arrived at v8. A SEPARATE guard from
    // the one above, not a widened one: a v7 file has the cast tables and not
    // the column, and one bound reads it wrongly at one end -- 046's rule, which
    // a test pins there and here.
    let pictures = if schema_version >= 8 {
        store.pictures_named().map_err(|e| e.to_string())?
    } else {
        0
    };
    // And once more for the table that arrived at v9. ITS OWN guard, for the
    // reason the one above has its own: a v8 file has the cast and the picture
    // column and not this table, and one widened bound reads it wrongly at one
    // end.
    let appearances = if schema_version >= 9 {
        store.appearance_count().map_err(|e| e.to_string())?
    } else {
        0
    };

    // NO GUARD, deliberately -- see the field. `meta` is v1.
    let covers = crate::covers::covers_named(&store)?;
    let (revision_passes, revision_tasks_open, revision_tasks_done) = if schema_version >= 13 {
        (count_of(&conn, "SELECT count(*) FROM revision_pass")?,
         count_of(&conn, "SELECT count(*) FROM revision_task WHERE done_at IS NULL")?,
         count_of(&conn, "SELECT count(*) FROM revision_task WHERE done_at IS NOT NULL")?)
    } else { (0, 0, 0) };

    let membership = store.membership().map_err(|error| error.to_string())?;
    Ok(Inspection {
        path: path.to_string_lossy().into_owned(),
        schema_version,
        book_id: store.book_id().map_err(|error| error.to_string())?,
        series: membership.series,
        universe: membership.universe,
        name: project_name(&store, path),
        items: items_by_type.values().sum(),
        items_by_type,
        documents: count_of(&conn, "SELECT count(*) FROM doc")?,
        words: counted.words,
        unreadable_documents: counted.skipped,
        trashed_items: trashed,
        synopses,
        cast_members,
        cast_members_active,
        cast_members_deleted,
        cast_fields,
        pictures,
        covers,
        appearances,
        snapshots,
        versions,
        review: crate::review_validation::counts(&conn, schema_version)?,
        revision_passes,
        revision_tasks_open,
        revision_tasks_done,
        structure_error,
    })
}

fn print_inspection(v: &Inspection) {
    println!("project    {}", v.name);
    println!("path       {}", v.path);
    println!("schema     v{}", v.schema_version);
    println!("book id    {}", v.book_id.as_deref().unwrap_or("not assigned (older project)"));
    println!("series     {}", v.series.as_ref().map(|group| group.name.as_str()).unwrap_or("none"));
    println!("universe   {}", v.universe.as_ref().map(|group| group.name.as_str()).unwrap_or("none"));
    let breakdown: Vec<String> = v
        .items_by_type
        .iter()
        .map(|(k, n)| format!("{k} {n}"))
        .collect();
    println!("items      {} ({})", v.items, breakdown.join(", "));
    println!("documents  {}", v.documents);
    if v.unreadable_documents > 0 {
        println!(
            "words      {} ({} unreadable document(s) not counted)",
            v.words, v.unreadable_documents
        );
    } else {
        println!("words      {}", v.words);
    }
    println!("trashed    {}", v.trashed_items);
    println!("synopses   {}", v.synopses);
    println!(
        "cast       {} active, {} retained ({} removed; {} detail field(s))",
        v.cast_members_active, v.cast_members, v.cast_members_deleted, v.cast_fields
    );
    println!("pictures   {}", v.pictures);
    println!("covers     {} of 2", v.covers);
    println!("appears    {}", v.appearances);
    println!("snapshots  {}", v.snapshots);
    println!("versions   {}", v.versions);
    println!("review     {} authors, {} groups, {} hunks, {} messages ({} pending, {} conflicted, {} accepted, {} rejected)",
        v.review.authors, v.review.groups, v.review.hunks, v.review.messages,
        v.review.pending, v.review.conflicted, v.review.accepted, v.review.rejected);
    println!("passes     {}", v.revision_passes);
    println!("tasks      {} open, {} done", v.revision_tasks_open, v.revision_tasks_done);
    if let Some(e) = &v.structure_error {
        println!("structure  {e}");
    }
}

fn print_validation(v: &Validation) {
    if v.ok {
        println!("{}: no problems found", v.path);
        return;
    }
    println!("{}: {} problem(s)", v.path, v.findings.len());
    for f in &v.findings {
        println!("  {:<16} {}", f.kind, f.detail);
    }
}

// ----------------------------------------------------------------- search

fn print_results(r: &find::FindResults, query: &str) {
    if r.total == 0 {
        println!("no matches for {query:?}");
    } else {
        println!(
            "{} item(s) match {query:?}{}",
            r.total,
            if r.truncated {
                format!(", showing {}", r.results.len())
            } else {
                String::new()
            }
        );
        for hit in &r.results {
            println!("  {:<8} {}", hit.kind, hit.title);
            println!("           {}", hit.snippet);
        }
    }
    if r.skipped > 0 {
        println!(
            "{} of {} document(s) could not be read and were not searched",
            r.skipped, r.scanned
        );
    }
}

// ----------------------------------------------------------------- export

/// Export to a path the OPERATOR named.
///
/// THIS DOES NOT REVERSE the earlier "no path argument" DECISION, and a reader will
/// take it for one unless told. That decision refused a destination named by the
/// WEBVIEW: `may_open`/`in_library` exist to stop a page-supplied path reaching
/// outside the library, and a page-named write would have been the first
/// outbound crossing of the same line. An operator typing a path on their own
/// command line is not the page -- they already have the shell, the filesystem
/// and this binary. The native dialogs elsewhere make the identical distinction for the
/// same reason: the human chooses the path, and nothing crosses from the
/// webview.
///
/// `crate::commands::export::export_to` is `Dest::New`, so an existing
/// destination is REFUSED rather than replaced. A shell that wants to
/// overwrite has `rm`; a CLI that silently destroyed a file named by a typo
/// would not.
pub fn export(
    path: &Path,
    dest: &Path,
    format: export::Format,
) -> Result<crate::commands::export::ExportResult, String> {
    let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
    let name = project_name(&store, path);
    drop(store);
    // THE VAULT THE APPLICATION USES, AND THERE IS NO `--vault` FLAG. A path for
    // it would be the same argument `project_export` declined, arriving by a
    // different door. An unreadable one refuses the export here rather than
    // exporting against an empty one.
    let vault = crate::identity::read_vault(&crate::data_home()).map_err(|e| e.to_string())?;
    // THE LANGUAGE THE HOST WRITES IN, from the same `settings.json` the window
    // reads and by the same rule -- there is no `--locale` flag for the vault's
    // recorded reason, and none is needed: a CLI export is the SAME writer's
    // book, run without a window, and it must not come out in a different
    // language from the one the File menu produces.
    let strings = crate::commands::export::strings_for(&crate::data_home());
    // A PROOF IS LAID OUT BY A WEB ENGINE and the other two formats are not, so
    // this is the one subcommand arm that needs a display. It is a SENTENCE and
    // not a crash when there is none -- `render_standalone` says what to set --
    // because "no display" and "your book is broken" are different problems
    // with different owners, which is the same distinction exit codes 2 and 3
    // are for.
    #[cfg(target_os = "linux")]
    if format == export::Format::Pdf {
        let design = {
            let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
            crate::design::design_of(&store)?
        };
        let page = (design.page.width_um, design.page.height_um);
        let scratch = tempfile::Builder::new()
            .prefix("proof")
            .suffix(".pdf")
            .tempfile()
            .map_err(|e| e.to_string())?;
        let scratch_path = scratch.path().to_path_buf();
        return crate::commands::export::export_into_with(
            path,
            &name,
            dest,
            crate::commands::export::Dest::New,
            format,
            &vault,
            strings,
            move |html| {
                let text = String::from_utf8(html).map_err(|e| e.to_string())?;
                let printed = crate::printer::render_standalone(&text, Some(&scratch_path), page)?;
                printed
                    .bytes
                    .ok_or_else(|| "the proof produced no file".to_string())
            },
        );
    }
    crate::commands::export::export_into(
        path,
        &name,
        dest,
        crate::commands::export::Dest::New,
        format,
        &vault,
        strings,
    )
}

// -------------------------------------------------------------- preflight

/// What `preflight` answers, mirroring `Validation`'s shape so the two JSON
/// contracts read alike: `path` first, `ok` last, everything `identity::check`
/// decided in between. NO `overrides` KEY: the override log does not exist
/// (053, structural), and a key that is always `[]` would document a behaviour
/// as available that this build does not have.
#[derive(Debug, Serialize)]
pub struct CliPreflight {
    pub path: String,
    pub format: &'static str,
    pub identity: Option<crate::identity::PinnedIdentity>,
    pub fields: Vec<crate::identity::DisclosedField>,
    pub checks: Vec<crate::identity::CheckState>,
    pub skipped: Vec<&'static str>,
    pub findings: Vec<crate::identity::Finding>,
    pub surfaces_checked: Vec<&'static str>,
    pub surfaces_unchecked: Vec<&'static str>,
    pub blockers: usize,
    pub reason_history: crate::warning_history::ReasonHistoryView,
    pub ok: bool,
}

/// The same check an export would run, without rendering a file.
///
/// `data_home` IS A PARAMETER rather than read from `crate::data_home()` in
/// here, so a test can point it at a tempdir without touching
/// `XDG_DATA_HOME` -- the seam `no test sets that variable` needs. The
/// dispatch arm below is the one caller that hands it the real one.
///
/// AN UNREADABLE VAULT IS AN `Err`, the vault's own rule restated: reading a
/// corrupt vault as empty would make the cross-identity check pass on the one
/// machine where there was something to find.
pub fn preflight_with(
    path: &Path,
    format: export::Format,
    data_home: &Path,
) -> Result<CliPreflight, String> {
    let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
    let name = project_name(&store, path);
    drop(store);
    let vault = crate::identity::read_vault(data_home).map_err(|e| e.to_string())?;
    let report = crate::commands::export::preflight_of(path, &name, format, &vault)?;
    Ok(CliPreflight {
        path: path.to_string_lossy().into_owned(),
        format: report.format,
        identity: report.identity,
        fields: report.fields,
        checks: report.checks,
        skipped: report.skipped,
        findings: report.findings,
        surfaces_checked: report.surfaces_checked,
        surfaces_unchecked: report.surfaces_unchecked,
        blockers: report.blockers,
        reason_history: report.reason_history,
        ok: report.blockers == 0,
    })
}

/// Read-only mirror disclosure. The CLI has no enable arm: a preview from one
/// process cannot authorize a later process after the book or vault changes.
pub fn mirror_preview_with(path: &Path, data_home: &Path, root: Option<&Path>) -> Result<crate::mirror_identity::Preview, String> {
    let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
    let name = project_name(&store, path);
    let book_id = store.book_id().map_err(|e| e.to_string())?
        .ok_or("this project has no stable book identity")?;
    drop(store);
    let settings = projects::read_settings_checked(data_home)?;
    let key = crate::protection::key_for(&settings, &book_id, crate::protection::Surface::Mirror)?;
    let dir = projects::mirror_dir(data_home, root, &key);
    Ok(crate::mirror_identity::capture(path, &book_id, &name, &dir, data_home)?.preview)
}

fn print_mirror_preview(preview: &crate::mirror_identity::Preview) {
    println!("readable folder destination: {}", preview.dir);
    println!("projected Markdown files: {}", preview.files);
    println!("known-name check: {}", preview.check_state);
    println!("book pen-name pin: {}", preview.pin_state);
    for finding in &preview.findings {
        println!("  {:?} in {}", finding.matched, finding.item_id.as_deref().unwrap_or(finding.surface));
    }
    println!("scope: destination, project name, rendered Markdown, wordlist");
    println!("limits: only names and aliases in the private pen-name list; no operating-system or sync history");
    println!("This is a read-only preview. Enable the plaintext folder in the application after reviewing its confirmation.");
}

/// The report a PERSON reads, built as a string rather than printed.
///
/// EXTRACTED so it can be tested, `salvage_report`'s own precedent: the human
/// report is not `--json`'s pinned contract, and nothing in this crate reads
/// `print_*` output back unless it is a string first.
fn preflight_report(v: &CliPreflight) -> String {
    let mut out = String::new();
    match &v.identity {
        Some(id) => {
            let stale = if id.stale { ", stale" } else { "" };
            out.push_str(&format!("pinned to {} (rev {}{stale})\n", id.name, id.rev));
        }
        None => out.push_str("no identity pinned\n"),
    }
    for c in &v.checks {
        out.push_str(&format!("{:<24} {}\n", c.name, c.state));
    }
    let checked = if v.surfaces_checked.is_empty() {
        "(none)".to_owned()
    } else {
        v.surfaces_checked.join(", ")
    };
    out.push_str(&format!(
        "cross-identity scope (known other-identity names only): {checked}\n"
    ));
    let unchecked = if v.surfaces_unchecked.is_empty() {
        "(none)".to_owned()
    } else {
        v.surfaces_unchecked.join(", ")
    };
    out.push_str(&format!("not checked: {unchecked}\n"));
    for f in &v.findings {
        let item = f
            .item_id
            .as_deref()
            .map(|id| format!(" item {id}"))
            .unwrap_or_default();
        // `matched` is empty for a finding that is not about a match
        // (`identity_unset`); a trailing colon with nothing after it read as
        // a truncated line.
        let matched = if f.matched.is_empty() {
            String::new()
        } else {
            format!(": {}", f.matched)
        };
        out.push_str(&format!(
            "{:<8} {} in {}{item}{matched}\n",
            f.severity, f.kind, f.surface
        ));
    }
    match &v.reason_history {
        crate::warning_history::ReasonHistoryView::Available { entries } => {
            for entry in entries {
                out.push_str(&format!(
                    "prior warning reason (historical only): {} in {} for {} at {}: {}\n",
                    entry.check, entry.surface, entry.format, entry.at_ms, entry.reason
                ));
            }
        }
        crate::warning_history::ReasonHistoryView::Unavailable => {
            out.push_str("prior warning reasons unavailable; stored history was preserved\n");
        }
    }
    if v.blockers > 0 {
        out.push_str(&format!("{} blocker(s)\n", v.blockers));
    } else {
        out.push_str("no blockers\n");
    }
    out
}

fn print_preflight(v: &CliPreflight) {
    print!("{}", preflight_report(v));
}

/// The exit code a preflight answers with: a blocker is the answer being a
/// failure (the spec's table, and `validate`'s rule); warnings alone are 0,
/// the load-bearing choice, so a script never learns to ignore the code that
/// carries the one finding about a writer's real name.
fn preflight_exit(v: &CliPreflight) -> i32 {
    if v.blockers > 0 {
        EXIT_ANSWER_IS_FAILURE
    } else {
        EXIT_OK
    }
}

// ------------------------------------------------------------------ import

/// One `import` subcommand answer: where the project landed, what it is
/// called, how many items it holds, and the loss report -- the JSON contract
/// `import_json_keys` pins, on `salvage_json_keys`'s own precedent.
#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub path: String,
    pub name: String,
    pub items: u64,
    pub losses: crate::docx_import::Losses,
}

/// Import `source` into `library`, headlessly. Markdown or DOCX, decided by
/// the file's own content exactly as the window's own import decides it
/// (`crate::import_path`, shared rather than restated) -- so a foreign file
/// can be graded without a window, which is this subcommand's whole point.
///
/// `library` IS THE OPERATOR'S OWN ARGUMENT: this
/// subcommand already takes an explicit destination on the command line, so
/// there is no hidden default here for the resolver to replace. `data_home`
/// is only `import_path`'s registration seam -- so a destination outside the
/// application's library is recorded in `Settings.books` exactly as the
/// window's own import would record it, and is openable from the library
/// screen afterwards.
pub fn import(
    data_home: &Path,
    source: &Path,
    library: &Path,
    strings: &crate::strings::Strings,
) -> Result<ImportResult, String> {
    let outcome = crate::import_path(data_home, library, source, strings)?;
    let store =
        store::Store::open_readonly(Path::new(&outcome.summary.path)).map_err(|e| e.to_string())?;
    let items = store.items().map_err(|e| e.to_string())?.len() as u64;
    Ok(ImportResult {
        path: outcome.summary.path,
        name: outcome.summary.name,
        items,
        losses: outcome.losses,
    })
}

/// One line naming the project, then one line per NON-ZERO loss kind --
/// `salvage_report`'s own shape: zero losses say nothing rather than seven
/// lines of zeros.
fn print_import(r: &ImportResult) {
    println!("imported {} as {:?} ({} item(s))", r.path, r.name, r.items);
    for (label, n) in [
        ("tables", r.losses.tables),
        ("pictures", r.losses.pictures),
        ("notes", r.losses.notes),
        ("comments", r.losses.comments),
        ("links", r.losses.links),
        ("fields", r.losses.fields),
        ("lists", r.losses.lists),
        ("revisions", r.losses.revisions),
    ] {
        if n > 0 {
            println!("  {label:<10} {n}");
        }
    }
}

// ---------------------------------------------------------------- history

#[derive(Debug, Serialize)]
pub struct History {
    pub path: String,
    pub schema_version: i64,
    /// The item asked about, or None when the whole project was.
    pub item: Option<String>,
    pub snapshots: Vec<store::history::SnapshotSummary>,
    /// Populated only when `item` is set. A listing of every version in a long
    /// manuscript is a listing of the whole manuscript's history, which is not
    /// an answer anybody asked for.
    pub versions: Vec<store::history::VersionSummary>,
    /// Every version row in the project, `item` or not.
    pub version_total: u64,
}

pub fn history(path: &Path, item: Option<&str>) -> Result<History, String> {
    let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
    let schema_version = store.user_version().map_err(|e| e.to_string())?;

    // A v1 project predates history entirely. Reporting that honestly, with
    // empty lists, is the answer -- turning it into an error would push a script
    // toward `Store::open`, which is the one thing this whole module exists to
    // avoid.
    if schema_version < 2 {
        return Ok(History {
            path: path.to_string_lossy().into_owned(),
            schema_version,
            item: item.map(str::to_string),
            snapshots: Vec::new(),
            versions: Vec::new(),
            version_total: 0,
        });
    }

    let conn = readonly_conn(path)?;
    let versions = match item {
        Some(id) => store.doc_versions(id).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    Ok(History {
        path: path.to_string_lossy().into_owned(),
        schema_version,
        item: item.map(str::to_string),
        snapshots: store.snapshots().map_err(|e| e.to_string())?,
        versions,
        version_total: count_of(&conn, "SELECT count(*) FROM doc_version")?,
    })
}

fn print_history(h: &History) {
    if h.schema_version < 2 {
        println!("{}: schema v1 predates version history", h.path);
        return;
    }
    println!("snapshots  {}", h.snapshots.len());
    for s in &h.snapshots {
        println!(
            "  #{:<5} {:<24} {} document(s)  {}",
            s.id, s.label, s.documents, s.created_at
        );
    }
    match &h.item {
        None => println!(
            "versions   {} (pass --item ID to list them)",
            h.version_total
        ),
        Some(id) => {
            println!("versions   {} of {}", h.versions.len(), h.version_total);
            for v in &h.versions {
                println!(
                    "  #{:<5} {:<12} {} word(s)  {}",
                    v.id,
                    v.snapshot_label.as_deref().unwrap_or("auto"),
                    v.words,
                    v.created_at
                );
            }
            if h.versions.is_empty() {
                println!("  (no versions recorded for {id})");
            }
        }
    }
}

// ---------------------------------------------------------------- salvage

/// The salvage report a PERSON reads, built as a string rather than printed.
///
/// EXTRACTED so it can be tested. Two lines were added here and a mutation
/// that made one of them lie survived the whole suite, because nothing in this
/// crate had ever read `print_*` output back -- the recorded "new logic that
/// needs coverage must be extracted, not tested in place" shape, in the one
/// place where a script's contract (`--json`, pinned by a key test) is NOT what
/// the operator is looking at. The lines are byte-for-byte what `print_salvage`
/// printed before the extraction.
fn salvage_report(v: &salvage::Salvage, out_dir: &Path) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "source     {} ({} byte(s))\n",
        v.source, v.source_bytes
    ));
    if !v.sidecars.is_empty() {
        out.push_str(&format!("sidecars   {}\n", v.sidecars.join(", ")));
    }
    // THE PATH THE OPERATOR TYPED, and NOT `v.out_dir`, which is the directory's
    // own name. The terminal belongs to the person who ran the
    // command, who needs to be told where to look; the manifest is the artifact
    // that travels, and it names files. Two readers, two answers.
    out.push_str(&format!("out        {}\n", out_dir.display()));
    match v.schema_version {
        Some(n) => out.push_str(&format!("schema     v{n}\n")),
        None => out.push_str("schema     unreadable\n"),
    }
    out.push_str(&format!("project    {}\n", v.name));
    out.push_str(&format!("items      {}\n", v.items_recovered));
    out.push_str(&format!("documents  {}\n", v.documents_recovered));
    out.push_str(&format!("words      {}\n", v.words));
    // Printed even at zero, unlike `raw` and `renamed` below. A writer looking
    // for their character sheets needs to be told there were none in the file
    // rather than left to read an absent line as an absent feature -- and a file
    // older than schema 6 or 7 reads zero here, which is the honest answer.
    out.push_str(&format!(
        "synopses   {}{}\n",
        v.synopses_recovered,
        v.synopses
            .as_deref()
            .map(|f| format!(" ({f})"))
            .unwrap_or_default()
    ));
    out.push_str(&format!(
        "cast       {} member(s), {} detail(s), {} alias(es){}\n",
        v.cast_members_recovered,
        v.cast_fields_recovered,
        v.cast_aliases_recovered,
        v.cast
            .as_deref()
            .map(|f| format!(" ({f})"))
            .unwrap_or_default()
    ));
    // The tags, at zero on the same rule. ONE FIGURE AND NOT TWO, which is
    // `cli::inspect`'s choice for this table: the pair above is two figures
    // because it is two TABLES.
    out.push_str(&format!("appears    {} tag(s)\n", v.appearances_recovered));
    // THE WRITER'S OWN NOTES, at zero on the same rule, and with the orphaned
    // figure beside the total because that is the one thing a person needs to
    // know about a recovered set of notes: how many of them can no longer say
    // which passage they were about. `cast`'s two-figure shape, for a different
    // reason -- these are one table, and the second figure is a STATE within it.
    out.push_str(&format!(
        "comments   {} note(s), {} orphaned{}\n",
        v.comments_recovered,
        v.comments_orphaned,
        v.comments
            .as_deref()
            .map(|f| format!(" ({f})"))
            .unwrap_or_default()
    ));
    // And the spelling list, at zero again: a writer who taught this book two
    // hundred invented names must be told whether they came back.
    out.push_str(&format!(
        "wordlist   {} word(s){}\n",
        v.wordlist_recovered,
        v.wordlist
            .as_deref()
            .map(|f| format!(" ({f})"))
            .unwrap_or_default()
    ));
    // THE VERSION HISTORY, at zero on the same rule, and in TWO lines because
    // they say two different things. The first is what came back; the second is
    // what this recovery CHOSE not to bring back, which is the whole of that
    // decision and the one figure a writer cannot get anywhere else. A dropped
    // automatic version is not a loss and so appears in no loss list -- if it is
    // not on this line it is nowhere.
    out.push_str(&format!(
        "snapshots  {} named, {} document(s){}\n",
        v.snapshots_recovered,
        v.versions_recovered,
        v.snapshots
            .as_deref()
            .map(|f| format!(" ({f})"))
            .unwrap_or_default()
    ));
    out.push_str(&format!(
        "versions   {} automatic version(s) not recovered\n",
        v.versions_dropped
    ));
    // Printed at zero for `synopses`' reason, one surface further out: a writer
    // looking for their photographs must be told there were none in the file
    // rather than left to read an absent line as an absent feature.
    out.push_str(&format!(
        "pictures   {}{}\n",
        v.pictures_recovered,
        v.pictures
            .as_deref()
            .map(|d| format!(" ({d}/)"))
            .unwrap_or_default()
    ));
    // And the covers, at zero, on the same rule again. Nought of two is the
    // ordinary answer and it is the one a writer needs to see, because a book
    // whose cover is missing from a recovery is a book that has to be redrawn.
    out.push_str(&format!(
        "covers     {} of 2{}\n",
        v.covers_recovered,
        v.covers
            .as_deref()
            .map(|f| format!(" ({f})"))
            .unwrap_or_default()
    ));
    out.push_str(&format!(
        "knowledge  {} link(s), {} resource record(s){}\n",
        v.knowledge_links_recovered,
        v.research_resources_recovered,
        v.knowledge.as_deref().map(|f| format!(" ({f})")).unwrap_or_default()
    ));
    out.push_str(&format!(
        "research   {} original file(s){}\n",
        v.research_originals_recovered,
        v.research.as_deref().map(|d| format!(" ({d}/)")).unwrap_or_default()
    ));
    out.push_str(&format!("review     {} authors, {} groups, {} hunks, {} messages{}\n",
        v.review_recovered.authors, v.review_recovered.groups, v.review_recovered.hunks, v.review_recovered.messages,
        v.review.as_deref().map(|file| format!(" ({file})")).unwrap_or_default()));
    // THE DESIGN, WHICH IS THE ONE FIGURE THAT IS NOT A COUNT OF THE WRITER'S
    // WORDS. Printed at zero, and printed as its `meta` KEYS and their values
    // verbatim: this is the one part of a recovery a person retypes rather than
    // reads, so the useful thing to put in front of them is the values.
    match &v.design {
        // `null` here means the `meta` table could not be read, and the loss
        // list says so. It is the one None in the manifest that can mean "I
        // could not look", which is why the word is not "0 of 5".
        None => out.push_str("design     unreadable\n"),
        Some(design) => {
            let rows = design.rows();
            out.push_str(&format!(
                "design     {} of {} recorded\n",
                rows.len(),
                salvage::DESIGN_ROWS
            ));
            for (key, value) in rows {
                out.push_str(&format!("  {key:<20} {value}\n"));
            }
        }
    }
    if !v.raw_bodies.is_empty() {
        out.push_str(&format!(
            "raw        {} body(ies) written verbatim, unreadable as documents\n",
            v.raw_bodies.len()
        ));
    }
    match (&v.manuscript, &v.manuscript_omitted) {
        (Some(f), _) => out.push_str(&format!("manuscript {f}\n")),
        (None, Some(why)) => out.push_str(&format!("manuscript omitted: {why}\n")),
        (None, None) => {}
    }
    if !v.renamed.is_empty() {
        out.push_str(&format!(
            "renamed    {} document(s) written under a name other than <id>.md \
             (the manifest maps them)\n",
            v.renamed.len()
        ));
    }
    if v.losses.is_empty() {
        out.push_str("losses     none\n");
    } else {
        out.push_str(&format!("losses     {}\n", v.losses.len()));
        for l in &v.losses {
            out.push_str(&format!("  {:<20} {}\n", l.kind, l.detail));
        }
    }
    out.push_str(&format!(
        "manifest   {}/{}\n",
        out_dir.display(),
        salvage::MANIFEST_NAME
    ));
    out
}

fn print_salvage(v: &salvage::Salvage, out_dir: &Path) {
    print!("{}", salvage_report(v, out_dir));
}

// ---------------------------------------------------------------- dispatch

/// Parsed flags. Kept separate from the subcommands so an unknown flag is one
/// refusal rather than five.
struct Options {
    json: bool,
    allow_picture_gaps: bool,
    limit: usize,
    item: Option<String>,
    key: Option<String>,
    /// Which file `export` writes.
    ///
    /// A FLAG AND NOT THE DESTINATION'S EXTENSION. Deriving it from the name
    /// the operator typed would make `book.epub.bak` a Markdown file and
    /// `notes.md` written by `--format epub` impossible to ask for; and the
    /// application's own answer to what it wrote is `Format::id`, which is
    /// what this parses into.
    format: export::Format,
    positional: Vec<String>,
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut out = Options {
        json: false,
        allow_picture_gaps: false,
        limit: find::DEFAULT_LIMIT,
        item: None,
        key: None,
        format: export::Format::Markdown,
        positional: Vec::new(),
    };
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => out.json = true,
            "--allow-picture-gaps" => out.allow_picture_gaps = true,
            "--limit" => {
                let raw = args.get(i + 1).ok_or("--limit needs a number")?;
                // A limit of 0 is refused rather than honoured: it would return
                // nothing from a search that matched, which reads as "no
                // matches" and is the one answer a search must not fake.
                let n: usize = raw
                    .parse()
                    .map_err(|_| format!("--limit {raw:?} is not a number"))?;
                if n == 0 {
                    return Err("--limit must be at least 1".into());
                }
                out.limit = n;
                i += 1;
            }
            "--format" => {
                let raw = args.get(i + 1).ok_or("--format needs a format")?;
                out.format = export::Format::from_id(raw)
                    .ok_or_else(|| format!("--format {raw:?} is not a format this build writes"))?;
                i += 1;
            }
            "--item" => {
                out.item = Some(args.get(i + 1).ok_or("--item needs an item id")?.clone());
                i += 1;
            }
            "--key" => {
                out.key = Some(args.get(i + 1).ok_or("--key needs a file or -")?.clone());
                i += 1;
            }
            other if other.starts_with("--") => {
                return Err(format!("{other:?} is not an option this build understands"))
            }
            other => out.positional.push(other.to_string()),
        }
        i += 1;
    }
    Ok(out)
}

/// The source project's slug for a point, taken from the directory the point
/// sits in.
///
/// A recovery directory IS `<data_home>/cc.local.app/recovery/<slug>`, so the
/// parent's name is the original project's file stem by construction rather
/// than by convention. A point somewhere else falls back to its own stem, which
/// is the only other thing on hand and still produces a name a person can read.
fn source_slug_of(point: &Path) -> String {
    point
        .parent()
        .and_then(|d| d.file_name())
        .or_else(|| point.file_stem())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "recovered".to_string())
}

fn emit<T: Serialize>(value: &T, json: bool, human: impl FnOnce(&T)) {
    if json {
        match serde_json::to_string_pretty(value) {
            Ok(s) => println!("{s}"),
            // Unreachable for these shapes, and still not an `unwrap`: a panic
            // here would print a backtrace where a script expects JSON.
            Err(e) => eprintln!("could not render JSON: {e}"),
        }
    } else {
        human(value);
    }
}

/// Why a subcommand did not answer. The two map to different exit codes and
/// must not be reconstructed from a message: "I could not look" and "you asked
/// wrongly" are different facts and the string is not a reliable way back to
/// which one happened.
enum Refusal {
    Usage(String),
    Unreadable(String),
}

impl Refusal {
    fn code(&self) -> i32 {
        match self {
            Refusal::Usage(_) => EXIT_USAGE,
            Refusal::Unreadable(_) => EXIT_UNREADABLE,
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::Usage(m) | Refusal::Unreadable(m) => write!(f, "{m}"),
        }
    }
}

/// `argv` WITHOUT the program name: `["inspect", "book.db", "--json"]`.
///
/// Returns the process exit code rather than calling `process::exit`, so every
/// branch of it is reachable from a test.
pub fn run(argv: &[String]) -> i32 {
    match dispatch(argv) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("{e}");
            if matches!(e, Refusal::Usage(_)) {
                eprintln!("\n{USAGE}");
            }
            e.code()
        }
    }
}

fn dispatch(argv: &[String]) -> Result<i32, Refusal> {
    let Some(command) = argv.first() else {
        return Err(Refusal::Usage("no subcommand given".into()));
    };
    let opts = parse(&argv[1..]).map_err(Refusal::Usage)?;
    if opts.allow_picture_gaps && command != "restore" {
        return Err(Refusal::Usage("--allow-picture-gaps applies only to restore".into()));
    }
    if opts.key.is_some() && !matches!(command.as_str(), "archive-encrypt" | "archive-verify" | "archive-restore") {
        return Err(Refusal::Usage("--key applies only to encrypted archive commands".into()));
    }
    let arg = |n: usize| -> Result<&String, Refusal> {
        opts.positional
            .get(n)
            .ok_or_else(|| Refusal::Usage(format!("{command} is missing an argument")))
    };
    // Every subcommand reads a project, so the path is checked once, before any
    // of them opens anything.
    let read = |f: &dyn Fn() -> Result<i32, String>| -> Result<i32, Refusal> {
        f().map_err(Refusal::Unreadable)
    };

    match command.as_str() {
        "design-export" => {
            if opts.positional.len() != 2 { return Err(Refusal::Usage("design-export needs a project and destination".into())); }
            let project = PathBuf::from(arg(0)?);
            let dest = PathBuf::from(arg(1)?);
            read(&|| {
                let store = store::Store::open_readonly(&project).map_err(|e| e.to_string())?;
                crate::design_transfer::export(&store, &dest)?;
                println!("book design saved to {}", dest.display());
                Ok(EXIT_OK)
            })
        }
        "design-preview" => {
            if opts.positional.len() != 2 { return Err(Refusal::Usage("design-preview needs a project and source".into())); }
            let project = PathBuf::from(arg(0)?);
            let source = PathBuf::from(arg(1)?);
            read(&|| {
                let store = store::Store::open_readonly(&project).map_err(|e| e.to_string())?;
                let preview = crate::design_transfer::preview(&store, &project, &source, 0)?;
                if opts.json { println!("{}", serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())?); }
                else {
                    println!("Source: {}. Changes: {}. Skipped: {}.", preview.source, preview.changes.len(), preview.skipped.len());
                    for change in &preview.changes { println!("{}: {:?} -> {:?}", change.field, change.before, change.after); }
                    for skipped in &preview.skipped { println!("Skipped {}: {}", skipped.field, skipped.reason); }
                    println!("{}", preview.note);
                    println!("Preview token: {}", preview.token);
                }
                Ok(EXIT_OK)
            })
        }
        "design-apply" => {
            if opts.positional.len() != 3 { return Err(Refusal::Usage("design-apply needs a project, source and preview token".into())); }
            let project = PathBuf::from(arg(0)?);
            let source = PathBuf::from(arg(1)?);
            let token = arg(2)?;
            read(&|| {
                let preflight = store::Store::open_readonly(&project).map_err(|e| e.to_string())?;
                if preflight.user_version().map_err(|e| e.to_string())? != store::SCHEMA_VERSION {
                    return Err("design-apply requires a current project schema; open it in the application first".into());
                }
                drop(preflight);
                let store = store::Store::open(&project).map_err(|e| e.to_string())?;
                let applied = crate::design_transfer::apply(&store, &project, &source, 0, token)?;
                if opts.json {
                    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                        "applied": true, "changes": applied.changes, "skipped": applied.skipped
                    })).map_err(|e| e.to_string())?);
                } else {
                    println!("Applied {} design changes. {} fields skipped.", applied.changes.len(), applied.skipped.len());
                }
                Ok(EXIT_OK)
            })
        }
        "archive-stage-list" => {
            let parent = PathBuf::from(arg(0)?);
            read(&|| {
                for name in crate::encrypted_archive::list_stages(&parent)? { println!("{name}"); }
                Ok(EXIT_OK)
            })
        }
        "archive-stage-clean" => {
            let parent = PathBuf::from(arg(0)?);
            let name = arg(1)?;
            read(&|| {
                crate::encrypted_archive::cleanup_stage(&parent, name)?;
                println!("cleaned owned encrypted archive stage {name}");
                Ok(EXIT_OK)
            })
        }
        "keygen" => {
            let dest = PathBuf::from(arg(0)?);
            read(&|| {
                let info = crate::encrypted_archive::generate_key(&dest)?;
                println!("recovery key created; public recipient: {}", info.recipient);
                Ok(EXIT_OK)
            })
        }
        "archive-encrypt" => {
            let source = PathBuf::from(arg(0)?);
            let dest = PathBuf::from(arg(1)?);
            let spec = opts.key.as_deref().ok_or_else(|| Refusal::Usage("archive-encrypt needs --key".into()))?;
            let key = if spec == "-" { crate::encrypted_archive::key_from_stdin() } else { crate::encrypted_archive::key_from_path(Path::new(spec)) }
                .map_err(Refusal::Unreadable)?;
            read(&|| {
                let result = if source.is_dir() {
                    crate::encrypted_archive::create_from_bundle(&source, &dest, &key, &crate::data_home())?
                } else {
                    crate::encrypted_archive::create_from_project(&source, &dest, &key, &crate::data_home())?
                };
                println!("encrypted archive written: {} (recipient {})", result.file, result.recipient);
                Ok(EXIT_OK)
            })
        }
        "archive-verify" => {
            let cipher = PathBuf::from(arg(0)?);
            let spec = opts.key.as_deref().ok_or_else(|| Refusal::Usage("archive-verify needs --key".into()))?;
            let key = if spec == "-" { crate::encrypted_archive::key_from_stdin() } else { crate::encrypted_archive::key_from_path(Path::new(spec)) }
                .map_err(Refusal::Unreadable)?;
            read(&|| {
                crate::encrypted_archive::verify(&cipher, &key, &crate::data_home())?;
                println!("encrypted archive verified");
                Ok(EXIT_OK)
            })
        }
        "archive-restore" => {
            let cipher = PathBuf::from(arg(0)?);
            let library = PathBuf::from(arg(1)?);
            let spec = opts.key.as_deref().ok_or_else(|| Refusal::Usage("archive-restore needs --key".into()))?;
            let key = if spec == "-" { crate::encrypted_archive::key_from_stdin() } else { crate::encrypted_archive::key_from_path(Path::new(spec)) }
                .map_err(Refusal::Unreadable)?;
            read(&|| {
                let result = crate::encrypted_archive::restore(&cipher, &key, &library, "recovered", crate::store::now_ms(), &crate::data_home())?;
                println!("restored {} as {:?}", result.path, result.name);
                Ok(EXIT_OK)
            })
        }
        "inspect" => {
            let path = PathBuf::from(arg(0)?);
            read(&|| {
                let v = inspect(&path)?;
                emit(&v, opts.json, print_inspection);
                Ok(EXIT_OK)
            })
        }
        "knowledge" => {
            let path = PathBuf::from(arg(0)?);
            read(&|| {
                let value = knowledge(&path)?;
                emit(&value, opts.json, print_knowledge);
                Ok(EXIT_OK)
            })
        }
        "analytics" => {
            let path = PathBuf::from(arg(0)?);
            read(&|| {
                let store = store::Store::open_readonly(&path).map_err(|error| error.to_string())?;
                let report = store.analytics_report(None).map_err(|error| error.to_string())?;
                if opts.json {
                    println!("{}", serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?);
                } else {
                    println!("Session recording: {}", if report.recording_enabled { "on" } else { "off" });
                    println!("Observed sessions: {}", report.sessions.len());
                    println!("{}", report.coverage_definition);
                    println!("Use --json for observed minutes, movements, corrections and exclusions.");
                }
                Ok(EXIT_OK)
            })
        }
        "validate" => {
            let path = PathBuf::from(arg(0)?);
            read(&|| {
                let v = validate(&path)?;
                let ok = v.ok;
                emit(&v, opts.json, print_validation);
                Ok(if ok { EXIT_OK } else { EXIT_ANSWER_IS_FAILURE })
            })
        }
        "search" => {
            let path = PathBuf::from(arg(0)?);
            let query = arg(1)?.clone();
            read(&|| {
                let r = crate::find_in(&path, &query, opts.limit)?;
                emit(&r, opts.json, |r| print_results(r, &query));
                Ok(if r.total == 0 {
                    EXIT_ANSWER_IS_FAILURE
                } else {
                    EXIT_OK
                })
            })
        }
        "export" => {
            let path = PathBuf::from(arg(0)?);
            let dest = PathBuf::from(arg(1)?);
            // An export that could not WRITE exits 2 as well. The table calls
            // 2 "could not open or read", and stretching it is the honest of
            // the two wrong answers available: there is no answer at all here,
            // so 3 -- which means the answer is a failure -- would be a worse
            // lie, and 1 would tell a script its arguments were wrong when they
            // were fine and the destination was occupied.
            read(&|| {
                let r = export(&path, &dest, opts.format)?;
                // No `--json` on export: its answer is a FILE, and the one line
                // saying where it landed is the same in both shapes.
                println!(
                    "wrote {} as {} ({} item(s), {} word(s))",
                    r.path, r.format, r.items, r.words
                );
                Ok(EXIT_OK)
            })
        }
        "history" => {
            let path = PathBuf::from(arg(0)?);
            read(&|| {
                let h = history(&path, opts.item.as_deref())?;
                emit(&h, opts.json, print_history);
                Ok(EXIT_OK)
            })
        }
        // SALVAGE. Its core returns `salvage::Refusal`, which carries the same
        // two facts this module's does -- "you asked wrongly" and "I could not
        // look" -- so the two map across rather than being reconstructed from a
        // message. The refusal for an output directory that already exists is a
        // USAGE refusal, not an unreadable one: the source was fine and the
        // destination was the operator's mistake.
        //
        // Not routed through `read`, unlike every other subcommand, precisely
        // because it is the one whose refusal is not always exit 2.
        "salvage" => {
            let path = PathBuf::from(arg(0)?);
            let out = PathBuf::from(arg(1)?);
            // THE WRITER'S LANGUAGE FOR THE RECOVERY DIRECTORY, AND ENGLISH
            // FOR THE TERMINAL. `salvage_with` writes files a WRITER opens --
            // their manuscript, their cast, their notes -- so those take the
            // language `settings.json` names, exactly as a File > Export from
            // the window would. The report `print_salvage` prints below is the
            // OPERATOR's, it is parsed by the graded rig, and it does not move:
            // see this module's header.
            let strings = crate::commands::export::strings_for(&crate::data_home());
            let v = salvage::salvage_with(&path, &out, strings).map_err(|e| match e {
                salvage::Refusal::Usage(m) => Refusal::Usage(m),
                salvage::Refusal::Unreadable(m) => Refusal::Unreadable(m),
            })?;
            let complete = v.complete;
            emit(&v, opts.json, |v| print_salvage(v, &out));
            // A salvage that recovered NOTHING is still a successful salvage if
            // it reported honestly. What separates 0 from 3 is whether anything
            // was lost, never how much came out.
            Ok(if complete {
                EXIT_OK
            } else {
                EXIT_ANSWER_IS_FAILURE
            })
        }
        // RESTORE. Routed through `read` like `export`, and for the same
        // reason its comment gives: the failures available here are "the point
        // does not read" and "the library could not be written", and there is
        // no answer at all in either case. 3 means the answer IS a failure and
        // would be a worse lie; 1 would tell a script its arguments were wrong
        // when they were fine.
        //
        // There is NO refusal for an occupied destination, unlike `salvage`.
        // The never-clobber rule advances the ordinal instead, and the only
        // thing refused is writing over a file -- by the kernel, per candidate.
        "restore" => {
            let point = PathBuf::from(arg(0)?);
            let library = PathBuf::from(arg(1)?);
            read(&|| {
                let (summary, gaps) = if opts.allow_picture_gaps {
                    projects::restore_point_with_picture_gaps(
                        &point,
                        &library,
                        &source_slug_of(&point),
                        crate::store::now_ms(),
                    )?
                } else {
                    (projects::restore_point_into(
                        &point,
                        &library,
                        &source_slug_of(&point),
                        crate::store::now_ms(),
                    )?, Vec::new())
                };
                // No `--json`, for `export`'s reason: the answer is a FILE and
                // the one line saying where it landed is the same either way.
                println!("restored {} as {:?}", summary.path, summary.name);
                if !point.is_dir() {
                    eprintln!("This older database-only point did not include original pictures or covers.");
                } else if opts.allow_picture_gaps {
                    eprintln!("Restored with picture gaps: {}. Missing references remain in the project.", gaps.join(", "));
                }
                Ok(EXIT_OK)
            })
        }
        "import" => {
            let source = PathBuf::from(arg(0)?);
            let library = PathBuf::from(arg(1)?);
            read(&|| {
                let data_home = crate::data_home();
                let strings = crate::projects::read_settings(&data_home).locale.strings();
                let r = import(&data_home, &source, &library, &strings)?;
                emit(&r, opts.json, print_import);
                Ok(EXIT_OK)
            })
        }
        // PREFLIGHT. The vault the CLI reads is the same one the application
        // uses, and there is no `--vault` flag -- `preflight_with`'s own
        // reason. A blocker is the answer being a failure, exactly as
        // `validate`'s findings are.
        "preflight" => {
            let path = PathBuf::from(arg(0)?);
            read(&|| {
                let v = preflight_with(&path, opts.format, &crate::data_home())?;
                let code = preflight_exit(&v);
                emit(&v, opts.json, print_preflight);
                Ok(code)
            })
        }
        "mirror-preview" => {
            let path = PathBuf::from(arg(0)?);
            read(&|| {
                let data_home = crate::data_home();
                let root = std::env::var_os("APP_MIRROR_DIR").map(PathBuf::from);
                let preview = mirror_preview_with(&path, &data_home, root.as_deref())?;
                emit(&preview, opts.json, print_mirror_preview);
                Ok(EXIT_OK)
            })
        }
        other => Err(Refusal::Usage(format!("{other:?} is not a subcommand"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{FlushEntry, Store};
    use tempfile::tempdir;

    fn import(data_home: &Path, source: &Path, library: &Path) -> Result<ImportResult, String> {
        super::import(data_home, source, library, &crate::strings::Strings::english())
    }

    /// A body of `text` as one paragraph, which is what a flush carries.
    fn body(text: &str) -> String {
        format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[
                 {{"type":"text","text":"{text}"}}]}}]}}"#
        )
    }

    /// A small project: one part holding two scenes, both with prose, plus the
    /// name the meta table carries.
    ///
    /// Built through `Store::open`, deliberately -- the fixture is the one place
    /// in this module that is ALLOWED to write, and it is what gives every test
    /// below a real file rather than a mock the CLI cannot be wrong about.
    fn fixture(db: &Path) {
        let store = Store::open(db).unwrap();
        store.set_meta(projects::NAME_KEY, "The Harbour").unwrap();
        let part = store.item_create(None, "part", "Part One").unwrap();
        for (title, text) in [
            ("Opening", "the harbour was quiet"),
            ("Second", "three more words"),
        ] {
            let s = store.item_create(Some(&part.id), "scene", title).unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: s.id.clone(),
                    body: body(text),
                    base_rev: s.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
    }

    /// Damage the file directly, with foreign keys OFF.
    ///
    /// rusqlite turns `foreign_keys` ON for every connection it opens, so a
    /// plain insert of an orphan is REFUSED and the fixture cannot be built at
    /// all. Turning it off is not cheating: the pragma is per connection and
    /// off by default in SQLite itself, so any other tool that ever wrote this
    /// file could have left exactly these rows -- which is the whole reason
    /// `validate` checks for them rather than trusting the schema.
    fn damage(db: &Path, sql: &str) {
        let conn = rusqlite::Connection::open(db).unwrap();
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        conn.execute_batch(sql).unwrap();
    }

    /// The JSON keys of a serialized value, sorted. Used by the per-subcommand
    /// key tests: a rename is then a FAILING TEST rather than a silently broken
    /// script, which is the whole reason the shape is documented as stable.
    fn keys_of<T: Serialize>(v: &T) -> Vec<String> {
        let json = serde_json::to_value(v).unwrap();
        let mut out: Vec<String> = json
            .as_object()
            .expect("the top level of every CLI answer is an object")
            .keys()
            .cloned()
            .collect();
        out.sort();
        out
    }

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    // -------------------------------------------------------- no migration

    /// THE LOAD-BEARING TEST OF THIS SLICE.
    ///
    /// `Store::open` migrates a v1 file to the current schema. A CLI that
    /// inspected a project and thereby migrated it would close that project to
    /// the build the writer is running -- and it would do so on a READ, with
    /// nothing said and no way back. This writes a GENUINE v1 file (v1's DDL and
    /// `user_version = 1`, not a v2 file with the pragma lowered, which would
    /// still hold v2's tables and could be migrated by a no-op), drives every
    /// read subcommand over it, and asserts the pragma afterwards.
    ///
    /// It would catch a single `Store::open` slipped into any of them, which is
    /// the mistake this module is one keystroke away from at all times.
    #[test]
    fn no_read_subcommand_migrates_a_v1_project() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("old.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE item (
                   id TEXT PRIMARY KEY, parent_id TEXT REFERENCES item(id),
                   type TEXT NOT NULL, title TEXT NOT NULL, position TEXT NOT NULL,
                   rev INTEGER NOT NULL DEFAULT 1);
                 CREATE UNIQUE INDEX item_sibling ON item(parent_id, position);
                 CREATE UNIQUE INDEX item_root_sibling ON item(position) WHERE parent_id IS NULL;
                 CREATE TABLE doc (
                   item_id TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
                   body TEXT NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 INSERT INTO meta VALUES ('project_name', 'Old Book');
                 INSERT INTO item (id, parent_id, type, title, position, rev) VALUES ('i1', NULL, 'scene', 'Only', '0000', 1);
                 INSERT INTO doc VALUES ('i1', '{\"type\":\"doc\",\"content\":[]}', 1, 0);
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        }
        let version = |db: &Path| -> i64 {
            rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(version(&db), 1, "the fixture must start at v1");

        let seen = inspect(&db).unwrap();
        assert_eq!(seen.schema_version, 1);
        assert_eq!(seen.name, "Old Book");
        assert_eq!(version(&db), 1, "inspect migrated the project");

        validate(&db).unwrap();
        assert_eq!(version(&db), 1, "validate migrated the project");

        crate::find_in(&db, "Only", find::DEFAULT_LIMIT).unwrap();
        assert_eq!(version(&db), 1, "search migrated the project");

        let h = history(&db, None).unwrap();
        assert_eq!(h.schema_version, 1);
        assert!(h.snapshots.is_empty());
        assert_eq!(version(&db), 1, "history migrated the project");

        export(&db, &dir.path().join("out.md"), export::Format::Markdown).unwrap();
        assert_eq!(version(&db), 1, "export migrated the project");

        // And nothing was left beside it either: a read that opens WAL writes
        // -wal/-shm, which is the visible half of the same defect.
        assert!(!db.with_extension("db-wal").exists());
    }

    /// A v1 project has no history tables at all. `inspect` and `history` must
    /// report that as "no snapshots", not as "no such table: snapshot" -- an
    /// error there reads as a damaged file and would push somebody toward
    /// `Store::open` to "repair" it.
    #[test]
    fn a_v1_project_reports_no_history_rather_than_a_missing_table() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("old.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE item (
                   id TEXT PRIMARY KEY, parent_id TEXT REFERENCES item(id),
                   type TEXT NOT NULL, title TEXT NOT NULL, position TEXT NOT NULL,
                   rev INTEGER NOT NULL DEFAULT 1);
                 CREATE TABLE doc (
                   item_id TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
                   body TEXT NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        }
        assert_eq!(inspect(&db).unwrap().snapshots, 0);
        assert_eq!(inspect(&db).unwrap().versions, 0);
        let v = validate(&db).unwrap();
        assert!(v.ok, "{:?}", v.findings);
    }

    // ------------------------------------------------------------- inspect

    #[test]
    fn inspect_reports_the_project() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let v = inspect(&db).unwrap();
        assert_eq!(v.name, "The Harbour");
        assert_eq!(v.schema_version, store::SCHEMA_VERSION);
        assert_eq!(v.book_id, store::Store::open_readonly(&db).unwrap().book_id().unwrap());
        assert!(v.book_id.is_some());
        assert_eq!(v.items, 3);
        assert_eq!(v.items_by_type.get("scene"), Some(&2));
        assert_eq!(v.items_by_type.get("part"), Some(&1));
        assert_eq!(v.documents, 2);
        assert_eq!(v.words, 7);
        assert_eq!(v.unreadable_documents, 0);
        assert_eq!(v.trashed_items, 0);
        assert!(v.structure_error.is_none());
    }

    #[test]
    fn inspect_names_a_project_that_never_recorded_one_after_its_file() {
        // Not a defect and not an error: a project written before names were
        // recorded has a true answer, and it is the file stem. The same rule
        // `projects::summarize` uses for a library listing.
        let dir = tempdir().unwrap();
        let db = dir.path().join("untitled.db");
        {
            Store::open(&db)
                .unwrap()
                .item_create(None, "scene", "One")
                .unwrap();
        }
        assert_eq!(inspect(&db).unwrap().name, "untitled");
    }

    #[test]
    fn inspect_leaves_the_bin_out_of_the_word_count() {
        // The figure must be the manuscript's, which is what the application
        // shows the writer -- otherwise a writer who deleted a chapter is told
        // by the CLI that they still have it.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = Store::open(&db).unwrap();
            let keep = store.item_create(None, "scene", "Keep").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: keep.id.clone(),
                    body: body("two words"),
                    base_rev: keep.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
            let bin = store.item_create(None, store::TRASH_TYPE, "Trash").unwrap();
            let gone = store.item_create(Some(&bin.id), "scene", "Gone").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: gone.id.clone(),
                    body: body("four words in here"),
                    base_rev: gone.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let v = inspect(&db).unwrap();
        assert_eq!(v.words, 2, "the binned scene was counted");
        assert_eq!(v.trashed_items, 2, "the bin and the scene inside it");
        // The rows are still THERE, and inspect says so: `documents` is a file
        // fact, `words` is a manuscript fact, and conflating them would hide a
        // whole chapter from somebody looking for it.
        assert_eq!(v.documents, 2);
    }

    #[test]
    fn inspect_leaves_the_bible_out_of_words_and_shows_it_by_type() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = Store::open(&db).unwrap();
            let keep = store.item_create(None, "scene", "Keep").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: keep.id.clone(),
                    body: body("two words"),
                    base_rev: keep.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
            let bible = store.item_create(None, store::BIBLE_TYPE, "Bible").unwrap();
            let note = store
                .item_create(Some(&bible.id), store::NOTE_TYPE, "Synopsis")
                .unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: note.id.clone(),
                    body: body("four words in here"),
                    base_rev: note.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let v = inspect(&db).unwrap();
        assert_eq!(v.words, 2, "the bible was counted into the book");
        assert_eq!(v.trashed_items, 0, "the bible is not the bin");
        // A FILE FACT, unchanged: the note's row is there and inspect says so.
        // The same argument the bin's test makes -- conflating `documents` with
        // `words` would hide a document from somebody looking for it.
        assert_eq!(v.documents, 2);
        assert_eq!(v.items_by_type.get(store::BIBLE_TYPE), Some(&1));
        assert_eq!(v.items_by_type.get(store::NOTE_TYPE), Some(&1));
    }

    /// THE MIRROR IMAGE of the test above, and the point is the FIRST
    /// assertion: a dedication's words are IN `words`, where a bible note's are
    /// not. Both sections are rows of the same tree with their own types; only
    /// one of them is out of the book.
    #[test]
    fn inspect_counts_front_matter_into_the_book_and_shows_it_by_type() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = Store::open(&db).unwrap();
            let keep = store.item_create(None, "scene", "Keep").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: keep.id.clone(),
                    body: body("two words"),
                    base_rev: keep.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
            let front = store
                .item_create(None, store::FRONT_MATTER_TYPE, "Front matter")
                .unwrap();
            let dedication = store
                .item_create(Some(&front.id), store::MATTER_TYPE, "Dedication")
                .unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: dedication.id.clone(),
                    body: body("four words in here"),
                    base_rev: dedication.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let v = inspect(&db).unwrap();
        assert_eq!(v.words, 6, "front matter is in the book");
        assert_eq!(v.documents, 2);
        assert_eq!(v.items_by_type.get(store::FRONT_MATTER_TYPE), Some(&1));
        assert_eq!(v.items_by_type.get(store::MATTER_TYPE), Some(&1));
    }

    /// A SYNOPSIS IS A FILE FACT AND `inspect` SAYS SO, exactly as `documents`
    /// does for a bible note. It is not in `words` and cannot be: it is not in
    /// the `doc` table the index scans. What this figure is for is the person
    /// looking at a file and asking what is in it -- a table nothing named
    /// would be a table nobody could find.
    #[test]
    fn inspect_counts_synopses_and_leaves_them_out_of_words() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = Store::open(&db).unwrap();
            let keep = store.item_create(None, "scene", "Keep").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: keep.id.clone(),
                    body: body("two words"),
                    base_rev: keep.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
            let chapter = store.item_create(None, "chapter", "Chapter 1").unwrap();
            store
                .synopsis_set(&keep.id, "she burns the letter")
                .unwrap();
            store
                .synopsis_set(&chapter.id, "the letter arrives")
                .unwrap();
        }
        let v = inspect(&db).unwrap();
        assert_eq!(v.synopses, 2);
        assert_eq!(v.words, 2, "a synopsis reached the manuscript's words");
        assert_eq!(v.documents, 1, "a synopsis is not a document");
    }

    #[test]
    fn inspect_reports_no_synopses_for_a_file_that_predates_the_table() {
        // GUARDED ON THE SCHEMA VERSION, for the reason `snapshots` and
        // `versions` are: a v5 file has no `synopsis` table and asking for one
        // would report "no such table" as though the project were damaged. It
        // is not damaged; it predates the feature.
        let dir = tempdir().unwrap();
        let db = dir.path().join("v1.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE item (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES item(id),
               type TEXT NOT NULL, title TEXT NOT NULL, position TEXT NOT NULL,
               rev INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE doc (item_id TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
               body TEXT NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO item (id, parent_id, type, title, position, rev)
               VALUES ('i1', NULL, 'scene', 'Only', '0000', 1);
             PRAGMA user_version = 1; COMMIT;",
        )
        .unwrap();
        drop(conn);

        let v = inspect(&db).unwrap();

        assert_eq!(v.schema_version, 1);
        assert_eq!(v.synopses, 0);
        assert_eq!(v.cast_members, 0);
        assert_eq!(v.cast_fields, 0);
        assert_eq!(v.pictures, 0);
    }

    #[test]
    fn inspect_counts_the_cast_and_leaves_it_out_of_words_and_documents() {
        // The FILE FACT, exactly as `documents` and `synopses` are. Two members
        // and three fields, so neither figure can be the other's by accident,
        // and one member with NO fields so the join cannot be what is counted.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = Store::open(&db).unwrap();
            let keep = store.item_create(None, "scene", "Keep").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: keep.id.clone(),
                    body: body("two words"),
                    base_rev: keep.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
            let ilse = store
                .cast_create(store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            store
                .cast_set(
                    &ilse.id,
                    store::cast::KIND_CHARACTER,
                    "Ilse",
                    "she burns the letter",
                    &[
                        store::cast::CastField {
                            label: "accent".into(),
                            value: "flat northern".into(),
                        },
                        store::cast::CastField {
                            label: "wants".into(),
                            value: "to be believed".into(),
                        },
                    ],
                    &[],
                )
                .unwrap();
            let quay = store
                .cast_create(store::cast::KIND_PLACE, "The Kelp Quay")
                .unwrap();
            store
                .cast_set(
                    &quay.id,
                    store::cast::KIND_PLACE,
                    "The Kelp Quay",
                    "",
                    &[store::cast::CastField {
                        label: "held by".into(),
                        value: "the guild".into(),
                    }],
                    &[],
                )
                .unwrap();
            let poi = store
                .cast_create(store::cast::KIND_POI, "The burnt letter")
                .unwrap();
            store
                .cast_set_picture(&poi.id, Some("a-photograph.jpg"))
                .unwrap();
        }
        let v = inspect(&db).unwrap();
        assert_eq!(v.cast_members, 3);
        assert_eq!(v.cast_members_active, 3);
        assert_eq!(v.cast_members_deleted, 0);
        assert_eq!(v.cast_fields, 3);
        // ONE OF THREE MEMBERS, so the figure cannot be the member count wearing
        // a different name -- which is the only reading a fixture where every
        // member had a picture would allow.
        assert_eq!(v.pictures, 1);
        assert_eq!(v.words, 2, "the cast reached the manuscript's words");
        assert_eq!(v.documents, 1, "a cast member is not a document");
        assert_eq!(v.items, 1, "a cast member became an item");
    }

    #[test]
    fn inspect_distinguishes_active_and_retained_cast() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let store = Store::open(&db).unwrap();
        let member = store.cast_create(store::cast::KIND_CHARACTER, "Ilse").unwrap();
        store.cast_remove(&member.id).unwrap();
        drop(store);
        let report = inspect(&db).unwrap();
        assert_eq!((report.cast_members, report.cast_members_active, report.cast_members_deleted), (1, 0, 1));
    }

    #[test]
    fn inspect_counts_the_appearances_and_leaves_them_out_of_words_and_documents() {
        // The FILE FACT, exactly as `documents`, `synopses` and `cast_members`
        // are. THREE rows across TWO items and TWO members, so no figure can be
        // another's by accident: a count of items would say 2, a count of
        // members would say 2, and the answer is 3.
        //
        // `items`, `documents` and `words` are asserted too, so a tag that had
        // somehow become an item, a document or prose would be caught here
        // rather than in whichever surface met it first.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        {
            let store = Store::open(&db).unwrap();
            let ilse = store
                .cast_create(store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            let harbour = store
                .cast_create(store::cast::KIND_PLACE, "The harbour")
                .unwrap();
            let walk = store.items().unwrap();
            let scenes: Vec<String> = walk
                .iter()
                .filter(|i| i.item_type == "scene")
                .map(|i| i.id.clone())
                .collect();
            assert_eq!(scenes.len(), 2, "the fixture is two scenes");
            store
                .appearances_set(&scenes[0], &[ilse.id.clone(), harbour.id.clone()])
                .unwrap();
            store
                .appearances_set(&scenes[1], &[ilse.id.clone()])
                .unwrap();
        }

        let v = inspect(&db).unwrap();

        assert_eq!(v.appearances, 3);
        assert_eq!(v.cast_members, 2);
        assert_eq!(v.items, 3);
        assert_eq!(v.documents, 2);
        assert_eq!(v.words, 7);
    }

    #[test]
    fn inspect_reports_no_appearances_for_a_file_that_predates_the_table() {
        // A v8 file is OLD, not damaged. Asking it for a table that arrived at
        // v9 reports "no such table" and a reader would take that for a broken
        // project -- `snapshots`' and `synopses`' rule, and its own guard rather
        // than a widened one for the reason 046 records: one bound reads a file
        // wrongly at one end.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        damage(&db, "DROP TABLE appearance; PRAGMA user_version = 8;");

        let v = inspect(&db).unwrap();

        assert_eq!(v.schema_version, 8);
        assert_eq!(v.appearances, 0);
        // And the figures a v8 file DOES carry are still answered, which is what
        // stops a guard that gave up on the whole inspection from passing.
        assert_eq!(v.documents, 2);
    }

    #[test]
    fn inspect_json_keys() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        assert_eq!(
            keys_of(&inspect(&db).unwrap()),
            [
                "appearances",
                "book_id",
                "cast_fields",
                "cast_members",
                "cast_members_active",
                "cast_members_deleted",
                "covers",
                "documents",
                "items",
                "items_by_type",
                "name",
                "path",
                "pictures",
                "review",
                "revision_passes",
                "revision_tasks_done",
                "revision_tasks_open",
                "schema_version",
                "series",
                "snapshots",
                "structure_error",
                "synopses",
                "trashed_items",
                "universe",
                "unreadable_documents",
                "versions",
                "words",
            ]
        );
    }

    #[test]
    fn review_cli_counts_and_recovery_report_name_every_retained_surface() {
        let dir = tempdir().unwrap(); let db = dir.path().join("review.db");
        let (store, _) = crate::review_validation::test_support::seed(&db); drop(store);
        let inspection = inspect(&db).unwrap();
        assert_eq!(keys_of(&inspection.review), ["accepted", "authors", "conflicted", "groups", "hunks", "messages", "pending", "rejected"]);
        assert_eq!((inspection.review.authors, inspection.review.groups, inspection.review.hunks, inspection.review.messages), (2, 4, 4, 1));
        let out = dir.path().join("recovered");
        let result = salvage::salvage(&db, &out).unwrap();
        assert!(salvage_report(&result, &out).contains("review     2 authors, 4 groups, 4 hunks, 1 messages (review.json)"));
    }

    #[test]
    fn inspect_still_answers_when_the_walk_is_broken() {
        // A file whose structure is corrupt is exactly the file somebody needs
        // an inspection of. Failing outright would leave them with no counts at
        // all and no idea what the project holds.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        damage(
            &db,
            "INSERT INTO item (id, parent_id, type, title, position, rev) VALUES ('orphan', 'nobody', 'scene', 'Lost', 'zzzz', 1);",
        );
        let v = inspect(&db).unwrap();
        assert_eq!(v.items, 4);
        assert!(
            v.structure_error
                .as_deref()
                .unwrap_or("")
                .contains("walk reached"),
            "{:?}",
            v.structure_error
        );
    }

    // ------------------------------------------------------------ validate

    #[test]
    fn validate_finds_nothing_wrong_with_a_healthy_project() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let v = validate(&db).unwrap();
        assert!(v.ok, "{:?}", v.findings);
        assert!(v.findings.is_empty());
    }

    #[test]
    fn validate_reports_a_broken_walk() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        damage(
            &db,
            "INSERT INTO item (id, parent_id, type, title, position, rev) VALUES ('orphan', 'nobody', 'scene', 'Lost', 'zzzz', 1);",
        );
        let v = validate(&db).unwrap();
        assert!(!v.ok);
        assert_eq!(v.findings[0].kind, KIND_STRUCTURE);
    }

    #[test]
    fn validate_reports_a_body_that_is_not_a_document() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        // `{"foo":1}` and not garbage: it PARSES as JSON and is still not a
        // document, which is the case a laxer root check would miss.
        damage(&db, "UPDATE doc SET body = '{\"foo\":1}';");
        let v = validate(&db).unwrap();
        assert!(!v.ok);
        assert_eq!(v.findings.len(), 2, "{:?}", v.findings);
        assert!(v.findings.iter().all(|f| f.kind == KIND_UNREADABLE_BODY));
        assert!(v.findings.iter().all(|f| f.item_id.is_some()));
    }

    #[test]
    fn validate_reports_a_document_whose_item_is_gone() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        damage(
            &db,
            "INSERT INTO doc VALUES ('nobody', '{\"type\":\"doc\",\"content\":[]}', 1, 0);",
        );
        let v = validate(&db).unwrap();
        assert!(!v.ok);
        assert_eq!(
            v.findings,
            vec![Finding {
                kind: KIND_ORPHAN_DOC.into(),
                detail: "a document is stored for nobody, which is not an item in this project"
                    .into(),
                item_id: Some("nobody".into()),
            }]
        );
    }

    #[test]
    fn validate_reports_appearances_whose_item_or_cast_member_is_gone() {
        // EXACTLY PARALLEL to the three orphan checks above, with the same
        // fixture discipline: a GOOD appearance beside the broken ones, so a
        // check that reported every row rather than the orphaned ones has
        // something to over-report and cannot pass by accident.
        //
        // BOTH SIDES, in one test, because they are one check and the sentence
        // is what tells them apart. A fixture with only one missing end passes
        // against a query that joined only that side.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let (scene, member) = {
            let store = Store::open(&db).unwrap();
            let ilse = store
                .cast_create(store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            let walk = store.items().unwrap();
            let scene = walk
                .iter()
                .find(|i| i.item_type == "scene")
                .unwrap()
                .id
                .clone();
            store.appearances_set(&scene, &[ilse.id.clone()]).unwrap();
            (scene, ilse.id)
        };
        damage(
            &db,
            &format!(
                "INSERT INTO appearance VALUES ('no-such-item', '{member}');
                 INSERT INTO appearance VALUES ('{scene}', 'no-such-member');
                 INSERT INTO appearance VALUES ('no-such-item', 'no-such-member');"
            ),
        );

        let v = validate(&db).unwrap();

        assert!(!v.ok);
        let mine: Vec<&Finding> = v
            .findings
            .iter()
            .filter(|f| f.kind == KIND_ORPHAN_APPEARANCE)
            .collect();
        assert_eq!(
            mine.len(),
            3,
            "the good row was reported, or one was missed"
        );
        assert_eq!(
            mine[0].detail,
            format!("an appearance records no-such-member, which is not a character, place or point of interest in this project, in {scene}")
        );
        assert_eq!(mine[0].item_id.as_deref(), Some(scene.as_str()));
        // The two broken rows under `no-such-item` come back in cast-member
        // order, and a uuid v7 begins with a hex digit so it sorts before the
        // literal. That ordering is the query's `ORDER BY` and is asserted
        // rather than sidestepped: a report whose order depends on the file's
        // page layout is one two runs of a recovery disagree about.
        assert_eq!(
            mine[1].detail,
            format!("an appearance records {member} in no-such-item, which is not an item in this project")
        );
        assert_eq!(
            mine[2].detail,
            "an appearance records no-such-member in no-such-item, and neither is in this project"
        );
    }

    #[test]
    fn validate_says_nothing_about_appearances_in_a_file_that_predates_the_table() {
        // The guard's other half. Without it a v8 project would fail validation
        // for the crime of being old, and `validate` is what VERIFIES a recovery
        // point -- an unverified point is never offered for restore.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        let store = store::historical_test_store(&db, 8);
        store.item_create(None, "scene", "Old scene").unwrap();
        drop(store);

        let v = validate(&db).unwrap();

        assert!(v.ok, "an old file validated as damaged: {:?}", v.findings);
    }

    #[test]
    fn validate_reports_detail_fields_whose_cast_member_is_gone() {
        // EXACTLY PARALLEL to the two orphan checks above, with the same
        // fixture discipline: a GOOD field beside the orphaned one, so a check
        // that reported every field rather than the orphaned ones has something
        // to over-report and cannot pass by accident.
        //
        // ONE FINDING FOR TWO ORPHANED ROWS, which is what the `DISTINCT` is
        // for: a member with four lost fields is one lost character sheet, and
        // four identical sentences would read as four problems.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        {
            let store = Store::open(&db).unwrap();
            let good = store
                .cast_create(store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            store
                .cast_set(
                    &good.id,
                    store::cast::KIND_CHARACTER,
                    "Ilse",
                    "",
                    &[store::cast::CastField {
                        label: "accent".into(),
                        value: "flat northern".into(),
                    }],
                    &[],
                )
                .unwrap();
        }
        damage(
            &db,
            "INSERT INTO cast_field VALUES ('nobody', 0, 'accent', 'flat northern');
             INSERT INTO cast_field VALUES ('nobody', 1, 'wants', 'out');",
        );
        let v = validate(&db).unwrap();
        assert!(!v.ok);
        assert_eq!(
            v.findings,
            vec![Finding {
                kind: KIND_ORPHAN_CAST_FIELD.into(),
                detail: "detail fields are stored for nobody, which is not a character, place or point of interest in this project"
                    .into(),
                item_id: Some("nobody".into()),
            }]
        );
    }

    #[test]
    fn validate_reports_aliases_whose_cast_member_is_gone() {
        // `validate_reports_detail_fields_whose_cast_member_is_gone`'s own
        // fixture discipline, one table over: a GOOD alias beside the orphaned
        // ones, and ONE finding for the two orphaned rows -- the `DISTINCT`.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        {
            let store = Store::open(&db).unwrap();
            let good = store
                .cast_create(store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            store
                .cast_set(
                    &good.id,
                    store::cast::KIND_CHARACTER,
                    "Ilse",
                    "",
                    &[],
                    &["Ils".to_string()],
                )
                .unwrap();
        }
        damage(
            &db,
            "INSERT INTO cast_alias VALUES ('nobody', 0, 'Quill');
             INSERT INTO cast_alias VALUES ('nobody', 1, 'Quillie');",
        );
        let v = validate(&db).unwrap();
        assert!(!v.ok);
        assert_eq!(
            v.findings,
            vec![Finding {
                kind: KIND_ORPHAN_CAST_ALIAS.into(),
                detail: "aliases are stored for nobody, which is not a character, place or point of interest in this project"
                    .into(),
                item_id: Some("nobody".into()),
            }]
        );
    }

    #[test]
    fn validate_says_nothing_about_aliases_in_a_file_that_predates_the_table() {
        // The guard's other half: without it a v9 project would fail
        // validation for the crime of being old, and `validate` is what
        // VERIFIES a recovery point -- an unverified point is never offered
        // for restore.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        let store = store::historical_test_store(&db, 9);
        store.item_create(None, "scene", "Old scene").unwrap();
        drop(store);

        let v = validate(&db).unwrap();

        assert!(v.ok, "an old file validated as damaged: {:?}", v.findings);
    }

    #[test]
    fn inspect_counts_the_covers_beside_the_cast_photographs_and_not_inside_them() {
        // TWO FIGURES BECAUSE THEY ARE TWO THINGS -- and the fixture is a book
        // with covers and no cast photograph, which is the only shape that can
        // tell a second figure from a widened first one.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        {
            let store = Store::open(&db).unwrap();
            let made = store
                .cast_create(store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            assert_eq!(made.picture_path, None);
            crate::covers::set_cover(&store, crate::covers::SIDE_FRONT, "front.jpg").unwrap();
        }

        let v = inspect(&db).unwrap();

        assert_eq!(v.covers, 1);
        assert_eq!(v.pictures, 0);
        assert_eq!(v.cast_members, 1);
    }

    #[test]
    fn validate_checks_database_coherence_while_recovery_reports_cover_gaps() {
        // SQL coherence and asset completeness are separate contracts. Missing
        // or unsafe cover references leave a usable database-only recovery point,
        // never a falsely verified complete bundle.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        {
            let store = Store::open(&db).unwrap();
            crate::covers::set_cover(&store, crate::covers::SIDE_FRONT, "nothing-is-here.jpg")
                .unwrap();
            // AND A ROW THIS BUILD WOULD NEVER HAVE WRITTEN, which is the value
            // most likely to tempt a shape check into `validate`. It is the
            // panel's business and not the file's coherence.
            store
                .set_meta(crate::covers::BACK_KEY, "../../elsewhere.png")
                .unwrap();
        }

        let v = validate(&db).unwrap();

        assert!(v.ok, "{:?}", v.findings);
        assert_eq!(v.findings, Vec::new());
        let points = dir.path().join("recovery");
        let point = crate::recovery::take_point(&db, "p", "P", &points, 1_700_000_000_000).unwrap();
        assert!(point.database_verified, "a book with a cover lost its database-only recovery point");
        assert!(!point.verified, "missing covers cannot form a complete bundle");
    }

    #[test]
    fn validate_checks_database_coherence_while_recovery_reports_picture_gaps() {
        // A coherent cast picture reference can name a missing original.
        // Preserve the database-only point and disclose its asset gap.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        {
            let store = Store::open(&db).unwrap();
            let made = store
                .cast_create(store::cast::KIND_CHARACTER, "Ilse")
                .unwrap();
            store
                .cast_set_picture(&made.id, Some("nothing-is-here.jpg"))
                .unwrap();
        }

        let v = validate(&db).unwrap();

        assert!(v.ok, "{:?}", v.findings);
        assert_eq!(v.findings, Vec::new());
        // Recovery retains the database while reporting incomplete assets.
        let points = dir.path().join("recovery");
        let point = crate::recovery::take_point(&db, "p", "P", &points, 1_700_000_000_000).unwrap();
        assert!(point.database_verified, "a book with a photograph lost its database-only recovery point");
        assert!(!point.verified, "a missing photograph cannot form a complete bundle");
    }

    #[test]
    fn validate_reports_a_synopsis_whose_item_is_gone() {
        // EXACTLY PARALLEL to the orphan-`doc` check above, and for the same
        // reason: the foreign key makes this unwritable while `foreign_keys` is
        // ON, which `open_readonly` does not set and an external tool need not
        // have set either. The check is about what the file HOLDS, not about
        // what this build would have written.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        damage(
            &db,
            // A GOOD ROW BESIDE THE BAD ONE. Without it a check that reported
            // every synopsis rather than the orphaned ones would report exactly
            // this one finding and pass -- the file would hold nothing else to
            // over-report.
            "INSERT INTO synopsis SELECT id, 'about a real item', 1, 0 FROM item LIMIT 1;
             INSERT INTO synopsis VALUES ('nobody', 'about nothing', 1, 0);",
        );
        let v = validate(&db).unwrap();
        assert!(!v.ok);
        assert_eq!(
            v.findings,
            vec![Finding {
                kind: KIND_ORPHAN_SYNOPSIS.into(),
                detail: "a synopsis is stored for nobody, which is not an item in this project"
                    .into(),
                item_id: Some("nobody".into()),
            }]
        );
    }

    #[test]
    fn validate_reports_a_version_whose_blob_is_missing() {
        // A version listed in the recovery panel that cannot be restored is
        // worse than one that is absent: the writer is offered a way back that
        // is not there.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        damage(
            &db,
            "INSERT INTO doc_version (item_id, blob_key, created_at, words, snapshot_id)
             SELECT id, 'nosuchblob', 1, 3, NULL FROM item WHERE type = 'scene' LIMIT 1;",
        );
        let v = validate(&db).unwrap();
        assert!(!v.ok);
        assert_eq!(v.findings.len(), 1);
        assert_eq!(v.findings[0].kind, KIND_MISSING_BLOB);
        assert!(v.findings[0].detail.contains("nosuchblob"));
    }

    #[test]
    fn validate_reports_every_finding_and_not_only_the_first() {
        // A validator that stopped at one problem would make a damaged file take
        // as many runs to understand as it has faults, and the run order would
        // decide which fault the operator heard about.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        damage(
            &db,
            "INSERT INTO item (id, parent_id, type, title, position, rev) VALUES ('orphan', 'nobody', 'scene', 'Lost', 'zzzz', 1);
             UPDATE doc SET body = 'not json';
             INSERT INTO doc VALUES ('ghost', '{\"type\":\"doc\",\"content\":[]}', 1, 0);",
        );
        let v = validate(&db).unwrap();
        let kinds: Vec<&str> = v.findings.iter().map(|f| f.kind.as_str()).collect();
        assert!(kinds.contains(&KIND_STRUCTURE), "{kinds:?}");
        assert!(kinds.contains(&KIND_UNREADABLE_BODY), "{kinds:?}");
        assert!(kinds.contains(&KIND_ORPHAN_DOC), "{kinds:?}");
    }

    /// MAJOR review finding 7: `validate` read `store.documents()` with no
    /// knowledge of `item.type`, so `document_markdown` -- correctly seeing a
    /// timeline's opaque JSON is not a ProseMirror document -- reported every
    /// healthy timeline in the file as `unreadable_body`, false damage an
    /// operator would act on.
    #[test]
    fn a_healthy_timeline_is_not_reported_as_an_unreadable_body() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        {
            let store = Store::open(&db).unwrap();
            let bible = store.item_create(None, store::BIBLE_TYPE, "Bible").unwrap();
            let timeline = store
                .item_create(Some(&bible.id), store::TIMELINE_TYPE, "Timeline")
                .unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: timeline.id.clone(),
                    body: store::EMPTY_TIMELINE_BODY.to_string(),
                    base_rev: timeline.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let v = validate(&db).unwrap();
        assert!(v.ok, "{:?}", v.findings);
        assert!(v.findings.is_empty(), "{:?}", v.findings);
    }

    /// The exclusion is BY ID, not "skip every unreadable body" -- a scene
    /// whose body is genuinely corrupt must still be reported, timeline or
    /// no timeline in the same file.
    #[test]
    fn a_genuinely_unreadable_scene_is_still_reported_beside_a_healthy_timeline() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let timeline_id = {
            let store = Store::open(&db).unwrap();
            let bible = store.item_create(None, store::BIBLE_TYPE, "Bible").unwrap();
            let timeline = store
                .item_create(Some(&bible.id), store::TIMELINE_TYPE, "Timeline")
                .unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: timeline.id.clone(),
                    body: store::EMPTY_TIMELINE_BODY.to_string(),
                    base_rev: timeline.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
            timeline.id
        };
        damage(
            &db,
            "UPDATE doc SET body = 'not json at all'
              WHERE item_id = (SELECT id FROM item WHERE type = 'scene' ORDER BY id LIMIT 1)",
        );
        let v = validate(&db).unwrap();
        let kinds: Vec<&str> = v.findings.iter().map(|f| f.kind.as_str()).collect();
        assert_eq!(kinds, vec![KIND_UNREADABLE_BODY], "{:?}", v.findings);
        assert!(
            v.findings
                .iter()
                .all(|f| f.item_id.as_deref() != Some(timeline_id.as_str())),
            "{:?}",
            v.findings
        );
    }

    #[test]
    fn validate_json_keys() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        assert_eq!(
            keys_of(&validate(&db).unwrap()),
            ["findings", "ok", "path", "schema_version"]
        );
    }

    #[test]
    fn validate_finding_json_keys() {
        // The findings array is the part a script reads, so its element shape is
        // as much of the contract as the envelope's.
        let f = Finding {
            kind: KIND_STRUCTURE.into(),
            detail: "x".into(),
            item_id: None,
        };
        assert_eq!(keys_of(&f), ["detail", "item_id", "kind"]);
    }

    // -------------------------------------------------------------- search

    #[test]
    fn search_finds_prose_and_titles() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let r = crate::find_in(&db, "harbour", find::DEFAULT_LIMIT).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.results[0].title, "Opening");
        assert!(r.results[0].snippet.contains("harbour"));
    }

    #[test]
    fn search_json_keys() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let r = crate::find_in(&db, "harbour", find::DEFAULT_LIMIT).unwrap();
        assert_eq!(
            keys_of(&r),
            ["results", "scanned", "skipped", "total", "truncated"]
        );
        let hit = serde_json::to_value(&r.results[0]).unwrap();
        let mut hit_keys: Vec<String> = hit.as_object().unwrap().keys().cloned().collect();
        hit_keys.sort();
        assert_eq!(
            hit_keys,
            [
                "item_id",
                "kind",
                "matches",
                "openable",
                "snippet",
                "title",
                "title_match",
            ]
        );
    }

    // -------------------------------------------------------------- export

    #[test]
    fn export_writes_the_manuscript_under_the_projects_own_name() {
        // The title line comes from the project's meta row, not from the
        // destination filename: the operator named where it goes, not what it
        // is called.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let dest = dir.path().join("book.md");
        let r = export(&db, &dest, export::Format::Markdown).unwrap();
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.starts_with("# The Harbour\n"), "{text}");
        assert!(text.contains("## Part One"), "{text}");
        assert!(text.contains("the harbour was quiet"), "{text}");
        assert_eq!(r.items, 3);
        assert_eq!(r.words, 7);
    }

    #[test]
    fn export_refuses_an_existing_destination() {
        // `Dest::New`, the kernel's refusal. A CLI that silently overwrote a
        // file named by a typo would be the one command here that destroys
        // something.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let dest = dir.path().join("book.md");
        std::fs::write(&dest, "mine").unwrap();
        assert!(export(&db, &dest, export::Format::Markdown).is_err());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "mine");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pdf_without_display_child() {
        if std::env::var_os("APP_PDF_HEADLESS_PROBE").is_none() { return; }
        let dir = tempdir().unwrap();
        std::env::set_var("XDG_DATA_HOME", dir.path());
        let db = dir.path().join("p.db");
        fixture(&db);
        let dest = dir.path().join("proof.pdf");
        let error = export(&db, &dest, export::Format::Pdf).unwrap_err();
        assert!(error.contains("needs a display"), "{error}");
        assert!(error.contains("set DISPLAY or WAYLAND_DISPLAY"), "{error}");
        assert!(!dest.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pdf_export_refuses_headless_with_a_display_instruction() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("cli::tests::pdf_without_display_child")
            .env("APP_PDF_HEADLESS_PROBE", "1")
            .env("GDK_BACKEND", "x11")
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stdout}\n{stderr}");
        assert!(stdout.contains("1 passed"), "{stdout}\n{stderr}");
    }

    #[test]
    fn the_cli_writes_in_the_language_settings_json_names() {
        // KILLS THE MUTANT the single-catalog record predicted would survive
        // once a second catalog shipped: this module's two
        // `strings_for(&crate::data_home())` calls (this one and salvage's)
        // replaced by `crate::projects::Settings::default().locale.strings()`.
        // Every other test in this file calls `export()`/`salvage_with()`
        // directly with a fixture locale or none at all, so neither call site
        // was ever exercised through the real `data_home()` seam this binary
        // actually runs on. This test dispatches the CLI subcommand, exactly
        // as an operator's shell would, over a `settings.json` this test
        // controls.
        //
        // `data_home()`'s OWN doc comment says why this is the one test in
        // this crate that touches `XDG_DATA_HOME`: "reading process
        // environment inside a unit test is a data race against every other
        // test in the binary." The lock below only serializes repeat runs of
        // THIS test against each other; it cannot protect
        // `export_writes_the_manuscript_under_the_projects_own_name` and its
        // neighbours above, which read the same variable's ambient value
        // without a lock of their own. Documented rather than hidden: those
        // tests do not assert anything language-dependent, so the window this
        // opens is real but narrow, and it is the only way to reach a seam
        // that has no other injection point.
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let project_dir = tempdir().unwrap();
        let db = project_dir.path().join("p.db");
        fixture(&db);
        let dest = project_dir.path().join("book.md");

        let home = tempdir().unwrap();
        let settings = crate::projects::settings_path(home.path());
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(&settings, br#"{"locale":"de"}"#).unwrap();

        struct RestoreDataHome(Option<std::ffi::OsString>);
        impl Drop for RestoreDataHome {
            fn drop(&mut self) {
                match &self.0 {
                    Some(value) => std::env::set_var("XDG_DATA_HOME", value),
                    None => std::env::remove_var("XDG_DATA_HOME"),
                }
            }
        }
        let restore_home = RestoreDataHome(std::env::var_os("XDG_DATA_HOME"));
        std::env::set_var("XDG_DATA_HOME", home.path());
        let code = run(&argv(&[
            "export",
            &db.to_string_lossy(),
            &dest.to_string_lossy(),
        ]));
        let source = write_manuscript(project_dir.path(), "source.md", "# Book\n\n## Part\n\n### Chapter\n");
        let library = project_dir.path().join("library");
        let import_code = run(&argv(&[
            "import",
            source.to_str().unwrap(),
            library.to_str().unwrap(),
        ]));
        drop(restore_home);

        assert_eq!(code, EXIT_OK);
        let text = std::fs::read_to_string(&dest).unwrap();
        // READ FROM THE CATALOG, not retyped, so this cannot drift from
        // `DE_ENTRIES` the way a hand-copied literal would.
        let german_contents = crate::strings::Strings::new(&crate::strings::DE).t("book.contents");
        assert!(text.contains(&german_contents), "{text}");
        assert!(!text.contains("Contents"), "{text}");

        assert_eq!(import_code, EXIT_OK);
        let store = Store::open_readonly(&library.join("book.db")).unwrap();
        let items = store.items().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].title, "Part");
        assert_eq!(items[1].title, "Chapter");
        assert_eq!(items[2].title, "Szene 1");
        assert!(items[2].parent_id.is_none());
    }

    // ------------------------------------------------------------- history

    #[test]
    fn history_lists_snapshots_and_a_documents_versions() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let item_id = {
            let store = Store::open(&db).unwrap();
            store.snapshot_create("before the cut").unwrap();
            store
                .items()
                .unwrap()
                .into_iter()
                .find(|i| i.item_type == "scene")
                .unwrap()
                .id
        };
        let all = history(&db, None).unwrap();
        assert_eq!(all.snapshots.len(), 1);
        assert_eq!(all.snapshots[0].label, "before the cut");
        assert_eq!(all.snapshots[0].documents, 2);
        assert_eq!(all.version_total, 2);
        assert!(
            all.versions.is_empty(),
            "the whole project's versions are a listing nobody asked for"
        );

        let one = history(&db, Some(&item_id)).unwrap();
        assert_eq!(one.item.as_deref(), Some(item_id.as_str()));
        assert_eq!(one.versions.len(), 1);
        assert_eq!(
            one.versions[0].snapshot_label.as_deref(),
            Some("before the cut")
        );
        assert_eq!(
            one.version_total, 2,
            "still the project's total, not the item's"
        );
    }

    #[test]
    fn history_of_an_unknown_item_is_an_empty_list_and_not_an_error() {
        // An id that names nothing has an answer -- no versions -- and it is not
        // a failure to read the project. Erroring would make a script treat a
        // typo the way it treats a damaged file.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let h = history(&db, Some("nosuchitem")).unwrap();
        assert!(h.versions.is_empty());
    }

    #[test]
    fn history_json_keys() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        assert_eq!(
            keys_of(&history(&db, None).unwrap()),
            [
                "item",
                "path",
                "schema_version",
                "snapshots",
                "version_total",
                "versions"
            ]
        );
    }

    // ---------------------------------------------------------- exit codes

    #[test]
    fn a_command_that_answered_exits_zero() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let path = db.to_string_lossy().into_owned();
        for args in [
            vec!["inspect", &path],
            vec!["inspect", &path, "--json"],
            vec!["validate", &path],
            vec!["history", &path, "--json"],
            vec!["search", &path, "harbour"],
        ] {
            assert_eq!(run(&argv(&args)), EXIT_OK, "{args:?}");
        }
    }

    #[test]
    fn restore_writes_a_new_project_and_leaves_the_point_alone() {
        // The CLI is the one restore surface that works with no display, which
        // matters because the panel driving the other one cannot be reached by
        // any rig.
        let dir = tempdir().unwrap();
        let points = dir.path().join("recovery").join("the-harbour");
        std::fs::create_dir_all(&points).unwrap();
        let point = points.join("2026-08-21T09-00-00Z.db");
        fixture(&point);
        let before = std::fs::read(&point).unwrap();
        let library = dir.path().join("projects");

        assert_eq!(
            run(&argv(&[
                "restore",
                &point.to_string_lossy(),
                &library.to_string_lossy()
            ])),
            EXIT_OK
        );

        assert_eq!(
            std::fs::read(&point).unwrap(),
            before,
            "the restore wrote to the point it was reading"
        );
        // The stem comes from the recovery directory the point sits in, which
        // IS the source project's slug by construction.
        let restored = library.join("the-harbour-recovered.db");
        assert!(restored.is_file(), "{restored:?} was not written");
        assert!(validate(&restored).unwrap().ok);
    }

    #[test]
    fn restore_with_picture_gaps_requires_the_explicit_flag() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("book.db");
        fixture(&source);
        let store = Store::open(&source).unwrap();
        let member = store.cast_create("character", "Ada").unwrap();
        store.cast_set_picture(&member.id, Some("missing.png")).unwrap();
        drop(store);
        let points = dir.path().join("recovery").join("book");
        let recorded = crate::recovery::take_point(&source, "book", "Book", &points, 1_700_000_000_000).unwrap();
        assert!(!recorded.verified);
        assert!(recorded.database_verified);
        let point = crate::backup_bundle::path_for(&points, &recorded.id);
        let library = dir.path().join("projects");
        assert_eq!(run(&argv(&["restore", &point.to_string_lossy(), &library.to_string_lossy()])), EXIT_UNREADABLE);
        assert!(!library.exists());
        assert_eq!(run(&argv(&["restore", &point.to_string_lossy(), &library.to_string_lossy(), "--allow-picture-gaps"])), EXIT_OK);
        let restored = library.join("book-recovered.db");
        let member = Store::open_readonly(&restored).unwrap().cast_list().unwrap();
        assert_eq!(member[0].picture_path.as_deref(), Some("missing.png"));
        assert!(!crate::pictures::dir_for(&restored).join("missing.png").exists());
    }

    #[test]
    fn restore_into_a_library_that_already_has_a_recovered_copy_takes_the_next_name() {
        // NOT a refusal. The never-clobber rule advances the ordinal; the only
        // thing that is refused is writing over a file, and that refusal is the
        // kernel's, per candidate.
        let dir = tempdir().unwrap();
        let points = dir.path().join("recovery").join("the-harbour");
        std::fs::create_dir_all(&points).unwrap();
        let point = points.join("p.db");
        fixture(&point);
        let library = dir.path().join("projects");
        std::fs::create_dir_all(&library).unwrap();
        let occupied = library.join("the-harbour-recovered.db");
        fixture(&occupied);
        let untouched = std::fs::read(&occupied).unwrap();

        assert_eq!(
            run(&argv(&[
                "restore",
                &point.to_string_lossy(),
                &library.to_string_lossy()
            ])),
            EXIT_OK
        );

        assert_eq!(std::fs::read(&occupied).unwrap(), untouched);
        assert!(library.join("the-harbour-recovered-2.db").is_file());
    }

    #[test]
    fn restore_without_a_library_is_a_usage_refusal() {
        let dir = tempdir().unwrap();
        let point = dir.path().join("p.db");
        fixture(&point);
        assert_eq!(
            run(&argv(&["restore", &point.to_string_lossy()])),
            EXIT_USAGE
        );
    }

    #[test]
    fn restore_of_a_point_that_cannot_be_read_exits_two() {
        let dir = tempdir().unwrap();
        let garbage = dir.path().join("garbage.db");
        std::fs::write(&garbage, "this is not a database").unwrap();
        let library = dir.path().join("projects");
        assert_eq!(
            run(&argv(&[
                "restore",
                &garbage.to_string_lossy(),
                &library.to_string_lossy()
            ])),
            EXIT_UNREADABLE
        );
        assert!(
            !library.exists() || std::fs::read_dir(&library).unwrap().next().is_none(),
            "a refused restore left something in the library"
        );
    }

    #[test]
    fn restore_is_a_subcommand_so_it_never_opens_a_window() {
        // The window opens only when no subcommand is given, which is one rule
        // rather than two precisely because this list is the whole of it.
        assert!(is_subcommand("restore"));
    }

    #[test]
    fn an_argument_this_build_does_not_understand_exits_one() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let path = db.to_string_lossy().into_owned();
        assert_eq!(run(&argv(&["inspect", &path, "--depth"])), EXIT_USAGE);
        assert_eq!(run(&argv(&["inspect"])), EXIT_USAGE);
        assert_eq!(run(&argv(&["search", &path])), EXIT_USAGE);
        assert_eq!(run(&argv(&["nonsense", &path])), EXIT_USAGE);
        assert_eq!(run(&[]), EXIT_USAGE);
        assert_eq!(
            run(&argv(&["search", &path, "x", "--limit", "many"])),
            EXIT_USAGE
        );
        // 0 would return nothing from a search that matched, which reads as "no
        // matches" -- the one answer a search must not fake.
        assert_eq!(
            run(&argv(&["search", &path, "harbour", "--limit", "0"])),
            EXIT_USAGE
        );
    }

    #[test]
    fn a_project_that_cannot_be_read_exits_two() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nope.db").to_string_lossy().into_owned();
        let garbage = dir.path().join("garbage.db");
        std::fs::write(&garbage, "this is not a database").unwrap();
        let garbage = garbage.to_string_lossy().into_owned();
        for args in [
            vec!["inspect", &missing],
            vec!["validate", &missing],
            vec!["history", &missing],
            vec!["search", &missing, "x"],
            vec!["inspect", &garbage],
            vec!["validate", &garbage],
            vec!["search", &garbage, "x"],
        ] {
            assert_eq!(run(&argv(&args)), EXIT_UNREADABLE, "{args:?}");
        }
    }

    #[test]
    fn an_answer_that_is_itself_a_failure_exits_three() {
        // And it is exit 3 rather than exit 2 BECAUSE THE FILE WAS FINE. A
        // script that conflated the two would retry a search that will never
        // match, or give up on a project that is merely damaged.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let path = db.to_string_lossy().into_owned();
        assert_eq!(
            run(&argv(&["search", &path, "zzzznotinthisbook"])),
            EXIT_ANSWER_IS_FAILURE
        );
        damage(
            &db,
            "INSERT INTO doc VALUES ('ghost', '{\"type\":\"doc\",\"content\":[]}', 1, 0);",
        );
        assert_eq!(run(&argv(&["validate", &path])), EXIT_ANSWER_IS_FAILURE);
        // The control: the same file still INSPECTS fine, so exit 3 is about the
        // answer and not about the command having stopped working.
        assert_eq!(run(&argv(&["inspect", &path])), EXIT_OK);
    }

    // ---------------------------------------------------------- salvage

    /// The manifest's keys are the contract, in `--json` and in the written
    /// `manifest.json` alike -- one shape, serialized twice. A rename is a
    /// failing test here rather than a silently broken recovery script.
    /// A catalog that is not English -- see `salvage.rs`'s own copy for why
    /// every value differs from the English one and why the tag is `qq`.
    static PSEUDO_ENTRIES: &[(&str, &str)] = &[
        ("book.contents", "INHALT"),
        ("salvage.cast.appears", "ERSCHEINT IN:"),
        ("salvage.cast.characters", "FIGUREN"),
        ("salvage.cast.orphans", "ANGABEN OHNE FIGUR"),
        ("salvage.cast.places", "ORTE"),
        ("salvage.cast.poi", "PUNKTE"),
        ("salvage.covers.back", "RUECKSEITE"),
        ("salvage.covers.front", "VORDERSEITE"),
        ("salvage.snapshots.created", "ANGELEGT {at}"),
        ("salvage.snapshots.not_stored", "BYTES FEHLEN"),
        ("salvage.title.cast", "{name} :: BESETZUNG"),
        ("salvage.title.comments", "{name} :: NOTIZEN"),
        ("salvage.title.covers", "{name} :: UMSCHLAG"),
        ("salvage.title.snapshots", "{name} :: STAENDE"),
        ("salvage.title.synopses", "{name} :: ABRISSE"),
        ("salvage.title.wordlist", "{name} :: WORTLISTE"),
    ];
    static PSEUDO: crate::strings::Locale = crate::strings::Locale::new("qq", PSEUDO_ENTRIES);

    #[test]
    fn a_language_moves_the_writers_files_and_never_the_machine_contract() {
        // THE PER-SURFACE DECISION OF SLICE 055, AS A TEST. A recovery run in
        // another language must write the writer's files in it AND leave the
        // operator's two contracts exactly where they were: the JSON keys a
        // script reads, and the report line labels `salvage-read.ts` parses.
        //
        // All three claims are asserted together on purpose. Split apart, a
        // build that localized nothing satisfies the last two, and one that
        // localized everything satisfies the first.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);

        let out_en = dir.path().join("en");
        let out_other = dir.path().join("qq");
        let english = salvage::salvage(&db, &out_en).unwrap();
        let other =
            salvage::salvage_with(&db, &out_other, crate::strings::Strings::new(&PSEUDO)).unwrap();

        // The writer's file moved. The manuscript, because this module's
        // fixture is a book and not a cast list, and its generated contents is
        // 041's heading -- the first of the two strings this slice was written
        // for.
        let book_en = std::fs::read_to_string(out_en.join(salvage::MANUSCRIPT_NAME)).unwrap();
        let book_other = std::fs::read_to_string(out_other.join(salvage::MANUSCRIPT_NAME)).unwrap();
        assert_ne!(book_en, book_other);
        assert!(book_other.contains("INHALT"), "{book_other}");
        assert!(!book_other.contains("Contents"), "{book_other}");
        assert!(book_en.contains("Contents"), "{book_en}");

        // The JSON keys did not, at the top level or inside a loss.
        assert_eq!(keys_of(&english), keys_of(&other));
        let kinds = |v: &salvage::Salvage| -> Vec<String> {
            v.losses.iter().map(|l| l.kind.clone()).collect()
        };
        assert_eq!(kinds(&english), kinds(&other));

        // And the operator's report is byte-identical. `out_dir` is the path
        // the operator typed, so both are asked about the same one.
        assert_eq!(
            salvage_report(&english, &out_en),
            salvage_report(&other, &out_en)
        );
    }

    #[test]
    fn salvage_json_keys() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let v = salvage::salvage(&db, &dir.path().join("out")).unwrap();
        assert_eq!(
            keys_of(&v),
            vec![
                "analytics",
                "appearances_recovered",
                "cast",
                "cast_aliases_recovered",
                "cast_fields_recovered",
                "cast_members_recovered",
                "comments",
                "comments_orphaned",
                "comments_recovered",
                "complete",
                "covers",
                "covers_recovered",
                "design",
                "documents_recovered",
                "items_recovered",
                "knowledge",
                "knowledge_links_recovered",
                "losses",
                "manuscript",
                "manuscript_omitted",
                "meta",
                "name",
                "out_dir",
                "pictures",
                "pictures_recovered",
                "raw_bodies",
                "renamed",
                "research",
                "research_originals_recovered",
                "research_resources_recovered",
                "review",
                "review_recovered",
                "schema_version",
                "sidecars",
                "snapshots",
                "snapshots_recovered",
                "source",
                "source_bytes",
                "synopses",
                "synopses_recovered",
                "versions_dropped",
                "versions_recovered",
                "wordlist",
                "wordlist_recovered",
                "words",
            ]
        );
    }

    #[test]
    fn salvage_loss_json_keys() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        damage(
            &db,
            "INSERT INTO doc VALUES ('ghost', '{\"type\":\"doc\",\"content\":[]}', 1, 0);",
        );
        let v = salvage::salvage(&db, &dir.path().join("out")).unwrap();
        assert_eq!(keys_of(&v.losses[0]), vec!["detail", "item_id", "kind"]);
    }

    /// The two figures added to the report a PERSON reads. The JSON
    /// key set is the machine contract and has its own test; this is the other
    /// half, and it exists because a mutation that made the synopsis line lie
    /// survived the whole suite before `salvage_report` was extracted.
    #[test]
    fn the_report_names_the_pictures_even_when_there_are_none() {
        // `synopses` and `cast`'s rule, for the same reason: a writer looking
        // for their photographs must be told there were none in the file rather
        // than left to read an absent line as an absent feature.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        let members = crate::salvage::tests::fixture_with_everything(&db).2;
        let out = dir.path().join("bare");
        let bare = salvage_report(&crate::salvage::salvage(&db, &out).unwrap(), &out);
        assert!(bare.contains("pictures   0\n"), "{bare}");

        crate::salvage::tests::with_picture(&db, &members[0]);
        let out2 = dir.path().join("with");
        let with = salvage_report(&crate::salvage::salvage(&db, &out2).unwrap(), &out2);
        let dir = crate::salvage::PICTURES_DIR;
        assert!(with.contains(&format!("pictures   1 ({dir}/)")), "{with}");
    }

    /// THE TERMINAL IS THE OPERATOR'S AND THE MANIFEST IS EVERYBODY ELSE'S.
    ///
    /// `manifest.json` names files because it travels; the two lines that tell
    /// the person who ran the command where to look must go on naming the whole
    /// directory, or the fix for a disclosure quietly costs the operator the one
    /// sentence they need. The assertion is against a REAL absolute temporary
    /// directory, so a report printing `v.out_dir` fails it.
    #[test]
    fn the_report_names_the_directory_the_operator_typed() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        fixture(&db);
        let out = dir.path().join("recovered");

        let v = salvage::salvage(&db, &out).unwrap();
        let report = salvage_report(&v, &out);

        assert!(
            report.contains(&format!("out        {}\n", out.display())),
            "{report}"
        );
        assert!(
            report.contains(&format!(
                "manifest   {}/{}\n",
                out.display(),
                salvage::MANIFEST_NAME
            )),
            "{report}"
        );
        // The other half of the same claim: what the report spells out in full,
        // the file it points at does not.
        assert_eq!(v.out_dir, "recovered");
    }

    #[test]
    fn the_report_names_the_covers_even_when_there_are_none() {
        // `pictures`' rule one owner further out, and it matters MORE here:
        // nought photographs is a book with no photographs, and nought covers is
        // a book whose front page has to be redrawn. "0 of 2" says which of the
        // two facts it is without the reader knowing how many a book can have.
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        crate::salvage::tests::fixture_with_everything(&db);
        let out = dir.path().join("bare");
        let bare = salvage_report(&crate::salvage::salvage(&db, &out).unwrap(), &out);
        assert!(bare.contains("covers     0 of 2\n"), "{bare}");
    }

    #[test]
    fn salvage_report_states_the_synopses_and_the_cast() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        {
            let store = Store::open(&db).unwrap();
            let scene = store
                .items()
                .unwrap()
                .into_iter()
                .find(|i| i.item_type == "scene")
                .unwrap();
            store
                .synopsis_set(&scene.id, "she burns the letter")
                .unwrap();
            let ada = store.cast_create("character", "Ada").unwrap();
            store
                .cast_set(
                    &ada.id,
                    "character",
                    "Ada",
                    "",
                    &[store::cast::CastField {
                        label: "Eyes".into(),
                        value: "grey".into(),
                    }],
                    &[],
                )
                .unwrap();
        }
        let out = dir.path().join("out");
        let v = salvage::salvage(&db, &out).unwrap();
        let report = salvage_report(&v, &out);
        assert!(report.contains("synopses   1 (synopses.md)\n"), "{report}");
        assert!(
            report.contains("cast       1 member(s), 1 detail(s), 0 alias(es) (cast.md)\n"),
            "{report}"
        );

        // And a file that holds neither still SAYS so, rather than leaving the
        // reader to read an absent line as an absent feature.
        let bare = dir.path().join("bare.db");
        fixture(&bare);
        let bare_out = dir.path().join("bare-out");
        let w = salvage::salvage(&bare, &bare_out).unwrap();
        let report = salvage_report(&w, &bare_out);
        assert!(report.contains("synopses   0\n"), "{report}");
        assert!(
            report.contains("cast       0 member(s), 0 detail(s), 0 alias(es)\n"),
            "{report}"
        );
    }

    /// The two lines added to the report a PERSON reads, and the
    /// three states the design line has. The JSON key set is the machine
    /// contract and has its own test; this is the other half, and it exists
    /// because a mutation that made the synopsis line lie survived the whole
    /// suite before `salvage_report` was extracted.
    #[test]
    fn salvage_report_states_the_tags_and_the_design() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        crate::salvage::tests::fixture_with_everything(&db);
        {
            let store = Store::open(&db).unwrap();
            let member = store.cast_list().unwrap()[0].id.clone();
            let item = store.items().unwrap()[0].id.clone();
            store.appearances_set(&item, &[member]).unwrap();
            crate::design::write_design(&store, &crate::design::default_design()).unwrap();
        }
        let report = salvage_report(
            &salvage::salvage(&db, &dir.path().join("out")).unwrap(),
            &dir.path().join("out"),
        );
        assert!(report.contains("appears    1 tag(s)\n"), "{report}");
        assert!(report.contains("design     3 of 7 recorded\n"), "{report}");
        // The KEYS and the values verbatim: this is the one part of a recovery
        // a person retypes rather than reads.
        assert!(
            report.contains("  design.page          152400x228600 trade\n"),
            "{report}"
        );
        assert!(!report.contains("design.glyph"), "{report}");

        // A file that holds neither still SAYS so, rather than leaving the
        // reader to read an absent line as an absent feature.
        let bare = dir.path().join("bare.db");
        fixture(&bare);
        let report = salvage_report(
            &salvage::salvage(&bare, &dir.path().join("bare-out")).unwrap(),
            &dir.path().join("bare-out"),
        );
        assert!(report.contains("appears    0 tag(s)\n"), "{report}");
        assert!(report.contains("design     0 of 7 recorded\n"), "{report}");

        // And a `meta` table that would not answer is UNREADABLE, which is not
        // the same sentence as "nought of seven".
        let broken = dir.path().join("broken.db");
        fixture(&broken);
        damage(&broken, "DROP TABLE meta;");
        let report = salvage_report(
            &salvage::salvage(&broken, &dir.path().join("broken-out")).unwrap(),
            &dir.path().join("broken-out"),
        );
        assert!(report.contains("design     unreadable\n"), "{report}");
    }

    /// The two lines added to the report a PERSON reads, both at zero.
    /// The JSON key set is the machine contract and has its own test; this is
    /// the other half, and it exists because a mutation that made the
    /// synopsis line lie survived the whole suite before `salvage_report` was
    /// extracted.
    #[test]
    fn salvage_report_states_the_notes_and_the_wordlist() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        crate::salvage::tests::fixture_with_comments(&db);
        {
            let store = Store::open(&db).unwrap();
            store.dict_add("Zorbulax").unwrap();
        }
        let report = salvage_report(
            &salvage::salvage(&db, &dir.path().join("out")).unwrap(),
            &dir.path().join("out"),
        );
        assert!(
            report.contains("comments   3 note(s), 0 orphaned (comments.md)\n"),
            "{report}"
        );
        assert!(
            report.contains("wordlist   1 word(s) (wordlist.md)\n"),
            "{report}"
        );

        // A note whose passage an edit destroyed is COUNTED as orphaned and is
        // not a loss, which is the distinction this figure exists to draw.
        let hurt = dir.path().join("hurt.db");
        crate::salvage::tests::fixture_with_comments(&hurt);
        damage(
            &hurt,
            "UPDATE comment SET anchor_to = anchor_from WHERE id = 1;",
        );
        let hurt_out = dir.path().join("hurt-out");
        let v = salvage::salvage(&hurt, &hurt_out).unwrap();
        assert!(v.complete, "{:?}", v.losses);
        assert!(
            salvage_report(&v, &hurt_out)
                .contains("comments   3 note(s), 1 orphaned (comments.md)\n"),
            "{}",
            salvage_report(&v, &hurt_out)
        );

        // And a file that holds neither still SAYS so, rather than leaving the
        // reader to read an absent line as an absent feature.
        let bare = dir.path().join("bare.db");
        fixture(&bare);
        let report = salvage_report(
            &salvage::salvage(&bare, &dir.path().join("bare-out")).unwrap(),
            &dir.path().join("bare-out"),
        );
        assert!(
            report.contains("comments   0 note(s), 0 orphaned\n"),
            "{report}"
        );
        assert!(report.contains("wordlist   0 word(s)\n"), "{report}");
    }

    /// The two lines added here, and the second is the load-bearing one: a
    /// dropped automatic version is NOT a loss and so appears in no loss list.
    /// If it is not on this line it is nowhere, which would be the silence the
    /// earlier fixes exist to end, reintroduced inside the fix for it.
    ///
    /// Read back through `salvage_report` because nothing in this crate had ever
    /// read a `print_*` back until this was extracted, and a mutation that made
    /// one of these lines lie would otherwise survive the whole suite.
    #[test]
    fn salvage_report_states_the_snapshots_and_what_it_dropped() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("book.db");
        crate::salvage::tests::fixture_with_history(&db);
        let report = salvage_report(
            &salvage::salvage(&db, &dir.path().join("out")).unwrap(),
            &dir.path().join("out"),
        );
        assert!(
            report.contains("snapshots  3 named, 6 document(s) (snapshots.md)\n"),
            "{report}"
        );
        assert!(
            report.contains("versions   2 automatic version(s) not recovered\n"),
            "{report}"
        );

        // And a book with no history SAYS so at zero, rather than leaving the
        // reader to read an absent line as an absent feature.
        let bare = dir.path().join("bare.db");
        fixture(&bare);
        let report = salvage_report(
            &salvage::salvage(&bare, &dir.path().join("bare-out")).unwrap(),
            &dir.path().join("bare-out"),
        );
        assert!(
            report.contains("snapshots  0 named, 0 document(s)\n"),
            "{report}"
        );
        assert!(
            report.contains("versions   0 automatic version(s) not recovered\n"),
            "{report}"
        );
    }

    /// The three exit codes salvage can produce, driven through `run` -- which
    /// is the only place the mapping from a `salvage::Refusal` to a code is
    /// stated, and the only place a test can see it.
    #[test]
    fn salvage_exit_codes() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let path = db.to_string_lossy().into_owned();

        // 0: recovered everything, nothing lost.
        let clean = dir.path().join("clean");
        assert_eq!(
            run(&argv(&["salvage", &path, &clean.to_string_lossy()])),
            EXIT_OK
        );

        // 1: the output directory already exists. The SOURCE is fine, so this
        // must not read as "could not open the project".
        assert_eq!(
            run(&argv(&["salvage", &path, &clean.to_string_lossy()])),
            EXIT_USAGE
        );
        // 1: a missing argument, before anything is opened at all.
        assert_eq!(run(&argv(&["salvage", &path])), EXIT_USAGE);

        // 2: a zero-byte file. SQLite reads one as an EMPTY DATABASE, so this
        // is the case that would otherwise report a truncated manuscript as a
        // project with nothing in it.
        let empty = dir.path().join("empty.db");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(
            run(&argv(&[
                "salvage",
                &empty.to_string_lossy(),
                &dir.path().join("e").to_string_lossy()
            ])),
            EXIT_UNREADABLE
        );

        // 3: it answered, and the answer carries losses.
        damage(
            &db,
            "INSERT INTO doc VALUES ('ghost', '{\"type\":\"doc\",\"content\":[]}', 1, 0);",
        );
        assert_eq!(
            run(&argv(&[
                "salvage",
                &path,
                &dir.path().join("damaged").to_string_lossy()
            ])),
            EXIT_ANSWER_IS_FAILURE
        );
    }

    #[test]
    fn every_name_main_dispatches_on_is_a_command_run_understands() {
        // `main()` decides whether to open a window by asking `is_subcommand`.
        // A name in that list with no arm in `dispatch` would exit 1 on a
        // command the binary advertises; a name in an arm but not in the list
        // would open a WINDOW instead of running, which on a headless machine is
        // a failure with no explanation at all.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        for name in SUBCOMMANDS {
            assert!(is_subcommand(name));
            // Driven with too few arguments on purpose: reaching USAGE means the
            // arm exists, and no arm means the "not a subcommand" branch, which
            // is also USAGE -- so the discriminator is the message.
            assert!(
                USAGE.contains(name),
                "{name} is dispatched and not documented"
            );
        }
        assert!(!is_subcommand("--seed"));
        assert!(!is_subcommand("--crash-child"));
    }

    #[test]
    fn export_writes_an_epub_when_the_operator_asks_for_one() {
        // THE OFFLINE CHECK'S ENTRY POINT. There is no EPUB validator in this
        // tree and no rig writes one, so the way the artifact was actually
        // verified is this subcommand plus a validator on the operator's
        // machine -- which is a reproducible step in the write-back rather than
        // a claim. It also means a script can ask for either file.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let dest = dir.path().join("out.epub");
        let r = export(&db, &dest, export::Format::Epub).unwrap();
        assert_eq!(r.format, "epub");
        let bytes = std::fs::read(&dest).unwrap();
        assert_eq!(&bytes[30..38], b"mimetype");
    }

    #[test]
    fn export_writes_a_docx_whose_heading_count_matches_the_walk() {
        // NOT `soffice --headless --convert-to txt` -- that is not a unit-test
        // dependency, and the plan author's evidence run covers it separately.
        // What a unit test CAN check without LibreOffice is that the package
        // this subcommand wrote holds one styled paragraph per walked item:
        // `fixture` seeds three items (Part One, Opening, Second), so Title
        // plus three headings is four, read back through the same `read_zip` +
        // `heading_walk` the module's own tests use.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let dest = dir.path().join("out.docx");
        let r = export(&db, &dest, export::Format::Docx).unwrap();
        assert_eq!(r.format, "docx");
        let bytes = std::fs::read(&dest).unwrap();
        let entries = crate::epub::read_zip(&bytes).unwrap();
        let doc = entries
            .iter()
            .find(|(name, _)| name == "word/document.xml")
            .expect("a docx package carries word/document.xml");
        let xml = String::from_utf8_lossy(&doc.1);
        let walked = crate::docx::heading_walk(&xml);
        // Title plus one heading per item the walk carries -- `fixture`'s
        // part and its two scenes.
        assert_eq!(walked.len(), 4);
        assert_eq!(walked[0].0, "Title");
        assert_eq!(
            walked[1..]
                .iter()
                .map(|(_, t)| t.as_str())
                .collect::<Vec<_>>(),
            vec!["Part One", "Opening", "Second"]
        );
    }

    #[test]
    fn a_format_this_build_does_not_write_is_a_usage_error_and_not_a_markdown_file() {
        // A WORD THIS BUILD HAS NO RENDERER FOR. It was `pdf` until this
        // build gained one, which is exactly the drift a literal in a test
        // acquires -- the assertion went on passing for a format that had
        // become real and would have kept passing for every format after it.
        assert!(parse(&["export".into(), "--format".into(), "postscript".into()]).is_err());
        // And the three this build DOES write all parse, so the refusal above
        // is about the word and not about the option.
        for format in export::Format::ALL {
            let parsed = parse(&["export".into(), "--format".into(), format.id().into()])
                .expect("a format this build writes");
            assert_eq!(parsed.format, format);
        }
        assert!(parse(&["export".into(), "--format".into()]).is_err());
    }

    // -------------------------------------------------------------- import

    /// A minimal Markdown source, written to `dir/name`, for the `import`
    /// subcommand's own tests -- kept apart from `main.rs`'s `import_fixture`
    /// (private to that module's tests) rather than reached across the
    /// crate.
    fn write_manuscript(dir: &Path, name: &str, source: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, source).unwrap();
        path
    }

    #[test]
    fn import_json_keys() {
        let dir = tempdir().unwrap();
        let source = write_manuscript(dir.path(), "book.md", "# The Harbour\n\n## One\n\ntext\n");
        let library = dir.path().join("library");
        let r = import(dir.path(), &source, &library).unwrap();
        assert_eq!(keys_of(&r), vec!["items", "losses", "name", "path"]);
        assert_eq!(
            keys_of(&r.losses),
            vec!["comments", "fields", "links", "lists", "notes", "pictures", "revisions", "tables"]
        );
    }

    #[test]
    fn import_creates_a_project_and_reports_its_name_and_item_count() {
        let dir = tempdir().unwrap();
        let source = write_manuscript(dir.path(), "book.md", "# The Harbour\n\n## One\n\ntext\n");
        let library = dir.path().join("library");
        let r = import(dir.path(), &source, &library).unwrap();
        assert_eq!(r.name, "The Harbour");
        assert_eq!(r.items, 1);
        assert_eq!(r.losses, crate::docx_import::Losses::default());
        assert!(Path::new(&r.path).exists());
    }

    #[test]
    fn import_accepts_a_same_named_book_in_a_separate_library() {
        let dir = tempdir().unwrap();
        let source = write_manuscript(dir.path(), "book.md", "# The Harbour\n\n## One\n\ntext\n");
        let library = dir.path().join("library");
        let remembered = dir.path().join("elsewhere").join("the-harbour.db");
        std::fs::create_dir_all(remembered.parent().unwrap()).unwrap();
        let remembered_store = Store::open(&remembered).unwrap();
        let remembered_id = remembered_store.book_id().unwrap().unwrap();
        drop(remembered_store);
        let remembered_before = std::fs::read(&remembered).unwrap();
        let imported = import(dir.path(), &source, &library).expect("a same-named import");
        let imported_id = Store::open_readonly(Path::new(&imported.path)).unwrap().book_id().unwrap().unwrap();

        assert_eq!(std::fs::read(&remembered).unwrap(), remembered_before);
        assert_ne!(remembered_id, imported_id);
    }

    /// THE DISPATCH ROUTE, argv in and an exit code out -- `import` reaches
    /// `dispatch` exactly as every other subcommand does.
    #[test]
    fn dispatch_runs_import() {
        let dir = tempdir().unwrap();
        let source = write_manuscript(dir.path(), "book.md", "# Book\n\n## One\n\ntext\n");
        let library = dir.path().join("library");
        let code = run(&argv(&[
            "import",
            source.to_str().unwrap(),
            library.to_str().unwrap(),
            "--json",
        ]));
        assert_eq!(code, EXIT_OK);
    }


    /// A DOCX BUILT BY THIS CRATE'S OWN EXPORT ROUND-TRIPS THROUGH THIS
    /// SUBCOMMAND: items land and the loss report is all zero, the same
    /// promise `docx_import`'s own round-trip test makes for the library
    /// path.
    #[test]
    fn importing_this_crates_own_docx_has_items_and_no_losses() {
        let dir = tempdir().unwrap();
        let book = crate::export::Book {
            name: "The Harbour",
            contents_title: "Contents",
            front: &[],
            chapters: &[("s1".to_string(), "One".to_string(), 0i64)],
            back: &[],
        };
        let bodies = std::collections::HashMap::new();
        let docx = crate::docx::render(&book, &bodies, "en");
        let source = dir.path().join("book.docx");
        std::fs::write(&source, &docx.bytes).unwrap();
        let library = dir.path().join("library");

        let r = import(dir.path(), &source, &library).unwrap();
        assert!(r.items > 0, "{r:?}");
        assert_eq!(r.losses, crate::docx_import::Losses::default());
    }

    /// A TABLE PARAGRAPH IN A DOCX IS COUNTED as a loss and SURVIVES INTO
    /// `--json`: `emit`'s JSON is exactly `ImportResult`'s own `Serialize`,
    /// so asserting on the serialized string is the same contract the
    /// subcommand's `--json` flag hands a script.
    #[test]
    fn a_docx_table_paragraph_is_a_loss_in_json() {
        const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        let document_xml = format!(
            "<?xml version=\"1.0\"?><w:document xmlns:w=\"{W_NS}\"><w:body>\
             <w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>\
             <w:p><w:r><w:t>prose</w:t></w:r></w:p>\
             </w:body></w:document>"
        );
        let bytes =
            crate::epub::zip(&[crate::epub::Entry::text("word/document.xml", &document_xml)]);
        let dir = tempdir().unwrap();
        let source = dir.path().join("table.docx");
        std::fs::write(&source, &bytes).unwrap();
        let library = dir.path().join("library");

        let r = import(dir.path(), &source, &library).unwrap();
        assert_eq!(r.losses.tables, 1, "{r:?}");
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"tables\":1"), "{json}");
    }

    /// A MISSING SOURCE FILE IS A REFUSAL WITH A NON-ZERO EXIT, not a panic
    /// and not a silently empty project.
    #[test]
    fn a_missing_source_file_is_refused_with_a_nonzero_exit() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("absent.md");
        let library = dir.path().join("library");
        assert!(import(dir.path(), &source, &library).is_err());

        let code = run(&argv(&[
            "import",
            source.to_str().unwrap(),
            library.to_str().unwrap(),
        ]));
        assert_ne!(code, EXIT_OK);
    }

    /// A MISSING LIBRARY DIRECTORY IS STILL CREATED: `import` shares
    /// `projects::create_imported`'s own behaviour rather than requiring the
    /// caller to make the directory first.
    #[test]
    fn a_missing_library_directory_is_created() {
        let dir = tempdir().unwrap();
        let source = write_manuscript(dir.path(), "book.md", "# The Harbour\n\n## One\n\ntext\n");
        let library = dir
            .path()
            .join("does")
            .join("not")
            .join("exist")
            .join("yet");
        assert!(!library.exists());

        let r = import(dir.path(), &source, &library).unwrap();
        assert!(library.exists());
        assert!(Path::new(&r.path).exists());
    }

    // ----------------------------------------------------------- preflight

    #[test]
    fn mirror_preview_cli_uses_the_resolved_destination_and_writes_nothing() {
        let home = tempdir().unwrap();
        let db = home.path().join("book.db");
        let store = Store::open(&db).unwrap();
        store.set_meta(projects::NAME_KEY, "A Book").unwrap();
        drop(store);
        let root = home.path().join("custom-mirror-root");
        let preview = mirror_preview_with(&db, home.path(), Some(&root)).unwrap();
        assert!(preview.dir.starts_with(root.to_str().unwrap()));
        assert_eq!(preview.check_state, crate::identity::STATE_NOT_APPLICABLE);
        assert!(preview.token.is_none());
        assert!(!root.exists(), "a read-only CLI preview may not create the destination");
        let keys = serde_json::to_value(&preview).unwrap().as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys, ["check_state", "dir", "files", "findings", "limits", "pin_state", "scope", "token"]);
    }

    /// A project with one scene whose prose names `name_in_body`, so the
    /// cross-identity scan has something to find. Returns the scene's item id
    /// for the finding's `item_id` to be checked against.
    fn fixture_with_body_naming(db: &Path, name_in_body: &str) -> String {
        let store = Store::open(db).unwrap();
        store.set_meta(projects::NAME_KEY, "The Harbour").unwrap();
        // Under a part, `fixture`'s shape, so the scan is shown reaching a
        // nested body and not only a root one.
        let part = store.item_create(None, "part", "Part One").unwrap();
        let scene = store.item_create(Some(&part.id), "scene", "Opening").unwrap();
        store
            .flush(&[FlushEntry {
                item_id: scene.id.clone(),
                body: body(&format!("and then {name_in_body} walked in")),
                base_rev: scene.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        scene.id
    }

    /// A vault of `(id, name)` pairs, written whole into a tempdir data home
    /// -- NEVER through `XDG_DATA_HOME`, `identity::write_vault`'s own
    /// discipline and the one this module's tests must keep to.
    fn write_vault_at(data_home: &Path, names: &[(&str, &str)]) {
        let vault = crate::identity::Vault {
            version: crate::identity::VAULT_VERSION,
            identities: names
                .iter()
                .map(|(id, name)| {
                    let mut i = crate::identity::Identity {
                        id: (*id).to_string(),
                        rev: 1,
                        ..crate::identity::Identity::default()
                    };
                    i.public.name = (*name).to_string();
                    i
                })
                .collect(),
        };
        crate::identity::write_vault(data_home, &vault).unwrap();
    }

    /// Pin the project to `id`/`name`, through the store's `meta` the way the
    /// application itself would.
    fn pin_project_to(db: &Path, id: &str, name: &str) {
        let store = Store::open(db).unwrap();
        let identity = crate::identity::Identity {
            id: id.to_string(),
            rev: 1,
            public: crate::identity::Public {
                name: name.to_string(),
                ..crate::identity::Public::default()
            },
            ..crate::identity::Identity::default()
        };
        crate::identity::set_pin(&store, Some(&crate::identity::pin_of(&identity, 10))).unwrap();
    }

    #[test]
    fn is_subcommand_knows_preflight() {
        assert!(is_subcommand("preflight"));
    }

    #[test]
    fn no_vault_makes_cross_identity_not_applicable_and_the_answer_ok() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let home = tempdir().unwrap();
        let v = preflight_with(&db, export::Format::Markdown, home.path()).unwrap();
        assert!(v.ok);
        assert_eq!(v.blockers, 0);
        let state = v
            .checks
            .iter()
            .find(|c| c.name == crate::identity::CHECK_CROSS_IDENTITY)
            .unwrap();
        assert_eq!(state.state, crate::identity::STATE_NOT_APPLICABLE);
    }

    #[test]
    fn a_planted_other_identity_name_is_one_blocker_at_its_own_item() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        let item_id = fixture_with_body_naming(&db, "Bram Kell");
        let home = tempdir().unwrap();
        write_vault_at(home.path(), &[("i1", "Ada Vane"), ("i2", "Bram Kell")]);
        pin_project_to(&db, "i1", "Ada Vane");

        let v = preflight_with(&db, export::Format::Markdown, home.path()).unwrap();
        assert!(!v.ok);
        assert_eq!(v.blockers, 1, "{:?}", v.findings);
        let f = v
            .findings
            .iter()
            .find(|f| f.kind == crate::identity::FINDING_CROSS_IDENTITY)
            .expect("the cross-identity finding");
        assert_eq!(f.item_id.as_deref(), Some(item_id.as_str()));
        assert_eq!(f.matched, "Bram Kell");
    }

    #[test]
    fn the_same_vault_with_no_pin_warns_instead_of_blocking() {
        // The design's own rule: no pin is the HIGHEST-risk state, not the
        // lowest, and the check still runs -- it can only not call the match
        // this book's OWN leak, so it warns rather than blocks.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture_with_body_naming(&db, "Bram Kell");
        let home = tempdir().unwrap();
        write_vault_at(home.path(), &[("i1", "Ada Vane"), ("i2", "Bram Kell")]);

        let v = preflight_with(&db, export::Format::Markdown, home.path()).unwrap();
        assert!(v.ok, "{:?}", v.findings);
        assert_eq!(v.blockers, 0);
        assert!(v
            .findings
            .iter()
            .any(|f| f.kind == crate::identity::FINDING_CROSS_IDENTITY_UNPINNED));
    }

    #[test]
    fn a_pinned_vault_with_the_name_absent_runs_and_finds_nothing() {
        // NOT VACUOUS: the check had needles to look for and looked, it just
        // found none. `not_applicable` is reserved for an empty vault.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let home = tempdir().unwrap();
        write_vault_at(home.path(), &[("i1", "Ada Vane"), ("i2", "Bram Kell")]);
        pin_project_to(&db, "i1", "Ada Vane");

        let v = preflight_with(&db, export::Format::Markdown, home.path()).unwrap();
        assert!(v.ok);
        assert_eq!(v.blockers, 0);
        let state = v
            .checks
            .iter()
            .find(|c| c.name == crate::identity::CHECK_CROSS_IDENTITY)
            .unwrap();
        assert_eq!(state.state, crate::identity::STATE_RAN);
        assert!(!v
            .findings
            .iter()
            .any(|f| f.kind == crate::identity::FINDING_CROSS_IDENTITY));
    }

    #[test]
    fn an_unparseable_vault_is_unreadable_rather_than_an_empty_one() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let home = tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(crate::APP_DIR)).unwrap();
        std::fs::write(crate::identity::vault_path(home.path()), b"{").unwrap();

        assert!(preflight_with(&db, export::Format::Markdown, home.path()).is_err());
    }

    #[test]
    fn preflight_alone_is_a_usage_error() {
        assert_eq!(run(&argv(&["preflight"])), EXIT_USAGE);
    }

    #[test]
    fn preflight_of_a_missing_file_is_unreadable() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nosuch.db");
        assert_eq!(
            run(&argv(&["preflight", missing.to_str().unwrap()])),
            EXIT_UNREADABLE
        );
    }

    #[test]
    fn preflight_json_key_set_is_pinned_exactly() {
        // A PINNED, BLOCKING value, so `identity` and `findings` are populated
        // and their nested key sets are pinned too; on the no-vault fixture
        // `identity` is null and a rename inside `PinnedIdentity` would break
        // a script with no failing test.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture_with_body_naming(&db, "Bram Kell");
        let home = tempdir().unwrap();
        write_vault_at(home.path(), &[("i1", "Ada Vane"), ("i2", "Bram Kell")]);
        pin_project_to(&db, "i1", "Ada Vane");
        // EPUB, because markdown discloses no identity field and `fields`
        // would be empty with nothing nested to pin.
        let v = preflight_with(&db, export::Format::Epub, home.path()).unwrap();
        // IN ORDER, not sorted: the struct's own claim is `path` first and
        // `ok` last, `Validation`'s shape. `serde_json::Value` sorts its
        // keys, so the order is read off the serialised TEXT by the offset
        // of each top-level key; every key here is unique in the output
        // except `name`, which is why the nested keys are checked separately
        // below on the parsed value.
        let text = serde_json::to_string(&v).unwrap();
        let top = [
            "path",
            "format",
            "identity",
            "fields",
            "checks",
            "skipped",
            "findings",
            "surfaces_checked",
            "surfaces_unchecked",
            "blockers",
            "reason_history",
            "ok",
        ];
        let offsets: Vec<usize> = top
            .iter()
            .map(|k| text.find(&format!("\"{k}\":")).unwrap_or_else(|| panic!("{k} in {text}")))
            .collect();
        assert!(offsets.windows(2).all(|w| w[0] < w[1]), "{text}");
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json.as_object().unwrap().len(), top.len(), "{text}");
        let nested = |key: &str, index: Option<usize>| -> Vec<String> {
            let node = match index {
                Some(i) => &json[key][i],
                None => &json[key],
            };
            let mut keys: Vec<String> = node.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            keys
        };
        assert_eq!(nested("identity", None), ["identity_id", "name", "rev", "stale"]);
        assert_eq!(
            nested("findings", Some(0)),
            ["item_id", "kind", "matched", "offset", "severity", "surface"]
        );
        assert_eq!(nested("checks", Some(0)), ["name", "state"]);
        assert_eq!(nested("fields", Some(0)), ["at", "field", "value"]);
        assert_eq!(nested("reason_history", None), ["entries", "state"]);
    }

    #[test]
    fn preflight_exit_is_three_on_a_blocker_and_zero_otherwise() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture_with_body_naming(&db, "Bram Kell");
        let home = tempdir().unwrap();
        write_vault_at(home.path(), &[("i1", "Ada Vane"), ("i2", "Bram Kell")]);
        pin_project_to(&db, "i1", "Ada Vane");
        let blocked = preflight_with(&db, export::Format::Markdown, home.path()).unwrap();
        assert_eq!(blocked.blockers, 1);
        assert_eq!(preflight_exit(&blocked), EXIT_ANSWER_IS_FAILURE);

        // The same book with no pin: the name is a WARNING, and warnings
        // alone exit 0.
        crate::identity::set_pin(&Store::open(&db).unwrap(), None).unwrap();
        let warned = preflight_with(&db, export::Format::Markdown, home.path()).unwrap();
        assert_eq!(warned.blockers, 0);
        assert!(!warned.findings.is_empty());
        assert_eq!(preflight_exit(&warned), EXIT_OK);
    }

    #[test]
    fn preflight_report_says_no_pin_no_blockers_and_a_stale_pin() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        fixture(&db);
        let home = tempdir().unwrap();
        let v = preflight_with(&db, export::Format::Markdown, home.path()).unwrap();
        let report = preflight_report(&v);
        assert!(report.starts_with("no identity pinned\n"), "{report}");
        assert!(report.ends_with("no blockers\n"), "{report}");
        // The one finding with nothing matched ends its line at the surface.
        assert!(
            report.contains(&format!(
                "warning  {} in project\n",
                crate::identity::FINDING_IDENTITY_UNSET
            )),
            "{report}"
        );

        // A pin at rev 1 against a vault that has moved to rev 2 is stale.
        let vault = crate::identity::Vault {
            version: crate::identity::VAULT_VERSION,
            identities: vec![crate::identity::Identity {
                id: "i1".into(),
                rev: 2,
                public: crate::identity::Public {
                    name: "Ada Vane".into(),
                    ..crate::identity::Public::default()
                },
                ..crate::identity::Identity::default()
            }],
        };
        crate::identity::write_vault(home.path(), &vault).unwrap();
        pin_project_to(&db, "i1", "Ada Vane");
        let v = preflight_with(&db, export::Format::Markdown, home.path()).unwrap();
        assert!(
            preflight_report(&v).starts_with("pinned to Ada Vane (rev 1, stale)\n"),
            "{}",
            preflight_report(&v)
        );
    }

    #[test]
    fn preflight_report_names_its_cross_identity_scope_even_when_vacuous() {
        let v = CliPreflight {
            path: "p.db".into(),
            format: "markdown",
            identity: None,
            fields: vec![],
            checks: vec![crate::identity::CheckState {
                name: crate::identity::CHECK_CROSS_IDENTITY,
                state: crate::identity::STATE_VACUOUS,
            }],
            skipped: vec![crate::identity::CHECK_CROSS_IDENTITY],
            findings: vec![],
            surfaces_checked: vec!["title", "body"],
            surfaces_unchecked: vec!["comments", "mirror"],
            blockers: 0,
            reason_history: crate::warning_history::ReasonHistoryView::default(),
            ok: true,
        };
        let report = preflight_report(&v);
        assert!(report.contains("cross_identity           vacuous\n"), "{report}");
        assert!(
            report.contains(
                "cross-identity scope (known other-identity names only): title, body\n"
            ),
            "{report}"
        );
        assert!(report.contains("not checked: comments, mirror\n"), "{report}");

        let empty = CliPreflight {
            surfaces_checked: vec![],
            surfaces_unchecked: vec![],
            ..v
        };
        let report = preflight_report(&empty);
        assert!(
            report.contains("cross-identity scope (known other-identity names only): (none)\n"),
            "{report}"
        );
        assert!(report.contains("not checked: (none)\n"), "{report}");
    }

    #[test]
    fn preflight_reports_prior_reasons_without_changing_them() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        let store = store::Store::open(&db).unwrap();
        let initial = crate::commands::export::preflight_of_store(
            &store, "Book", export::Format::Markdown, &crate::identity::Vault::default(),
        ).unwrap();
        let token = &initial.warning_tokens[0].token;
        store.with_immediate(|store| crate::warning_history::append(store, &initial, token, "No byline for this draft", 42)).unwrap();
        let raw = store.get_meta(crate::warning_history::META_KEY).unwrap();
        drop(store);
        let home = tempdir().unwrap();
        let report = preflight_with(&db, export::Format::Markdown, home.path()).unwrap();
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["reason_history"]["entries"][0]["reason"], "No byline for this draft");
        assert!(preflight_report(&report).contains("prior warning reason (historical only)"));
        assert!(report.findings.iter().any(|finding| finding.kind == crate::identity::FINDING_IDENTITY_UNSET));
        let store = store::Store::open_readonly(&db).unwrap();
        assert_eq!(store.get_meta(crate::warning_history::META_KEY).unwrap(), raw);
    }

    #[test]
    fn preflight_report_prints_the_identity_the_checks_and_the_blocker_count() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        let item_id = fixture_with_body_naming(&db, "Bram Kell");
        let home = tempdir().unwrap();
        write_vault_at(home.path(), &[("i1", "Ada Vane"), ("i2", "Bram Kell")]);
        pin_project_to(&db, "i1", "Ada Vane");

        let v = preflight_with(&db, export::Format::Markdown, home.path()).unwrap();
        let report = preflight_report(&v);
        assert!(report.contains("pinned to Ada Vane (rev 1)"), "{report}");
        assert!(
            report.contains(&format!(
                "blocker  {} in document_body item {item_id}: Bram Kell",
                crate::identity::FINDING_CROSS_IDENTITY
            )),
            "{report}"
        );
        assert!(report.contains("1 blocker(s)"), "{report}");
    }
}
