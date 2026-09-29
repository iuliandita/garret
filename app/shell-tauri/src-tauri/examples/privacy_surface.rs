//! Native concealment experiment. No project is opened and no authentication is provided.
//! Run through the diagnostic driver; this is not the application's lock screen.

#[cfg(target_os = "linux")]
mod linux {
    use gtk::atk::prelude::AtkObjectExt;
    use gtk::glib::translate::IntoGlib;
    use gtk::prelude::*;
    use javascriptcore::ValueExt;
    use std::{cell::Cell, path::PathBuf, rc::Rc, time::Duration};
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    use tauri_plugin_dialog::DialogExt as _;
    use webkit2gtk::WebViewExt;

    const HTML: &str = r#"<!doctype html><html><head><title>PRIVATE_BOOK_SENTINEL</title></head>
<body style="background:#f5efe4;color:#202020;font:24px serif">
<h1>PRIVATE_BOOK_SENTINEL</h1><p>PRIVATE_PROSE_SENTINEL</p>
<textarea aria-label="PRIVATE_EDITOR_SENTINEL">An unsaved sentence.</textarea>
<script src="appdist://localhost/probe.js"></script></body></html>"#;
    const JS: &str = r#"document.querySelector('textarea').value='EDITED_'+Date.now()+'_'+Math.random();let ticks=0;setInterval(()=>window.__TAURI__.core.invoke('probe_state', {value: JSON.stringify({ticks:++ticks, value:document.querySelector('textarea').value})}),500);"#;

    #[tauri::command]
    fn probe_state(out: tauri::State<'_, PathBuf>, value: String) -> Result<(), String> {
        use std::io::Write;
        if value == "busy-started" {
            return std::fs::write(out.join("busy-started"), "yes").map_err(|e| e.to_string());
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(out.join("messages.jsonl"))
            .map_err(|e| e.to_string())?;
        writeln!(file, "{value}").map_err(|e| e.to_string())
    }

    pub fn run() {
        let mut args = std::env::args().skip(1);
        let mode = args.next().expect("probe mode");
        assert!(matches!(
            mode.as_str(),
            "baseline" | "hide" | "detach" | "busy-detach" | "dialog" | "plugin-dialog"
        ));
        let out = PathBuf::from(args.next().expect("diagnostic output directory"));
        assert!(out.is_dir(), "driver must create output directory");
        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .manage(out.clone())
            .invoke_handler(tauri::generate_handler![probe_state])
            .register_uri_scheme_protocol("appdist", |_ctx, request| {
                let (content, mime) = if request.uri().path() == "/probe.js" {
                    (JS, "text/javascript")
                } else {
                    (HTML, "text/html")
                };
                tauri::http::Response::builder()
                    .header("Content-Type", mime)
                    .body(content.as_bytes().to_vec())
                    .expect("static response")
            })
            .setup(move |app| {
                let window = WebviewWindowBuilder::new(
                    app,
                    "main",
                    WebviewUrl::CustomProtocol("appdist://localhost/index.html".parse()?),
                )
                .title("PRIVATE_BOOK_SENTINEL")
                .inner_size(800.0, 520.0)
                .build()?;
                let handle = app.handle().clone();
                window.with_webview(move |platform| {
                    let web = platform.inner();
                    let parent = web
                        .parent()
                        .expect("webview parent")
                        .downcast::<gtk::Box>()
                        .expect("Tauri webview parent must be GtkBox");
                    let native = web
                        .toplevel()
                        .expect("native window")
                        .downcast::<gtk::Window>()
                        .expect("Tauri toplevel must be GtkWindow");
                    let position = parent.child_position(&web);
                    let packing = parent.query_child_packing(&web);
                    let lock_window = gtk::Window::new(gtk::WindowType::Toplevel);
                    lock_window.set_title("Application locked");
                    lock_window.set_default_size(800, 520);
                    lock_window.connect_delete_event(|_, _| gtk::glib::Propagation::Stop);
                    let screen = gtk::Box::new(gtk::Orientation::Vertical, 16);
                    screen.set_margin_top(48);
                    screen.set_margin_start(48);
                    screen.set_margin_end(48);
                    screen.add(&gtk::Label::new(Some("Application locked (probe)")));
                    let entry = gtk::Entry::new();
                    entry.set_visibility(false);
                    entry
                        .accessible()
                        .expect("native entry accessibility")
                        .set_name("Password");
                    entry.set_placeholder_text(Some("Synthetic password; no authentication"));
                    let label = gtk::Label::with_mnemonic("_Password");
                    label.set_mnemonic_widget(Some(&entry));
                    screen.add(&label);
                    screen.add(&entry);
                    let button = gtk::Button::with_label("Unlock probe");
                    screen.add(&button);
                    let locked = Rc::new(Cell::new(false));
                    let second_dialog = gtk::FileChooserNative::new(
                        Some("SECOND_DIALOG_SENTINEL"), Some(&native),
                        gtk::FileChooserAction::Open, Some("Open"), Some("Cancel"),
                    );
                    second_dialog.set_current_folder(&out);
                    let second_out = out.clone();
                    second_dialog.connect_response(move |dialog, response| {
                        std::fs::write(second_out.join("second-dialog-result.txt"),
                            if matches!(response, gtk::ResponseType::Cancel | gtk::ResponseType::DeleteEvent) { "cancelled" } else { "other" })
                            .expect("second native dialog response");
                        dialog.destroy();
                    });
                    let restored = {
                        let (parent, web, screen, native, locked, out, mode) = (
                            parent.clone(),
                            web.clone(),
                            screen.clone(),
                            native.clone(),
                            locked.clone(),
                            out.clone(),
                            mode.clone(),
                        );
                        let handle = handle.clone();
                        let lock_window = lock_window.clone();
                        Rc::new(move || {
                            if !locked.replace(false) {
                                return;
                            }
                            if mode == "hide" { parent.remove(&screen); } else {
                                lock_window.hide();
                                lock_window.remove(&screen);
                            }
                            if mode != "hide" {
                                parent.pack_start(&web, packing.0, packing.1, packing.2);
                                parent.set_child_packing(
                                    &web, packing.0, packing.1, packing.2, packing.3,
                                );
                                parent.reorder_child(&web, position);
                            }
                            web.show();
                            native.show();
                            native.set_title("PRIVATE_BOOK_SENTINEL");
                            web.grab_focus();
                            if mode == "dialog" { second_dialog.show(); }
                            if mode == "plugin-dialog" {
                                let callback_out = out.clone();
                                handle.dialog().file().set_title("SECOND_DIALOG_SENTINEL")
                                    .set_directory(out.clone()).pick_file(move |result| {
                                        std::fs::write(callback_out.join("second-dialog-result.txt"),
                                            if result.is_none() { "cancelled" } else { "selected" }).expect("second plugin dialog response");
                                    });
                            }
                            let out = out.clone();
                            web.evaluate_javascript(
                                "document.querySelector('textarea').value",
                                None,
                                None,
                                gtk::gio::Cancellable::NONE,
                                move |result| {
                                    std::fs::write(
                                        out.join("restored.txt"),
                                        result.expect("read editor after restore").to_str(),
                                    )
                                    .expect("write retained state");
                                },
                            );
                        })
                    };
                    let on_activate = restored.clone();
                    let typed_out = out.clone();
                    entry.connect_activate(move |entry| {
                        std::fs::write(
                            typed_out.join("unicode-input.txt"),
                            if entry.text() == "écriture 你好" {
                                "matched"
                            } else {
                                "not-matched"
                            },
                        )
                        .expect("synthetic input result");
                        entry.set_text("");
                        on_activate();
                    });
                    button.connect_clicked(move |_| restored());

                    // Retain the NativeDialog handle: the plugin's public callback API does not.
                    let dialog = gtk::FileChooserNative::new(
                        Some("PRIVATE_DIALOG_SENTINEL"),
                        Some(&native),
                        gtk::FileChooserAction::Open,
                        Some("Open"),
                        Some("Cancel"),
                    );
                    dialog.set_current_folder(&out);
                    let first_out = out.clone();
                    dialog.connect_response(move |_, response| {
                        std::fs::write(first_out.join("dialog-result.txt"),
                            if matches!(response, gtk::ResponseType::Cancel | gtk::ResponseType::DeleteEvent) { "cancelled" } else { "other" })
                            .expect("first native dialog response");
                    });
                    if mode == "dialog" {
                        let dialog = dialog.clone();
                        gtk::glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                            dialog.show()
                        });
                    } else if mode == "plugin-dialog" {
                        let (handle, out) = (handle.clone(), out.clone());
                        gtk::glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                            let callback_out = out.clone();
                            handle
                                .dialog()
                                .file()
                                .set_title("PRIVATE_DIALOG_SENTINEL")
                                .set_directory(out)
                                .pick_file(move |result| {
                                    std::fs::write(
                                        callback_out.join("dialog-result.txt"),
                                        if result.is_none() {
                                            "cancelled"
                                        } else {
                                            "selected"
                                        },
                                    )
                                    .expect("dialog result");
                                });
                        });
                    }
                    if mode == "busy-detach" {
                        let web = web.clone();
                        let busy_out = out.clone();
                        gtk::glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                            web.evaluate_javascript(
                                "window.__TAURI__.core.invoke('probe_state', {value:'busy-started'});let end=Date.now()+10000;while(Date.now()<end){}",
                                None,
                                None,
                                gtk::gio::Cancellable::NONE,
                                move |result| {
                                    result.expect("busy JavaScript must finish");
                                    std::fs::write(busy_out.join("busy-completed"), "yes").expect("busy completion");
                                },
                            );
                        });
                    }
                    let ready_out = out.clone();
                    gtk::glib::timeout_add_local_once(Duration::from_millis(2500), move || {
                        std::fs::write(ready_out.join("ready"), "yes").expect("ready diagnostic");
                    });
                    gtk::glib::timeout_add_local(Duration::from_millis(100), move || {
                        if !out.join("lock-now").exists() {
                            return gtk::glib::ControlFlow::Continue;
                        }
                        if mode != "baseline" {
                            native.set_title("Application locked");
                            web.hide();
                            if mode != "hide" {
                                parent.remove(&web);
                            }
                            if mode == "dialog" {
                                dialog.hide();
                                dialog.emit_by_name::<()>("response", &[&gtk::ResponseType::Cancel.into_glib()]);
                                dialog.destroy();
                            }
                            if mode == "plugin-dialog" {
                                for top in gtk::Window::list_toplevels() {
                                    if let Ok(dialog) = top.downcast::<gtk::Dialog>() {
                                        dialog.hide();
                                        dialog.response(gtk::ResponseType::Cancel);
                                    }
                                }
                            }
                            if mode == "hide" {
                                parent.pack_start(&screen, true, true, 0);
                                screen.show_all();
                            } else {
                                native.hide();
                                lock_window.add(&screen);
                                lock_window.show_all();
                            }
                            locked.set(true);
                            entry.grab_focus();
                        }
                        std::fs::write(out.join("locked"), "yes").expect("lock diagnostic");
                        gtk::glib::ControlFlow::Break
                    });
                    gtk::glib::timeout_add_local_once(Duration::from_secs(45), move || {
                        handle.exit(0)
                    });
                })?;
                Ok(())
            })
            .run(tauri::generate_context!())
            .expect("privacy surface probe");
    }
}

#[cfg(target_os = "linux")]
fn main() {
    linux::run();
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("The native privacy surface probe is Linux-only.");
    std::process::exit(2);
}
