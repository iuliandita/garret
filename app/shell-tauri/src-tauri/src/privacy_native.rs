use crate::{
    privacy::{self, LockState, Policy, SecretKind},
    privacy_host as host,
};
use gtk::{atk::prelude::AtkObjectExt, glib, prelude::*};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

thread_local! {
    static SURFACE: RefCell<Option<Rc<Surface>>> = const { RefCell::new(None) };
}

struct Surface {
    strings: Cell<crate::strings::Strings>,
    web: webkit2gtk::WebView,
    parent: gtk::Box,
    native: gtk::Window,
    window: gtk::Window,
    entry: gtk::Entry,
    submit: gtk::Button,
    message: gtk::Label,
    detached: Cell<bool>,
    position: i32,
    packing: (bool, bool, u32, gtk::PackType),
    activity: Cell<Instant>,
    pointer: Cell<Option<(f64, f64)>>,
    dialogs: RefCell<Vec<gtk::FileChooserDialog>>,
    configuration: RefCell<Option<gtk::Window>>,
}

fn surface() -> Option<Rc<Surface>> {
    SURFACE.with(|s| s.borrow().clone())
}

pub fn install(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    let handle = app.clone();
    app.get_webview_window("main")
        .expect("main window")
        .with_webview(move |platform| {
            let web = platform.inner();
            let parent = web
                .parent()
                .expect("webview parent")
                .downcast::<gtk::Box>()
                .expect("GTK box");
            let native = web
                .toplevel()
                .expect("native window")
                .downcast::<gtk::Window>()
                .expect("GTK window");
            let strings = host::strings(&handle);
            let window = gtk::Window::new(gtk::WindowType::Toplevel);
            window.set_title(&strings.t("privacy.locked"));
            window.set_default_size(560, 300);
            let column = gtk::Box::new(gtk::Orientation::Vertical, 16);
            column.set_border_width(32);
            let heading = gtk::Label::new(Some(&strings.t("privacy.locked")));
            column.add(&heading);
            let entry = secret_entry(&strings.t("privacy.secret"));
            labelled(&column, &strings.t("privacy.secret"), &entry);
            let message = gtk::Label::new(None);
            message.set_line_wrap(true);
            if let Some(a) = message.accessible() {
                a.set_role(gtk::atk::Role::Alert);
            }
            column.add(&message);
            let submit = gtk::Button::with_label(&strings.t("privacy.unlock"));
            column.add(&submit);
            let quit = gtk::Button::with_label(&strings.t("privacy.quit"));
            column.add(&quit);
            window.add(&column);
            let s = Rc::new(Surface {
                strings: Cell::new(strings),
                position: parent.child_position(&web),
                packing: parent.query_child_packing(&web),
                web,
                parent,
                native,
                window,
                entry,
                submit,
                message,
                detached: Cell::new(false),
                activity: Cell::new(Instant::now()),
                pointer: Cell::new(None),
                dialogs: RefCell::new(Vec::new()),
                configuration: RefCell::new(None),
            });
            SURFACE.with(|slot| *slot.borrow_mut() = Some(s.clone()));
            let app = handle.clone();
            s.entry.connect_activate(move |_| unlock(&app));
            let app = handle.clone();
            s.submit.connect_clicked(move |_| unlock(&app));
            let app = handle.clone();
            quit.connect_clicked(move |_| request_close(&app));
            let app = handle.clone();
            s.window.connect_delete_event(move |_, _| {
                request_close(&app);
                glib::Propagation::Stop
            });
            let weak = Rc::downgrade(&s);
            s.web.connect_event(move |_, event| {
                if let Some(s) = weak.upgrade() {
                    s.note_activity(event);
                }
                glib::Propagation::Proceed
            });
            let weak = Rc::downgrade(&s);
            s.native.connect_event(move |_, event| {
                if let Some(s) = weak.upgrade() {
                    s.note_activity(event);
                }
                glib::Propagation::Proceed
            });
            if handle.state::<privacy::Privacy>().locked() {
                s.conceal(&handle);
            } else {
                s.native.show_all();
            }
            let app = handle.clone();
            glib::timeout_add_local(Duration::from_millis(250), move || {
                if let Some(s) = surface() {
                    let status = app.state::<privacy::Privacy>().status();
                    if status.state == LockState::Unlocked && !host::locked(&app) {
                        if status.policy.idle_min.is_some_and(|m| {
                            s.activity.get().elapsed() >= Duration::from_secs(u64::from(m) * 60)
                        }) {
                            lock_now(&app);
                        }
                    }
                    if s.detached.get() {
                        s.submit.set_sensitive(
                            status.state == LockState::Locked && status.retry_after_ms == 0,
                        );
                        s.entry.set_sensitive(status.state == LockState::Locked);
                        if status.retry_after_ms > 0 {
                            s.message.set_text(&host::strings(&app).f(
                                "privacy.retry",
                                &[("seconds", &status.retry_after_ms.div_ceil(1000).to_string())],
                            ));
                        }
                    }
                }
                glib::ControlFlow::Continue
            });
        })
}

impl Surface {
    fn note_activity(&self, event: &gtk::gdk::Event) {
        let active = is_activity(event.event_type(), event.coords(), &self.pointer);
        if active {
            self.activity.set(Instant::now());
        }
    }

    fn conceal(&self, app: &tauri::AppHandle) {
        app.state::<host::Barrier>().0.store(true, Ordering::SeqCst);
        self.native
            .set_title(&self.strings.get().t("privacy.locked"));
        self.native.hide();
        if !self.detached.replace(true) {
            self.web.hide();
            self.parent.remove(&self.web);
        }
        app.state::<host::Epoch>().0.fetch_add(1, Ordering::SeqCst);
        let dialogs = std::mem::take(&mut *self.dialogs.borrow_mut());
        for dialog in dialogs {
            dialog.hide();
            dialog.response(gtk::ResponseType::Cancel);
        }
        let config = self.configuration.borrow_mut().take();
        if let Some(config) = config {
            config.close();
        }
        self.entry.set_text("");
        let status = app.state::<privacy::Privacy>().status();
        let recovery = status.state == LockState::Recovery;
        self.entry.set_sensitive(status.state == LockState::Locked);
        self.submit
            .set_sensitive(status.state == LockState::Locked && status.retry_after_ms == 0);
        self.entry.set_visible(!recovery);
        self.submit.set_visible(!recovery);
        self.message.set_text(&host::strings(app).t(if recovery {
            "privacy.recovery"
        } else {
            "privacy.explanation"
        }));
        self.window.show_all();
        self.window.present();
        if recovery {
            self.entry.hide();
            self.submit.hide();
        } else {
            self.entry.grab_focus();
        }
    }

    fn restore(&self, app: &tauri::AppHandle) {
        if app.state::<privacy::Privacy>().locked() {
            return;
        }
        if self.detached.replace(false) {
            self.parent
                .pack_start(&self.web, self.packing.0, self.packing.1, self.packing.2);
            self.parent.set_child_packing(
                &self.web,
                self.packing.0,
                self.packing.1,
                self.packing.2,
                self.packing.3,
            );
            self.parent.reorder_child(&self.web, self.position);
            self.web.show();
        }
        app.state::<host::Barrier>()
            .0
            .store(false, Ordering::SeqCst);
        app.state::<crate::close_state::CloseState>().reset();
        let name = crate::locked(&app.state::<crate::StoreState>())
            .as_ref()
            .map(|p| p.name.clone())
            .unwrap_or_else(|| host::strings(app).t("library"));
        self.native.set_title(&host::title(app, &name));
        self.window.hide();
        app.state::<host::ContentShown>()
            .0
            .store(true, Ordering::SeqCst);
        self.native.show_all();
        self.native.present();
        self.web.grab_focus();
        self.activity.set(Instant::now());
        host::changed(app);
    }
}

pub fn lock_now(app: &tauri::AppHandle) {
    if app.state::<privacy::Privacy>().status().state == LockState::Disabled {
        return;
    }
    app.state::<privacy::Privacy>().lock();
    if let Some(s) = surface() {
        s.conceal(app);
        host::changed(app);
        let _ = app.emit(host::LOCK, ());
    } else if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

pub fn focus(app: &tauri::AppHandle) {
    if host::locked(app) {
        if let Some(s) = surface() {
            s.window.present();
        }
    }
}

pub fn save_failed(app: &tauri::AppHandle) {
    if host::locked(app) {
        if let Some(s) = surface() {
            s.message
                .set_text(&host::strings(app).t("privacy.save_failed"));
        }
    }
}

fn request_close(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}

fn unlock(app: &tauri::AppHandle) {
    let Some(s) = surface() else { return };
    let secret = s.entry.text().to_string();
    s.entry.set_text("");
    perform(app, move |p, generation| p.unlock(generation, secret));
}

fn perform(
    app: &tauri::AppHandle,
    operation: impl FnOnce(&privacy::Privacy, u64) -> Result<privacy::Status, privacy::Error>
        + Send
        + 'static,
) {
    let Some(s) = surface() else { return };
    s.conceal(app);
    s.submit.set_sensitive(false);
    s.entry.set_sensitive(false);
    s.message
        .set_text(&host::strings(app).t("privacy.verifying"));
    let generation = app.state::<privacy::Privacy>().generation();
    let app = app.clone();
    std::thread::spawn(move || {
        let result = operation(&app.state::<privacy::Privacy>(), generation);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(s) = surface() {
                if !handle.state::<privacy::Privacy>().locked() {
                    s.restore(&handle);
                    if let Err(error) = result {
                        show_error(&handle, error);
                    }
                } else {
                    s.conceal(&handle);
                    if let Err(error) = result {
                        s.message.set_text(&error_text(&handle, error));
                    }
                }
                host::changed(&handle);
            }
        });
    });
}

fn error_text(app: &tauri::AppHandle, error: privacy::Error) -> String {
    use privacy::Error::*;
    host::strings(app).t(match error {
        WrongSecret => "privacy.wrong",
        RateLimited => "privacy.wait",
        Busy => "privacy.verifying",
        InvalidSecret => "privacy.requirements",
        Confirmation => "privacy.confirmation_mismatch",
        Persist | Recovery => "privacy.recovery",
        Stale => "privacy.locked_again",
        _ => "privacy.error",
    })
}

fn show_error(app: &tauri::AppHandle, error: privacy::Error) {
    let Some(s) = surface() else { return };
    let dialog = gtk::MessageDialog::new(
        Some(&s.native),
        gtk::DialogFlags::MODAL,
        gtk::MessageType::Error,
        gtk::ButtonsType::Close,
        &error_text(app, error),
    );
    dialog.connect_response(|d, _| d.close());
    dialog.show();
}

fn secret_entry(name: &str) -> gtk::Entry {
    let entry = gtk::Entry::new();
    entry.set_visibility(false);
    entry.set_max_length(1024);
    if let Some(a) = entry.accessible() {
        a.set_name(name);
    }
    entry
}

fn labelled(column: &gtk::Box, text: &str, widget: &impl IsA<gtk::Widget>) {
    if let Some(a) = widget.as_ref().accessible() {
        a.set_name(text);
    }
    let label = gtk::Label::new(Some(text));
    label.set_xalign(0.0);
    column.add(&label);
    column.add(widget);
}

pub fn settings(app: &tauri::AppHandle) {
    if host::locked(app) {
        return;
    }
    let Some(s) = surface() else { return };
    if let Some(w) = s.configuration.borrow().as_ref() {
        w.present();
        return;
    }
    let strings = host::strings(app);
    s.strings.set(strings);
    let status = app.state::<privacy::Privacy>().status();
    let enabled = status.state != LockState::Disabled;
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title(&strings.t("privacy.settings"));
    window.set_transient_for(Some(&s.native));
    window.set_modal(true);
    window.set_default_size(560, 600);
    let weak = Rc::downgrade(&s);
    let shortcut_app = app.clone();
    window.connect_event(move |_, event| {
        if native_shortcut(&shortcut_app, event) {
            return glib::Propagation::Stop;
        }
        if let Some(s) = weak.upgrade() {
            s.note_activity(event);
        }
        glib::Propagation::Proceed
    });
    let column = gtk::Box::new(gtk::Orientation::Vertical, 10);
    column.set_border_width(24);
    for key in [
        "privacy.explanation",
        "privacy.reset_advice",
        "privacy.requirements",
    ] {
        let label = gtk::Label::new(Some(&strings.t(key)));
        label.set_line_wrap(true);
        label.set_max_width_chars(64);
        label.set_xalign(0.0);
        column.add(&label);
    }
    let current = secret_entry(&strings.t("privacy.current"));
    if enabled {
        labelled(&column, &strings.t("privacy.current"), &current);
    }
    let kind = gtk::ComboBoxText::new();
    kind.append(Some("password"), &strings.t("privacy.password"));
    kind.append(Some("pin"), &strings.t("privacy.pin"));
    kind.set_active_id(Some("password"));
    labelled(&column, &strings.t("privacy.kind"), &kind);
    let secret = secret_entry(&strings.t("privacy.new_secret"));
    let confirmation = secret_entry(&strings.t("privacy.confirm"));
    labelled(&column, &strings.t("privacy.new_secret"), &secret);
    labelled(&column, &strings.t("privacy.confirm"), &confirmation);
    let idle = gtk::ComboBoxText::new();
    idle.append(Some("off"), &strings.t("privacy.idle_off"));
    for n in [1, 5, 15, 30, 60] {
        idle.append(
            Some(&n.to_string()),
            &strings.f("privacy.minutes", &[("minutes", &n.to_string())]),
        );
    }
    idle.set_active_id(Some(
        &status
            .policy
            .idle_min
            .map(|v| v.to_string())
            .unwrap_or_else(|| "off".into()),
    ));
    labelled(&column, &strings.t("privacy.idle"), &idle);
    let shortcut = gtk::ComboBoxText::new();
    shortcut.append(Some("ctrl_alt_l"), "Ctrl+Alt+L");
    shortcut.append(Some("ctrl_alt_p"), "Ctrl+Alt+P");
    shortcut.append(Some("off"), &strings.t("privacy.idle_off"));
    shortcut.set_active_id(Some(match status.policy.shortcut {
        privacy::Shortcut::CtrlAltL => "ctrl_alt_l",
        privacy::Shortcut::CtrlAltP => "ctrl_alt_p",
        privacy::Shortcut::Off => "off",
    }));
    labelled(&column, &strings.t("privacy.shortcut"), &shortcut);
    let neutral = gtk::CheckButton::with_label(&strings.t("privacy.neutral_option"));
    neutral.set_active(status.policy.neutral_title);
    column.add(&neutral);
    let caps = crate::privacy_lifecycle::capabilities();
    let session = gtk::CheckButton::with_label(&strings.t("privacy.session_lock"));
    session.set_active(status.policy.session_lock);
    session.set_sensitive(caps.session_lock);
    if !caps.session_lock {
        session.set_tooltip_text(Some(&strings.t("privacy.unavailable")));
    }
    column.add(&session);
    let sleep = gtk::CheckButton::with_label(&strings.t("privacy.sleep"));
    sleep.set_active(status.policy.sleep);
    sleep.set_sensitive(caps.sleep);
    if !caps.sleep {
        sleep.set_tooltip_text(Some(&strings.t("privacy.unavailable")));
    }
    column.add(&sleep);
    let weak_session = session.downgrade();
    let weak_sleep = sleep.downgrade();
    let strings_copy = strings.clone();
    glib::timeout_add_local(Duration::from_millis(250), move || {
        let (Some(session), Some(sleep)) = (weak_session.upgrade(), weak_sleep.upgrade()) else {
            return glib::ControlFlow::Break;
        };
        let caps = crate::privacy_lifecycle::capabilities();
        for (button, key, available) in [
            (&session, "privacy.session_lock", caps.session_lock),
            (&sleep, "privacy.sleep", caps.sleep),
        ] {
            button.set_sensitive(available);
            let label = if available {
                strings_copy.t(key)
            } else {
                format!(
                    "{} ({})",
                    strings_copy.t(key),
                    strings_copy.t("privacy.unavailable")
                )
            };
            button.set_label(&label);
        }
        glib::ControlFlow::Continue
    });
    let capability = gtk::Label::new(Some(&strings.t("privacy.capabilities")));
    capability.set_line_wrap(true);
    capability.set_max_width_chars(64);
    column.add(&capability);
    let acknowledgement = gtk::CheckButton::with_label(&strings.t("privacy.acknowledge"));
    if !enabled {
        column.add(&acknowledgement);
    }
    let save = gtk::Button::with_label(&strings.t(if enabled {
        "privacy.change"
    } else {
        "privacy.enable"
    }));
    let actions = gtk::Box::new(gtk::Orientation::Vertical, 8);
    actions.set_border_width(12);
    actions.add(&save);
    save.set_sensitive(enabled);
    if !enabled {
        let save_copy = save.clone();
        acknowledgement.connect_toggled(move |ack| save_copy.set_sensitive(ack.is_active()));
    }
    let app_clone = app.clone();
    let (current_copy, idle_copy, neutral_copy) = (current.clone(), idle.clone(), neutral.clone());
    let (session_copy, sleep_copy) = (session.clone(), sleep.clone());
    let shortcut_copy = shortcut.clone();
    save.connect_clicked(move |_| {
        if !enabled && !acknowledgement.is_active() {
            return;
        }
        let kind = if kind.active_id().as_deref() == Some("pin") {
            SecretKind::Pin
        } else {
            SecretKind::Password
        };
        let a = secret.text().to_string();
        let b = confirmation.text().to_string();
        let c = current_copy.text().to_string();
        secret.set_text("");
        confirmation.set_text("");
        current_copy.set_text("");
        let policy = Policy {
            idle_min: idle_copy.active_id().and_then(|v| v.parse().ok()),
            neutral_title: neutral_copy.is_active(),
            session_lock: session_copy.is_active(),
            sleep: sleep_copy.is_active(),
            shortcut: selected_shortcut(&shortcut_copy),
        };
        perform(&app_clone, move |p, generation| {
            if enabled {
                p.change_secret(generation, c, kind, a, b)
            } else {
                p.enroll(generation, kind, a, b, policy)
            }
        });
    });
    if enabled {
        let policy_button = gtk::Button::with_label(&strings.t("privacy.save_policy"));
        actions.add(&policy_button);
        let app_clone = app.clone();
        let current_copy = current.clone();
        policy_button.connect_clicked(move |_| {
            let c = current_copy.text().to_string();
            current_copy.set_text("");
            let policy = Policy {
                idle_min: idle.active_id().and_then(|v| v.parse().ok()),
                neutral_title: neutral.is_active(),
                session_lock: session.is_active(),
                sleep: sleep.is_active(),
                shortcut: selected_shortcut(&shortcut),
            };
            perform(&app_clone, move |p, generation| {
                p.update_policy(generation, c, policy)
            });
        });
        let disable = gtk::Button::with_label(&strings.t("privacy.disable"));
        actions.add(&disable);
        let app_clone = app.clone();
        disable.connect_clicked(move |_| {
            let c = current.text().to_string();
            current.set_text("");
            perform(&app_clone, move |p, generation| p.disable(generation, c));
        });
    }
    let scroll = gtk::ScrolledWindow::new(gtk::Adjustment::NONE, gtk::Adjustment::NONE);
    scroll.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
    scroll.add(&column);
    let outer = gtk::Box::new(gtk::Orientation::Vertical, 0);
    outer.pack_start(&scroll, true, true, 0);
    let cancel = gtk::Button::with_label(&strings.t("privacy.choose_cancel"));
    let weak_window = window.downgrade();
    cancel.connect_clicked(move |_| {
        if let Some(window) = weak_window.upgrade() {
            window.close();
        }
    });
    actions.add(&cancel);
    outer.pack_start(&actions, false, false, 0);
    window.add(&outer);
    let weak = Rc::downgrade(&s);
    window.connect_destroy(move |_| {
        if let Some(s) = weak.upgrade() {
            s.configuration.borrow_mut().take();
        }
    });
    *s.configuration.borrow_mut() = Some(window.clone());
    window.show_all();
}

pub async fn pick(
    app: &tauri::AppHandle,
    action: gtk::FileChooserAction,
    title: String,
    directory: std::path::PathBuf,
    name: Option<String>,
    filter: Option<(String, Vec<String>)>,
) -> Option<std::path::PathBuf> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    let handle = app.clone();
    let epoch = app.state::<host::Epoch>().0.load(Ordering::SeqCst);
    app.run_on_main_thread(move || {
        let Some(s) = surface() else {
            let _ = tx.try_send(None);
            return;
        };
        if host::locked(&handle) || handle.state::<host::Epoch>().0.load(Ordering::SeqCst) != epoch
        {
            let _ = tx.try_send(None);
            return;
        }
        let strings = host::strings(&handle);
        let accept = strings.t(if action == gtk::FileChooserAction::Save {
            "privacy.choose_save"
        } else {
            "privacy.choose_open"
        });
        let dialog = gtk::FileChooserDialog::with_buttons(
            Some(&title),
            Some(&s.native),
            action,
            &[
                (
                    &strings.t("privacy.choose_cancel"),
                    gtk::ResponseType::Cancel,
                ),
                (&accept, gtk::ResponseType::Accept),
            ],
        );
        dialog.set_modal(true);
        let weak = Rc::downgrade(&s);
        let shortcut_app = handle.clone();
        dialog.connect_event(move |_, event| {
            if native_shortcut(&shortcut_app, event) {
                return glib::Propagation::Stop;
            }
            if let Some(s) = weak.upgrade() {
                s.note_activity(event);
            }
            glib::Propagation::Proceed
        });
        dialog.set_current_folder(directory);
        if let Some(name) = name {
            dialog.set_current_name(&name);
        }
        if let Some((name, extensions)) = filter {
            let filter = gtk::FileFilter::new();
            filter.set_name(Some(&name));
            for extension in extensions {
                filter.add_pattern(&format!("*.{extension}"));
            }
            dialog.add_filter(filter);
        }
        if action == gtk::FileChooserAction::Save {
            dialog.set_do_overwrite_confirmation(true);
        }
        let weak = Rc::downgrade(&s);
        let responded = Cell::new(false);
        dialog.connect_response(move |dialog, response| {
            if responded.replace(true) {
                return;
            }
            let picked = weak.upgrade().and_then(|s| {
                s.dialogs.borrow_mut().retain(|d| d != dialog);
                if response == gtk::ResponseType::Accept
                    && handle.state::<host::Epoch>().0.load(Ordering::SeqCst) == epoch
                    && !host::locked(&handle)
                {
                    dialog.filename()
                } else {
                    None
                }
            });
            let _ = tx.try_send(picked);
            dialog.close();
        });
        s.dialogs.borrow_mut().push(dialog.clone());
        dialog.show();
    })
    .ok()?;
    let picked = rx.recv().await.flatten();
    if host::locked(app) || app.state::<host::Epoch>().0.load(Ordering::SeqCst) != epoch {
        None
    } else {
        picked
    }
}

fn selected_shortcut(combo: &gtk::ComboBoxText) -> privacy::Shortcut {
    match combo.active_id().as_deref() {
        Some("ctrl_alt_p") => privacy::Shortcut::CtrlAltP,
        Some("off") => privacy::Shortcut::Off,
        _ => privacy::Shortcut::CtrlAltL,
    }
}

pub fn composition_activity(app: &tauri::AppHandle) {
    if !host::locked(app) {
        if let Some(s) = surface() {
            s.activity.set(Instant::now());
        }
    }
}

fn is_activity(
    kind: gtk::gdk::EventType,
    at: Option<(f64, f64)>,
    previous: &Cell<Option<(f64, f64)>>,
) -> bool {
    use gtk::gdk::EventType;
    match kind {
        EventType::KeyPress
        | EventType::ButtonPress
        | EventType::Scroll
        | EventType::TouchBegin
        | EventType::TouchUpdate => true,
        EventType::MotionNotify => at.is_some() && previous.replace(at) != at,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gtk::gdk::EventType;
    #[test]
    fn native_shortcut_matches_configured_key_and_rejects_extra_modifiers() {
        use gtk::gdk::ModifierType as M;
        let control_alt = M::CONTROL_MASK | M::MOD1_MASK;
        assert!(matches_shortcut(
            privacy::Shortcut::CtrlAltL,
            Some('l' as u32),
            control_alt
        ));
        assert!(matches_shortcut(
            privacy::Shortcut::CtrlAltP,
            Some('P' as u32),
            control_alt | M::LOCK_MASK
        ));
        assert!(!matches_shortcut(
            privacy::Shortcut::CtrlAltP,
            Some('l' as u32),
            control_alt
        ));
        assert!(!matches_shortcut(
            privacy::Shortcut::Off,
            Some('l' as u32),
            control_alt
        ));
        assert!(!matches_shortcut(
            privacy::Shortcut::CtrlAltL,
            Some('l' as u32),
            control_alt | M::SHIFT_MASK
        ));
        assert!(!matches_shortcut(
            privacy::Shortcut::CtrlAltL,
            Some('l' as u32),
            M::CONTROL_MASK
        ));
    }

    #[test]
    fn idle_activity_ignores_focus_and_repeated_pointer_coordinates() {
        let previous = Cell::new(None);
        assert!(!is_activity(EventType::MotionNotify, None, &previous));
        assert!(is_activity(
            EventType::MotionNotify,
            Some((8.0, 9.0)),
            &previous
        ));
        assert!(!is_activity(
            EventType::MotionNotify,
            Some((8.0, 9.0)),
            &previous
        ));
        assert!(is_activity(
            EventType::MotionNotify,
            Some((8.0, 10.0)),
            &previous
        ));
        for noise in [
            EventType::FocusChange,
            EventType::Expose,
            EventType::Configure,
        ] {
            assert!(!is_activity(noise, None, &previous));
        }
        for input in [
            EventType::KeyPress,
            EventType::ButtonPress,
            EventType::Scroll,
            EventType::TouchBegin,
            EventType::TouchUpdate,
        ] {
            assert!(is_activity(input, None, &previous));
        }
    }
}

fn native_shortcut(app: &tauri::AppHandle, event: &gtk::gdk::Event) -> bool {
    if event.event_type() != gtk::gdk::EventType::KeyPress {
        return false;
    }
    let status = app.state::<privacy::Privacy>().status();
    if status.state == LockState::Disabled || host::locked(app) {
        return false;
    }
    if matches_shortcut(
        status.policy.shortcut,
        event.keyval(),
        event.state().unwrap_or_else(gtk::gdk::ModifierType::empty),
    ) {
        lock_now(app);
        true
    } else {
        false
    }
}

fn matches_shortcut(
    shortcut: privacy::Shortcut,
    key: Option<u32>,
    state: gtk::gdk::ModifierType,
) -> bool {
    use gtk::gdk::ModifierType as M;
    let modifiers = M::CONTROL_MASK | M::MOD1_MASK | M::SHIFT_MASK | M::META_MASK | M::SUPER_MASK;
    let wanted = match shortcut {
        privacy::Shortcut::CtrlAltL => 'l',
        privacy::Shortcut::CtrlAltP => 'p',
        privacy::Shortcut::Off => return false,
    };
    (state & modifiers) == (M::CONTROL_MASK | M::MOD1_MASK)
        && key
            .and_then(char::from_u32)
            .is_some_and(|c| c.to_ascii_lowercase() == wanted)
}
