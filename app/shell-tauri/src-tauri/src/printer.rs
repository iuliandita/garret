// app/shell-tauri/src-tauri/src/printer.rs
// The Linux proof renderer. Windows uses printer_windows.rs; the report parser
// and Printed result are shared so both engines feed the same export contract.
//
// WHAT IT DOES. It loads the proof document `pdf.rs` built into a WebKitGTK web
// view of its own, lets that document's own script cut the flow into leaves,
// reads the leaves back, and asks the same view to print itself into a PDF
// file. One load, one layout, one set of leaf boundaries: the preview shows the
// leaves the printer was handed, which is 043's "the preview is the file, read
// back" met for a format that cannot be read back.
//
// WHY WEBKIT AND NOT A PDF CRATE. The publishing track's design record, section
// (d): `webkit2gtk` with feature `v2_40` is already a direct dependency of this
// crate and nothing else in the 450-package lock rasterizes text or emits PDF.
// It was VERIFIED before it was chosen -- headless, under Xvfb, printing to a
// file with no printer and no CUPS. `gtk` and
// `javascriptcore-rs` are named in Cargo.toml and neither is a new
// package: both are already in the lock under `webkit2gtk` and `tauri`, so
// naming them unifies to the same compilation unit rather than adding one --
// the argument this crate already made for `webkit2gtk` itself.
//
// Rendering needs a display and a live web process. The ignored lifecycle test
// runs under an isolated X display; preview-cli covers the shipped export path.
// The document, stylesheet, page count and gutter rules stay pure in pdf.rs.

use crate::pdf::ProofReport;
#[cfg(target_os = "linux")]
use webkit2gtk::{gio, glib};

/// How long a proof render may take before it is abandoned.
///
/// A BOUND RATHER THAN A HANG. A book with no bound on its leaves is a book
/// whose pagination is O(the manuscript), and a writer whose window stopped
/// answering would have no way to tell a slow book from a broken application.
/// The failure is reported; it is never a silent empty preview.
#[cfg(target_os = "linux")]
const RENDER_TIMEOUT_SECONDS: u32 = 180;

#[derive(serde::Deserialize)]
struct PaginatorOutcome {
    report: Option<ProofReport>,
    error: Option<String>,
}

pub(crate) fn proof_report(json: &str) -> Result<ProofReport, String> {
    let outcome: PaginatorOutcome = serde_json::from_str(json)
        .map_err(|e| format!("{e}: the proof reported nothing this build can read"))?;
    if let Some(error) = outcome.error {
        return Err(format!("proof layout failed: {error}"));
    }
    outcome
        .report
        .ok_or_else(|| "the proof paginator did not report a result".to_string())
}

#[cfg(any(windows, test))]
pub(crate) fn proof_request_authorized(
    label: &str,
    path: &str,
    expected_label: &str,
    nonce: &str,
) -> bool {
    label == expected_label && path.strip_prefix('/') == Some(nonce)
}

#[cfg(any(windows, test))]
pub(crate) fn proof_navigation_allowed(url: &str, nonce: &str) -> bool {
    url == "about:blank"
        || url == format!("proof://localhost/{nonce}")
        || url == format!("http://proof.localhost/{nonce}")
        || url == format!("https://proof.localhost/{nonce}")
}

/// What one render produced.
pub struct Printed {
    pub report: ProofReport,
    /// The PDF, or None when the caller asked only to paginate.
    pub bytes: Option<Vec<u8>>,
}

/// Load `html`, let it paginate itself, and optionally print it.
///
/// MUST RUN ON THE THREAD OWNING THE GTK MAIN CONTEXT. Both callers arrange
/// that: the command path posts through `run_on_main_thread`, and the CLI path
/// owns the loop itself. The `finished` handler is what completes the work, so
/// this function returns as soon as the operation is armed.
#[cfg(target_os = "linux")]
pub fn render(
    html: &str,
    dest: Option<&std::path::Path>,
    page_um: (i64, i64),
    done: impl FnOnce(Result<Printed, String>) + 'static,
) {
    render_with_timeout(html, dest, page_um, RENDER_TIMEOUT_SECONDS, done);
}

#[cfg(target_os = "linux")]
fn render_with_timeout(
    html: &str,
    dest: Option<&std::path::Path>,
    page_um: (i64, i64),
    timeout_seconds: u32,
    done: impl FnOnce(Result<Printed, String>) + 'static,
) {
    use gtk::prelude::*;
    use webkit2gtk::{PrintOperationExt, WebViewExt};

    // A timed-out proof must be terminable without touching the editor's process.
    let context = webkit2gtk::WebContext::new_ephemeral();
    let view = webkit2gtk::WebView::with_context(&context);
    // A REAL TOPLEVEL, NOT AN OFFSCREEN ONE. `Gtk::OffscreenWindow` forces the
    // GL path and WebKitGTK aborts on it under Xvfb -- "GDK is not able to
    // create a GL context: The current backend does not support OpenGL", a core
    // dump rather than an error. Measured; the probe is in the record. The
    // window is never presented, so nothing appears on the writer's desktop.
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.add(&view);
    window.realize();
    view.realize();

    let dest = dest.map(|p| p.to_path_buf());
    let holder = std::rc::Rc::new(std::cell::RefCell::new(Some(
        Box::new(done) as Box<dyn FnOnce(Result<Printed, String>)>
    )));
    let keep = std::rc::Rc::new(std::cell::RefCell::new(Some((view.clone(), window))));
    // Where a live print operation waits out its own asynchrony. Cleared with
    // the view, so nothing outlives the render that made it.
    let parked: std::rc::Rc<std::cell::RefCell<Option<webkit2gtk::PrintOperation>>> =
        std::rc::Rc::new(std::cell::RefCell::new(None));
    let timer = std::rc::Rc::new(std::cell::RefCell::new(None::<glib::SourceId>));
    let termination_timer = std::rc::Rc::new(std::cell::RefCell::new(None::<glib::SourceId>));
    let timed_out = std::rc::Rc::new(std::cell::Cell::new(false));

    let answer = {
        let holder = holder.clone();
        let keep = keep.clone();
        let parked = parked.clone();
        let timer = timer.clone();
        let termination_timer = termination_timer.clone();
        move |result: Result<Printed, String>| {
            let Some(callback) = holder.borrow_mut().take() else {
                return;
            };
            if let Some(source) = timer.borrow_mut().take() {
                source.remove();
            }
            if let Some(source) = termination_timer.borrow_mut().take() {
                source.remove();
            }
            // The view and its window outlive this function and are dropped
            // exactly once, when the work is over or abandoned. Dropping them
            // earlier destroys the web process mid-print.
            let operation = parked.borrow_mut().take();
            drop(operation);
            let kept = keep.borrow_mut().take();
            if let Some((_, window)) = kept {
                unsafe { window.destroy() };
            }
            // The CLI quits its main loop here, after cleanup has finished.
            callback(result);
        }
    };

    {
        let answer = answer.clone();
        let timed_out = timed_out.clone();
        view.connect_web_process_terminated(move |_, reason| {
            let message = if timed_out.get() {
                format!("the proof did not finish within {timeout_seconds} seconds")
            } else {
                format!("the proof web process terminated: {reason:?}")
            };
            answer(Err(message));
        });
    }

    // The timeout is armed before the load, so a document that never finishes
    // loading is bounded too.
    {
        let answer = answer.clone();
        let timer_fired = timer.clone();
        let termination_timer = termination_timer.clone();
        let timed_out = timed_out.clone();
        let weak_view = view.downgrade();
        *timer.borrow_mut() = Some(glib::timeout_add_seconds_local_once(
            timeout_seconds,
            move || {
                timer_fired.borrow_mut().take();
                timed_out.set(true);
                let fallback_timer = termination_timer.clone();
                *termination_timer.borrow_mut() =
                    Some(glib::timeout_add_seconds_local_once(2, move || {
                        fallback_timer.borrow_mut().take();
                        answer(Err(format!(
                            "the proof did not finish within {timeout_seconds} seconds"
                        )));
                    }));
                // Closing IPC cannot interrupt the paginator's synchronous script.
                // Keep pumping GTK until WebKit acknowledges termination.
                if let Some(view) = weak_view.upgrade() {
                    view.terminate_web_process();
                }
            },
        ));
    }

    let printing = std::cell::Cell::new(false);
    let completed = holder.clone();
    view.connect_load_changed(move |view, event| {
        if event != webkit2gtk::LoadEvent::Finished
            || printing.get()
            || timed_out.get()
            || completed.borrow().is_none()
        {
            return;
        }
        printing.set(true);
        let answer = answer.clone();
        let dest = dest.clone();
        let weak_view = view.downgrade();
        let parked = parked.clone();
        let timed_out = timed_out.clone();
        let completed = completed.clone();
        // The paginator has already run by the time the load finishes -- it is
        // a classic synchronous script at the end of the body -- so this reads
        // a result rather than waiting for one.
        view.evaluate_javascript(
            "JSON.stringify({report:window.__proof || null,error:window.__proofError || null})",
            None,
            None,
            None::<&gio::Cancellable>,
            move |value| {
                if timed_out.get() || completed.borrow().is_none() {
                    return;
                }
                let Some(view) = weak_view.upgrade() else {
                    return;
                };
                let report = match value
                    .map_err(|e| e.to_string())
                    .map(|v| v.to_string())
                    .and_then(|s| proof_report(&s))
                {
                    Ok(report) => report,
                    Err(e) => {
                        answer(Err(e));
                        return;
                    }
                };
                let Some(dest) = dest else {
                    answer(Ok(Printed {
                        report,
                        bytes: None,
                    }));
                    return;
                };
                let operation = webkit2gtk::PrintOperation::new(&view);
                let settings = gtk::PrintSettings::new();
                // THE FILE BACKEND, WHICH NEEDS NO PRINTER AND NO CUPS. GTK
                // ships it in-tree; "Print to File" is its printer name and the
                // output uri is where the sheets land.
                settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(&uri_for(&dest)));
                settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
                settings.set_printer("Print to File");
                let setup = gtk::PageSetup::new();
                setup.set_paper_size(&gtk::PaperSize::new_custom(
                    "proof",
                    "Proof",
                    micrometres_to_points(page_um.0),
                    micrometres_to_points(page_um.1),
                    gtk::Unit::Points,
                ));
                // ZERO MARGINS HERE, and the book's own margins are the leaf's
                // padding instead. A margin set twice is a margin applied twice:
                // the printable area would shrink under a leaf box that is
                // already exactly the trim, and every leaf would spill onto a
                // second sheet.
                setup.set_top_margin(0.0, gtk::Unit::Points);
                setup.set_bottom_margin(0.0, gtk::Unit::Points);
                setup.set_left_margin(0.0, gtk::Unit::Points);
                setup.set_right_margin(0.0, gtk::Unit::Points);
                operation.set_print_settings(&settings);
                operation.set_page_setup(&setup);

                let finished = std::cell::RefCell::new(Some((answer.clone(), report, dest)));
                let failed = std::cell::RefCell::new(Some(answer));
                let timed_out_finished = timed_out.clone();
                operation.connect_finished(move |_| {
                    if timed_out_finished.get() {
                        return;
                    }
                    let Some((answer, report, dest)) = finished.borrow_mut().take() else {
                        return;
                    };
                    match std::fs::read(&dest) {
                        Ok(bytes) => answer(Ok(Printed {
                            report,
                            bytes: Some(bytes),
                        })),
                        Err(e) => answer(Err(format!("{}: {e}", dest.display()))),
                    }
                });
                operation.connect_failed(move |_, error| {
                    if timed_out.get() {
                        return;
                    }
                    if let Some(answer) = failed.borrow_mut().take() {
                        answer(Err(error.to_string()));
                    }
                });
                // A LIVE REFERENCE FOR THE LIFE OF THE OPERATION. `print()` is
                // asynchronous; a `PrintOperation` dropped here would take the
                // job with it and the `finished` signal would never arrive.
                // PARKED, NOT LEAKED. `std::mem::forget` was the first draft
                // and it holds one GObject per export for the life of the
                // window; this drops with the view that made it.
                *parked.borrow_mut() = Some(operation.clone());
                operation.print();
            },
        );
    });

    view.load_html(html, Some("about:blank"));
}

/// Micrometres as PostScript points, which is what GTK's paper sizes take.
///
/// 1 in is 72 pt and 25 400 um, so a point is 2540/72 um exactly. The division
/// is the only float on this path and it is at the very edge, handing a number
/// to a toolkit that stores doubles anyway.
#[cfg(target_os = "linux")]
fn micrometres_to_points(um: i64) -> f64 {
    um as f64 * 72.0 / 25_400.0
}

/// A path as a `file://` URI.
///
/// Percent-encoded on the conservative side: everything outside the unreserved
/// set plus `/` is escaped, so a destination the writer chose in an OS dialog
/// cannot carry a character that ends the URI. A path is bytes on Linux and the
/// lossy conversion is what the dialog already handed us.
#[cfg(target_os = "linux")]
fn uri_for(path: &std::path::Path) -> String {
    let mut out = String::from("file://");
    for byte in path.to_string_lossy().as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A proof render, from a thread that is not the GTK main thread.
///
/// THE COMMAND PATH. `render` must be armed on the thread owning the main
/// context; a Tauri command runs on the async runtime, so the work is posted
/// across and the answer comes back over a channel. Blocking here is safe and
/// deliberate: the thread that is blocked is not the one that has to pump the
/// loop, and an export is already an operation the writer is waiting on.
#[cfg(target_os = "linux")]
pub fn render_via(
    app: &tauri::AppHandle,
    html: &str,
    dest: Option<&std::path::Path>,
    page_um: (i64, i64),
) -> Result<Printed, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let html = html.to_string();
    let dest = dest.map(|p| p.to_path_buf());
    app.run_on_main_thread(move || {
        render(&html, dest.as_deref(), page_um, move |result| {
            let _ = tx.send(result);
        });
    })
    .map_err(|e| e.to_string())?;
    // A wider bound than the render's own, so the render's timeout is what
    // reports a slow book and this only ever fires if the main loop itself is
    // gone -- two failures with two different owners, which is the recorded
    // reason exit codes 2 and 3 are not one code.
    rx.recv_timeout(std::time::Duration::from_secs(
        (RENDER_TIMEOUT_SECONDS + 30) as u64,
    ))
    .map_err(|_| "the proof render never answered".to_string())?
}

/// The same, owning the main loop.
///
/// THE CLI PATH, and it is why `garret export --format pdf` needs a
/// display where the other two formats do not. That is stated in the usage and
/// refused with a sentence rather than a crash: a proof copy is laid out by a
/// web engine, and a web engine needs somewhere to render.
#[cfg(target_os = "linux")]
pub fn render_standalone(
    html: &str,
    dest: Option<&std::path::Path>,
    page_um: (i64, i64),
) -> Result<Printed, String> {
    gtk::init().map_err(|_| {
        "a PDF proof is laid out by a web engine, which needs a display: \
         set DISPLAY or WAYLAND_DISPLAY, or run this under xvfb-run"
            .to_string()
    })?;
    let answer = std::rc::Rc::new(std::cell::RefCell::new(None));
    {
        let answer = answer.clone();
        render(html, dest, page_um, move |result| {
            *answer.borrow_mut() = Some(result);
            gtk::main_quit();
        });
    }
    gtk::main();
    let taken = answer.borrow_mut().take();
    taken.unwrap_or_else(|| Err("the proof render never answered".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_document_requires_its_own_window_and_exact_nonce() {
        assert!(proof_request_authorized(
            "proof-abc",
            "/abc",
            "proof-abc",
            "abc"
        ));
        assert!(!proof_request_authorized(
            "main",
            "/abc",
            "proof-abc",
            "abc"
        ));
        assert!(!proof_request_authorized(
            "proof-abc",
            "/abcd",
            "proof-abc",
            "abc"
        ));
        assert!(!proof_request_authorized(
            "proof-abc",
            "/abc/extra",
            "proof-abc",
            "abc"
        ));
    }

    #[test]
    fn proof_navigation_stays_on_its_own_origin() {
        assert!(proof_navigation_allowed(
            "http://proof.localhost/abc",
            "abc"
        ));
        assert!(!proof_navigation_allowed(
            "https://proof.evil.test/abc",
            "abc"
        ));
        assert!(!proof_navigation_allowed(
            "http://proof.localhost/def",
            "abc"
        ));
    }

    #[cfg(target_os = "linux")]
    fn render_for_test(
        html: &str,
        dest: Option<&std::path::Path>,
        page_um: (i64, i64),
    ) -> Result<Printed, String> {
        let result = std::rc::Rc::new(std::cell::RefCell::new(None));
        let done = result.clone();
        render_with_timeout(html, dest, page_um, 15, move |value| {
            *done.borrow_mut() = Some(value);
            gtk::main_quit();
        });
        gtk::main();
        let answer = result.borrow_mut().take().expect("render answered");
        answer
    }

    #[test]
    fn paginator_errors_are_returned_before_printing() {
        let error =
            proof_report(r#"{"report":null,"error":"a proof h2 exceeds the page"}"#).unwrap_err();
        assert_eq!(error, "proof layout failed: a proof h2 exceeds the page");
        assert_eq!(
            proof_report(r#"{"report":null,"error":null}"#).unwrap_err(),
            "the proof paginator did not report a result"
        );
    }

    #[test]
    #[ignore = "requires an isolated X display and a live WebKit process"]
    fn rich_paragraphs_keep_text_and_marks_and_oversized_headings_refuse() {
        fn document(flow: &str) -> String {
            let shell = r#"<!doctype html><html><head><style>
              html,body{margin:0}body{font:16px/20px serif}
              .proof-leaf{width:180px;height:150px;box-sizing:border-box;display:flex;
                flex-direction:column;overflow:hidden}
              .proof-runhead,.proof-folio{height:20px;flex:0 0 auto}
              .proof-text{flex:1 1 auto;min-height:0;overflow:hidden}
              p,h2{margin:0}p{overflow-wrap:anywhere}p.proof-continued{text-indent:0}
              </style><script type="application/json" id="proof-meta">
              {"book":"Test","font":"serif","newPage":false,"markupLimit":null}
              </script></head><body><div id="proof-flow">__FLOW__</div>
              <div id="proof-leaves"></div><script>__SCRIPT__</script>
              <script>if(window.__proof){
                document.querySelectorAll('.proof-text p').forEach(function(p){
                  p.setAttribute('data-lines', String(Math.round(p.offsetHeight / 20)));
                });
                window.__proof.pages = Array.from(document.querySelectorAll('.proof-leaf'),
                  function(page){ return page.outerHTML; });
                if(document.querySelector('.proof-text em strong')){
                  window.__proof.pages.push(JSON.stringify({
                    marked: Array.from(document.querySelectorAll('.proof-text em strong'),
                      function(node){ return node.textContent; }).join(''),
                    underlined: Array.from(document.querySelectorAll('.proof-text u'),
                      function(node){ return node.textContent; }).join('')
                  }));
                }
              }</script></body></html>"#;
            shell
                .replace("__FLOW__", flow)
                .replace("__SCRIPT__", crate::pdf::PAGINATOR_JS)
        }
        fn paginate(html: String) -> Result<Printed, String> {
            render_for_test(&html, None, (152_400, 228_600))
        }
        fn text_column(page: &str) -> &str {
            let start = page.find("class=\"proof-text\"").expect("text column");
            let start = page[start..].find('>').unwrap() + start + 1;
            let end = page[start..].find("</div>").unwrap() + start;
            &page[start..end]
        }
        fn visible_text(markup: &str) -> String {
            let mut text = String::new();
            let mut inside_tag = false;
            for ch in markup.chars() {
                if ch == '<' {
                    inside_tag = true;
                } else if ch == '>' {
                    inside_tag = false;
                } else if !inside_tag {
                    text.push(ch);
                }
            }
            text
        }

        gtk::init().unwrap();
        let before = "before  ".repeat(35);
        let marked = "café\tinside  marks ".repeat(35);
        let after = "after  ".repeat(35);
        let flow = format!("<p>{before}<em><strong>{marked}</strong></em><u>{after}</u></p>");
        let mut rendered = paginate(document(&flow)).unwrap();
        assert!(rendered.report.leaves > 1);
        let marks: serde_json::Value =
            serde_json::from_str(&rendered.report.pages.pop().expect("mark probe")).unwrap();
        assert_eq!(marks["marked"].as_str(), Some(marked.as_str()));
        assert_eq!(marks["underlined"].as_str(), Some(after.as_str()));
        let columns: Vec<_> = rendered
            .report
            .pages
            .iter()
            .map(|p| text_column(p))
            .collect();
        assert_eq!(
            columns.iter().map(|p| visible_text(p)).collect::<String>(),
            format!("{before}{marked}{after}")
        );
        assert!(columns.iter().any(|p| p.contains("<em><strong>")));
        assert!(columns.iter().any(|p| p.contains("<u>")));
        assert!(
            columns.iter().all(|p| p.contains("data-lines=\"2\"")
                || (3..=7).any(|n| p.contains(&format!("data-lines=\"{n}\"")))),
            "a splittable paragraph left a one-line fragment: {columns:?}"
        );

        let deep = "deeply marked words ".repeat(250);
        let final_run = "final marked words ".repeat(20);
        let all_marked = format!(
            "<p><br><em><strong>{deep}</strong></em><br>\
             <em><strong>{final_run}</strong></em><br></p>"
        );
        let mut marked_proof = paginate(document(&all_marked)).unwrap();
        assert!(marked_proof.report.leaves > 3);
        let marks: serde_json::Value =
            serde_json::from_str(&marked_proof.report.pages.pop().expect("mark probe")).unwrap();
        let expected_marked = format!("{deep}{final_run}");
        assert_eq!(marks["marked"].as_str(), Some(expected_marked.as_str()));
        let marked_columns: Vec<_> = marked_proof
            .report
            .pages
            .iter()
            .map(|p| text_column(p))
            .collect();
        assert_eq!(
            marked_columns
                .iter()
                .map(|p| visible_text(p))
                .collect::<String>(),
            expected_marked
        );
        assert_eq!(
            marked_columns
                .iter()
                .map(|p| p.matches("<br").count())
                .sum::<usize>(),
            3,
            "a hard break was lost at a split"
        );

        for token in ["😀".repeat(200), format!("short {}", "😀".repeat(200))] {
            let unicode = paginate(document(&format!("<p>{token}</p>"))).unwrap();
            assert!(unicode.report.leaves > 1);
            assert_eq!(
                unicode
                    .report
                    .pages
                    .iter()
                    .map(|p| visible_text(text_column(p)))
                    .collect::<String>(),
                token
            );
        }

        let too_wide = format!("<h2 style=\"white-space:nowrap\">{}</h2>", "W".repeat(300));
        let refused = match paginate(document(&too_wide)) {
            Ok(_) => panic!("an overflowing heading was printed"),
            Err(error) => error,
        };
        assert_eq!(refused, "proof layout failed: a proof h2 exceeds the page");

        let impossible_pair = "<h2 style=\"height:100px\">Head</h2><p>tail</p>";
        let refused = match paginate(document(impossible_pair)) {
            Ok(_) => panic!("an unplaceable heading pair was printed"),
            Err(error) => error,
        };
        assert_eq!(
            refused,
            "proof layout failed: a proof heading and following block exceed the page"
        );
    }

    #[test]
    #[ignore = "requires an isolated X display, WebKit and Poppler tools"]
    fn printed_rich_paragraph_is_readable_from_the_pdf() {
        use crate::covers::CoverFit;
        use crate::design::{default_design, ChapterStyle};
        use crate::export::Book;
        use crate::pdf::{pdf_page_count, proof_document, Cover, Proof};
        use std::process::Command;

        gtk::init().unwrap();
        let chapters = vec![("chapter".to_string(), "Chapter".to_string(), 0)];
        let book = Book {
            name: "Proof Test",
            contents_title: "Contents",
            front: &[],
            chapters: &chapters,
            back: &[],
        };
        let body = serde_json::json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": format!("Beginproof {}", "plain words ".repeat(220))},
                {"type": "text", "text": format!("Middleproof {}", "marked words ".repeat(220)),
                    "marks": [{"type": "em"}, {"type": "strong"}]},
                {"type": "text", "text": format!("{}Endproof", "final words ".repeat(220)),
                    "marks": [{"type": "underline"}]}
            ]}]
        })
        .to_string();
        let bodies = std::collections::HashMap::from([("chapter".to_string(), body)]);
        let design = default_design();
        let html = proof_document(&Proof {
            language: "en",
            book: &book,
            openings: Default::default(),
            bodies: &bodies,
            design: &design,
            style: ChapterStyle {
                glyph: None,
                new_page: false,
                caps_title: false,
                drop_cap: false,
            },
            front_cover: Some(Cover {
                bytes: include_bytes!("../fixtures/black-and-clear.png").to_vec(),
                media_type: "image/png",
                fit: CoverFit::Contain,
            }),
            back_cover: Some(Cover {
                bytes: include_bytes!("../fixtures/black-and-clear.png").to_vec(),
                media_type: "image/png",
                fit: CoverFit::Fill,
            }),
            markup_limit: None,
            pin: None,
        });
        let directory = tempfile::tempdir().unwrap();
        let dest = directory.path().join("proof.pdf");
        let printed = render_for_test(
            &html,
            Some(&dest),
            (design.page.width_um, design.page.height_um),
        )
        .unwrap();
        let bytes = printed.bytes.expect("printed bytes");
        assert!(printed.report.leaves > 4);
        assert!(printed.report.pages[0].contains("data-kind=\"plate\""));
        assert!(printed.report.pages[1].contains("data-kind=\"title\""));
        assert!(printed
            .report
            .pages
            .last()
            .unwrap()
            .contains("data-kind=\"plate\""));
        assert_eq!(pdf_page_count(&bytes), Some(printed.report.leaves));

        let info = Command::new("pdfinfo").arg(&dest).output().unwrap();
        assert!(
            info.status.success(),
            "{}",
            String::from_utf8_lossy(&info.stderr)
        );
        let info = String::from_utf8(info.stdout).unwrap();
        let pages: u32 = info
            .lines()
            .find_map(|line| line.strip_prefix("Pages:"))
            .expect("pdfinfo page count")
            .trim()
            .parse()
            .unwrap();
        assert_eq!(pages, printed.report.leaves);

        let images = Command::new("pdfimages")
            .args(["-list"])
            .arg(&dest)
            .output()
            .unwrap();
        assert!(
            images.status.success(),
            "{}",
            String::from_utf8_lossy(&images.stderr)
        );
        let image_pages: Vec<u32> = String::from_utf8(images.stdout)
            .unwrap()
            .lines()
            .skip(2)
            .filter_map(|line| line.split_whitespace().next()?.parse().ok())
            .collect();
        assert!(
            image_pages.contains(&1),
            "front cover image missing: {image_pages:?}"
        );
        assert!(
            image_pages.contains(&pages),
            "back cover image is not last: {image_pages:?}"
        );

        let extracted = Command::new("pdftotext")
            .args(["-layout", dest.to_str().unwrap(), "-"])
            .output()
            .unwrap();
        assert!(
            extracted.status.success(),
            "{}",
            String::from_utf8_lossy(&extracted.stderr)
        );
        let extracted = String::from_utf8(extracted.stdout).unwrap();
        // The PDF reader emits the font's fi ligature as one Unicode scalar.
        let extracted = extracted.replace('ﬁ', "fi");
        let normalized = extracted.split_whitespace().collect::<Vec<_>>().join(" ");
        for marker in ["Beginproof", "Middleproof", "Endproof"] {
            assert!(normalized.contains(marker), "PDF lost {marker}");
        }
        for word in ["plain", "marked", "final"] {
            assert_eq!(
                normalized
                    .split_whitespace()
                    .filter(|part| *part == word)
                    .count(),
                220,
                "PDF lost prose from the {word} run"
            );
        }
        assert!(
            normalized.find("Beginproof") < normalized.find("Middleproof")
                && normalized.find("Middleproof") < normalized.find("Endproof")
        );
        assert!(normalized.rfind("final words") < normalized.rfind("Endproof"));

        if let Some(stem) = std::env::var_os("WRITE_PROOF_SCREENSHOT") {
            let shot = Command::new("pdftoppm")
                .args([
                    "-f",
                    "3",
                    "-l",
                    "3",
                    "-scale-to",
                    "1200",
                    "-png",
                    "-singlefile",
                ])
                .arg(&dest)
                .arg(stem)
                .output()
                .unwrap();
            assert!(
                shot.status.success(),
                "{}",
                String::from_utf8_lossy(&shot.stderr)
            );
        }
    }

    #[test]
    #[ignore = "requires an isolated X display and a live WebKit process"]
    fn a_busy_proof_times_out_once_without_killing_another_view() {
        use gtk::prelude::*;
        use javascriptcore::ValueExt;
        use webkit2gtk::WebViewExt;
        gtk::init().unwrap();
        // Avoid the process-global default context: libtest runs this on a
        // worker, but drops globals on its main thread after that worker exits.
        let other_context = webkit2gtk::WebContext::new_ephemeral();
        let other = webkit2gtk::WebView::with_context(&other_context);
        let other_window = gtk::Window::new(gtk::WindowType::Toplevel);
        other_window.add(&other);
        other_window.realize();
        other.realize();
        let ready = std::rc::Rc::new(std::cell::Cell::new(false));
        let ready_load = ready.clone();
        other.connect_load_changed(move |_, event| {
            if event == webkit2gtk::LoadEvent::Finished {
                ready_load.set(true);
                gtk::main_quit();
            }
        });
        other.load_html("<script>window.sentinel = 42</script>", None);
        gtk::main();
        assert!(ready.get());
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("busy.pdf");
        let calls = std::rc::Rc::new(std::cell::Cell::new(0));
        let error = std::rc::Rc::new(std::cell::RefCell::new(None));
        let calls_done = calls.clone();
        let error_done = error.clone();
        let started = std::time::Instant::now();
        render_with_timeout(
            "<script>while (true) {}</script>",
            Some(&dest),
            (152_400, 228_600),
            1,
            move |result| {
                calls_done.set(calls_done.get() + 1);
                *error_done.borrow_mut() = Some(result.err());
                gtk::main_quit();
            },
        );
        gtk::main();
        assert_eq!(calls.get(), 1);
        assert_eq!(
            error.borrow().as_ref().unwrap().as_deref(),
            Some("the proof did not finish within 1 seconds")
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert!(!dest.exists());
        let sentinel = std::rc::Rc::new(std::cell::Cell::new(0));
        let sentinel_done = sentinel.clone();
        other.evaluate_javascript(
            "window.sentinel",
            None,
            None,
            None::<&gio::Cancellable>,
            move |value| {
                sentinel_done.set(value.unwrap().to_int32());
                gtk::main_quit();
            },
        );
        gtk::main();
        assert_eq!(sentinel.get(), 42);
        let normal_calls = std::rc::Rc::new(std::cell::Cell::new(0));
        let normal_done = normal_calls.clone();
        render_with_timeout(
            r#"<script>window.__proof = {leaves:1,truncated:false,fontResolved:true,pages:["ok"]}</script>"#,
            None,
            (152_400, 228_600),
            1,
            move |result| {
                normal_done.set(normal_done.get() + 1);
                assert_eq!(result.unwrap().report.leaves, 1);
                gtk::main_quit();
            },
        );
        gtk::main();
        // Run beyond both short render deadlines to catch late completion.
        glib::timeout_add_seconds_local_once(3, gtk::main_quit);
        gtk::main();
        assert_eq!(normal_calls.get(), 1);
        assert_eq!(calls.get(), 1);
        unsafe {
            other_window.destroy();
        }
    }

    /// The two pure lines in this file, and they are the two that can be wrong
    /// without anything looking wrong: a bad conversion prints a book at the
    /// wrong size and a bad URI prints it nowhere.
    #[test]
    fn a_trim_size_converts_to_the_points_gtk_takes() {
        // 1 in is 72 pt and 25 400 um. 6 x 9 in is 432 x 648 pt, which is what
        // `pdfinfo` reports for a proof of this book -- the number the probe
        // read back off a real file.
        assert_eq!(micrometres_to_points(152_400), 432.0);
        assert_eq!(micrometres_to_points(228_600), 648.0);
        assert_eq!(micrometres_to_points(25_400), 72.0);
    }

    #[test]
    fn a_destination_with_a_space_or_a_hash_in_it_still_names_one_file() {
        // A writer names this file in an OS dialog, so it can hold anything a
        // filename can. A bare `file://` join would end the URI at the `#` and
        // print the book to a path nobody asked for.
        assert_eq!(
            uri_for(std::path::Path::new("/tmp/a b.pdf")),
            "file:///tmp/a%20b.pdf"
        );
        assert_eq!(
            uri_for(std::path::Path::new("/tmp/x#1.pdf")),
            "file:///tmp/x%231.pdf"
        );
        assert_eq!(
            uri_for(std::path::Path::new("/tmp/plain.pdf")),
            "file:///tmp/plain.pdf"
        );
        // Non-ASCII is bytes, and every byte is escaped rather than passed on.
        assert_eq!(
            uri_for(std::path::Path::new("/tmp/\u{e9}.pdf")),
            "file:///tmp/%C3%A9.pdf"
        );
    }
}
