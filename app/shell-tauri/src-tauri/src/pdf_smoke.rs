//! Opt-in native export probe. No editor, writable project, or command bridge.
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{atomic::AtomicU64, Arc, Mutex},
    time::Instant,
};
use tauri::Manager;

pub(crate) struct Smoke {
    pub root: PathBuf,
    log: Mutex<(File, String)>,
    started: Instant,
}

impl Smoke {
    fn stage(&self, phase: &str) {
        let Ok(mut log) = self.log.lock() else {
            let _ = writeln!(std::io::stderr(), "native PDF smoke phase log mutex poisoned");
            return;
        };
        if log.1 != phase {
            let event = serde_json::json!({"phase": phase, "elapsed_ms": self.started.elapsed().as_millis()});
            if let Err(error) = writeln!(log.0, "{event}").and_then(|()| log.0.flush()) {
                let _ = writeln!(std::io::stderr(), "native PDF smoke phase log failed: {error}");
                return;
            }
            log.1 = phase.into();
        }
    }

    fn result(&self, result: &serde_json::Value) -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.root.join("result.json"))
            .map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(&mut file, result).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }
}

pub(crate) fn stage(app: &tauri::AppHandle, phase: &str) {
    if let Some(smoke) = app.try_state::<Arc<Smoke>>() {
        smoke.stage(phase);
    }
}

fn export(app: &tauri::AppHandle, root: &Path) -> Result<serde_json::Value, String> {
    let path = root
        .join("sample.db")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("sample must be inside the smoke directory".into());
    }
    let store = crate::store::Store::open_readonly(&path).map_err(|e| e.to_string())?;
    let name = store
        .get_meta(crate::projects::NAME_KEY)
        .map_err(|e| e.to_string())?
        .ok_or("seeded project has no name")?;
    let design = crate::design::design_of(&store)?;
    let page = (design.page.width_um, design.page.height_um);
    drop(store);
    let mut report = None;
    let mut bytes = 0;
    let dest = root.join("proof.pdf");
    let exported = crate::commands::export::export_into_with(
        &path,
        &name,
        &dest,
        crate::commands::export::Dest::New,
        crate::export::Format::Pdf,
        &crate::identity::Vault::default(),
        crate::commands::export::strings_for(root),
        |html| {
            stage(app, "render");
            let text = String::from_utf8(html).map_err(|e| e.to_string())?;
            let printed = crate::printer_windows::render_via(app, &text, true, page)?;
            report = Some(printed.report);
            let pdf = printed.bytes.ok_or("the proof produced no file")?;
            bytes = pdf.len();
            stage(app, "write-pdf");
            Ok(pdf)
        },
    )?;
    let report = report.ok_or("the proof produced no report")?;
    if exported.pages != Some(report.leaves) {
        return Err(format!(
            "PDF pages {:?} differ from {} proof leaves",
            exported.pages, report.leaves
        ));
    }
    Ok(serde_json::json!({
        "ok": true, "pages": exported.pages, "leaves": report.leaves, "bytes": bytes,
        "width_um": page.0, "height_um": page.1, "font_resolved": report.font_resolved,
        "cover_leaves": report.pages.iter().filter(|p| p.contains("proof-plate")).count(),
    }))
}

pub(crate) fn run(root: &Path) -> i32 {
    let prepare = || -> Result<Arc<Smoke>, String> {
        if !root.is_absolute() || !root.is_dir() {
            return Err("smoke directory must exist and be absolute".into());
        }
        if root
            .symlink_metadata()
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("smoke directory must not be a symlink".into());
        }
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        for name in ["proof.pdf", "result.json", "webview"] {
            if root.join(name).symlink_metadata().is_ok() {
                return Err(format!("smoke destination already exists: {name}"));
            }
        }
        let log = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(root.join("phases.jsonl"))
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(Smoke {
            root,
            log: Mutex::new((log, String::new())),
            started: Instant::now(),
        }))
    };
    let smoke = match prepare() {
        Ok(smoke) => smoke,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    smoke.stage("startup");
    let setup = smoke.clone();
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol("proof", |ctx, request| crate::printer_windows::serve(ctx.webview_label(), request))
        .setup(move |app| {
            app.manage(setup.clone());
            app.manage(crate::privacy_host::Epoch(AtomicU64::new(0)));
            let handle = app.handle().clone();
            let (done, wait) = std::sync::mpsc::channel();
            let watchdog = setup.clone();
            std::thread::spawn(move || {
                let (phase, error, code) = match wait.recv_timeout(std::time::Duration::from_secs(240)) {
                    Ok(()) => return,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (
                        "watchdog-timeout", "native PDF smoke exceeded 240 seconds", 124,
                    ),
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => (
                        "worker-disconnected", "native PDF smoke worker disconnected before reporting completion", 1,
                    ),
                };
                watchdog.stage(phase);
                let _ = watchdog.result(&serde_json::json!({"ok":false,"error":error}));
                std::process::exit(code);
            });
            std::thread::spawn(move || {
                let result = export(&handle, &setup.root);
                let ok = result.is_ok();
                let value = result.unwrap_or_else(|error| serde_json::json!({"ok":false,"error":error}));
                setup.stage(if ok { "complete" } else { "failed" });
                let written = setup.result(&value);
                let _ = done.send(());
                handle.exit(if ok && written.is_ok() { 0 } else { 1 });
            });
            Ok(())
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|_, event| {
            // Destroying the proof window must not exit before the writer finishes.
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        }),
        Err(error) => {
            let _ = smoke.result(&serde_json::json!({"ok":false,"error":error.to_string()}));
            return 1;
        }
    }
    0
}
