use crate::{export_dir, locked, open_project, projects, store, DataHome, StoreState};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Debug, serde::Serialize)]
pub(crate) struct ExportResult {
    pub(crate) path: String,
    pub(crate) items: u64,
    pub(crate) words: u64,
    /// Underlined runs the Markdown could not carry. Markdown has no underline,
    /// so the mark is dropped -- and the drop is REPORTED, because a loss the
    /// writer is never told about is the class of silent loss this repo
    /// deliberately avoids. The page says it in the export notice.
    /// See `export::document_markdown_counted`.
    pub(crate) underlined: u64,
    /// WHICH FILE THIS IS, as `export::Format::id` spells it -- `"markdown"`
    /// today, and the reason this field exists before there is a second answer.
    /// The page words its own notice from it (`export-formats.ts`), so the
    /// value is a stable machine word and never a display name.
    ///
    /// Taken from the RENDER rather than from the caller's intention: a build
    /// that asked for one format and wrote another must report what it wrote.
    pub(crate) format: String,
    /// How many pages the written file holds, for a format that has pages.
    ///
    /// READ BACK OUT OF THE FILE, never taken from the renderer's intention --
    /// `pdf::pdf_page_count` over the bytes that landed. It is `None` for
    /// Markdown and for an EPUB, and that is the honest answer rather than a
    /// zero: a reflowable format has no page and a text file has no page, and a
    /// `0` there would be a claim that they have none.
    pub(crate) pages: Option<u32>,
    /// What this export was checked for, and what each check does and does not
    /// prove.
    ///
    /// IT TRAVELS WITH THE RESULT rather than being asked for separately,
    /// because a report a writer has to go and fetch is a report about an export
    /// that already happened. A BLOCKER never reaches here at all: it stops the
    /// render, so there is no file and no result.
    pub(crate) preflight: crate::identity::Preflight,
}

/// The catalog key for the heading the generated table of contents is written
/// under.
///
/// A KEY AND NO LONGER A CONSTANT. It was `CONTENTS_TITLE = "Contents"`,
/// and was left a parameter on `export::Book` precisely so a later change
/// could source it -- `export.rs` is pure and holds no writer-facing words of
/// its own, which `no_writer_facing_literal_in_the_renderers` now enforces.
/// The word comes from `strings`, which comes from the locale in
/// `settings.json`, which is the same file the theme comes from and the only
/// source a `app-shell-tauri export` run with no window can read.
pub(crate) const CONTENTS_KEY: &str = "book.contents";

/// Export the project at `path` into `dest`.
///
/// A free function over a path rather than the open `Store`, for the reason
/// `word_count_at` is one: the open store lives behind the mutex `doc_flush`
/// needs, and a full read of the manuscript through it would put the save path
/// behind a file write for as long as the export takes. It is also the only
/// shape a unit test can call -- a `#[tauri::command]` cannot be.
///
/// `open_readonly`, never `open`: `open` creates schema v1 on a blank file and
/// migrates, so using it to merely read WRITES. WAL gives this reader a
/// consistent snapshot, which makes the file "as saved at the moment it began".
pub(crate) fn export_to(
    path: &Path,
    name: &str,
    dest: &Path,
    vault: &crate::identity::Vault,
    strings: crate::strings::Strings,
) -> std::result::Result<ExportResult, String> {
    export_into(
        path,
        name,
        dest,
        Dest::New,
        crate::export::Format::Markdown,
        vault,
        strings,
    )
}

/// The same, as `format`. The two exist because `export_open_project` injects
/// its exporter as a three-argument function and every caller of THAT is
/// Markdown's automatic path; a fourth argument on the injection point would be
/// carried by every test that only ever passes one value.
#[cfg(test)]
pub(crate) fn export_as(
    path: &Path,
    name: &str,
    dest: &Path,
    format: crate::export::Format,
    vault: &crate::identity::Vault,
    strings: crate::strings::Strings,
) -> std::result::Result<ExportResult, String> {
    export_into(path, name, dest, Dest::New, format, vault, strings)
}

/// Whether the destination may already exist.
///
/// The two callers differ in who chose the name, and that is the whole
/// distinction. `project_export` picks its own free filename, so a collision
/// there is a race or a caller bug and never an intention — it must refuse.
/// `project_export_as` writes to a path the WRITER typed into an OS dialog that
/// already asked them about replacing it, and refusing that would be the
/// application overruling an answer the writer had just given.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Dest {
    New,
    Replace,
}

/// The temp file a `Dest::Replace` export lands in before the rename. A sibling
/// of the destination, deliberately: `rename` is only atomic within a
/// filesystem, and `/tmp` is a different one on this machine.
fn export_tmp_path(dest: &Path) -> PathBuf {
    let mut name = std::ffi::OsString::from(".");
    name.push(
        dest.file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("export")),
    );
    name.push(".tmp-export");
    dest.with_file_name(name)
}

pub(crate) fn export_into(
    path: &Path,
    name: &str,
    dest: &Path,
    mode: Dest,
    format: crate::export::Format,
    vault: &crate::identity::Vault,
    strings: crate::strings::Strings,
) -> std::result::Result<ExportResult, String> {
    // The three formats whose render IS the file. A PDF's is not: see
    // `export_into_with`.
    export_into_with(path, name, dest, mode, format, vault, strings, Ok)
}

/// The same, with the step that turns a render into the bytes that land.
///
/// THE INJECTION EXISTS BECAUSE ONE FORMAT NEEDS A DISPLAY AND THE OTHER THREE
/// DO NOT. `pdf::proof_document` answers with HTML; the PDF is what a web engine
/// makes of it, which needs a platform webview, its event loop and somewhere to
/// render -- none of which a `cargo test` has, and none of which belongs inside
/// a function whose subject is crash-safe file writing.
///
/// EVERYTHING BELOW THE CONVERSION IS UNCHANGED AND THAT IS THE POINT. The
/// `create_new` refusal, the sibling temp file, the rename and the reclaim are
/// the crash safety, not decoration, and a format that wrote its own file would
/// have quietly left all four behind. A test can pass a converter of its own and
/// prove that safety applies to the new format without a display anywhere.
pub(crate) fn export_into_with(
    path: &Path,
    name: &str,
    dest: &Path,
    mode: Dest,
    format: crate::export::Format,
    vault: &crate::identity::Vault,
    strings: crate::strings::Strings,
    convert: impl FnOnce(Vec<u8>) -> std::result::Result<Vec<u8>, String>,
) -> std::result::Result<ExportResult, String> {
    let (written, items, words, preflight) = render_project(path, name, format, vault, strings)?;
    let bytes = convert(written.bytes)?;
    let pages = match format {
        crate::export::Format::Pdf => Some(
            crate::pdf::pdf_page_count(&bytes)
                .ok_or_else(|| "the proof produced no pages".to_string())?,
        ),
        _ => None,
    };

    match mode {
        // `create_new` is the refusal, and it is the kernel's: an `exists()`
        // check first is a race, and the thing on the other side of that race is
        // a manuscript.
        Dest::New => {
            let file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dest)
                .map_err(|e| format!("{}: {e}", dest.display()))?;
            write_manuscript(file, dest, &bytes)?;
        }
        // Write beside the destination and rename over it. NOT `truncate(true)`
        // on `dest` itself: that destroys the writer's existing file at the
        // instant it opens, so an ENOSPC halfway through leaves them with
        // neither their old manuscript nor a complete new one. `write_manuscript`
        // reclaims the TEMP on failure, which is why the original survives a
        // failed replace untouched.
        Dest::Replace => replace_file(dest, &bytes)?,
    }

    Ok(ExportResult {
        path: dest.to_string_lossy().into_owned(),
        items,
        words,
        underlined: written.underlined_runs,
        format: written.format.id().to_string(),
        pages,
        preflight,
    })
}

/// Write `bytes` beside `dest` and rename over it: the `Dest::Replace` arm,
/// on its own so the statistics export (whose bytes the page composed) lands
/// with the same crash safety as a manuscript and not a second, weaker write.
pub(crate) fn replace_file(dest: &Path, bytes: &[u8]) -> std::result::Result<(), String> {
    let tmp = export_tmp_path(dest);
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    write_manuscript(file, &tmp, bytes)?;
    if let Err(e) = fs::rename(&tmp, dest) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{}: {e}", dest.display()));
    }
    Ok(())
}

/// The book at `path`, rendered as `format`, plus the two figures that describe
/// the BOOK rather than the file.
///
/// ONE RENDER FOR EVERY CALLER, and that is the design record's constraint met
/// by construction. `export_into` writes what comes back from here and
/// `preview_of` reads what comes back from here BACK OUT of the archive; there
/// is no second path a preview could be right on while the file is wrong.
///
/// `open_readonly`, never `open`, for `export_into`'s recorded reason: `open`
/// creates schema v1 on a blank file and migrates, so using it to merely read
/// WRITES. It is also what makes the preview safe to run while the writer is
/// typing.
fn render_project(
    path: &Path,
    name: &str,
    format: crate::export::Format,
    vault: &crate::identity::Vault,
    strings: crate::strings::Strings,
) -> std::result::Result<Rendered, String> {
    render_project_with(path, name, format, vault, strings, None)
}

/// What one render answers with: the bytes, the two figures that describe the
/// BOOK rather than the file, and what the export was checked for.
type Rendered = (crate::export::Manuscript, u64, u64, crate::identity::Preflight);

/// The same, with the bound a PREVIEW puts on how much markup comes back. Every
/// other format ignores it, which is why it is a parameter here and not a field
/// on `Format`: it is a property of the CALL and not of the file.
fn render_project_with(
    path: &Path,
    name: &str,
    format: crate::export::Format,
    vault: &crate::identity::Vault,
    strings: crate::strings::Strings,
    markup_limit: Option<u32>,
) -> std::result::Result<Rendered, String> {
    let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
    let book_id = store.book_id().map_err(|e| e.to_string())?;
    let Walked {
        front,
        chapters,
        back,
        bodies,
        openings,
    } = walk_of(&store)?;
    // ONE list for every question that is about the file as a whole -- the word
    // count below and the reported item count. A dedication is prose in the
    // exported file, so it is prose in the figure that describes it.
    let items: Vec<&(String, String, i64)> = front
        .iter()
        .chain(chapters.iter())
        .chain(back.iter())
        .collect();

    // Counted over the WALKED items only, not over every `doc` row, so the
    // figure describes the file that was written. `manuscript` emits prose for
    // `bodies.get(id)` of walked items and nothing else, so a `doc` row whose
    // item is not in the walk contributes no prose -- and must contribute no
    // words. Counting the whole map instead would make `project_word_count` and
    // this agree by sharing one omission, and `export_word_count_agrees` would
    // PASS with prose silently missing from the manuscript. Diverging is the
    // point: the graded gate is a tripwire, not a pair of matching blind spots.
    let mut index = store::WordIndex::default();
    for (item_id, _, _) in &items {
        if let Some(body) = bodies.get(item_id) {
            index.record(item_id, body);
        }
    }

    let contents_title = strings.t(CONTENTS_KEY);
    let book = crate::export::Book {
        name,
        contents_title: &contents_title,
        front: &front,
        chapters: &chapters,
        back: &back,
    };
    // THE PREFLIGHT, AND THIS IS THE ONE PLACE IT GOES.
    //
    // Every entry -- Export manuscript, Export as, the EPUB preview and the PDF
    // preview -- builds one `Book` here and then matches on `Format`, so a check
    // between the two sees the project name, the whole walk and every body, for
    // all four formats, once, and for previews as well as saves. Placed in the
    // four format arms instead it would be four checks with four drift paths,
    // and it would violate the one-table rule the field map rests on.
    //
    // PURE AND INJECTABLE: `identity::check` takes what is already in memory,
    // opens nothing and writes nothing, so it is unit-testable without a command
    // and without a display. It is also why the override log is NOT in this
    // slice: this function opens the store READ-ONLY and cannot record one.
    let pin = crate::identity::pin_of_project(&store)?;
    let planning = if crate::identity::has_needles(vault, pin.as_ref()) {
        planning_texts(&store)?
    } else { Vec::new() };
    let mut preflight = checked(format, name, vault, pin.as_ref(), &items, &bodies, &planning);
    preflight.reason_history = crate::warning_history::read(&store)?;
    // A CROSS-IDENTITY LEAK BLOCKS AND CANNOT BE DISMISSED. Section 8 says so in
    // those words, and the rule that stops a blocker being a trap is that a
    // check may only raise one if it can name the location of what it objects
    // to -- which a literal match has by definition. Everything else is a
    // warning and rides back on the result.
    if preflight.blockers > 0 {
        return Err(crate::identity::blocked_message(&preflight.findings));
    }

    let written = match format {
        crate::export::Format::Markdown => crate::export::manuscript(&book, &bodies),
        // A PROOF COPY, and what the render answers with is HTML: the
        // book laid out for a page, with the script that cuts it into leaves.
        // Turning that into PDF bytes is `printer.rs`'s job and the caller's
        // injected step.
        crate::export::Format::Pdf => {
            let design = crate::design::design_of(&store)?;
            let style = crate::design::chapter_style_of(&store)?;
            let cover = |side: &str| -> std::result::Result<Option<crate::pdf::Cover>, String> {
                let fit = crate::covers::fit_of(&store, side)?;
                Ok(crate::covers::cover_of(&store, side)?
                    .and_then(|stored| {
                        crate::pictures::original(&crate::pictures::dir_for(path), &stored)
                    })
                    .map(|(f, bytes)| crate::pdf::Cover {
                        bytes,
                        media_type: f.mime(),
                        fit,
                    }))
            };
            let html = crate::pdf::proof_document(&crate::pdf::Proof {
                language: strings.tag(),
                book: &book,
                bodies: &bodies,
                design: &design,
                style,
                openings,
                // BOTH COVERS. 043 recorded that an EPUB has one slot and the
                // back cover has nowhere to go; a bound book has a back and this
                // is where it goes.
                front_cover: cover(crate::covers::SIDE_FRONT)?,
                back_cover: cover(crate::covers::SIDE_BACK)?,
                markup_limit,
                pin: pin.as_ref(),
            });
            crate::export::Manuscript {
                bytes: html.into_bytes(),
                format: crate::export::Format::Pdf,
                // A PROOF COPY CARRIES THE UNDERLINE, exactly as the EPUB does
                // and for its reason: this is a measurement and not a default.
                underlined_runs: 0,
            }
        }
        crate::export::Format::Epub => {
            let design = crate::design::design_of(&store)?;
            let style = crate::design::chapter_style_of(&store)?;
            // THE FRONT COVER ONLY, and a cover whose file has gone leaves the
            // book without one rather than refusing the export. 038's rule --
            // a missing file does not clear the claim -- with the consequence
            // that belongs to an export: what went missing is the cover, not
            // the manuscript.
            let cover = crate::covers::cover_of(&store, crate::covers::SIDE_FRONT)?
                .and_then(|stored| {
                    crate::pictures::original(&crate::pictures::dir_for(path), &stored)
                })
                .map(|(f, bytes)| crate::epub::Cover {
                    bytes,
                    media_type: f.mime(),
                    extension: f.extension(),
                });
            crate::epub::manuscript(&crate::epub::Epub {
                book: &book,
                language: strings.tag(),
                bodies: &bodies,
                book_id: book_id.as_deref(),
                font: &design.font,
                style,
                openings,
                cover,
                modified: &crate::epub::iso8601_utc(now_seconds()),
                pin: pin.as_ref(),
            })?
        }
        // NEEDS NO DESIGN, NO COVER, NO DISPLAY -- unlike PDF, it works
        // on Windows, and the CLI export works headless. An editor's own
        // Word document is Letter/A4 by their own default and this only has
        // to be valid, so `docx::render` asks this function for nothing but
        // the book, the bodies and the language.
        crate::export::Format::Docx => crate::docx::render(&book, &bodies, strings.tag()),
    };
    Ok((written, items.len() as u64, index.count().words, preflight))
}

/// Seconds since the Unix epoch, or the epoch itself if this machine's clock is
/// set before it.
///
/// THE ONLY NON-DETERMINISTIC FACT IN AN EPUB, and it is one field of the
/// package document (`dcterms:modified`). Every zip entry carries a fixed
/// timestamp instead, so two exports of an unchanged book differ in exactly
/// those twenty bytes and a diff of two archives is still readable.
/// The book's three runs and every stored body: one statement of what an export
/// is about, so the render and the preflight-only path cannot walk differently.
///
/// Deleted items are not the manuscript, and neither is the bible. Filtering the
/// WALK rather than the bodies is what makes this one edit instead of two: the
/// word count is fed from the walked items, so an excluded scene leaves the
/// prose and the reported figure together, and `export_word_count_agrees` stays
/// a tripwire rather than a pair of matching blind spots.
struct Walked {
    front: Vec<(String, String, i64)>,
    chapters: Vec<(String, String, i64)>,
    back: Vec<(String, String, i64)>,
    bodies: std::collections::HashMap<String, String>,
    openings: crate::export::ChapterOpenings,
}

fn walk_of(store: &store::Store) -> std::result::Result<Walked, String> {
    let walk = store::book_walk(store.items().map_err(|e| e.to_string())?);
    let bodies = store.documents().map_err(|e| e.to_string())?;
    let mut openings = crate::export::ChapterOpenings::default();
    for item in &walk.chapters {
        if item.item_type == "chapter" || (item.depth == 0 && item.item_type != "part") {
            openings.styled.insert(item.id.clone());
        }
        if item.item_type == "chapter" || item.item_type == "part" {
            openings.page.insert(item.id.clone());
        }
    }
    let tuples = |rows: Vec<store::Item>| -> Vec<(String, String, i64)> {
        rows.into_iter().map(|i| (i.id, i.title, i.depth)).collect()
    };
    Ok(Walked {
        front: tuples(walk.front),
        chapters: tuples(walk.chapters),
        back: tuples(walk.back),
        bodies,
        openings,
    })
}

/// What this export would be checked for, without rendering it.
///
/// THE SAME INPUTS AND THE SAME `identity::check` the render uses, gathered by
/// the same `walk_of`. It exists because a BLOCKER stops a render, so the only
/// way a writer could ever read the report of a blocked export is a path that
/// does not render -- and a panel that asked for one by attempting an export
/// would have to succeed to say why it would fail.
pub(crate) fn preflight_of(
    path: &Path,
    name: &str,
    format: crate::export::Format,
    vault: &crate::identity::Vault,
) -> std::result::Result<crate::identity::Preflight, String> {
    let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
    preflight_of_store(&store, name, format, vault)
}

pub(crate) fn preflight_of_store(
    store: &store::Store,
    name: &str,
    format: crate::export::Format,
    vault: &crate::identity::Vault,
) -> std::result::Result<crate::identity::Preflight, String> {
    let Walked {
        front,
        chapters,
        back,
        bodies,
        openings: _,
    } = walk_of(&store)?;
    let items: Vec<&(String, String, i64)> =
        front.iter().chain(chapters.iter()).chain(back.iter()).collect();
    let pin = crate::identity::pin_of_project(&store)?;
    let planning = if crate::identity::has_needles(vault, pin.as_ref()) {
        planning_texts(&store)?
    } else { Vec::new() };
    let mut report = checked(format, name, vault, pin.as_ref(), &items, &bodies, &planning);
    report.reason_history = crate::warning_history::read(store)?;
    Ok(report)
}

fn planning_texts(store: &store::Store) -> std::result::Result<Vec<crate::identity::PlanningText>, String> {
    let mut out = Vec::new();
    for pass in store.revision_passes().map_err(|e| e.to_string())? {
        out.push(crate::identity::PlanningText {
            surface: "revision_pass_name", item_id: None, text: pass.name,
        });
        if let Some(purpose) = pass.purpose {
            out.push(crate::identity::PlanningText {
                surface: "revision_pass_purpose", item_id: None, text: purpose,
            });
        }
    }
    for task in store.revision_tasks().map_err(|e| e.to_string())? {
        out.push(crate::identity::PlanningText {
            surface: "revision_task_body", item_id: task.item_id, text: task.body,
        });
    }
    Ok(out)
}

/// The preflight over inputs already in memory.
///
/// ONE FUNCTION FOR BOTH CALLERS -- the render and the report -- so a project
/// cannot be checked one way when it is exported and another way when it is
/// asked about. Everything it decides lives in `identity::check`; this only
/// projects the walk into the shape that function takes.
fn checked(
    format: crate::export::Format,
    name: &str,
    vault: &crate::identity::Vault,
    pin: Option<&crate::identity::Pin>,
    items: &[&(String, String, i64)],
    bodies: &std::collections::HashMap<String, String>,
    planning: &[crate::identity::PlanningText],
) -> crate::identity::Preflight {
    let titles: Vec<(&str, &str)> = items
        .iter()
        .map(|(id, title, _)| (id.as_str(), title.as_str()))
        .collect();
    // THE PROSE IS PROJECTED ONLY WHEN THERE IS SOMETHING TO COMPARE IT
    // AGAINST. With an empty vault -- which is every installation today -- the
    // cross-identity check has no needles, reports `not_applicable`, and this
    // walk does not happen at all, so the export path costs exactly what it cost
    // before. `check` decides the answer either way; this only avoids building
    // an input nothing will read.
    let prose: Vec<(&str, String)> = if crate::identity::has_needles(vault, pin) {
        titles
            .iter()
            .filter_map(|(id, _)| {
                bodies
                    .get(*id)
                    .and_then(|body| crate::store::document_text(body))
                    .map(|text| (*id, text))
            })
            .collect()
    } else {
        Vec::new()
    };
    crate::identity::check(&crate::identity::Subject {
        format,
        project_name: name,
        titles: &titles,
        bodies: &prose,
        planning,
        pin,
        vault,
    })
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// One document of the preview, as it sits in the archive.
#[derive(Debug, serde::Serialize)]
pub(crate) struct PreviewDocument {
    /// Its path INSIDE the container. Not a path on this machine: nothing here
    /// names a file the page could ask for.
    pub(crate) name: String,
    pub(crate) xhtml: String,
}

/// What the rail paints: the book's own bytes, read back out of the archive
/// this application would have written.
#[derive(Debug, serde::Serialize)]
pub(crate) struct EpubPreview {
    pub(crate) documents: Vec<PreviewDocument>,
    pub(crate) css: String,
    /// The front cover as a data URI, or None. Cut from the bytes IN THE
    /// ARCHIVE and not from the file on disk, for this whole surface's reason:
    /// what is shown is what was packed.
    pub(crate) cover_data_uri: Option<String>,
    /// The figures the rail states, so a writer can see the preview is of their
    /// whole book and not of part of it.
    pub(crate) items: u64,
    pub(crate) words: u64,
}

/// Render the book at `path` as an EPUB and read the archive back.
///
/// THE UNZIP IS THE POINT. Handing the page the strings the renderer happened
/// to build would be a preview that agrees with itself; reading them out of the
/// packed bytes is a preview that agrees with the FILE, and it exercises the
/// container writer, the CRCs and the reading order on every open.
pub(crate) fn preview_of(
    path: &Path,
    name: &str,
    vault: &crate::identity::Vault,
    strings: crate::strings::Strings,
) -> std::result::Result<EpubPreview, String> {
    let (written, items, words, _) =
        render_project(path, name, crate::export::Format::Epub, vault, strings)?;
    let entries = crate::epub::read_zip(&written.bytes)?;
    let documents = crate::epub::reading_order(&entries)
        .into_iter()
        .map(|(name, xhtml)| PreviewDocument { name, xhtml })
        .collect();
    let named = |wanted: String| {
        entries
            .iter()
            .find(|(n, _)| *n == wanted)
            .map(|(_, b)| b.clone())
    };
    let css = named(format!("{}/{}", crate::epub::OEBPS, crate::epub::CSS_HREF))
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let cover_data_uri = entries
        .iter()
        .find(|(n, _)| {
            n.starts_with(&format!("{}/cover.", crate::epub::OEBPS)) && !n.ends_with(".xhtml")
        })
        .map(|(n, bytes)| {
            let mime = if n.ends_with(".png") {
                crate::pictures::Format::Png.mime()
            } else {
                crate::pictures::Format::Jpeg.mime()
            };
            format!("data:{mime};base64,{}", crate::pictures::base64(bytes))
        });
    Ok(EpubPreview {
        documents,
        css,
        cover_data_uri,
        items,
        words,
    })
}

/// What the rail paints for a proof copy: leaves, and what the render learned
/// about the book while it laid them out.
#[derive(Debug, serde::Serialize)]
pub(crate) struct PdfPreview {
    /// Each leaf, as the markup the printer was handed. Bounded by
    /// `pdf::PREVIEW_LEAVES`; `leaves` is the whole book either way.
    pub(crate) pages: Vec<String>,
    /// The leaves' stylesheet WITHOUT the `@page` rule. Every rule that decides
    /// a line break is here; the one the preview cannot scope is not.
    pub(crate) css: String,
    pub(crate) leaves: u32,
    pub(crate) truncated: bool,
    /// The family 040 stored, and whether it resolved to a face on THIS
    /// machine. A proof copy set in a substitute with nothing saying so is a
    /// proof copy that lies about itself -- 040 recorded the gap and this is
    /// the measurement that closes it.
    pub(crate) font: String,
    pub(crate) font_resolved: bool,
    /// KDP's gutter minimum for a book of this many pages, and the inner margin
    /// the writer set, both in micrometres. `None` for a page count outside the
    /// range they print. 040 left this open because nothing knew the page
    /// count; a laid-out proof does.
    pub(crate) gutter_minimum_um: Option<i64>,
    pub(crate) inner_um: i64,
    pub(crate) items: u64,
    pub(crate) words: u64,
}

/// Write the manuscript through `file`, durably, and reclaim `dest` if it fails.
///
/// Two things the plain `write_all` did not do:
///
///  - `sync_all`. An export is the copy a writer made for safety; a file that is
///    only in the page cache is not that copy. The store already runs
///    `synchronous = FULL` for the same reason.
///  - The removal. A failed write (ENOSPC is the realistic one) otherwise leaves
///    a truncated manuscript at the picked path, `pick_export_path` advances past
///    it forever, and its name is indistinguishable in form from a good one. A
///    file that never fully existed must not survive as one.
///
/// Takes the open handle rather than opening it, so the failure path is
/// reachable from a test: the caller's `create_new` open is what makes a
/// write-failure destination impossible to construct through the path alone.
/// BYTES, not `&str`. An EPUB is a zip container and a PDF is
/// binary; a writer that could only take text would have to be rewritten by the
/// change that adds the first of them, and the `Dest::New` / `Dest::Replace`
/// crash safety above it -- the `create_new` refusal, the sibling temp file, the
/// rename, the reclaim -- would be rewritten with it. That safety is the reason
/// this function exists and it is unchanged: only the type of what it writes
/// moved.
pub(crate) fn write_manuscript(
    mut file: fs::File,
    dest: &Path,
    bytes: &[u8],
) -> std::result::Result<(), String> {
    match file.write_all(bytes).and_then(|()| file.sync_all()) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Best effort: if the removal also fails there is nothing further to
            // try, and the write error is the one worth reporting.
            let _ = fs::remove_file(dest);
            Err(format!("{}: {e}", dest.display()))
        }
    }
}

/// The file name stem for a project's export. `slugify` returns None when the
/// name holds nothing that survives it, and `.md` alone is a hidden file with no
/// name rather than a manuscript the writer can find.
pub(crate) fn export_slug(name: &str) -> String {
    projects::slugify(name).unwrap_or_else(|| "manuscript".to_string())
}

/// Write the open project to a Markdown file and say where it went.
///
/// TAKES NO PATH, and must not gain one. `may_open`/`in_library` exist to stop a
/// page-supplied path naming a file outside the library; a destination argument
/// would be the same crossing outbound, as a write, from a webview. Declining
/// the argument is stronger than validating it.
///
/// `APP_EXPORT_DIR` overrides the destination directory, in the same spirit as
/// `APP_PROJECT`: an operator escape hatch, read in Rust only and never
/// interpolated into the page's init script, so it needs no `js_string`.
#[command_boundary::command]
pub(crate) fn project_export(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
) -> std::result::Result<ExportResult, String> {
    export_open_project(&state, &data_home.0, export_to)
}

/// The vault, or a refusal that STOPS whatever asked for it.
///
/// THE ONE RULE THIS SLICE RESTS ON. A vault that will not parse must never read
/// as an empty one, because an empty vault makes the cross-identity check report
/// that it found nothing -- on the machine where there was something to find.
/// `read_settings` beside it does the opposite and is right to: losing a theme
/// costs a click.
pub(crate) fn vault_for(data_home: &Path) -> std::result::Result<crate::identity::Vault, String> {
    crate::identity::read_vault(data_home).map_err(|e| e.to_string())
}

/// The language the host writes in, for any caller that has a data home.
///
/// LENIENT, AND DELIBERATELY THE OPPOSITE OF `vault_for` DIRECTLY ABOVE IT. An
/// unreadable vault must stop the export, because an empty one makes the
/// cross-identity check report it found nothing on the machine where there was
/// something to find. An unreadable settings file costs the writer English --
/// `read_settings`' own recorded rule -- and refusing to export over it would
/// be worse than exporting in the wrong language.
///
/// READ AT EXPORT TIME rather than taken from the startup injection, so a
/// writer who changes the language and exports gets the language they chose,
/// and so a CLI run -- which has no startup injection at all -- reads the same
/// file the window would have.
pub(crate) fn strings_for(data_home: &Path) -> crate::strings::Strings {
    crate::projects::read_settings(data_home).locale.strings()
}

/// The whole of `project_export` except unwrapping Tauri's `State`, which is the
/// only part a `#[tauri::command]` signature makes untestable.
///
/// The lock discipline is HERE, and it is asserted rather than asserted-about:
/// the path and name come out under the guard, the guard drops with that block,
/// and the O(manuscript) work runs off-mutex. The previous slice found
/// `project_word_count` holding this same lock across a full scan -- a deadlock
/// proven by a test that hung for 10 s -- and a comment claiming an ordering is
/// not a test of it.
///
/// `export` is injected for exactly that reason. `the_export_runs_off_the_store_
/// mutex` passes a probe that calls `try_lock` at the moment the export would
/// begin, so moving the guard's scope to span this call turns the probe red on
/// the same thread, with no timing and no second thread.
pub(crate) fn export_open_project(
    state: &StoreState,
    data_home: &Path,
    export: impl FnOnce(
        &Path,
        &str,
        &Path,
        &crate::identity::Vault,
        crate::strings::Strings,
    ) -> std::result::Result<ExportResult, String>,
) -> std::result::Result<ExportResult, String> {
    let (path, name) = {
        let guard = locked(state);
        let project = open_project(&guard)?;
        (project.path.clone(), project.name.clone())
    };

    // BEFORE THE DIRECTORY IS EVEN MADE. An unreadable vault stops the export
    // here rather than letting it run against an empty one, which is the whole
    // point of the vault failing loud where `settings.json` fails soft.
    let vault = vault_for(data_home)?;

    let dir = export_dir(data_home);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    export(
        &path,
        &name,
        &projects::pick_export_path(&dir, &export_slug(&name)),
        &vault,
        strings_for(data_home),
    )
}

/// The open book, rendered as an EPUB and read back out of the archive.
///
/// A FREE FUNCTION OVER A PATH BEHIND IT, exactly as `project_export` is, and
/// for that command's reason: the open store lives behind the mutex `doc_flush`
/// needs, and a full read of the manuscript through it would put the writer's
/// keystrokes behind the render for as long as it takes.
///
/// ON DEMAND AND NEVER ON A KEYSTROKE. The render is O(manuscript) -- the
/// graded run measures 240-300 ms at the `stress` fixture -- and this
/// application's keystroke path is measured and gated. A preview that repainted
/// as a writer typed would put a full walk of the book on the budget that
/// decides whether their typing feels instant. The rail refreshes when it is
/// opened and when it is asked to, and it drains the flush scheduler first, so
/// what it shows is the book AS SAVED -- which is what an export is.
#[command_boundary::command]
pub(crate) fn epub_preview(
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
) -> std::result::Result<EpubPreview, String> {
    let (path, name) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        (project.path.clone(), project.name.clone())
    };
    preview_of(
        &path,
        &name,
        &vault_for(&data_home.0)?,
        strings_for(&data_home.0),
    )
}

/// The open book, laid out as a proof copy, with the leaves read back.
///
/// ONE RENDER, TWO CONSUMERS, exactly as `epub_preview` is: the document this
/// paginates is the document the save prints, and the leaves the rail paints
/// are the leaves that run produced. There is no second paginator for the
/// preview to be right on while the file is wrong.
///
/// ON DEMAND AND NEVER ON A KEYSTROKE, for `epub_preview`'s recorded reason and
/// more so: this one lays out every page of the book.
/// ASYNC, AND THAT IS NOT A STYLE CHOICE. A synchronous `#[tauri::command]`
/// runs on the thread that owns the GTK main loop; this one posts work TO that
/// thread and blocks until the answer comes back, which on the main thread is a
/// deadlock -- the render is queued behind the command waiting for it. The
/// symptom is the whole window freezing with the File menu still painted, which
/// is exactly what the first capture photographed. `epub_preview` beside it may
/// stay synchronous: it never leaves the thread it is on.
#[cfg(any(target_os = "linux", windows))]
#[command_boundary::command]
pub(crate) async fn pdf_preview(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    data_home: State<'_, DataHome>,
) -> std::result::Result<PdfPreview, String> {
    let (path, name) = {
        let guard = locked(&state);
        let project = open_project(&guard)?;
        (project.path.clone(), project.name.clone())
    };
    let vault = vault_for(&data_home.0)?;
    let strings = strings_for(&data_home.0);
    proof_preview_of(&path, &name, &vault, strings, |html, page| {
        #[cfg(target_os = "linux")]
        {
            crate::printer::render_via(&app, html, None, page).map(|p| p.report)
        }
        #[cfg(windows)]
        {
            crate::printer_windows::render_via(&app, html, false, page).map(|p| p.report)
        }
    })
}

/// The whole of `pdf_preview` except the part that needs a display.
///
/// The renderer is INJECTED for `export_open_project`'s recorded reason: a
/// `#[tauri::command]` cannot be called from a test, and neither can a web
/// process. What is left here -- which design the proof is laid out to, which
/// covers reach it, what the rail is told about the gutter -- is the part that
/// can be wrong without a display, so it is the part a test can reach.
pub(crate) fn proof_preview_of(
    path: &Path,
    name: &str,
    vault: &crate::identity::Vault,
    strings: crate::strings::Strings,
    render: impl FnOnce(&str, (i64, i64)) -> std::result::Result<crate::pdf::ProofReport, String>,
) -> std::result::Result<PdfPreview, String> {
    let (written, items, words, _) = render_project_with(
        path,
        name,
        crate::export::Format::Pdf,
        vault,
        strings,
        Some(crate::pdf::PREVIEW_LEAVES),
    )?;
    let design = {
        let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
        crate::design::design_of(&store)?
    };
    let style = {
        let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
        crate::design::chapter_style_of(&store)?
    };
    let html = String::from_utf8(written.bytes).map_err(|e| e.to_string())?;
    let report = render(&html, (design.page.width_um, design.page.height_um))?;
    Ok(PdfPreview {
        pages: report.pages,
        css: crate::pdf::stylesheet(&design, &style),
        leaves: report.leaves,
        truncated: report.truncated,
        font: design.font.clone(),
        font_resolved: report.font_resolved,
        gutter_minimum_um: crate::pdf::gutter_minimum_um(report.leaves),
        inner_um: design.margins.inner_um,
        items,
        words,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        export_open_project, export_slug, export_tmp_path, strings_for, walk_of, write_manuscript, Dest,
        CONTENTS_KEY,
    };

    /// A vault with nothing in it, which is the state of every installation
    /// today and therefore the state most of this file's tests are about.
    ///
    /// THE SIX SHIMS BELOW EXIST SO THE VAULT IS AN EXPLICIT ARGUMENT WHERE IT
    /// MATTERS AND INVISIBLE WHERE IT DOES NOT. Every test in this module that
    /// is about crash-safe writing, the walk, the figures or the round trip is
    /// not about an identity, and threading an empty vault through forty call
    /// sites would bury the handful of tests that ARE about one. The shims
    /// shadow the real functions by name; the tests that care call `super::`
    /// explicitly, which is what makes them visible.
    fn no_vault() -> crate::identity::Vault {
        crate::identity::Vault::default()
    }

    /// A CATALOG THAT IS NOT ENGLISH, so that "the export used the catalog" is
    /// falsifiable at all. Every value differs from the English one and the tag
    /// differs from `en`: a build that ignored the catalog and a build that
    /// honoured it agree on nothing here, which is the whole requirement a
    /// fixture in this repo has repeatedly failed to meet.
    ///
    /// NOT A SHIPPED LANGUAGE, and `qq`/`QQ-CONTENTS` deliberately, now that
    /// `de` IS one: a tag or a value this fixture shared with the real German
    /// catalog would make a test reading either indistinguishable from a test
    /// of the shipped catalog, which is a different claim than this fixture
    /// exists to prove.
    static PSEUDO_ENTRIES: &[(&str, &str)] = &[("book.contents", "QQ-CONTENTS")];
    static PSEUDO: crate::strings::Locale = crate::strings::Locale::new("qq", PSEUDO_ENTRIES);

    fn pseudo() -> crate::strings::Strings {
        crate::strings::Strings::new(&PSEUDO)
    }

    #[test]
    fn the_language_a_headless_run_writes_in_comes_from_the_settings_file() {
        // THE SEAM THE WHOLE ARCHITECTURE RESTS ON, and the case that decides
        // it: `app-shell-tauri export`, `validate` and `salvage` run with no
        // window and no page to ask, so the language has to come off disk.
        //
        // `fr` NAMES A LANGUAGE THIS BUILD DOES NOT SHIP, `en` and `de` being
        // the two it does, so "fr selects French" is not a claim this build
        // can make or falsify. What IS asserted is that the file is read, that
        // an unshipped tag costs English rather than an empty catalog, and
        // that the catalog which comes back actually holds the key the export
        // asks it for -- which is what a resolver returning an empty
        // `Strings` would fail.
        let dir = tempdir().unwrap();
        let settings = crate::projects::settings_path(dir.path());
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();

        // No file at all: the state of every fresh installation.
        assert_eq!(strings_for(dir.path()).tag(), "en");
        assert_eq!(strings_for(dir.path()).t(CONTENTS_KEY), "Contents");

        std::fs::write(&settings, r#"{"locale":"fr"}"#).unwrap();
        assert_eq!(strings_for(dir.path()).tag(), "en");
        assert_eq!(strings_for(dir.path()).t(CONTENTS_KEY), "Contents");

        // And an unreadable settings file costs the language and never the
        // export -- `read_settings`' own rule, restated here because this is
        // the path an export takes.
        std::fs::write(&settings, b"{ this is not json").unwrap();
        assert_eq!(strings_for(dir.path()).tag(), "en");
    }

    #[test]
    fn a_real_second_catalog_makes_this_seam_falsifiable_without_the_pseudo_locale() {
        // THE FOUR EQUIVALENT MUTANTS from the single-catalog record: with one
        // shipped language every input to `strings_for` resolved to the same
        // catalog, so a resolver that read `settings.json` and one that
        // ignored it agreed on everything. `de` is now a REAL shipped catalog
        // rather than the `PSEUDO` fixture above, so this reads it through the
        // actual production seam: `strings_for` -> `LocaleTag` ->
        // `strings::locale_for`.
        let dir = tempdir().unwrap();
        let settings = crate::projects::settings_path(dir.path());
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();

        std::fs::write(&settings, r#"{"locale":"de"}"#).unwrap();
        assert_eq!(strings_for(dir.path()).tag(), "de");
        assert_eq!(strings_for(dir.path()).t(CONTENTS_KEY), "Inhalt");
    }

    #[test]
    fn the_generated_contents_heading_comes_from_the_catalog() {
        // 041 LEFT THIS A PARAMETER FOR THIS SLICE. The heading was
        // `CONTENTS_TITLE`, a host constant, and it was written into every
        // Markdown export and every EPUB in English whatever the writer's
        // language. Both halves are asserted: the catalog's word is there AND
        // the English one is not, because a renderer that emitted both would
        // satisfy the first alone.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let dest = dir.path().join("out.md");
        super::export_to(&db, "My Novel", &dest, &no_vault(), pseudo()).unwrap();
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.contains("QQ-CONTENTS"), "{text}");
        assert!(!text.contains("Contents"), "{text}");
    }

    #[test]
    fn the_epub_carries_the_language_of_the_catalog_it_was_rendered_from() {
        // 043's `LANGUAGE = "en"` was a constant on `<package xml:lang>`,
        // `dc:language` and every XHTML document. All three are asserted, and
        // the English tag is asserted ABSENT: three attributes written from one
        // value can only be proved to share it by moving that value.
        //
        // The archive stores its entries UNCOMPRESSED (043: an OCF container
        // permits STORED entries and that is what this writes), so the bytes
        // can be read without a zip reader.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let dest = dir.path().join("out.epub");
        super::export_into(
            &db,
            "N",
            &dest,
            Dest::New,
            crate::export::Format::Epub,
            &no_vault(),
            pseudo(),
        )
        .unwrap();
        let bytes = std::fs::read(&dest).unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        assert!(text.contains("<dc:language>qq</dc:language>"), "{text}");
        assert!(text.contains("xml:lang=\"qq\""), "{text}");
        assert!(text.contains("lang=\"qq\">"), "{text}");
        assert!(!text.contains("\"en\""), "{text}");
        assert!(text.contains("QQ-CONTENTS"), "{text}");
    }

    #[test]
    fn the_proof_document_carries_the_language_of_the_catalog_too() {
        // The third surface 043's constant reached, through 044. Read off the
        // HTML the printer is handed, which is where the attribute is written.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let mut html = None;
        super::export_into_with(
            &db,
            "N",
            &dir.path().join("a.pdf"),
            Dest::New,
            crate::export::Format::Pdf,
            &no_vault(),
            pseudo(),
            |bytes| {
                html = Some(String::from_utf8(bytes).unwrap());
                Ok(fake_pdf(1))
            },
        )
        .unwrap();
        let html = html.unwrap();
        assert!(html.contains("<html lang=\"qq\">"), "{html}");
        assert!(!html.contains("<html lang=\"en\">"), "{html}");
    }

    #[test]
    fn a_catalog_missing_the_heading_key_says_so_in_the_file() {
        // The fallback, through the REAL export path rather than through the
        // lookup's own unit test: a key that is not there renders visibly,
        // because a silently empty heading in an exported book is a defect
        // nobody can see and `⟦book.contents⟧` is a bug report.
        static EMPTY: &[(&str, &str)] = &[];
        static NOTHING: crate::strings::Locale = crate::strings::Locale::new("zz", EMPTY);
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let dest = dir.path().join("out.md");
        super::export_to(
            &db,
            "My Novel",
            &dest,
            &no_vault(),
            crate::strings::Strings::new(&NOTHING),
        )
        .unwrap();
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.contains("⟦book.contents⟧"), "{text}");
    }

    fn export_to(
        path: &Path,
        name: &str,
        dest: &Path,
    ) -> std::result::Result<super::ExportResult, String> {
        super::export_to(
            path,
            name,
            dest,
            &no_vault(),
            crate::strings::Strings::english(),
        )
    }

    fn export_as(
        path: &Path,
        name: &str,
        dest: &Path,
        format: crate::export::Format,
    ) -> std::result::Result<super::ExportResult, String> {
        super::export_as(
            path,
            name,
            dest,
            format,
            &no_vault(),
            crate::strings::Strings::english(),
        )
    }

    fn export_into(
        path: &Path,
        name: &str,
        dest: &Path,
        mode: Dest,
        format: crate::export::Format,
    ) -> std::result::Result<super::ExportResult, String> {
        super::export_into(
            path,
            name,
            dest,
            mode,
            format,
            &no_vault(),
            crate::strings::Strings::english(),
        )
    }

    fn export_into_with(
        path: &Path,
        name: &str,
        dest: &Path,
        mode: Dest,
        format: crate::export::Format,
        convert: impl FnOnce(Vec<u8>) -> std::result::Result<Vec<u8>, String>,
    ) -> std::result::Result<super::ExportResult, String> {
        super::export_into_with(
            path,
            name,
            dest,
            mode,
            format,
            &no_vault(),
            crate::strings::Strings::english(),
            convert,
        )
    }

    fn preview_of(path: &Path, name: &str) -> std::result::Result<super::EpubPreview, String> {
        super::preview_of(path, name, &no_vault(), crate::strings::Strings::english())
    }

    fn proof_preview_of(
        path: &Path,
        name: &str,
        render: impl FnOnce(&str, (i64, i64)) -> std::result::Result<crate::pdf::ProofReport, String>,
    ) -> std::result::Result<super::PdfPreview, String> {
        super::proof_preview_of(
            path,
            name,
            &no_vault(),
            crate::strings::Strings::english(),
            render,
        )
    }

    use crate::store::{FlushEntry, WordCount};
    use crate::test_support::{body, seeded_project};
    use crate::{locked, word_count_at, OpenProject, StoreState};
    use std::path::Path;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn an_export_reports_which_format_it_wrote() {
        // The discriminator the publishing track's design record asks for, and
        // the reason it is here before there is a second answer: the page words
        // its notice from this field, so a build that started writing something
        // else and went on reporting `markdown` would tell a writer the wrong
        // thing about their own file.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let dest = dir.path().join("out.md");
        let r = export_to(&db, "My Novel", &dest).unwrap();
        assert_eq!(r.format, crate::export::Format::Markdown.id());
    }

    #[test]
    fn the_written_bytes_are_the_rendered_bytes() {
        // `write_manuscript` takes bytes and the render produces them;
        // nothing in between may reinterpret. Asserted against the renderer
        // rather than against a literal, so this stays true for a format whose
        // bytes are not text.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let dest = dir.path().join("out.md");
        export_to(&db, "My Novel", &dest).unwrap();

        let store = crate::store::Store::open_readonly(&db).unwrap();
        let walk = crate::store::manuscript_items(store.items().unwrap());
        let items: Vec<(String, String, i64)> =
            walk.into_iter().map(|i| (i.id, i.title, i.depth)).collect();
        let bodies = store.documents().unwrap();
        let rendered = crate::export::manuscript(
            &crate::export::Book {
                name: "My Novel",
                contents_title: &crate::strings::Strings::english().t(CONTENTS_KEY),
                front: &[],
                chapters: &items,
                back: &[],
            },
            &bodies,
        );

        assert_eq!(std::fs::read(&dest).unwrap(), rendered.bytes);
    }

    #[test]
    fn export_to_writes_every_item_and_reports_the_counts() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = crate::store::Store::open(&db).unwrap();
            let s = store.item_create(None, "scene", "Opening").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: s.id.clone(),
                    body: body("two words"),
                    base_rev: s.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let dest = dir.path().join("out.md");
        let r = export_to(&db, "My Novel", &dest).unwrap();
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.starts_with("# My Novel\n"), "{text}");
        assert!(text.contains("## Opening"), "{text}");
        assert!(text.contains("two words"), "{text}");
        assert_eq!(r.items, 1);
        assert_eq!(r.words, 2);
        assert_eq!(r.path, dest.to_string_lossy());
    }

    #[test]
    fn the_export_reports_how_many_underlined_runs_it_dropped() {
        // THE COUNTED, SURFACED LOSS. Markdown has no underline, so the mark is
        // dropped -- deliberately. What must never happen
        // is the drop being silent, so the figure rides back with the result and
        // the page says it in the export notice.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = crate::store::Store::open(&db).unwrap();
            let s = store.item_create(None, "scene", "Opening").unwrap();
            let underlined = serde_json::json!({"type":"doc","content":[
                {"type":"paragraph","content":[
                    {"type":"text","text":"plain "},
                    {"type":"text","text":"under","marks":[{"type":"underline"}]},
                ]}
            ]})
            .to_string();
            store
                .flush(&[FlushEntry {
                    item_id: s.id.clone(),
                    body: underlined,
                    base_rev: s.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let dest = dir.path().join("out.md");
        let r = export_to(&db, "N", &dest).unwrap();
        assert_eq!(r.underlined, 1);
        // The TEXT is not lost, only the emphasis: the count is a report and
        // never a refusal.
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.contains("plain under"), "{text}");
        // And no smuggled markup. Emitting `<u>` was the rejected option: the
        // escaper escapes `<`, the importer has no HTML path, and accepting a
        // mirror edit would strip every underline in the document.
        assert!(!text.contains("<u>"), "{text}");
    }

    #[test]
    fn a_manuscript_with_no_underline_reports_none() {
        // The control for the test above. A figure that was really "did this
        // export carry any marks" would tell a writer who never pressed the
        // control that they had lost something.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = crate::store::Store::open(&db).unwrap();
            let s = store.item_create(None, "scene", "Opening").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: s.id.clone(),
                    body: body("two words"),
                    base_rev: s.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let r = export_to(&db, "N", &dir.path().join("out.md")).unwrap();
        assert_eq!(r.underlined, 0);
    }

    #[test]
    fn the_exported_word_count_is_the_figure_the_project_bar_shows() {
        // The graded run uses one as an oracle for the other, so a divergence
        // here would make `export_word_count_agrees` a test of nothing. The
        // comparison is against the INDEPENDENT full scan, not against the
        // index this build happens to feed the export from.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = crate::store::Store::open(&db).unwrap();
            for (title, text) in [
                ("One", "four words go here"),
                ("Two", "and three more"),
                ("Three", ""),
            ] {
                let s = store.item_create(None, "scene", title).unwrap();
                store
                    .flush(&[FlushEntry {
                        item_id: s.id.clone(),
                        body: body(text),
                        base_rev: s.doc_rev.unwrap(),
                        comments: None,
                    }])
                    .unwrap();
            }
            // An unreadable body: the scan reports it as skipped rather than
            // counted, and the export must undercount identically.
            let bad = store.item_create(None, "scene", "Bad").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: bad.id.clone(),
                    body: "{not json at all".to_string(),
                    base_rev: bad.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let scanned = word_count_at(&db).unwrap();
        assert_eq!(
            scanned,
            WordCount {
                words: 7,
                skipped: 1
            }
        );
        let r = export_to(&db, "N", &dir.path().join("out.md")).unwrap();
        assert_eq!(r.words, scanned.words);
    }

    #[test]
    fn the_exported_word_count_describes_the_file_that_was_written() {
        // A `doc` row whose item is not in the walk contributes no prose to the
        // manuscript, so it must contribute no words to the figure either.
        // Foreign keys make this unreachable through the app; the point of the
        // test is that the figure is derived from what was EMITTED, so the
        // graded oracle gate is a tripwire rather than a second copy of the same
        // blind spot. The row is inserted on a raw connection because the
        // store's own handle enforces the constraint that forbids it.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = crate::store::Store::open(&db).unwrap();
            let s = store.item_create(None, "scene", "Opening").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: s.id.clone(),
                    body: body("two words"),
                    base_rev: s.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let raw = rusqlite::Connection::open(&db).unwrap();
        raw.pragma_update(None, "foreign_keys", "OFF").unwrap();
        raw.execute(
            "INSERT INTO doc (item_id, body, rev, updated_at) VALUES ('ghost', ?1, 1, 0)",
            rusqlite::params![body("three ghostly words")],
        )
        .unwrap();

        let dest = dir.path().join("out.md");
        let r = export_to(&db, "N", &dest).unwrap();
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(!text.contains("ghostly"), "{text}");
        assert_eq!(r.words, 2);
        // And the divergence from the project bar's figure is the signal: the
        // full scan still counts the orphan, so the two disagree exactly when
        // prose is missing from the manuscript.
        assert_eq!(word_count_at(&db).unwrap().words, 5);
    }

    #[test]
    fn export_to_does_not_create_a_schema_on_a_blank_file() {
        // Store::open would migrate it. Reading must never write.
        let dir = tempdir().unwrap();
        let blank = dir.path().join("blank.db");
        std::fs::write(&blank, b"").unwrap();
        assert!(export_to(&blank, "N", &dir.path().join("o.md")).is_err());
        assert_eq!(std::fs::read(&blank).unwrap().len(), 0);
        assert!(!dir.path().join("blank.db-wal").exists());
        // And nothing half-written is left behind claiming to be a manuscript.
        assert!(!dir.path().join("o.md").exists());
    }

    #[test]
    fn export_to_refuses_to_overwrite_an_existing_destination() {
        // pick_export_path picks a free name, but the command must not depend on
        // that alone: a race or a caller bug must not destroy a manuscript.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        crate::store::Store::open(&db).unwrap();
        let dest = dir.path().join("taken.md");
        std::fs::write(&dest, "prior").unwrap();
        assert!(export_to(&db, "N", &dest).is_err());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "prior");
    }

    #[test]
    fn export_into_replace_overwrites_a_file_the_writer_named() {
        // The control for the test above, and the reason `Dest` exists. The
        // automatic export picks its own free name, so a collision is a bug; a
        // dialog destination was typed by the writer over a prompt that already
        // asked them, and refusing it would overrule the answer they just gave.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        crate::store::Store::open(&db).unwrap();
        let dest = dir.path().join("taken.md");
        std::fs::write(&dest, "prior").unwrap();

        export_into(
            &db,
            "The Harbour",
            &dest,
            Dest::Replace,
            crate::export::Format::Markdown,
        )
        .expect("the replace to land");
        let written = std::fs::read_to_string(&dest).unwrap();
        assert!(written.starts_with("# The Harbour"), "{written}");
        assert!(!written.contains("prior"), "{written}");
    }

    #[test]
    fn a_replacing_export_leaves_no_temp_file_behind() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        crate::store::Store::open(&db).unwrap();
        let dest = dir.path().join("out.md");

        export_into(
            &db,
            "N",
            &dest,
            Dest::Replace,
            crate::export::Format::Markdown,
        )
        .expect("the export to land");
        assert!(
            !export_tmp_path(&dest).exists(),
            "the temp file must be renamed away"
        );
        let strays: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|n| n.contains("tmp-export"))
            .collect();
        assert!(strays.is_empty(), "{strays:?}");
    }

    #[test]
    fn a_replace_that_cannot_be_written_leaves_the_original_manuscript_intact() {
        // The reason a replace writes a sibling and renames rather than opening
        // the destination with `truncate`. Truncating destroys the writer's file
        // at the instant it opens, so a failure halfway through would leave them
        // with neither their old manuscript nor a complete new one.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        crate::store::Store::open(&db).unwrap();
        let guarded = dir.path().join("guarded");
        std::fs::create_dir(&guarded).unwrap();
        let dest = guarded.join("book.md");
        std::fs::write(&dest, "the writer's manuscript").unwrap();

        // Read-only directory: the temp file cannot be created, so the failure
        // lands before anything has touched `dest`.
        let mut perms = std::fs::metadata(&guarded).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&guarded, perms).unwrap();

        let result = export_into(
            &db,
            "N",
            &dest,
            Dest::Replace,
            crate::export::Format::Markdown,
        );

        let mut perms = std::fs::metadata(&guarded).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&guarded, perms).unwrap();

        assert!(
            result.is_err(),
            "a replace into a read-only directory must fail"
        );
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "the writer's manuscript"
        );
    }

    #[test]
    fn the_export_temp_file_is_a_sibling_of_the_destination() {
        // `rename` is atomic only within a filesystem. A temp in /tmp would be a
        // different one on this machine, which turns the rename into a copy that
        // can fail halfway.
        let tmp = export_tmp_path(Path::new("/somewhere/else/book.md"));
        assert_eq!(tmp.parent(), Some(Path::new("/somewhere/else")));
        assert_ne!(tmp.file_name(), Some(std::ffi::OsStr::new("book.md")));
    }

    #[test]
    fn a_project_whose_items_have_no_bodies_exports_its_headings() {
        // Parts and chapters hold no document. A manuscript that is all
        // structure and no prose is a legal one, and it must not export as an
        // error or as an empty file.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = crate::store::Store::open(&db).unwrap();
            let part = store.item_create(None, "part", "Part One").unwrap();
            store
                .item_create(Some(&part.id), "chapter", "Chapter One")
                .unwrap();
        }
        let dest = dir.path().join("out.md");
        let r = export_to(&db, "N", &dest).unwrap();
        assert_eq!(r.items, 2);
        assert_eq!(r.words, 0);
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "# N\n\n## Contents\n\n- Part One\n  - Chapter One\n\n## Part One\n\n### Chapter One\n"
        );
    }

    #[test]
    fn export_to_reports_a_store_that_cannot_be_opened() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nothing.db");
        let err = export_to(&missing, "N", &dir.path().join("o.md")).unwrap_err();
        assert!(!err.is_empty());
        // Read-only, so the failure must not have created the file it named.
        assert!(!missing.exists());
    }

    #[test]
    fn export_to_reads_the_file_on_its_own_connection() {
        // Named for what it establishes, and no more. It drives `export_to`,
        // which does not take the state and never touches the mutex, so it can
        // say nothing about the COMMAND's ordering -- that claim belongs to
        // `the_export_runs_off_the_store_mutex` below. What it does prove is the
        // property that makes the ordering possible at all: the export reaches
        // the file on a second connection, so it can run while the open store's
        // mutex is held by an in-flight doc_flush.
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let store = seeded_project(&path);
        let words = store.word_index().unwrap();
        // Built from the walk, exactly as a real open builds it: a helper that
        // hardcoded an empty set would make every test here blind to the bin.
        let excluded = crate::store::excluded_from_book(&store.items().unwrap());
        let state = StoreState(Mutex::new(Some(OpenProject {
            book_id: crate::project_book_id(&store).unwrap(),
            registry_home: None,
            store,
            path: path.clone(),
            name: "counted".to_string(),
            generation: 1,
            words,
            excluded,
            analytics: None,
            tracking_on: false,
        })));

        // Held for the whole export, exactly as an in-flight doc_flush would.
        let held = locked(&state);

        let (tx, rx) = mpsc::channel();
        let exported = path.clone();
        let dest = dir.path().join("out.md");
        let worker = std::thread::spawn(move || {
            let _ = tx.send(export_to(&exported, "counted", &dest));
        });
        let answer = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the export did not finish while the store mutex was held");

        drop(held);
        worker.join().unwrap();
        // And it exported something real, not an error swallowed into a zero: a
        // failure to open the file would satisfy the timing claim alone.
        let result = answer.unwrap();
        assert_eq!(result.items, 1);
        assert_eq!(result.words, 4);
    }

    /// THE THIRD STATE, END TO END. Front matter is the opposite of the bible on
    /// every clause of the test below it: its prose is IN the file, its words are
    /// IN the reported figure, and its SECTION ROOT is in neither -- so
    /// `FRONT MATTER` never appears as a heading between two chapters.
    #[test]
    fn front_and_back_matter_are_exported_and_the_section_roots_are_not() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("matter.db");
        {
            let store = seeded_project(&path);
            for (root_type, root_title, title, prose) in [
                (
                    crate::store::FRONT_MATTER_TYPE,
                    "Front matter",
                    "Dedication",
                    "for three good people",
                ),
                (
                    crate::store::BACK_MATTER_TYPE,
                    "Back matter",
                    "Acknowledgements",
                    "thanks to two more",
                ),
            ] {
                let root = store.item_create(None, root_type, root_title).unwrap();
                let doc = store
                    .item_create(Some(&root.id), crate::store::MATTER_TYPE, title)
                    .unwrap();
                store
                    .flush(&[crate::store::FlushEntry {
                        item_id: doc.id.clone(),
                        body: crate::test_support::body(prose),
                        base_rev: doc.doc_rev.unwrap(),
                        comments: None,
                    }])
                    .unwrap();
            }
        }
        let dest = dir.path().join("out.md");
        let result = export_to(&path, "matter", &dest).unwrap();
        let written = std::fs::read_to_string(&dest).unwrap();
        assert!(
            written.contains("## Dedication\n\nfor three good people\n"),
            "{written}"
        );
        assert!(
            written.contains("## Acknowledgements\n\nthanks to two more\n"),
            "{written}"
        );
        assert!(
            !written.contains("Front matter"),
            "the section root is a marker: {written}"
        );
        assert!(
            !written.contains("Back matter"),
            "the section root is a marker: {written}"
        );
        // The dedication prints ABOVE the seeded scene and the acknowledgements
        // below it. Position, not merely presence.
        let at = |needle: &str| written.find(needle).expect(needle);
        assert!(at("## Dedication") < at("## Only scene"));
        assert!(at("## Only scene") < at("## Acknowledgements"));
        assert_eq!(
            result.items, 3,
            "the scene, the dedication, the acknowledgements"
        );
        // FOUR from the seeded scene and FOUR from each matter document: a
        // dedication's words are in the book, because they are in the file the
        // figure describes and the same walk feeds both.
        assert_eq!(result.words, 12);
    }

    /// Export is the free one: prose comes only from the WALKED items, so
    /// filtering the walk is the entire fix. What this pins is that it WAS
    /// filtered -- the reported word count is fed from the same walk, so a bible
    /// left in would put its words in the manuscript AND in the figure, and the
    /// `export_word_count_agrees` tripwire would stay green while doing it.
    #[test]
    fn the_bible_is_not_the_manuscript_and_is_never_exported() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        {
            let store = seeded_project(&path);
            let bible = store
                .item_create(None, crate::store::BIBLE_TYPE, "Bible")
                .unwrap();
            let note = store
                .item_create(Some(&bible.id), crate::store::NOTE_TYPE, "Magic System")
                .unwrap();
            store
                .flush(&[crate::store::FlushEntry {
                    item_id: note.id.clone(),
                    body: crate::test_support::body("five whole words of worldbuilding"),
                    base_rev: note.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let dest = dir.path().join("out.md");
        let result = export_to(&path, "counted", &dest).unwrap();
        let written = std::fs::read_to_string(&dest).unwrap();
        assert!(!written.contains("Magic System"), "{written}");
        assert!(!written.contains("worldbuilding"), "{written}");
        assert!(!written.contains("Bible"), "{written}");
        assert_eq!(result.items, 1, "only the manuscript's one scene");
        assert_eq!(result.words, 4);
    }

    /// A TIMELINE UNDER THE BIBLE IS NEVER EXPORTED EITHER. One
    /// assertion, per the plan: it needs no new filter of its own, because it
    /// lives inside the same bible subtree `manuscript_items` already drops --
    /// this pins that the existing exclusion covers it rather than assuming so.
    #[test]
    fn a_timeline_under_the_bible_produces_no_export_output() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        {
            let store = seeded_project(&path);
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
        }
        let dest = dir.path().join("out.md");
        let result = export_to(&path, "counted", &dest).unwrap();
        let written = std::fs::read_to_string(&dest).unwrap();
        assert!(!written.contains("Timeline"), "{written}");
        assert_eq!(result.items, 1, "only the manuscript's one scene");
        assert_eq!(result.words, 4);
    }

    /// A SYNOPSIS IS NOT IN THE EXPORT, and it is free for the reason the word
    /// count is: the exporter emits the walked items' `doc` bodies, and a
    /// synopsis is a row in a table it never names. The scene's own words are
    /// asserted too, so the test cannot be satisfied by an export that wrote
    /// nothing.
    ///
    /// This is a PRODUCT answer as much as a mechanical one. What a writer
    /// exports is the book; a summary of a chapter is the writer's scaffolding
    /// and would arrive in a publisher's manuscript as prose nobody wrote.
    #[test]
    fn a_synopsis_is_not_the_manuscript_and_is_never_exported() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        {
            let store = seeded_project(&path);
            let scene = store.items().unwrap()[0].id.clone();
            store
                .synopsis_set(&scene, "she burns the letter before dawn")
                .unwrap();
        }
        let dest = dir.path().join("out.md");
        let result = export_to(&path, "counted", &dest).unwrap();
        let written = std::fs::read_to_string(&dest).unwrap();
        assert!(!written.contains("burns the letter"), "{written}");
        assert!(written.contains("four words go here"), "{written}");
        assert_eq!(result.items, 1);
        assert_eq!(result.words, 4, "the synopsis reached the reported total");
    }

    /// THE CAST IS NOT IN THE EXPORT, free for the reason the synopsis is: the
    /// exporter emits the walked items' `doc` bodies and a cast member is a row
    /// in two tables it never names. The scene's own words are asserted too, so
    /// the test cannot be satisfied by an export that wrote nothing.
    ///
    /// A PRODUCT ANSWER as much as a mechanical one. A character sheet is the
    /// writer's reference; it would arrive in a publisher's manuscript as
    /// paragraphs nobody wrote, under a heading nobody chose.
    #[test]
    fn the_cast_is_not_the_manuscript_and_is_never_exported() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        {
            let store = seeded_project(&path);
            let made = store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse Vandermeer")
                .unwrap();
            store
                .cast_set(
                    &made.id,
                    crate::store::cast::KIND_CHARACTER,
                    "Ilse Vandermeer",
                    "Keeps the letter she was told to burn.",
                    &[crate::store::cast::CastField {
                        label: "accent".into(),
                        value: "flat northern".into(),
                    }],
                    &[],
                )
                .unwrap();
        }
        let dest = dir.path().join("out.md");
        let result = export_to(&path, "counted", &dest).unwrap();
        let written = std::fs::read_to_string(&dest).unwrap();
        assert!(!written.contains("Vandermeer"), "{written}");
        assert!(!written.contains("told to burn"), "{written}");
        assert!(!written.contains("flat northern"), "{written}");
        assert!(written.contains("four words go here"), "{written}");
        assert_eq!(result.items, 1);
        assert_eq!(result.words, 4, "the cast reached the reported total");
    }

    /// THE ROUND-TRIP WARNING DOES NOT APPLY TO THIS SLICE, and the judgement is
    /// asserted rather than left as a remark.
    ///
    /// `decisions/2026-08-27-where-pictures-live.md` warns that `escape`'s
    /// `INLINE_METACHARACTERS` omits `!` and that `import.rs` has no image
    /// syntax at all, so an `![alt](path)` emitted into Markdown would import as
    /// literal text and re-export escaped -- breaking the graded
    /// export -> import -> export stability claim. That is true, and NOTHING IN
    /// SLICE 038 CAN REACH IT: the exporter emits the walked items' `doc`
    /// bodies, a cast member is not an item and has no `doc` row, and the mirror
    /// is out for the cast on 036's front-matter argument. There is no `.md`
    /// anywhere a cast photograph could ride on.
    ///
    /// 042 (covers) was the case this named as the one that WOULD make the
    /// warning live, and it does not -- see the test below. What is left is an
    /// inline `image`
    /// NODE in the editor's schema -- which is also the case the recorded
    /// `store::document_text` / `export::document_markdown` forward guard fires
    /// on. This test is what would go red the day either arrives with the
    /// escape unfixed.
    #[test]
    fn a_cast_photograph_never_reaches_the_manuscript_so_the_escape_is_untouched() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let picture = "0198c0de-0000-7000-8000-000000000000.jpg";
        {
            let store = seeded_project(&path);
            let made = store
                .cast_create(crate::store::cast::KIND_CHARACTER, "Ilse Vandermeer")
                .unwrap();
            store.cast_set_picture(&made.id, Some(picture)).unwrap();
        }
        let dest = dir.path().join("out.md");

        let result = export_to(&path, "counted", &dest).unwrap();

        let written = std::fs::read_to_string(&dest).unwrap();
        assert!(!written.contains(picture), "{written}");
        assert!(!written.contains(".jpg"), "{written}");
        // THE CHARACTER ITSELF, because `escape` not covering it is the whole of
        // the recorded hazard: an export carrying no `!` cannot be broken by
        // one that is not escaped.
        assert!(!written.contains('!'), "{written}");
        // The control: the export DID run and DID carry the prose, so none of
        // the three assertions above is satisfied by an empty file.
        assert!(written.contains("four words go here"), "{written}");
        assert_eq!(result.words, 4);
    }

    /// THE JUDGEMENT 038 DEFERRED TO 042, MADE: A COVER IS NOT IN THE MARKDOWN,
    /// so the escape stays untouched for a stated reason rather than by
    /// accident.
    ///
    /// Emitting `![Cover](<project>.pictures/<uuid>.jpg)` under the H1 is the
    /// obvious thing to do and is refused on three counts.
    ///
    /// It breaks the graded round trip. `escape`'s `INLINE_METACHARACTERS`
    /// omits `!` and `import.rs` has no image syntax at all, so the line would
    /// import as literal text and re-export escaped. Fixing both is a slice of
    /// its own and it buys Markdown nothing.
    ///
    /// The link would dangle exactly when it is useful. It is RELATIVE to the
    /// picture directory beside the project, and an export is a file the writer
    /// carries somewhere else -- so the one copy of the manuscript that leaves
    /// this machine is the one whose cover cannot resolve.
    ///
    /// And a cover is an artifact of a BOUND book, not of a text file. 043's
    /// EPUB has a real cover slot and 044's PDF has a first page; both are named
    /// as this feature's consumers by the publishing track's record, exactly as
    /// 040's page size and margins have no consumer yet either.
    #[test]
    fn a_cover_never_reaches_the_manuscript_either_and_the_escape_stays_untouched() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let cover = "0198c0de-0000-7000-8000-000000000001.jpg";
        {
            let store = seeded_project(&path);
            crate::covers::set_cover(&store, crate::covers::SIDE_FRONT, cover).unwrap();
            crate::covers::set_cover(&store, crate::covers::SIDE_BACK, cover).unwrap();
        }
        let dest = dir.path().join("out.md");

        let result = export_to(&path, "counted", &dest).unwrap();

        let written = std::fs::read_to_string(&dest).unwrap();
        assert!(!written.contains(cover), "{written}");
        assert!(!written.contains(".jpg"), "{written}");
        assert!(!written.contains(".pictures"), "{written}");
        // THE CHARACTER ITSELF, for the reason the test above asserts it: an
        // export carrying no `!` cannot be broken by one that is not escaped.
        assert!(!written.contains('!'), "{written}");
        // The control, so none of the four is satisfied by an empty file.
        assert!(written.contains("four words go here"), "{written}");
        assert_eq!(result.words, 4);
    }

    #[test]
    fn the_export_runs_off_the_store_mutex() {
        // The command's own ordering, which no test had: path and name under the
        // guard, guard dropped, then the O(manuscript) work. The probe runs at
        // the instant the export begins and asks the mutex directly, so widening
        // the guard's scope to span the export turns it red -- deterministically,
        // on one thread, with no timeout. `try_lock` rather than `lock` because
        // std's Mutex is not re-entrant and a second `lock` here would hang the
        // suite instead of failing it.
        let dir = tempdir().unwrap();
        let path = dir.path().join("counted.db");
        let store = seeded_project(&path);
        let words = store.word_index().unwrap();
        // Built from the walk, exactly as a real open builds it: a helper that
        // hardcoded an empty set would make every test here blind to the bin.
        let excluded = crate::store::excluded_from_book(&store.items().unwrap());
        let state = StoreState(Mutex::new(Some(OpenProject {
            book_id: crate::project_book_id(&store).unwrap(),
            registry_home: None,
            store,
            path: path.clone(),
            name: "counted".to_string(),
            generation: 1,
            words,
            excluded,
            analytics: None,
            tracking_on: false,
        })));

        let mut free_at_export = None;
        let result = export_open_project(&state, dir.path(), |p, n, dest, _vault, _strings| {
            free_at_export = Some(state.0.try_lock().is_ok());
            export_to(p, n, dest)
        })
        .unwrap();

        assert_eq!(
            free_at_export,
            Some(true),
            "the store mutex was still held when the export began"
        );
        // And a real export happened: a probe that never ran would leave the
        // flag None, and an export that failed would satisfy nothing here.
        assert_eq!(result.items, 1);
        assert_eq!(result.words, 4);
        assert!(Path::new(&result.path).exists());
    }

    #[test]
    fn a_failed_write_leaves_no_partial_manuscript_behind() {
        // ENOSPC is the realistic failure, and it is the one that leaves a
        // truncated file at a path `pick_export_path` then advances past
        // forever, under a name indistinguishable in form from a good one.
        // `/dev/full` delivers it deterministically; the destination is a real
        // file because reclaiming it is what is under test, and `export_to`'s
        // `create_new` makes a write-failing destination impossible to reach
        // through the path alone.
        let dir = tempdir().unwrap();
        let dest = dir.path().join("half.md");
        std::fs::write(&dest, "partly written").unwrap();
        let full = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/full")
            .expect("/dev/full: this project is Linux-only and the test needs it");

        let err = write_manuscript(full, &dest, b"the rest of the manuscript").unwrap_err();
        assert!(err.contains("half.md"), "{err}");
        assert!(
            !dest.exists(),
            "a truncated manuscript survived at the picked path"
        );
    }

    #[test]
    fn a_name_with_no_slug_falls_back_rather_than_naming_a_file_nothing() {
        assert_eq!(export_slug("My Novel"), "my-novel");
        // slugify returns None here; ".md" alone is a hidden file with no name.
        assert_eq!(export_slug("...."), "manuscript");
        assert_eq!(export_slug(""), "manuscript");
    }

    #[test]
    fn the_epub_a_writer_saves_is_the_epub_the_preview_shows() {
        // THE WHOLE POINT OF THE SLICE, and it is a property of the code rather
        // than of a convention. The design record's constraint is that the
        // render be callable without writing a file; what is built is stronger.
        // `preview_of` renders the archive and then UNZIPS it, so the documents
        // the rail paints are the file's own bytes, parsed. A preview that is
        // right while the file is wrong is not a defect this build can have.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let dest = dir.path().join("out.epub");
        export_as(&db, "My Novel", &dest, crate::export::Format::Epub).unwrap();

        let preview = preview_of(&db, "My Novel").unwrap();
        let written = std::fs::read(&dest).unwrap();
        let read_back = crate::epub::read_zip(&written).unwrap();
        let documents = crate::epub::reading_order(&read_back);
        assert_eq!(preview.documents.len(), documents.len());
        for (n, doc) in documents.iter().enumerate() {
            assert_eq!(preview.documents[n].name, doc.0);
            assert_eq!(preview.documents[n].xhtml, doc.1);
        }
        // And the stylesheet, which is where three of the four options live.
        let css = read_back
            .iter()
            .find(|(n, _)| n == &format!("{}/{}", crate::epub::OEBPS, crate::epub::CSS_HREF))
            .map(|(_, b)| String::from_utf8(b.clone()).unwrap());
        assert_eq!(Some(preview.css.clone()), css);
    }

    #[test]
    fn an_epub_export_reports_the_format_it_wrote_and_loses_no_underline() {
        // Markdown drops the underline and COUNTS the drop; XHTML carries it,
        // so the honest figure here is nought. A build that reported a loss
        // would tell a writer something untrue about a file that holds their
        // emphasis perfectly.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = crate::store::Store::open(&db).unwrap();
            let s = store.item_create(None, "scene", "Opening").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: s.id.clone(),
                    body:
                        serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
                        {"type":"text","text":"under","marks":[{"type":"underline"}]}]}]})
                        .to_string(),
                    base_rev: s.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let dest = dir.path().join("out.epub");
        let r = export_as(&db, "N", &dest, crate::export::Format::Epub).unwrap();
        assert_eq!(r.format, "epub");
        assert_eq!(r.underlined, 0);
        assert_eq!(r.items, 1);
    }

    #[test]
    fn the_two_formats_count_the_same_book_the_same_way() {
        // The figures describe the BOOK, not the file, so a format cannot move
        // them. `export_word_count_agrees` grades the Markdown side; this is
        // what stops the EPUB path acquiring a second answer to the same
        // question.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let md = export_as(
            &db,
            "N",
            &dir.path().join("a.md"),
            crate::export::Format::Markdown,
        )
        .unwrap();
        let ep = export_as(
            &db,
            "N",
            &dir.path().join("a.epub"),
            crate::export::Format::Epub,
        )
        .unwrap();
        assert_eq!((md.items, md.words), (ep.items, ep.words));
    }

    #[test]
    fn typed_book_walk_selects_chapter_openings_without_matter_or_parts() {
        let dir = tempdir().unwrap();
        let store = crate::store::Store::open(&dir.path().join("p.db")).unwrap();
        let front = store.item_create(None, crate::store::FRONT_MATTER_TYPE, "Front").unwrap();
        let matter = store.item_create(Some(&front.id), crate::store::MATTER_TYPE, "Dedication").unwrap();
        let part = store.item_create(None, "part", "Part").unwrap();
        let chapter = store.item_create(Some(&part.id), "chapter", "Chapter").unwrap();
        let scene = store.item_create(Some(&chapter.id), "scene", "Scene").unwrap();
        let loose = store.item_create(None, "scene", "Loose scene").unwrap();
        let back = store.item_create(None, crate::store::BACK_MATTER_TYPE, "Back").unwrap();
        let afterword = store.item_create(Some(&back.id), crate::store::MATTER_TYPE, "Afterword").unwrap();
        let walked = walk_of(&store).unwrap();
        assert_eq!(walked.openings.styled, [chapter.id.clone(), loose.id.clone()].into());
        assert_eq!(walked.openings.page, [part.id.clone(), chapter.id.clone()].into());
        for id in [matter.id, scene.id, afterword.id] {
            assert!(!walked.openings.styled.contains(&id));
            assert!(!walked.openings.page.contains(&id));
        }
    }

    #[test]
    fn the_epub_carries_the_font_and_the_style_the_book_was_given() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = seeded_project(&db);
            crate::design::write_design(&store, &crate::design::preset("non-fiction").unwrap())
                .unwrap();
            crate::design::write_chapter_style(
                &store,
                &crate::design::ChapterStyle {
                    glyph: Some("fleuron".to_string()),
                    new_page: true,
                    caps_title: true,
                    drop_cap: true,
                },
            )
            .unwrap();
        }
        let preview = preview_of(&db, "N").unwrap();
        assert!(preview.css.contains("Source Serif 4"), "{}", preview.css);
        assert!(preview.css.contains("break-before"));
        assert!(preview.css.contains("text-transform"));
        assert!(preview.css.contains("first-letter"));
        assert!(
            preview
                .documents
                .iter()
                .any(|d| d.xhtml.contains(crate::epub::ORNAMENT_CLASS)),
            "no ornament in any document"
        );
    }

    #[test]
    fn the_front_cover_reaches_the_epub_and_the_back_cover_does_not() {
        // An EPUB has ONE cover slot and it is the front. The back cover is
        // recorded as having nowhere to go rather than quietly appended as a
        // last page nobody asked for.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        let pictures = crate::pictures::dir_for(&db);
        std::fs::create_dir_all(&pictures).unwrap();
        // TWO DIFFERENT PICTURES, and it is the whole test. The first draft
        // attached the SAME file twice, so embedding the BACK cover produced
        // byte-identical output and a mutation swapping the sides survived the
        // run -- the recorded shape where a fixture two implementations agree on
        // makes the test about the fixture. A PNG and a JPEG cannot be confused:
        // the entry's name, its extension and its media type all differ.
        let source = dir.path().join("in.png");
        std::fs::write(&source, include_bytes!("../../fixtures/two-halves.png")).unwrap();
        let other = dir.path().join("in.jpg");
        std::fs::write(&other, include_bytes!("../../fixtures/two-halves.jpg")).unwrap();
        let front = crate::pictures::attach(&pictures, &source).unwrap();
        let back = crate::pictures::attach(&pictures, &other).unwrap();
        {
            let store = seeded_project(&db);
            crate::covers::set_cover(&store, "front", &front).unwrap();
            crate::covers::set_cover(&store, "back", &back).unwrap();
        }
        let preview = preview_of(&db, "N").unwrap();
        assert_eq!(preview.documents[0].name, "OEBPS/text/cover.xhtml");
        assert_eq!(
            preview
                .documents
                .iter()
                .filter(|d| d.name.contains("cover"))
                .count(),
            1
        );
        // THE FRONT'S OWN BYTES. The data URI carries the media type the sniff
        // decided for the file this book calls its front cover, and the back
        // cover is a JPEG -- so a build that reached for the wrong side says so
        // here rather than shipping the wrong picture on the front of a book.
        let uri = preview.cover_data_uri.expect("a front cover");
        assert!(
            uri.starts_with("data:image/png;base64,"),
            "{}",
            &uri[..40.min(uri.len())]
        );
    }

    #[test]
    fn a_cover_whose_file_has_gone_leaves_the_book_without_one_rather_than_failing() {
        // 038's rule: a missing file does not clear the claim, and it must not
        // stop the writer exporting their book either. The cover is what goes
        // missing, not the manuscript.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = seeded_project(&db);
            crate::covers::set_cover(&store, "front", "deadbeef.png").unwrap();
        }
        let preview = preview_of(&db, "N").unwrap();
        assert!(preview.cover_data_uri.is_none());
        assert!(preview.documents.iter().all(|d| !d.name.contains("cover")));
    }

    /// A PDF whose page count is `pages`, in the least a PDF can be. It is not
    /// a document any reader would open and it is not meant to be: what the
    /// export path does with the bytes is write them, and what it reads out of
    /// them is the count. A real proof needs a display and cannot be built
    /// here -- that is `printer.rs`'s recorded structural gap and `shot-cli
    /// --pdf` is what covers it.
    fn fake_pdf(pages: usize) -> Vec<u8> {
        let mut out = b"%PDF-1.4\n".to_vec();
        for n in 0..pages {
            out.extend_from_slice(format!("{} 0 obj\n<</Type /Page>>\nendobj\n", n + 2).as_bytes());
        }
        out.extend_from_slice(b"%%EOF\n");
        out
    }

    #[test]
    fn a_proof_export_writes_what_the_printer_produced_and_reports_the_pages_it_holds() {
        // THE PAGE COUNT IS READ BACK OUT OF THE FILE, which is 043's unzip for
        // a format that cannot be unzipped. The renderer's own opinion about
        // how many leaves it cut never reaches this field.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let dest = dir.path().join("out.pdf");
        let mut given = None;
        let r = export_into_with(
            &db,
            "My Novel",
            &dest,
            Dest::New,
            crate::export::Format::Pdf,
            |html| {
                given = Some(String::from_utf8(html).unwrap());
                Ok(fake_pdf(7))
            },
        )
        .unwrap();
        assert_eq!(r.format, "pdf");
        assert_eq!(r.pages, Some(7));
        assert_eq!(std::fs::read(&dest).unwrap(), fake_pdf(7));
        // And what the printer was handed is the proof document, not the
        // Markdown and not the archive.
        let html = given.expect("the converter ran");
        assert!(html.starts_with("<!DOCTYPE html>"), "{html}");
        assert!(html.contains("id=\"proof-flow\""), "{html}");
    }

    #[test]
    fn the_two_formats_that_have_no_pages_report_none_rather_than_nought() {
        // A `0` there would be a claim that a text file and a reflowable book
        // have no pages, which is a different statement from having no such
        // thing as a page. `formatCount`'s rule one boundary out.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        for (format, name) in [
            (crate::export::Format::Markdown, "a.md"),
            (crate::export::Format::Epub, "a.epub"),
        ] {
            let r = export_as(&db, "N", &dir.path().join(name), format).unwrap();
            assert_eq!(r.pages, None, "{format:?}");
        }
    }

    #[test]
    fn a_proof_that_did_not_come_back_as_a_pdf_is_refused_and_nothing_is_written() {
        // THE CRASH SAFETY APPLIES TO THE NEW FORMAT TOO, and this is what says
        // so. A converter that answered with something that is not a PDF -- a
        // printer that failed halfway, an engine that wrote an error page --
        // must not put a file at the destination for a writer to find and
        // believe.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let dest = dir.path().join("out.pdf");
        let err = export_into_with(
            &db,
            "N",
            &dest,
            Dest::New,
            crate::export::Format::Pdf,
            |_| Ok(b"<html>not a pdf</html>".to_vec()),
        )
        .unwrap_err();
        assert!(err.contains("no pages"), "{err}");
        assert!(!dest.exists(), "a file that is not a proof was left behind");
    }

    #[test]
    fn a_proof_replace_that_fails_to_render_leaves_the_writers_file_untouched() {
        // The sibling-temp-and-rename dance is the crash safety and a format
        // that wrote its own file would have quietly left it behind. The
        // printer's scratch file is not the destination and never becomes one.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let dest = dir.path().join("book.pdf");
        std::fs::write(&dest, "the writer's last proof").unwrap();
        let err = export_into_with(
            &db,
            "N",
            &dest,
            Dest::Replace,
            crate::export::Format::Pdf,
            |_| Err("the web process died".to_string()),
        )
        .unwrap_err();
        assert_eq!(err, "the web process died");
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "the writer's last proof"
        );
        assert!(!export_tmp_path(&dest).exists());
    }

    #[test]
    fn the_three_formats_count_the_same_book_the_same_way() {
        // The figures describe the BOOK, not the file, so a format cannot move
        // them. `the_two_formats_...` said this of two; a third format is a
        // third chance for one of them to acquire its own answer.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let md = export_as(
            &db,
            "N",
            &dir.path().join("a.md"),
            crate::export::Format::Markdown,
        )
        .unwrap();
        let ep = export_as(
            &db,
            "N",
            &dir.path().join("a.epub"),
            crate::export::Format::Epub,
        )
        .unwrap();
        let pdf = export_into_with(
            &db,
            "N",
            &dir.path().join("a.pdf"),
            Dest::New,
            crate::export::Format::Pdf,
            |_| Ok(fake_pdf(3)),
        )
        .unwrap();
        assert_eq!((md.items, md.words), (pdf.items, pdf.words));
        assert_eq!((ep.items, ep.words), (pdf.items, pdf.words));
    }

    #[test]
    fn the_proof_is_laid_out_to_the_design_the_book_was_given() {
        // 040 STORED A TRIM AND FOUR MARGINS AND NOTHING CONSUMED THEM. This is
        // the consumer, and the assertion is on the bytes the printer receives:
        // a build that laid every book out at one size would say so here.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = seeded_project(&db);
            crate::design::write_design(&store, &crate::design::preset("non-fiction").unwrap())
                .unwrap();
        }
        let mut html = None;
        export_into_with(
            &db,
            "N",
            &dir.path().join("a.pdf"),
            Dest::New,
            crate::export::Format::Pdf,
            |bytes| {
                html = Some(String::from_utf8(bytes).unwrap());
                Ok(fake_pdf(1))
            },
        )
        .unwrap();
        let html = html.unwrap();
        // 7 x 10 in, and the non-fiction preset's 0.875 in gutter.
        assert!(
            html.contains("@page { size: 177.8mm 254mm; margin: 0; }"),
            "{html}"
        );
        assert!(html.contains("22.225mm"), "{html}");
        assert!(html.contains("Source Serif 4"), "{html}");
    }

    #[test]
    fn both_covers_reach_the_proof_and_the_back_one_is_the_last_leaf() {
        // 042 recorded that NOTHING CONSUMES A COVER YET and named this slice;
        // 043 recorded that an EPUB has nowhere to put a back cover. A bound
        // book has a front and a back, and a proof copy of one has both.
        //
        // TWO DIFFERENT PICTURES, on 043's own recorded finding: attaching the
        // same file twice makes the two sides byte-identical and a mutation
        // swapping them survives.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        let pictures = crate::pictures::dir_for(&db);
        std::fs::create_dir_all(&pictures).unwrap();
        let source = dir.path().join("in.png");
        std::fs::write(&source, include_bytes!("../../fixtures/two-halves.png")).unwrap();
        let other = dir.path().join("in.jpg");
        std::fs::write(&other, include_bytes!("../../fixtures/two-halves.jpg")).unwrap();
        let front = crate::pictures::attach(&pictures, &source).unwrap();
        let back = crate::pictures::attach(&pictures, &other).unwrap();
        {
            let store = seeded_project(&db);
            crate::covers::set_cover(&store, "front", &front).unwrap();
            crate::covers::set_cover(&store, "back", &back).unwrap();
        }
        let mut html = None;
        export_into_with(
            &db,
            "N",
            &dir.path().join("a.pdf"),
            Dest::New,
            crate::export::Format::Pdf,
            |bytes| {
                html = Some(String::from_utf8(bytes).unwrap());
                Ok(fake_pdf(1))
            },
        )
        .unwrap();
        let html = html.unwrap();
        let png = html
            .find("data:image/png;base64,")
            .expect("the front cover");
        let jpeg = html
            .find("data:image/jpeg;base64,")
            .expect("the back cover");
        assert!(png < jpeg, "the front cover is not first");
        // The PNG is the FRONT: a build that read the two rows the other way
        // round would ship the back of the book on the front of it.
        let (front_format, front_bytes) = crate::pictures::original(&pictures, &front).unwrap();
        assert_eq!(front_format.mime(), "image/png");
        assert!(
            html.contains(&crate::pictures::base64(&front_bytes)),
            "the front cover's own bytes"
        );
    }

    #[test]
    fn a_cover_whose_file_has_gone_leaves_the_proof_without_one_rather_than_failing() {
        // 038's rule, in this format: a missing file does not clear the claim
        // and must not stop the writer making a proof of their book.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = seeded_project(&db);
            crate::covers::set_cover(&store, "front", "deadbeef.png").unwrap();
        }
        let mut html = None;
        export_into_with(
            &db,
            "N",
            &dir.path().join("a.pdf"),
            Dest::New,
            crate::export::Format::Pdf,
            |bytes| {
                html = Some(String::from_utf8(bytes).unwrap());
                Ok(fake_pdf(1))
            },
        )
        .unwrap();
        let html = html.unwrap();
        assert!(!html.contains("data:image/"), "{html}");
        assert!(
            html.contains("proof-title"),
            "the book is still there: {html}"
        );
    }

    #[test]
    fn the_preview_asks_for_bounded_markup_and_reports_the_whole_book_anyway() {
        // THE BOUND IS ON WHAT CROSSES, NOT ON WHAT IS LAID OUT. A preview that
        // reported 48 leaves for a 300-page book would put the gutter minimum
        // in the wrong band, which is the one number on that surface a writer
        // would act on.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let mut asked = None;
        let view = proof_preview_of(&db, "N", |html, page| {
            asked = Some((html.to_string(), page));
            Ok(crate::pdf::ProofReport {
                leaves: 312,
                truncated: true,
                font_resolved: true,
                pages: vec!["<div class=\"proof-leaf\"></div>".to_string()],
            })
        })
        .unwrap();
        let (html, page) = asked.expect("the render ran");
        assert!(html.contains("\"markupLimit\":48"), "{html}");
        assert_eq!(page, (152_400, 228_600));
        assert_eq!(view.leaves, 312);
        assert!(view.truncated);
        assert_eq!(view.pages.len(), 1);
        // 312 pages is KDP's 301-500 band: 0.625 in.
        assert_eq!(view.gutter_minimum_um, Some(15_875));
        assert_eq!(view.inner_um, 19_050);
        assert_eq!(view.items, 1);
        assert_eq!(view.words, 4);
    }

    #[test]
    fn the_preview_is_handed_the_leaves_stylesheet_and_never_the_printers() {
        // 043's `scopeStylesheet` REFUSES an at-rule rather than mangling one,
        // so a `@page` in the stylesheet the rail is given is a preview with no
        // styling at all -- and every rule that decides a line break has to be
        // in it or the preview is a second layout.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let view = proof_preview_of(&db, "N", |_, _| {
            Ok(crate::pdf::ProofReport {
                leaves: 1,
                truncated: false,
                font_resolved: true,
                pages: vec![],
            })
        })
        .unwrap();
        assert!(!view.css.contains("@page"), "{}", view.css);
        assert!(view.css.contains(".proof-leaf"), "{}", view.css);
        assert!(view.css.contains("152.4mm"), "{}", view.css);
    }

    #[test]
    fn the_preview_carries_whether_the_books_own_face_resolved() {
        // 040's recorded gap: this application ships no font files, so a writer
        // whose machine lacks the face "gets something else and is told
        // nothing". The render measures it and the rail says it.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        for resolved in [true, false] {
            let view = proof_preview_of(&db, "N", |_, _| {
                Ok(crate::pdf::ProofReport {
                    leaves: 1,
                    truncated: false,
                    font_resolved: resolved,
                    pages: vec![],
                })
            })
            .unwrap();
            assert_eq!(view.font_resolved, resolved);
            assert_eq!(view.font, "Crimson Text");
        }
    }

    #[test]
    fn the_preview_reports_a_render_that_failed_rather_than_an_empty_book() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let err = proof_preview_of(&db, "N", |_, _| Err("no display".to_string())).unwrap_err();
        assert_eq!(err, "no display");
    }

    #[test]
    fn a_book_with_nothing_in_it_previews_as_its_title_page_and_a_contents() {
        // WHAT A WRITER SEES WHEN THE BOOK IS EMPTY, and it is not an empty
        // rail. Every book has a title, so every book has a first page.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(crate::store::Store::open(&db).unwrap());
        let preview = preview_of(&db, "Untitled").unwrap();
        assert_eq!(preview.documents.len(), 2);
        assert!(preview.documents[0].xhtml.contains("Untitled"));
    }

    // --------------------------------------------- 053, the export preflight

    fn vault_with(names: &[(&str, &str)]) -> crate::identity::Vault {
        crate::identity::Vault {
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
        }
    }

    fn pin_project(db: &Path, identity: &crate::identity::Identity) {
        let store = crate::store::Store::open(db).unwrap();
        crate::identity::set_pin(&store, Some(&crate::identity::pin_of(identity, 10))).unwrap();
    }

    #[test]
    fn every_format_is_checked_at_the_one_place_and_the_result_carries_the_report() {
        // THE CONVERGENCE POINT. Markdown, EPUB and a proof copy all build one
        // `Book` in `render_project_with` and then match on `Format`; a check
        // between the two sees all three once. Placed in the three arms it would
        // be three checks with three drift paths.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        for (format, ext) in [
            (crate::export::Format::Markdown, "md"),
            (crate::export::Format::Epub, "epub"),
        ] {
            let dest = dir.path().join(format!("out.{ext}"));
            let r = export_as(&db, "My Novel", &dest, format).unwrap();
            assert_eq!(r.preflight.format, format.id());
            // Nothing pinned, so exactly one warning and no blocker -- and the
            // export happened, which is the whole of that decision.
            assert_eq!(r.preflight.blockers, 0);
            assert!(r
                .preflight
                .findings
                .iter()
                .any(|f| f.kind == crate::identity::FINDING_IDENTITY_UNSET));
            assert!(dest.exists());
        }
        // And the PDF, whose render is not the file, through the injected
        // conversion so no display is needed.
        let dest = dir.path().join("out.pdf");
        let r = export_into_with(
            &db,
            "My Novel",
            &dest,
            Dest::New,
            crate::export::Format::Pdf,
            |_| Ok(fake_pdf(1)),
        )
        .unwrap();
        assert_eq!(r.preflight.format, "pdf");
    }

    #[test]
    fn a_cross_identity_leak_stops_the_export_and_no_file_is_written() {
        // A BLOCKER STOPS THE RENDER, so there is no file and no result -- and
        // the sentence names the location, which is the only reason a check is
        // allowed to block at all.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = crate::store::Store::open(&db).unwrap();
            let scene = store.item_create(None, "scene", "Opening").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: scene.id.clone(),
                    body: body("Bram Kell was already there"),
                    base_rev: scene.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let vault = vault_with(&[("i1", "Ada Vane"), ("i2", "Bram Kell")]);
        pin_project(&db, &vault.identities[0]);

        let dest = dir.path().join("out.md");
        let err = super::export_to(
            &db,
            "My Novel",
            &dest,
            &vault,
            crate::strings::Strings::english(),
        )
        .unwrap_err();
        assert!(err.contains("Bram Kell"), "{err}");
        assert!(!dest.exists(), "a blocked export must write nothing");

        // THE CONTROL. The same book, the same vault, with the OTHER identity
        // pinned instead -- the name is then this book's own and the export
        // runs. Without this the test would pass against a build that refused
        // every export.
        pin_project(&db, &vault.identities[1]);
        super::export_to(
            &db,
            "My Novel",
            &dest,
            &vault,
            crate::strings::Strings::english(),
        )
        .unwrap();
        assert!(dest.exists());
    }

    #[test]
    fn a_preview_is_blocked_by_the_same_check_as_a_save() {
        // The check sits before the format match, so it covers previews as well
        // as saves. A preview that rendered what a save refuses would be a
        // surface a writer could read their leak out of.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        {
            let store = crate::store::Store::open(&db).unwrap();
            let scene = store.item_create(None, "scene", "Opening").unwrap();
            store
                .flush(&[FlushEntry {
                    item_id: scene.id.clone(),
                    body: body("Bram Kell was already there"),
                    base_rev: scene.doc_rev.unwrap(),
                    comments: None,
                }])
                .unwrap();
        }
        let vault = vault_with(&[("i1", "Ada Vane"), ("i2", "Bram Kell")]);
        pin_project(&db, &vault.identities[0]);
        let err = super::preview_of(&db, "My Novel", &vault, crate::strings::Strings::english())
            .unwrap_err();
        assert!(err.contains("Bram Kell"), "{err}");
        // The control, as above.
        pin_project(&db, &vault.identities[1]);
        super::preview_of(&db, "My Novel", &vault, crate::strings::Strings::english()).unwrap();
    }

    #[test]
    fn an_unreadable_vault_stops_the_export_rather_than_running_against_an_empty_one() {
        // THE LOAD-BEARING FAILURE OF THIS WHOLE SLICE. A vault that will not
        // parse read as empty makes the cross-identity check report that it
        // found nothing, on the one machine where there was something to find.
        // `read_settings` beside it does the opposite and is right to.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let store = crate::store::Store::open(&db).unwrap();
        let store_words = store.word_index().unwrap();
        let excluded = crate::store::excluded_from_book(&store.items().unwrap());
        let state = StoreState(Mutex::new(Some(OpenProject {
            book_id: crate::project_book_id(&store).unwrap(),
            registry_home: None,
            store,
            path: db.clone(),
            name: "My Novel".to_string(),
            generation: 1,
            words: store_words,
            excluded,
            analytics: None,
            tracking_on: false,
        })));
        std::fs::create_dir_all(dir.path().join(crate::APP_DIR)).unwrap();
        std::fs::write(
            crate::identity::vault_path(dir.path()),
            b"{ this is not a vault",
        )
        .unwrap();

        let err = export_open_project(&state, dir.path(), |p, n, d, v, g| {
            super::export_to(p, n, d, v, g)
        })
        .unwrap_err();
        assert!(err.contains("identities.json"), "{err}");
        // Nothing was exported: the refusal is before the directory is even
        // made, so there is no half-done act to undo.
        assert!(!crate::export_dir(dir.path()).exists(), "{err}");

        // THE CONTROL. Remove the file and the same call exports, so this
        // cannot pass against a build that refuses every export.
        std::fs::remove_file(crate::identity::vault_path(dir.path())).unwrap();
        export_open_project(&state, dir.path(), |p, n, d, v, g| super::export_to(p, n, d, v, g))
            .unwrap();
    }

    #[test]
    fn a_pinned_book_writes_its_byline_into_the_epub_and_not_into_the_markdown() {
        // The two ends of the field map, through the real export path: an EPUB
        // carries `dc:creator` and Markdown carries nothing, which is what the
        // disclosure check says of each.
        let dir = tempdir().unwrap();
        let db = dir.path().join("p.db");
        drop(seeded_project(&db));
        let vault = vault_with(&[("i1", "Ada Vane")]);
        pin_project(&db, &vault.identities[0]);

        let epub = dir.path().join("out.epub");
        let r = super::export_as(
            &db,
            "My Novel",
            &epub,
            crate::export::Format::Epub,
            &vault,
            crate::strings::Strings::english(),
        )
        .unwrap();
        assert_eq!(r.preflight.fields.len(), 1);
        assert_eq!(r.preflight.fields[0].at, "dc:creator");
        let entries = crate::epub::read_zip(&std::fs::read(&epub).unwrap()).unwrap();
        let (_, opf) = entries
            .iter()
            .find(|(n, _)| n == crate::epub::OPF_PATH)
            .unwrap();
        assert!(String::from_utf8_lossy(opf).contains("Ada Vane"));

        let md = dir.path().join("out.md");
        let r = super::export_to(
            &db,
            "My Novel",
            &md,
            &vault,
            crate::strings::Strings::english(),
        )
        .unwrap();
        assert!(r.preflight.fields.is_empty());
        assert!(!std::fs::read_to_string(&md).unwrap().contains("Ada Vane"));
    }
}
