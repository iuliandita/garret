use crate::{
    privacy::{self, LockState, Policy, SecretKind, Shortcut},
    privacy_host as host,
};
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    ffi::OsString,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::PathBuf,
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use windows::{
    core::{HRESULT, PCWSTR},
    Win32::{
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            Common::COMDLG_FILTERSPEC, FileOpenDialog, FileSaveDialog, IFileDialog, IShellItem,
            SHCreateItemFromParsingName, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
        },
    },
};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    Graphics::Gdi::COLOR_WINDOW,
    System::{
        LibraryLoader::GetModuleHandleW,
        RemoteDesktop::{
            WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
            NOTIFY_FOR_THIS_SESSION,
        },
        Threading::GetCurrentProcessId,
    },
    UI::{
        Controls::EM_LIMITTEXT,
        Input::KeyboardAndMouse::{
            EnableWindow, GetFocus, GetKeyState, GetLastInputInfo, SetFocus, LASTINPUTINFO,
            VK_ESCAPE, VK_RETURN,
        },
        WindowsAndMessaging::*,
    },
};
use zeroize::Zeroize;

const SHOW_LOCK: u32 = WM_APP + 1;
const SHOW_SETTINGS: u32 = WM_APP + 2;
const SHOW_ERROR: u32 = WM_APP + 3;
const OP_RESULT: u32 = WM_APP + 4;
const NOTE_ACTIVITY: u32 = WM_APP + 5;
const SHOW_PICKER: u32 = WM_APP + 6;
const CANCEL_PICKER: u32 = WM_APP + 7;
const HIDE_LOCK: u32 = WM_APP + 8;
const FOCUS_LOCK: u32 = WM_APP + 9;
const ID_SECRET: usize = 101;
const ID_SUBMIT: usize = 102;
const ID_QUIT: usize = 103;
const ID_CURRENT: usize = 104;
const ID_NEW: usize = 105;
const ID_CONFIRM: usize = 106;
const ID_KIND: usize = 107;
const ID_IDLE: usize = 108;
const ID_SHORTCUT: usize = 109;
const ID_SESSION: usize = 110;
const ID_SLEEP: usize = 111;
const ID_NEUTRAL: usize = 112;
const ID_ACK: usize = 113;
const ID_CHANGE: usize = 114;
const ID_POLICY: usize = 115;
const ID_DISABLE: usize = 116;
const ID_CANCEL: usize = 117;
const ID_MESSAGE: usize = 118;
const ID_EXPLANATION: usize = 119;
const TIMER_IDLE: usize = 1;

pub enum PickAction {
    Open,
    Save,
    Folder,
}

struct PickerRequest {
    action: PickAction,
    title: String,
    directory: PathBuf,
    name: Option<String>,
    filter: Option<(String, Vec<String>)>,
    epoch: u64,
    reply: mpsc::Sender<Option<PathBuf>>,
}

struct Native {
    hwnd: AtomicUsize,
    main_hwnd: AtomicUsize,
    activity: Mutex<Instant>,
    outcome: Mutex<Option<Result<privacy::Status, privacy::Error>>>,
    pickers: Mutex<VecDeque<PickerRequest>>,
    enrolling: AtomicBool,
    pending_os_lock: AtomicBool,
    last_native_input: Mutex<u32>,
}
static NATIVE: OnceLock<Arc<Native>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

thread_local! {
    static SURFACE: RefCell<Option<Surface>> = const { RefCell::new(None) };
    static ACTIVE_PICKER: RefCell<Option<IFileDialog>> = const { RefCell::new(None) };
}

enum Mode {
    Hidden,
    Lock,
    Settings,
}

struct Surface {
    app: tauri::AppHandle,
    native: Arc<Native>,
    window: HWND,
    controls: HashMap<usize, HWND>,
    mode: Mode,
    session_events: bool,
    busy: bool,
    last_focus: Option<usize>,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_path(path: &std::path::Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

unsafe fn text(hwnd: HWND, value: &str) {
    SetWindowTextW(hwnd, wide(value).as_ptr());
}

unsafe fn control_text(hwnd: HWND) -> Option<String> {
    let len = GetWindowTextLengthW(hwnd);
    if len < 0 || len > 1024 {
        return None;
    }
    let mut raw = vec![0u16; len as usize + 1];
    let written = GetWindowTextW(hwnd, raw.as_mut_ptr(), raw.len() as i32);
    if written < 0 {
        raw.zeroize();
        return None;
    }
    let result = String::from_utf16(&raw[..written as usize]).ok();
    raw.zeroize();
    text(hwnd, "");
    result
}

fn record_activity(native: &Native) {
    if let Ok(mut last) = native.activity.lock() {
        *last = Instant::now();
    }
}

fn hwnd() -> Option<HWND> {
    NATIVE.get().and_then(|native| {
        let handle = native.hwnd.load(Ordering::SeqCst);
        (handle != 0).then_some(handle as HWND)
    })
}

fn main_hwnd() -> Option<HWND> {
    NATIVE.get().and_then(|native| {
        let handle = native.main_hwnd.load(Ordering::SeqCst);
        (handle != 0).then_some(handle as HWND)
    })
}

fn post(msg: u32) {
    if let Some(window) = hwnd() {
        unsafe { PostMessageW(window, msg, 0, 0) };
    }
}

pub fn install(app: &tauri::AppHandle) -> Result<(), std::io::Error> {
    let main_hwnd = app
        .get_webview_window("main")
        .ok_or_else(|| std::io::Error::other("main window unavailable"))?
        .hwnd()
        .map_err(|_| std::io::Error::other("main native handle unavailable"))?;
    let native = Arc::new(Native {
        hwnd: AtomicUsize::new(0),
        main_hwnd: AtomicUsize::new(main_hwnd.0 as usize),
        activity: Mutex::new(Instant::now()),
        outcome: Mutex::new(None),
        pickers: Mutex::new(VecDeque::new()),
        enrolling: AtomicBool::new(false),
        pending_os_lock: AtomicBool::new(false),
        last_native_input: Mutex::new(0),
    });
    let (tx, rx) = mpsc::sync_channel(1);
    APP.set(app.clone()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "privacy already installed",
        )
    })?;
    NATIVE.set(native.clone()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "privacy already installed",
        )
    })?;
    let handle = app.clone();
    let thread_native = native.clone();
    std::thread::Builder::new()
        .name("privacy-native-windows".into())
        .spawn(move || run_window(handle, thread_native, tx))?;
    let result = rx.recv_timeout(Duration::from_secs(5)).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "native privacy window did not start",
        )
    })?;
    result?;
    if app.state::<privacy::Privacy>().locked() {
        lock_now(app);
    }
    Ok(())
}

fn run_window(
    app: tauri::AppHandle,
    native: Arc<Native>,
    ready: mpsc::SyncSender<Result<(), std::io::Error>>,
) {
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            let _ = ready.send(Err(std::io::Error::other(
                "native dialog apartment unavailable",
            )));
            return;
        }
        let class_name = wide("WritingStudioPrivacyNative");
        let instance = GetModuleHandleW(ptr::null());
        let class = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance,
            hbrBackground: (COLOR_WINDOW as usize + 1) as _,
            lpszClassName: class_name.as_ptr(),
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            let _ = ready.send(Err(std::io::Error::last_os_error()));
            return;
        }
        let title = host::strings(&app).t("privacy.locked");
        let window = CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide(&title).as_ptr(),
            WS_OVERLAPPEDWINDOW,
            180,
            130,
            640,
            580,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            ptr::null(),
        );
        if window.is_null() {
            let _ = ready.send(Err(std::io::Error::last_os_error()));
            return;
        }
        let session_events = WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION) != 0;
        SURFACE.with(|slot| {
            *slot.borrow_mut() = Some(Surface {
                app,
                native: native.clone(),
                window,
                controls: HashMap::new(),
                mode: Mode::Hidden,
                session_events,
                busy: false,
                last_focus: None,
            });
        });
        native.hwnd.store(window as usize, Ordering::SeqCst);
        if SetTimer(window, TIMER_IDLE, 1000, None) == 0 {
            if session_events {
                WTSUnRegisterSessionNotification(window);
            }
            DestroyWindow(window);
            let _ = ready.send(Err(std::io::Error::last_os_error()));
            return;
        }
        let _ = ready.send(Ok(()));
        let mut msg = std::mem::zeroed::<MSG>();
        while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
            if matches!(msg.message, WM_KEYDOWN | WM_SYSKEYDOWN) {
                let used = SURFACE.with(|slot| {
                    slot.borrow().as_ref().is_some_and(|surface| {
                        if surface.shortcut(msg.wParam as u32) {
                            return true;
                        }
                        match (&surface.mode, msg.wParam as u16) {
                            (Mode::Lock, key)
                                if key == VK_RETURN && msg.hwnd == surface.control(ID_SECRET) =>
                            {
                                PostMessageW(surface.window, WM_COMMAND, ID_SUBMIT, 0);
                                true
                            }
                            (Mode::Settings, key)
                                if key == VK_RETURN
                                    && [ID_NEW, ID_CONFIRM]
                                        .into_iter()
                                        .any(|id| msg.hwnd == surface.control(id)) =>
                            {
                                PostMessageW(surface.window, WM_COMMAND, ID_CHANGE, 0);
                                true
                            }
                            (Mode::Settings, key)
                                if key == VK_ESCAPE
                                    && (msg.hwnd == surface.window
                                        || [
                                            ID_CURRENT, ID_NEW, ID_CONFIRM, ID_SESSION, ID_SLEEP,
                                            ID_NEUTRAL, ID_ACK, ID_CHANGE, ID_POLICY, ID_DISABLE,
                                            ID_CANCEL,
                                        ]
                                        .into_iter()
                                        .any(|id| msg.hwnd == surface.control(id))) =>
                            {
                                PostMessageW(surface.window, WM_CLOSE, 0, 0);
                                true
                            }
                            (Mode::Lock, key) if key == VK_ESCAPE => true,
                            _ => false,
                        }
                    })
                });
                if used {
                    continue;
                }
            }
            if matches!(
                msg.message,
                WM_KEYDOWN | WM_SYSKEYDOWN | WM_LBUTTONDOWN | WM_MOUSEWHEEL
            ) {
                record_activity(&native);
            }
            let dialog_shown = SURFACE.with(|slot| {
                slot.borrow()
                    .as_ref()
                    .is_some_and(|surface| !matches!(surface.mode, Mode::Hidden))
            });
            if dialog_shown && IsDialogMessageW(window, &msg) != 0 {
                continue;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        native.hwnd.store(0, Ordering::SeqCst);
        CoUninitialize();
    }
}

impl Surface {
    unsafe fn clear(&mut self) {
        self.last_focus = None;
        for id in [ID_SECRET, ID_CURRENT, ID_NEW, ID_CONFIRM] {
            let edit = self.control(id);
            if !edit.is_null() {
                text(edit, "");
            }
        }
        for (_, hwnd) in self.controls.drain() {
            if !hwnd.is_null() {
                DestroyWindow(hwnd);
            }
        }
    }

    unsafe fn add(
        &mut self,
        id: usize,
        class: &str,
        label: &str,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> HWND {
        let child = CreateWindowExW(
            0,
            wide(class).as_ptr(),
            wide(label).as_ptr(),
            WS_CHILD | WS_VISIBLE | style,
            x,
            y,
            width,
            height,
            self.window,
            id as _,
            GetModuleHandleW(ptr::null()),
            ptr::null(),
        );
        self.controls.insert(id, child);
        child
    }

    unsafe fn label(&mut self, id: usize, text: &str, y: i32) {
        self.add(id, "STATIC", text, 0, 30, y, 550, 38);
    }

    unsafe fn edit(&mut self, id: usize, label: &str, y: i32) {
        self.label(id + 1000, label, y);
        let field = self.add(
            id,
            "EDIT",
            "",
            WS_TABSTOP | WS_BORDER | ES_PASSWORD as u32 | ES_AUTOHSCROLL as u32,
            30,
            y + 25,
            550,
            29,
        );
        SendMessageW(field, EM_LIMITTEXT, 1024, 0);
    }

    unsafe fn button(&mut self, id: usize, label: &str, x: i32, y: i32, width: i32) {
        self.add(
            id,
            "BUTTON",
            label,
            WS_TABSTOP | BS_PUSHBUTTON as u32,
            x,
            y,
            width,
            32,
        );
    }

    unsafe fn checkbox(&mut self, id: usize, label: &str, y: i32, checked: bool) {
        let item = self.add(
            id,
            "BUTTON",
            label,
            WS_TABSTOP | BS_AUTOCHECKBOX as u32,
            30,
            y,
            550,
            27,
        );
        SendMessageW(item, BM_SETCHECK, usize::from(checked), 0);
    }

    unsafe fn combo(&mut self, id: usize, label: &str, y: i32, values: &[String], selected: usize) {
        self.label(id + 1000, label, y);
        let item = self.add(
            id,
            "COMBOBOX",
            "",
            WS_TABSTOP | CBS_DROPDOWNLIST as u32 | WS_VSCROLL,
            30,
            y + 23,
            550,
            190,
        );
        for value in values {
            SendMessageW(item, CB_ADDSTRING, 0, wide(value).as_ptr() as isize);
        }
        SendMessageW(item, CB_SETCURSEL, selected, 0);
    }

    fn control(&self, id: usize) -> HWND {
        self.controls.get(&id).copied().unwrap_or(ptr::null_mut())
    }

    unsafe fn field(&self, id: usize) -> Option<String> {
        let field = self.control(id);
        if field.is_null() {
            None
        } else {
            control_text(field)
        }
    }

    unsafe fn checked(&self, id: usize) -> bool {
        SendMessageW(self.control(id), BM_GETCHECK, 0, 0) == 1
    }

    unsafe fn selected(&self, id: usize) -> usize {
        SendMessageW(self.control(id), CB_GETCURSEL, 0, 0).max(0) as usize
    }

    unsafe fn message(&self, value: &str) {
        let item = self.control(ID_MESSAGE);
        if !item.is_null() {
            text(item, value);
        }
    }

    unsafe fn show_lock(&mut self) {
        self.clear();
        self.mode = Mode::Lock;
        self.busy = false;
        let strings = host::strings(&self.app);
        text(self.window, &strings.t("privacy.locked"));
        self.label(ID_EXPLANATION, &strings.t("privacy.explanation"), 25);
        let state = self.app.state::<privacy::Privacy>().status();
        if state.state != LockState::Recovery {
            self.edit(ID_SECRET, &strings.t("privacy.secret"), 105);
            self.button(ID_SUBMIT, &strings.t("privacy.unlock"), 30, 200, 230);
        }
        self.label(
            ID_MESSAGE,
            &strings.t(if state.state == LockState::Recovery {
                "privacy.recovery"
            } else {
                "privacy.locked_again"
            }),
            255,
        );
        self.button(ID_QUIT, &strings.t("privacy.quit"), 350, 200, 230);
        ShowWindow(self.window, SW_SHOW);
        SetForegroundWindow(self.window);
        if state.state != LockState::Recovery {
            self.last_focus = Some(ID_SECRET);
            SetFocus(self.control(ID_SECRET));
        }
    }

    unsafe fn show_settings(&mut self) {
        if host::locked(&self.app) {
            return;
        }
        self.clear();
        self.mode = Mode::Settings;
        self.busy = false;
        let strings = host::strings(&self.app);
        let status = self.app.state::<privacy::Privacy>().status();
        let enabled = status.state != LockState::Disabled;
        text(self.window, &strings.t("privacy.settings"));
        self.label(ID_EXPLANATION, &strings.t("privacy.explanation"), 8);
        if enabled {
            self.edit(ID_CURRENT, &strings.t("privacy.current"), 45);
        }
        self.edit(ID_NEW, &strings.t("privacy.new_secret"), 110);
        self.edit(ID_CONFIRM, &strings.t("privacy.confirm"), 175);
        self.combo(
            ID_KIND,
            &strings.t("privacy.kind"),
            240,
            &[strings.t("privacy.password"), strings.t("privacy.pin")],
            usize::from(status.kind == Some(SecretKind::Pin)),
        );
        let idle = [None, Some(1), Some(5), Some(15), Some(30), Some(60)];
        let values = idle
            .iter()
            .map(|n| match n {
                None => strings.t("privacy.idle_off"),
                Some(n) => strings.f("privacy.minutes", &[("minutes", &n.to_string())]),
            })
            .collect::<Vec<_>>();
        self.combo(
            ID_IDLE,
            &strings.t("privacy.idle"),
            302,
            &values,
            idle.iter()
                .position(|v| *v == status.policy.idle_min)
                .unwrap_or(0),
        );
        self.combo(
            ID_SHORTCUT,
            &strings.t("privacy.shortcut"),
            364,
            &[
                "Ctrl+Alt+L".into(),
                "Ctrl+Alt+P".into(),
                strings.t("privacy.idle_off"),
            ],
            match status.policy.shortcut {
                Shortcut::CtrlAltL => 0,
                Shortcut::CtrlAltP => 1,
                Shortcut::Off => 2,
            },
        );
        self.checkbox(
            ID_SESSION,
            &strings.t("privacy.session_lock"),
            427,
            status.policy.session_lock && self.session_events,
        );
        if !self.session_events {
            EnableWindow(self.control(ID_SESSION), 0);
        }
        self.checkbox(
            ID_SLEEP,
            &strings.t("privacy.sleep"),
            453,
            status.policy.sleep,
        );
        self.checkbox(
            ID_NEUTRAL,
            &strings.t("privacy.neutral_option"),
            479,
            status.policy.neutral_title,
        );
        if !enabled {
            self.checkbox(ID_ACK, &strings.t("privacy.acknowledge"), 505, false);
        }
        self.button(
            ID_CHANGE,
            &strings.t(if enabled {
                "privacy.change"
            } else {
                "privacy.enable"
            }),
            30,
            541,
            160,
        );
        if enabled {
            self.button(ID_POLICY, &strings.t("privacy.save_policy"), 200, 541, 160);
            self.button(ID_DISABLE, &strings.t("privacy.disable"), 370, 541, 160);
        } else {
            self.button(
                ID_CANCEL,
                &strings.t("privacy.choose_cancel"),
                370,
                541,
                160,
            );
        }
        self.label(ID_MESSAGE, &strings.t("privacy.requirements"), 580);
        MoveWindow(self.window, 180, 80, 640, 670, 1);
        ShowWindow(self.window, SW_SHOW);
        SetForegroundWindow(self.window);
        let first = if enabled { ID_CURRENT } else { ID_NEW };
        self.last_focus = Some(first);
        SetFocus(self.control(first));
    }

    unsafe fn policy(&self) -> Policy {
        let idle = [None, Some(1), Some(5), Some(15), Some(30), Some(60)];
        Policy {
            idle_min: idle.get(self.selected(ID_IDLE)).copied().unwrap_or(None),
            shortcut: match self.selected(ID_SHORTCUT) {
                1 => Shortcut::CtrlAltP,
                2 => Shortcut::Off,
                _ => Shortcut::CtrlAltL,
            },
            session_lock: self.session_events && self.checked(ID_SESSION),
            sleep: self.checked(ID_SLEEP),
            neutral_title: self.checked(ID_NEUTRAL),
        }
    }

    unsafe fn submit(&mut self, id: usize) {
        if self.busy {
            return;
        }
        let state = self.app.state::<privacy::Privacy>().status().state;
        let generation = self.app.state::<privacy::Privacy>().generation();
        let app = self.app.clone();
        let native = self.native.clone();
        let window = self.window as usize;
        let op: Box<
            dyn FnOnce(&privacy::Privacy) -> Result<privacy::Status, privacy::Error> + Send,
        > = match id {
            ID_SUBMIT if state == LockState::Locked => {
                let Some(secret) = self.field(ID_SECRET) else {
                    return;
                };
                Box::new(move |p| p.unlock(generation, secret))
            }
            ID_CHANGE if matches!(self.mode, Mode::Settings) => {
                if state == LockState::Disabled && !self.checked(ID_ACK) {
                    return;
                }
                let Some(current) = (if state == LockState::Disabled {
                    Some(String::new())
                } else {
                    self.field(ID_CURRENT)
                }) else {
                    return;
                };
                let Some(new) = self.field(ID_NEW) else {
                    return;
                };
                let Some(confirm) = self.field(ID_CONFIRM) else {
                    return;
                };
                let kind = if self.selected(ID_KIND) == 1 {
                    SecretKind::Pin
                } else {
                    SecretKind::Password
                };
                let policy = self.policy();
                if state == LockState::Disabled {
                    Box::new(move |p| p.enroll(generation, kind, new, confirm, policy))
                } else {
                    Box::new(move |p| p.change_secret(generation, current, kind, new, confirm))
                }
            }
            ID_POLICY if matches!(self.mode, Mode::Settings) => {
                let Some(current) = self.field(ID_CURRENT) else {
                    return;
                };
                let policy = self.policy();
                Box::new(move |p| p.update_policy(generation, current, policy))
            }
            ID_DISABLE if matches!(self.mode, Mode::Settings) => {
                let Some(current) = self.field(ID_CURRENT) else {
                    return;
                };
                Box::new(move |p| p.disable(generation, current))
            }
            _ => return,
        };
        self.busy = true;
        if id == ID_CHANGE && state == LockState::Disabled {
            self.native.enrolling.store(true, Ordering::SeqCst);
        }
        self.message(&host::strings(&app).t("privacy.verifying"));
        std::thread::spawn(move || {
            let result = op(&app.state::<privacy::Privacy>());
            if let Ok(mut slot) = native.outcome.lock() {
                *slot = Some(result);
            }
            unsafe { PostMessageW(window as HWND, OP_RESULT, 0, 0) };
        });
    }

    unsafe fn result(&mut self) {
        self.busy = false;
        let Some(result) = self
            .native
            .outcome
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
        else {
            return;
        };
        self.native.enrolling.store(false, Ordering::SeqCst);
        let deferred_os_lock = self.native.pending_os_lock.swap(false, Ordering::SeqCst);
        let succeeded = result.is_ok();
        match result {
            Ok(_) if matches!(self.mode, Mode::Lock) => {
                let app = self.app.clone();
                let _ = app.clone().run_on_main_thread(move || restore(&app));
            }
            Ok(_) if matches!(self.mode, Mode::Settings) => {
                self.clear();
                ShowWindow(self.window, SW_HIDE);
                self.mode = Mode::Hidden;
                record_activity(&self.native);
                host::changed(&self.app);
            }
            Ok(_) => host::changed(&self.app),
            Err(error) => {
                if error == privacy::Error::Persist {
                    lock_now(&self.app);
                }
                let strings = host::strings(&self.app);
                let key = match error {
                    privacy::Error::WrongSecret => "privacy.wrong",
                    privacy::Error::RateLimited => "privacy.wait",
                    privacy::Error::Recovery | privacy::Error::Persist => "privacy.recovery",
                    privacy::Error::Confirmation => "privacy.confirmation_mismatch",
                    _ => "privacy.error",
                };
                self.message(&strings.t(key));
            }
        }
        if succeeded && deferred_os_lock {
            lock_now(&self.app);
        }
    }

    unsafe fn tick(&self) {
        if host::locked(&self.app) {
            return;
        }
        self.picker_activity();
        let status = self.app.state::<privacy::Privacy>().status();
        if status.state == LockState::Disabled {
            return;
        }
        let Some(minutes) = status.policy.idle_min else {
            return;
        };
        let inactive = self
            .native
            .activity
            .lock()
            .map(|last| last.elapsed())
            .unwrap_or(Duration::ZERO);
        if inactive >= Duration::from_secs(u64::from(minutes) * 60) {
            lock_now(&self.app);
        }
    }

    unsafe fn picker_activity(&self) {
        if !ACTIVE_PICKER.with(|slot| slot.borrow().is_some()) {
            return;
        }
        let foreground = GetForegroundWindow();
        let Some(main) = main_hwnd() else {
            return;
        };
        let mut process = 0;
        GetWindowThreadProcessId(foreground, &mut process);
        if process != GetCurrentProcessId() || GetWindow(foreground, GW_OWNER) != main {
            return;
        }
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info) != 0 {
            if let Ok(mut last) = self.native.last_native_input.lock() {
                if *last != info.dwTime {
                    *last = info.dwTime;
                    record_activity(&self.native);
                }
            }
        }
    }

    unsafe fn shortcut(&self, vk: u32) -> bool {
        let status = self.app.state::<privacy::Privacy>().status();
        if status.state == LockState::Disabled || host::locked(&self.app) {
            return false;
        }
        let control = GetKeyState(0x11) < 0;
        let alt = GetKeyState(0x12) < 0;
        let shift = GetKeyState(0x10) < 0;
        let win = GetKeyState(0x5b) < 0 || GetKeyState(0x5c) < 0;
        let key = match status.policy.shortcut {
            Shortcut::CtrlAltL => 0x4c,
            Shortcut::CtrlAltP => 0x50,
            Shortcut::Off => return false,
        };
        if control && alt && !shift && !win && vk == key {
            lock_now(&self.app);
            true
        } else {
            false
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_SETFOCUS {
        let child = SURFACE.with(|slot| {
            slot.try_borrow().ok().and_then(|slot| {
                let surface = slot.as_ref()?;
                if surface.window != hwnd {
                    return None;
                }
                surface.last_focus.map(|id| surface.control(id))
            })
        });
        if let Some(child) = child.filter(|child| !child.is_null()) {
            SetFocus(child);
            return 0;
        }
    }
    if msg == WM_WTSSESSION_CHANGE && w as u32 == WTS_SESSION_LOCK {
        if let Some(app) = APP.get() {
            if app.state::<privacy::Privacy>().status().policy.session_lock {
                os_lock(app);
            }
        }
        return 0;
    }
    if msg == WM_POWERBROADCAST && w as u32 == PBT_APMSUSPEND {
        if let Some(app) = APP.get() {
            if app.state::<privacy::Privacy>().status().policy.sleep {
                os_lock(app);
            }
        }
        return 1;
    }
    if msg == SHOW_LOCK || msg == CANCEL_PICKER {
        ACTIVE_PICKER.with(|slot| {
            if let Some(dialog) = slot.borrow().as_ref() {
                let _ = dialog.Close(HRESULT(0x800704c7u32 as i32));
            }
        });
    }
    if msg == CANCEL_PICKER || msg == HIDE_LOCK {
        ShowWindow(hwnd, SW_HIDE);
        return 0;
    }
    if msg == FOCUS_LOCK {
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        return 0;
    }
    if msg == SHOW_PICKER {
        run_picker(hwnd);
        return 0;
    }
    let handled = SURFACE.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else {
            let deferred = matches!(msg, SHOW_LOCK | SHOW_SETTINGS | OP_RESULT | WM_CLOSE)
                || (msg == WM_COMMAND
                    && matches!(
                        w & 0xffff,
                        ID_SUBMIT | ID_CHANGE | ID_POLICY | ID_DISABLE | ID_QUIT | ID_CANCEL
                    ));
            if deferred {
                if msg == SHOW_LOCK {
                    ShowWindow(hwnd, SW_HIDE);
                }
                PostMessageW(hwnd, msg, w, l);
                return Some(0);
            }
            return None;
        };
        let Some(surface) = slot.as_mut() else {
            return None;
        };
        if surface.window != hwnd {
            return None;
        }
        match msg {
            SHOW_LOCK => {
                surface.show_lock();
                Some(0)
            }
            SHOW_SETTINGS => {
                surface.show_settings();
                Some(0)
            }
            SHOW_ERROR => {
                surface.message(&host::strings(&surface.app).t("privacy.save_failed"));
                Some(0)
            }
            OP_RESULT => {
                surface.result();
                Some(0)
            }
            NOTE_ACTIVITY => {
                record_activity(&surface.native);
                Some(0)
            }
            WM_TIMER if w == TIMER_IDLE => {
                surface.tick();
                Some(0)
            }
            WM_COMMAND => {
                let id = w & 0xffff;
                let child = l as HWND;
                if !child.is_null() && surface.control(id) == child && GetFocus() == child {
                    surface.last_focus = Some(id);
                }
                match id {
                    ID_SUBMIT | ID_CHANGE | ID_POLICY | ID_DISABLE => surface.submit(id),
                    ID_QUIT => request_close(&surface.app),
                    ID_CANCEL => {
                        surface.clear();
                        ShowWindow(surface.window, SW_HIDE);
                        surface.mode = Mode::Hidden;
                    }
                    _ => {}
                }
                record_activity(&surface.native);
                Some(0)
            }
            WM_KEYDOWN | WM_SYSKEYDOWN => {
                if surface.shortcut(w as u32) {
                    Some(0)
                } else {
                    record_activity(&surface.native);
                    None
                }
            }
            WM_MOUSEMOVE | WM_MOUSEWHEEL | WM_LBUTTONDOWN => {
                record_activity(&surface.native);
                None
            }
            WM_CLOSE => {
                if matches!(surface.mode, Mode::Lock) {
                    request_close(&surface.app);
                } else {
                    surface.clear();
                    ShowWindow(surface.window, SW_HIDE);
                    surface.mode = Mode::Hidden;
                }
                Some(0)
            }
            WM_DESTROY => {
                KillTimer(hwnd, TIMER_IDLE);
                if surface.session_events {
                    WTSUnRegisterSessionNotification(hwnd);
                }
                PostQuitMessage(0);
                Some(0)
            }
            _ => None,
        }
    });
    handled.unwrap_or_else(|| DefWindowProcW(hwnd, msg, w, l))
}

fn os_lock(app: &tauri::AppHandle) {
    if app.state::<privacy::Privacy>().status().state == LockState::Disabled {
        if let Some(native) = NATIVE.get() {
            if native.enrolling.load(Ordering::SeqCst) {
                native.pending_os_lock.store(true, Ordering::SeqCst);
            }
        }
    } else {
        begin_lock(app);
        ACTIVE_PICKER.with(|slot| {
            if let Some(dialog) = slot.borrow().as_ref() {
                let _ = unsafe { dialog.Close(HRESULT(0x800704c7u32 as i32)) };
            }
        });
        if let Some(native) = hwnd() {
            unsafe { ShowWindow(native, SW_HIDE) };
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let handle = app.clone();
        if app
            .run_on_main_thread(move || {
                conceal_on_main(&handle);
                let _ = tx.send(());
            })
            .is_err()
            || rx.recv_timeout(Duration::from_secs(3)).is_err()
        {
            if let Some(main) = main_hwnd() {
                unsafe { ShowWindowAsync(main, SW_HIDE) };
            }
            post(SHOW_LOCK);
        }
    }
}

fn begin_lock(app: &tauri::AppHandle) {
    app.state::<host::Barrier>().0.store(true, Ordering::SeqCst);
    app.state::<privacy::Privacy>().lock();
    app.state::<host::Epoch>().0.fetch_add(1, Ordering::SeqCst);
    crate::printer_windows::abort_all();
}

fn conceal_on_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    if let Some(main) = main_hwnd() {
        unsafe {
            SetWindowTextW(main, wide(&host::strings(app).t("privacy.locked")).as_ptr());
            ShowWindow(main, SW_HIDE);
        }
    }
    post(SHOW_LOCK);
    host::changed(app);
    let _ = app.emit(host::LOCK, ());
}

fn request_close(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}

fn restore(app: &tauri::AppHandle) {
    if app.state::<privacy::Privacy>().locked() {
        return;
    }
    app.state::<host::Barrier>()
        .0
        .store(false, Ordering::SeqCst);
    app.state::<crate::close_state::CloseState>().reset();
    let name = crate::locked(&app.state::<crate::StoreState>())
        .as_ref()
        .map(|p| p.name.clone())
        .unwrap_or_else(|| host::strings(app).t("library"));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&host::title(app, &name));
        let _ = window.show();
        // A watchdog may have hidden the HWND before Tauri processed hide().
        if let Some(main) = main_hwnd() {
            unsafe { ShowWindow(main, SW_SHOW) };
        }
        let _ = window.set_focus();
    }
    app.state::<host::ContentShown>()
        .0
        .store(true, Ordering::SeqCst);
    if let Some(native) = NATIVE.get() {
        post(HIDE_LOCK);
        record_activity(native);
    }
    host::changed(app);
}

pub fn lock_now(app: &tauri::AppHandle) {
    if app.state::<privacy::Privacy>().status().state == LockState::Disabled {
        return;
    }
    begin_lock(app);
    post(CANCEL_PICKER);
    let handle = app.clone();
    if app
        .run_on_main_thread(move || conceal_on_main(&handle))
        .is_err()
    {
        if let Some(main) = main_hwnd() {
            unsafe { ShowWindowAsync(main, SW_HIDE) };
        }
        post(SHOW_LOCK);
    }
}

pub fn focus(app: &tauri::AppHandle) {
    if host::locked(app) {
        post(FOCUS_LOCK);
    }
}

pub fn settings(app: &tauri::AppHandle) {
    if !host::locked(app) {
        post(SHOW_SETTINGS);
    }
}

pub fn save_failed(app: &tauri::AppHandle) {
    if host::locked(app) {
        post(SHOW_ERROR);
    }
}

pub fn activity(app: &tauri::AppHandle) {
    if !host::locked(app) {
        post(NOTE_ACTIVITY);
    }
}

pub async fn pick(
    app: &tauri::AppHandle,
    action: PickAction,
    title: String,
    directory: PathBuf,
    name: Option<String>,
    filter: Option<(String, Vec<String>)>,
) -> Option<PathBuf> {
    if host::locked(app) {
        return None;
    }
    let epoch = app.state::<host::Epoch>().0.load(Ordering::SeqCst);
    let native = NATIVE.get()?;
    let (tx, rx) = mpsc::channel();
    let request = PickerRequest {
        action,
        title,
        directory,
        name,
        filter,
        epoch,
        reply: tx,
    };
    native.pickers.lock().ok()?.push_back(request);
    post(SHOW_PICKER);
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
}

unsafe fn run_picker(window: HWND) {
    if ACTIVE_PICKER.with(|slot| slot.borrow().is_some()) {
        return;
    }
    let (Some(native), Some(app)) = (NATIVE.get(), APP.get()) else {
        return;
    };
    let request = native
        .pickers
        .lock()
        .ok()
        .and_then(|mut queue| queue.pop_front());
    let Some(request) = request else { return };
    if !host::picker_epoch_allows(
        host::locked(app),
        app.state::<host::Epoch>().0.load(Ordering::SeqCst),
        request.epoch,
    ) {
        let _ = request.reply.send(None);
        PostMessageW(window, SHOW_PICKER, 0, 0);
        return;
    }
    let selected = run_picker_dialog(app, &request);
    let result = if !host::picker_epoch_allows(
        host::locked(app),
        app.state::<host::Epoch>().0.load(Ordering::SeqCst),
        request.epoch,
    ) {
        None
    } else {
        selected
    };
    let _ = request.reply.send(result);
    PostMessageW(window, SHOW_PICKER, 0, 0);
}

unsafe fn run_picker_dialog(app: &tauri::AppHandle, request: &PickerRequest) -> Option<PathBuf> {
    let class = match request.action {
        PickAction::Save => &FileSaveDialog,
        PickAction::Open | PickAction::Folder => &FileOpenDialog,
    };
    let dialog: IFileDialog = CoCreateInstance(class, None, CLSCTX_INPROC_SERVER).ok()?;
    let mut options = dialog.GetOptions().ok()? | FOS_FORCEFILESYSTEM;
    if matches!(request.action, PickAction::Folder) {
        options |= FOS_PICKFOLDERS;
    }
    dialog.SetOptions(options).ok()?;
    let title = wide(&request.title);
    dialog.SetTitle(PCWSTR(title.as_ptr())).ok()?;
    let directory = wide_path(&request.directory);
    if let Ok(folder) = SHCreateItemFromParsingName::<_, _, IShellItem>(
        PCWSTR(directory.as_ptr()),
        None::<&windows::Win32::System::Com::IBindCtx>,
    ) {
        let _ = dialog.SetFolder(&folder);
    }
    let name = request.name.as_ref().map(|name| wide(name));
    if let Some(name) = &name {
        dialog.SetFileName(PCWSTR(name.as_ptr())).ok()?;
    }
    let filter_name = request.filter.as_ref().map(|filter| wide(&filter.0));
    let filter_pattern = request.filter.as_ref().map(|filter| {
        wide(
            &filter
                .1
                .iter()
                .map(|ext| format!("*.{ext}"))
                .collect::<Vec<_>>()
                .join(";"),
        )
    });
    if let (Some(filter_name), Some(filter_pattern)) = (&filter_name, &filter_pattern) {
        dialog
            .SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: PCWSTR(filter_name.as_ptr()),
                pszSpec: PCWSTR(filter_pattern.as_ptr()),
            }])
            .ok()?;
    }
    let main = main_hwnd()?;
    if !host::picker_epoch_allows(
        host::locked(app),
        app.state::<host::Epoch>().0.load(Ordering::SeqCst),
        request.epoch,
    ) {
        return None;
    }
    ACTIVE_PICKER.with(|slot| *slot.borrow_mut() = Some(dialog.clone()));
    let shown = dialog.Show(Some(windows::Win32::Foundation::HWND(main)));
    ACTIVE_PICKER.with(|slot| *slot.borrow_mut() = None);
    if shown.is_err() {
        return None;
    }
    let item = dialog.GetResult().ok()?;
    let path = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
    let mut len = 0;
    while *path.0.add(len) != 0 {
        len += 1;
    }
    let selected = Some(PathBuf::from(OsString::from_wide(
        std::slice::from_raw_parts(path.0, len),
    )));
    CoTaskMemFree(Some(path.0.cast()));
    selected
}
