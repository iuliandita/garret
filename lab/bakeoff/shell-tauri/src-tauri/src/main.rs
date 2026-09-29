// lab/bakeoff/shell-tauri/src-tauri/src/main.rs
// Tauri 2 shell mirroring the Electron shim contract. Assets are served at
// RUNTIME from the staged BAKEOFF_DIST via a custom `bakeoff://` protocol (a
// path frontendDist would embed ../dist at build time and ignore per-run
// staging). The window is built in code so its initialization_script installs
// the shims before any page script runs; `sink` writes the payload and exits.
// WebKitGTK webview => no CDP, matching spec.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::Path;
use std::process;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn sink(payload: serde_json::Value) {
    let path = std::env::var("BAKEOFF_SINK").unwrap_or_else(|_| "sink.json".into());
    let _ = fs::write(&path, serde_json::to_string(&payload).unwrap_or_default());
    // Stay alive so the matrix can snapshot the AT-SPI tree while the window is up
    // (a11y_exposure gate); the matrix kills us once it has the snapshot. Self-exit
    // is a safety net if it never does.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(30));
        process::exit(0);
    });
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html",
        Some("js") | Some("mjs") => "text/javascript",
        Some("json") => "application/json",
        Some("css") => "text/css",
        _ => "application/octet-stream",
    }
}

fn main() {
    let seed = std::env::var("BAKEOFF_SEED").unwrap_or_else(|_| "bakeoff-v1".into());
    // Init script runs before the page's own scripts, installing the shims.
    // window.__TAURI__.core.invoke is available because withGlobalTauri=true and
    // the page is served from a Tauri-owned (local) custom protocol.
    let init = format!(
        "window.__bakeoffFixtureUrl='./scene-data.json';\
         window.__bakeoffCandidate='tauri';\
         window.__bakeoffSeed='{seed}';\
         window.__bakeoffSink=(p)=>window.__TAURI__.core.invoke('sink',{{payload:p}});"
    );

    tauri::Builder::default()
        .register_uri_scheme_protocol("bakeoff", |_ctx, request| {
            let uri = request.uri();
            let path = uri.path();
            let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
            let dir = std::env::var("BAKEOFF_DIST").unwrap_or_else(|_| "dist".into());
            let full = Path::new(&dir).join(rel);
            match fs::read(&full) {
                Ok(bytes) => tauri::http::Response::builder()
                    .header("Content-Type", mime_for(&full))
                    .body(bytes)
                    .unwrap(),
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![sink])
        .setup(move |app| {
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::CustomProtocol(
                    "bakeoff://localhost/index.html".parse().expect("valid url"),
                ),
            )
            .title("bakeoff editor")
            .inner_size(900.0, 900.0)
            .initialization_script(init.as_str())
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
