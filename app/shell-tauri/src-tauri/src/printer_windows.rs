use crate::{printer, privacy_host};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{webview::PageLoadEvent, Manager, WebviewUrl, WebviewWindowBuilder};
use webview2_com::{
    ExecuteScriptCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Environment, ICoreWebView2Environment6, ICoreWebView2_16,
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    },
    PrintToPdfStreamCompletedHandler,
};
use windows::{
    core::{Interface, HSTRING},
    Win32::System::Com::IStream,
};

const RENDER_TIMEOUT: Duration = Duration::from_secs(210);
const MAX_PDF_BYTES: usize = 256 * 1024 * 1024;
const RESULT_SCRIPT: &str =
    "JSON.stringify({report:window.__proof || null,error:window.__proofError || null})";
const PROOF_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";

struct Job {
    app: tauri::AppHandle,
    label: String,
    nonce: String,
    epoch: u64,
    page_um: (i64, i64),
    print: bool,
    html: Mutex<Option<Vec<u8>>>,
    answer: Mutex<Option<mpsc::Sender<Result<printer::Printed, String>>>>,
    cancelled: AtomicBool,
}

static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();

struct StreamRead {
    stream: IStream,
    bytes: Vec<u8>,
    report: crate::pdf::ProofReport,
    job: Arc<Job>,
}

thread_local! {
    static STREAMS: RefCell<HashMap<String, StreamRead>> = RefCell::new(HashMap::new());
}

fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn proof_url(nonce: &str) -> String {
    format!("proof://localhost/{nonce}")
}

fn refuse() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .body(Vec::new())
        .expect("static response")
}

/// A one-use document, bound to both the native proof view's label and URL.
pub fn serve(
    label: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    if request.method() != tauri::http::Method::GET {
        return refuse();
    }
    let Some(nonce) = request.uri().path().strip_prefix('/') else {
        return refuse();
    };
    let job = jobs()
        .lock()
        .ok()
        .and_then(|entries| entries.get(nonce).cloned());
    let Some(job) = job else {
        return refuse();
    };
    if !printer::proof_request_authorized(label, request.uri().path(), &job.label, &job.nonce)
        || !job.valid()
    {
        return refuse();
    }
    let Some(html) = job.html.lock().ok().and_then(|mut body| body.take()) else {
        return refuse();
    };
    if !job.valid() {
        return refuse();
    }
    tauri::http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Content-Security-Policy", PROOF_CSP)
        .body(html)
        .expect("static response")
}

impl Job {
    fn valid(&self) -> bool {
        !self.cancelled.load(Ordering::SeqCst)
            && !privacy_host::locked(&self.app)
            && self
                .app
                .state::<privacy_host::Epoch>()
                .0
                .load(Ordering::SeqCst)
                == self.epoch
    }

    fn finish(&self, result: Result<printer::Printed, String>) {
        let result = if result.is_ok() && !self.valid() {
            Err("proof render interrupted by privacy locking".into())
        } else {
            result
        };
        if self.cancelled.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut html) = self.html.lock() {
            html.take();
        }
        if let Ok(mut entries) = jobs().lock() {
            entries.remove(&self.nonce);
        }
        if let Ok(mut answer) = self.answer.lock() {
            if let Some(tx) = answer.take() {
                let _ = tx.send(result);
            }
        }
        let app = self.app.clone();
        let label = self.label.clone();
        tauri::async_runtime::spawn(async move {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = handle.get_webview_window(&label) {
                    let _ = window.destroy();
                }
            });
        });
    }

    fn fail(&self, message: impl Into<String>) {
        self.finish(Err(message.into()));
    }
}

/// Called at the start of every Windows privacy lock, without waiting for UI work.
pub fn abort_all() {
    let active = jobs()
        .lock()
        .map(|entries| entries.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for job in active {
        job.fail("proof render interrupted by privacy locking");
    }
}

pub fn render_via(
    app: &tauri::AppHandle,
    html: &str,
    print: bool,
    page_um: (i64, i64),
) -> Result<printer::Printed, String> {
    if privacy_host::locked(app) || page_um.0 <= 0 || page_um.1 <= 0 {
        return Err("proof render unavailable".into());
    }
    let nonce = uuid::Uuid::now_v7().to_string();
    let label = format!("proof-{nonce}");
    let (tx, rx) = mpsc::channel();
    let job = Arc::new(Job {
        app: app.clone(),
        label,
        nonce: nonce.clone(),
        epoch: app.state::<privacy_host::Epoch>().0.load(Ordering::SeqCst),
        page_um,
        print,
        html: Mutex::new(Some(html.as_bytes().to_vec())),
        answer: Mutex::new(Some(tx)),
        cancelled: AtomicBool::new(false),
    });
    if !job.valid() {
        return Err("proof render interrupted by privacy locking".into());
    }
    jobs()
        .lock()
        .map_err(|_| "proof renderer unavailable")?
        .insert(nonce, job.clone());
    let handle = app.clone();
    let launch = job.clone();
    if app
        .run_on_main_thread(move || start_window(&handle, launch))
        .is_err()
    {
        job.fail("proof window unavailable");
    }
    match rx.recv_timeout(RENDER_TIMEOUT) {
        Ok(value) => value,
        Err(_) => {
            job.fail("the proof render never answered");
            Err("the proof render never answered".into())
        }
    }
}

fn start_window(app: &tauri::AppHandle, job: Arc<Job>) {
    if !job.valid() {
        job.fail("proof render interrupted by privacy locking");
        return;
    }
    let url = proof_url(&job.nonce);
    let allowed = job.nonce.clone();
    let loaded = job.clone();
    let result = WebviewWindowBuilder::new(
        app,
        job.label.clone(),
        WebviewUrl::CustomProtocol(url.parse().expect("local proof URL")),
    )
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .inner_size(800.0, 1000.0)
    .on_navigation(move |url| printer::proof_navigation_allowed(url.as_str(), &allowed))
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_page_load(move |window, payload| {
        if payload.event() == PageLoadEvent::Finished
            && printer::proof_navigation_allowed(payload.url().as_str(), &loaded.nonce)
            && payload.url().as_str() != "about:blank"
        {
            start_script(window, loaded.clone());
        }
    })
    .build();
    if let Err(error) = result {
        job.fail(format!("proof window unavailable: {error}"));
    }
}

fn start_script(window: tauri::WebviewWindow, job: Arc<Job>) {
    if !job.valid() {
        job.fail("proof render interrupted by privacy locking");
        return;
    }
    let launched = job.clone();
    let result = window.with_webview(move |platform| {
        let start = (|| -> windows::core::Result<()> {
            let view = unsafe { platform.controller().CoreWebView2()? };
            let script_view = view.clone();
            let environment = platform.environment();
            let next = launched.clone();
            let callback = ExecuteScriptCompletedHandler::create(Box::new(move |status, text| {
                if !next.valid() {
                    next.fail("proof render interrupted by privacy locking");
                    return Ok(());
                }
                match status {
                    Ok(()) => {
                        let result = serde_json::from_str::<String>(&text)
                            .map_err(|e| e.to_string())
                            .and_then(|json| printer::proof_report(&json));
                        match result {
                            Ok(report) if next.print => {
                                print_pdf(next.clone(), environment, view, report)
                            }
                            Ok(report) => next.finish(Ok(printer::Printed {
                                report,
                                bytes: None,
                            })),
                            Err(error) => next.fail(error),
                        }
                    }
                    Err(error) => next.fail(format!("proof script failed: {error}")),
                }
                Ok(())
            }));
            unsafe { script_view.ExecuteScript(&HSTRING::from(RESULT_SCRIPT), &callback) }
        })();
        if let Err(error) = start {
            launched.fail(format!("proof script unavailable: {error}"));
        }
    });
    if let Err(error) = result {
        job.fail(format!("proof webview unavailable: {error}"));
    }
}

fn print_pdf(
    job: Arc<Job>,
    environment: ICoreWebView2Environment,
    view: ICoreWebView2,
    report: crate::pdf::ProofReport,
) {
    if !job.valid() {
        job.fail("proof render interrupted by privacy locking");
        return;
    }
    let start = (|| -> windows::core::Result<()> {
        let environment: ICoreWebView2Environment6 = environment.cast()?;
        let view: ICoreWebView2_16 = view.cast()?;
        let settings = unsafe { environment.CreatePrintSettings()? };
        unsafe {
            settings.SetPageWidth(job.page_um.0 as f64 / 25_400.0)?;
            settings.SetPageHeight(job.page_um.1 as f64 / 25_400.0)?;
            settings.SetMarginTop(0.0)?;
            settings.SetMarginBottom(0.0)?;
            settings.SetMarginLeft(0.0)?;
            settings.SetMarginRight(0.0)?;
            settings.SetScaleFactor(1.0)?;
            settings.SetShouldPrintBackgrounds(true)?;
            settings.SetShouldPrintHeaderAndFooter(false)?;
            // The document's @page and these explicit dimensions are already oriented.
            settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
        }
        let done = job.clone();
        let callback = PrintToPdfStreamCompletedHandler::create(Box::new(move |status, stream| {
            if !done.valid() {
                done.fail("proof render interrupted by privacy locking");
                return Ok(());
            }
            match (status, stream) {
                (Ok(()), Some(stream)) => {
                    STREAMS.with(|reads| {
                        reads.borrow_mut().insert(
                            done.nonce.clone(),
                            StreamRead {
                                stream,
                                bytes: Vec::new(),
                                report,
                                job: done.clone(),
                            },
                        );
                    });
                    schedule_read(done);
                }
                (Err(error), _) => done.fail(format!("proof print failed: {error}")),
                (Ok(()), None) => done.fail("proof print returned no stream"),
            }
            Ok(())
        }));
        unsafe { view.PrintToPdfStream(&settings, &callback) }
    })();
    if let Err(error) = start {
        job.fail(format!("proof print unavailable: {error}"));
    }
}

fn schedule_read(job: Arc<Job>) {
    let app = job.app.clone();
    let nonce = job.nonce.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = app.run_on_main_thread(move || read_step(&nonce)) {
            job.fail(format!("proof stream unavailable: {error}"));
        }
    });
}

fn read_step(nonce: &str) {
    let Some(mut state) = STREAMS.with(|reads| reads.borrow_mut().remove(nonce)) else {
        return;
    };
    if !state.job.valid() {
        state
            .job
            .fail("proof render interrupted by privacy locking");
        return;
    }
    let mut block = [0u8; 64 * 1024];
    for _ in 0..16 {
        let mut read = 0u32;
        let result = unsafe {
            state.stream.Read(
                block.as_mut_ptr().cast(),
                block.len() as u32,
                Some(&mut read),
            )
        };
        if let Err(error) = result.ok() {
            state.job.fail(format!("proof stream unreadable: {error}"));
            return;
        }
        if read == 0 {
            state.job.finish(Ok(printer::Printed {
                report: state.report,
                bytes: Some(state.bytes),
            }));
            return;
        }
        if state.bytes.len() > MAX_PDF_BYTES - read as usize {
            state.job.fail("the proof PDF exceeds 256 MiB");
            return;
        }
        state.bytes.extend_from_slice(&block[..read as usize]);
    }
    let job = state.job.clone();
    STREAMS.with(|reads| {
        reads.borrow_mut().insert(job.nonce.clone(), state);
    });
    schedule_read(job);
}
