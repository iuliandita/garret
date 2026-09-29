//! logind callbacks run on the GTK main context that installs them.
use gio::prelude::*;
use glib::variant::{Handle, ObjectPath};
use gtk::{gio, glib};
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    sync::atomic::{AtomicBool, AtomicU8, Ordering},
};
use tauri::Manager;

const SERVICE: &str = "org.freedesktop.login1";
const PATH: &str = "/org/freedesktop/login1";
const MANAGER: &str = "org.freedesktop.login1.Manager";
const SESSION: &str = "org.freedesktop.login1.Session";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
static INSTALLED: AtomicBool = AtomicBool::new(false);
static AVAILABLE: AtomicU8 = AtomicU8::new(0);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub session_lock: bool,
    pub sleep: bool,
}

pub fn capabilities() -> Capabilities {
    let bits = AVAILABLE.load(Ordering::SeqCst);
    Capabilities {
        session_lock: bits & 1 != 0,
        sleep: bits & 2 != 0,
    }
}

fn publish(app: &tauri::AppHandle, caps: Capabilities) {
    let bits = u8::from(caps.session_lock) | (u8::from(caps.sleep) << 1);
    if AVAILABLE.swap(bits, Ordering::SeqCst) != bits {
        crate::privacy_host::changed(app);
    }
}

#[derive(Default)]
struct Cycle {
    preparing: bool,
    disconnected: bool,
}
impl Cycle {
    fn prepare(&mut self, start: bool) -> bool {
        if self.disconnected || self.preparing == start {
            return false;
        }
        self.preparing = start;
        true
    }
}

struct Adapter {
    connection: gio::DBusConnection,
    owner: String,
    // gio 0.18 exposes raw descriptors; retaining their owning list avoids unsafe conversion.
    inhibitor: Option<gio::UnixFDList>,
    caps: Capabilities,
    cycle: Cycle,
}

fn call(
    connection: &gio::DBusConnection,
    owner: &str,
    path: &str,
    interface: &str,
    method: &str,
    args: &glib::Variant,
) -> Option<glib::Variant> {
    connection
        .call_sync(
            Some(owner),
            path,
            interface,
            method,
            Some(args),
            None,
            gio::DBusCallFlags::NONE,
            1500,
            gio::Cancellable::NONE,
        )
        .ok()
}

fn inhibit(connection: &gio::DBusConnection, owner: &str) -> Option<gio::UnixFDList> {
    let (reply, fds) = connection
        .call_with_unix_fd_list_sync(
            Some(owner),
            PATH,
            MANAGER,
            "Inhibit",
            Some(
                &(
                    "sleep",
                    "Writing application",
                    "Conceal application before sleep",
                    "delay",
                )
                    .to_variant(),
            ),
            None,
            gio::DBusCallFlags::NONE,
            1500,
            None::<&gio::UnixFDList>,
            gio::Cancellable::NONE,
        )
        .ok()?;
    let (handle,) = reply.get::<(Handle,)>()?;
    valid_handle(handle.0, fds.peek_fds().len()).then_some(fds)
}

fn valid_handle(index: i32, len: usize) -> bool {
    index >= 0 && (index as usize) < len
}

fn property(
    connection: &gio::DBusConnection,
    owner: &str,
    path: &str,
    interface: &str,
    name: &str,
) -> Option<bool> {
    let reply = call(
        connection,
        owner,
        path,
        PROPERTIES,
        "Get",
        &(interface, name).to_variant(),
    )?;
    let (value,) = reply.get::<(glib::Variant,)>()?;
    value.get::<bool>()
}

fn session_lock(app: &tauri::AppHandle, adapter: &Rc<RefCell<Adapter>>) {
    if adapter.borrow().cycle.disconnected || adapter.borrow().connection.is_closed() {
        return;
    }
    if app
        .state::<crate::privacy::Privacy>()
        .status()
        .policy
        .session_lock
    {
        crate::privacy_native::lock_now(app);
    }
}

fn sleep(app: &tauri::AppHandle, adapter: &Rc<RefCell<Adapter>>, start: bool) {
    let enabled = app.state::<crate::privacy::Privacy>().status().policy.sleep;
    sleep_with(
        adapter,
        start,
        enabled,
        || crate::privacy_native::lock_now(app),
        |caps| publish(app, caps),
    );
}

fn sleep_with(
    adapter: &Rc<RefCell<Adapter>>,
    start: bool,
    enabled: bool,
    conceal: impl FnOnce(),
    changed: impl FnOnce(Capabilities),
) {
    if adapter.borrow().connection.is_closed() {
        let mut a = adapter.borrow_mut();
        a.cycle.disconnected = true;
        a.inhibitor.take();
        a.caps = Capabilities::default();
        changed(a.caps);
        return;
    }
    if !adapter.borrow_mut().cycle.prepare(start) {
        return;
    }
    if start {
        if enabled {
            // Synchronous GTK concealment must finish BEFORE the delay inhibitor is released.
            conceal();
        }
        adapter.borrow_mut().inhibitor.take();
    } else {
        let mut a = adapter.borrow_mut();
        a.inhibitor = inhibit(&a.connection, &a.owner);
        a.caps.sleep = a.inhibitor.is_some();
        changed(a.caps);
    }
}

fn lost(app: &tauri::AppHandle, adapter: &Rc<RefCell<Adapter>>) {
    let mut a = adapter.borrow_mut();
    a.cycle.disconnected = true;
    a.inhibitor.take();
    a.caps = Capabilities::default();
    publish(app, a.caps);
}

fn locked_hint(args: &glib::Variant) -> Option<bool> {
    let (interface, changed, invalidated) =
        args.get::<(String, HashMap<String, glib::Variant>, Vec<String>)>()?;
    if interface != SESSION {
        return None;
    }
    if let Some(value) = changed.get("LockedHint") {
        return value.get::<bool>();
    }
    // An invalidated hint is conservatively treated as a lock until the next known state.
    invalidated
        .iter()
        .any(|name| name == "LockedHint")
        .then_some(true)
}

fn inherited_session_matches(
    properties: &HashMap<String, glib::Variant>,
    id: &str,
    uid: u32,
) -> bool {
    !id.is_empty()
        && properties
            .get("Id")
            .and_then(|v| v.get::<String>())
            .as_deref()
            == Some(id)
        && properties
            .get("User")
            .and_then(|v| v.get::<(u32, ObjectPath)>())
            .is_some_and(|(owner, _)| owner == uid)
        && properties.get("Remote").and_then(|v| v.get::<bool>()) == Some(false)
        && matches!(
            properties
                .get("Type")
                .and_then(|v| v.get::<String>())
                .as_deref(),
            Some("wayland" | "x11")
        )
        && matches!(
            properties
                .get("Class")
                .and_then(|v| v.get::<String>())
                .as_deref(),
            Some("user" | "user-early" | "user-light" | "user-early-light")
        )
}

fn inherited_session(
    connection: &gio::DBusConnection,
    owner: &str,
    id: &str,
    uid: u32,
) -> Option<(ObjectPath,)> {
    if id.is_empty() {
        return None;
    }
    let (path,) = call(
        connection,
        owner,
        PATH,
        MANAGER,
        "GetSession",
        &(id,).to_variant(),
    )?
    .get::<(ObjectPath,)>()?;
    let (properties,) = call(
        connection,
        owner,
        &path,
        PROPERTIES,
        "GetAll",
        &(SESSION,).to_variant(),
    )?
    .get::<(HashMap<String, glib::Variant>,)>()?;
    inherited_session_matches(&properties, id, uid).then_some((path,))
}

/// Call once, on GTK's main thread, after the native concealment adapter exists.
pub fn install(app: &tauri::AppHandle) {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(connection) = gio::bus_get_sync(gio::BusType::System, gio::Cancellable::NONE) else {
        return;
    };
    let Some(reply) = call(
        &connection,
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "GetNameOwner",
        &(SERVICE,).to_variant(),
    ) else {
        return;
    };
    let Some((owner,)) = reply.get::<(String,)>() else {
        return;
    };
    let session = call(
        &connection,
        &owner,
        PATH,
        MANAGER,
        "GetSessionByPID",
        &(std::process::id(),).to_variant(),
    )
    .and_then(|v| v.get::<(ObjectPath,)>())
    .or_else(|| {
        // Desktop user services can live outside the session's process scope.
        let id = std::env::var("XDG_SESSION_ID").ok()?;
        let uid = gio::Credentials::new().unix_user().ok()?;
        inherited_session(&connection, &owner, &id, uid)
    });
    let adapter = Rc::new(RefCell::new(Adapter {
        connection: connection.clone(),
        owner: owner.clone(),
        inhibitor: None,
        caps: Capabilities::default(),
        cycle: Cycle::default(),
    }));
    let a = adapter.clone();
    let app_sleep = app.clone();
    connection.signal_subscribe(
        Some(&owner),
        Some(MANAGER),
        Some("PrepareForSleep"),
        Some(PATH),
        None,
        gio::DBusSignalFlags::NONE,
        move |_, _, _, _, _, args| {
            if let Some((start,)) = args.get::<(bool,)>() {
                sleep(&app_sleep, &a, start);
            }
        },
    );
    let a = adapter.clone();
    let app_owner = app.clone();
    connection.signal_subscribe(
        Some("org.freedesktop.DBus"),
        Some("org.freedesktop.DBus"),
        Some("NameOwnerChanged"),
        Some("/org/freedesktop/DBus"),
        Some(SERVICE),
        gio::DBusSignalFlags::NONE,
        move |_, _, _, _, _, args| {
            if let Some((_, old, new)) = args.get::<(String, String, String)>() {
                if old == a.borrow().owner && old != new {
                    lost(&app_owner, &a);
                }
            }
        },
    );
    // GDBus emits closed on a worker thread. Queue resource cleanup on GTK, but clear availability immediately.
    let app_closed = app.clone();
    connection.connect_closed(move |_, _, _| {
        AVAILABLE.store(0, Ordering::SeqCst);
        crate::privacy_host::changed(&app_closed);
    });
    // The connection cannot deliver more events after close; this local poll releases its owned FD.
    let a = adapter.clone();
    let app_poll = app.clone();
    glib::timeout_add_local(std::time::Duration::from_secs(1), move || {
        if a.borrow().connection.is_closed() {
            lost(&app_poll, &a);
            glib::ControlFlow::Break
        } else if a.borrow().cycle.disconnected {
            glib::ControlFlow::Break
        } else {
            glib::ControlFlow::Continue
        }
    });
    if let Some((path,)) = session {
        let a = adapter.clone();
        let app_lock = app.clone();
        connection.signal_subscribe(
            Some(&owner),
            Some(SESSION),
            Some("Lock"),
            Some(&path),
            None,
            gio::DBusSignalFlags::NONE,
            move |_, _, _, _, _, _| session_lock(&app_lock, &a),
        );
        let a = adapter.clone();
        let app_hint = app.clone();
        connection.signal_subscribe(
            Some(&owner),
            Some(PROPERTIES),
            Some("PropertiesChanged"),
            Some(&path),
            Some(SESSION),
            gio::DBusSignalFlags::NONE,
            move |_, _, _, _, _, args| {
                if locked_hint(args) == Some(true) {
                    session_lock(&app_hint, &a);
                }
            },
        );
        let a = adapter.clone();
        let app_removed = app.clone();
        let watched = path.clone();
        connection.signal_subscribe(
            Some(&owner),
            Some(MANAGER),
            Some("SessionRemoved"),
            Some(PATH),
            None,
            gio::DBusSignalFlags::NONE,
            move |_, _, _, _, _, args| {
                if let Some((_, removed)) = args.get::<(String, ObjectPath)>() {
                    if removed == watched {
                        let mut a = a.borrow_mut();
                        a.caps.session_lock = false;
                        publish(&app_removed, a.caps);
                    }
                }
            },
        );
        // A successful property read establishes that the resolved session still exists.
        if let Some(locked) = property(&connection, &owner, &path, SESSION, "LockedHint") {
            adapter.borrow_mut().caps.session_lock = true;
            if locked {
                session_lock(app, &adapter);
            }
        }
    }
    adapter.borrow_mut().inhibitor = inhibit(&connection, &owner);
    {
        let mut a = adapter.borrow_mut();
        a.caps.sleep = a.inhibitor.is_some();
    }
    // The signal may have preceded startup; do not hold sleep while waiting for an event already sent.
    if let Some(preparing) = property(&connection, &owner, PATH, MANAGER, "PreparingForSleep") {
        if preparing {
            sleep(app, &adapter, true);
        }
    } else {
        let mut a = adapter.borrow_mut();
        a.inhibitor.take();
        a.caps.sleep = false;
    }
    publish(app, adapter.borrow().caps);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inherited_session_requires_own_local_graphical_user_session() {
        let user = ObjectPath::try_from("/org/freedesktop/login1/user/_1000").unwrap();
        let properties = HashMap::from([
            ("Id".into(), "desktop".to_variant()),
            ("User".into(), (1000_u32, user).to_variant()),
            ("Remote".into(), false.to_variant()),
            ("Type".into(), "wayland".to_variant()),
            ("Class".into(), "user".to_variant()),
        ]);
        assert!(inherited_session_matches(&properties, "desktop", 1000));
        assert!(!inherited_session_matches(&properties, "", 1000));
        assert!(!inherited_session_matches(&properties, "other", 1000));
        assert!(!inherited_session_matches(&properties, "desktop", 1001));
        for key in ["Id", "User", "Remote", "Type", "Class"] {
            let mut missing = properties.clone();
            missing.remove(key);
            assert!(
                !inherited_session_matches(&missing, "desktop", 1000),
                "{key}"
            );
            missing.insert(key.into(), 42_u32.to_variant());
            assert!(
                !inherited_session_matches(&missing, "desktop", 1000),
                "{key}"
            );
        }
        for (key, value) in [
            ("Remote", true.to_variant()),
            ("Type", "tty".to_variant()),
            ("Class", "greeter".to_variant()),
        ] {
            let mut wrong = properties.clone();
            wrong.insert(key.into(), value);
            assert!(!inherited_session_matches(&wrong, "desktop", 1000), "{key}");
        }
        for kind in ["wayland", "x11"] {
            for class in ["user", "user-early", "user-light", "user-early-light"] {
                let mut valid = properties.clone();
                valid.insert("Type".into(), kind.to_variant());
                valid.insert("Class".into(), class.to_variant());
                valid.insert("Active".into(), false.to_variant());
                assert!(inherited_session_matches(&valid, "desktop", 1000));
            }
        }
    }

    #[test]
    fn sleep_cycles_deduplicate_and_disconnect_is_terminal() {
        let mut c = Cycle::default();
        assert!(!c.prepare(false));
        assert!(c.prepare(true));
        assert!(!c.prepare(true));
        assert!(c.prepare(false));
        assert!(!c.prepare(false));
        assert!(c.prepare(true));
        c.disconnected = true;
        assert!(!c.prepare(false));
        assert!(!c.prepare(true));
    }
    #[test]
    fn fd_handle_must_name_a_received_descriptor() {
        assert!(valid_handle(0, 1));
        assert!(valid_handle(1, 2));
        assert!(!valid_handle(-1, 1));
        assert!(!valid_handle(1, 1));
        assert!(!valid_handle(0, 0));
    }
    #[test]
    fn hints_require_correct_interface_and_boolean_and_unlock_is_not_lock() {
        let changed = HashMap::from([("LockedHint".to_string(), true.to_variant())]);
        assert_eq!(
            locked_hint(&(SESSION, changed.clone(), Vec::<String>::new()).to_variant()),
            Some(true)
        );
        assert_eq!(
            locked_hint(&(MANAGER, changed, Vec::<String>::new()).to_variant()),
            None
        );
        let changed = HashMap::from([("LockedHint".to_string(), false.to_variant())]);
        assert_eq!(
            locked_hint(&(SESSION, changed, Vec::<String>::new()).to_variant()),
            Some(false)
        );
        let changed = HashMap::from([("LockedHint".to_string(), "true".to_variant())]);
        assert_eq!(
            locked_hint(&(SESSION, changed, Vec::<String>::new()).to_variant()),
            None
        );
        assert_eq!(
            locked_hint(
                &(
                    SESSION,
                    HashMap::<String, glib::Variant>::new(),
                    vec!["LockedHint"]
                )
                    .to_variant()
            ),
            Some(true)
        );
        assert_eq!(locked_hint(&(true,).to_variant()), None);
    }

    #[test]
    #[ignore = "requires local Unix socket permission; runs only an isolated dbus-daemon"]
    fn private_bus_inhibitor_conceal_release_resume_and_loss() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
            sync::mpsc,
            time::Duration,
        };
        struct Bus(std::process::Child);
        impl Drop for Bus {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut bus = Bus(Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("private dbus-daemon"));
        let mut address = String::new();
        BufReader::new(bus.0.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        let address = address.trim().to_owned();
        let flags = gio::DBusConnectionFlags::AUTHENTICATION_CLIENT
            | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION;
        let server =
            gio::DBusConnection::for_address_sync(&address, flags, None, gio::Cancellable::NONE)
                .unwrap();
        let client =
            gio::DBusConnection::for_address_sync(&address, flags, None, gio::Cancellable::NONE)
                .unwrap();
        let owner = server.unique_name().unwrap().to_string();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (calls_tx, calls_rx) = mpsc::channel();
        let serving = std::thread::spawn(move || {
            let context = glib::MainContext::new();
            context.with_thread_default(|| {
                let xml = "<node><interface name='org.freedesktop.login1.Manager'><method name='Inhibit'><arg type='s' direction='in'/><arg type='s' direction='in'/><arg type='s' direction='in'/><arg type='s' direction='in'/><arg type='h' direction='out'/></method></interface></node>";
                let node = gio::DBusNodeInfo::for_xml(xml).unwrap();
                let registration = server.register_object(PATH, &node.lookup_interface(MANAGER).unwrap(),
                    move |_, _, _, _, method, args, invocation| {
                        let valid = method == "Inhibit" && args.get::<(String, String, String, String)>()
                            .is_some_and(|(what, who, why, mode)| what == "sleep" && !who.is_empty() && !why.is_empty() && mode == "delay");
                        calls_tx.send(valid).unwrap();
                        let file = std::fs::File::open("/dev/null").unwrap();
                        let fds = gio::UnixFDList::from_array([file]);
                        invocation.return_value_with_unix_fd_list(Some(&(Handle(0),).to_variant()), Some(&fds));
                    }, |_, _, _, _, _| false.to_variant(), |_, _, _, _, _, _| false).unwrap();
                let main_loop = glib::MainLoop::new(Some(&context), false);
                ready_tx.send(main_loop.clone()).unwrap();
                main_loop.run();
                server.unregister_object(registration).unwrap();
            }).unwrap();
        });
        let main_loop = ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let fd = inhibit(&client, &owner).expect("received delay inhibitor FD");
        assert!(calls_rx.recv_timeout(Duration::from_secs(2)).unwrap());
        let a = Rc::new(RefCell::new(Adapter {
            connection: client.clone(),
            owner,
            inhibitor: Some(fd),
            caps: Capabilities {
                session_lock: true,
                sleep: true,
            },
            cycle: Cycle::default(),
        }));
        let count = std::cell::Cell::new(0);
        sleep_with(
            &a,
            true,
            true,
            || {
                assert!(
                    a.borrow().inhibitor.is_some(),
                    "inhibitor released before concealment"
                );
                count.set(count.get() + 1);
            },
            |_| {},
        );
        assert!(a.borrow().inhibitor.is_none());
        assert_eq!(count.get(), 1);
        sleep_with(
            &a,
            true,
            true,
            || panic!("duplicate sleep concealed twice"),
            |_| {},
        );
        sleep_with(
            &a,
            false,
            true,
            || panic!("resume changed lock state"),
            |caps| assert!(caps.sleep),
        );
        assert!(a.borrow().inhibitor.is_some());
        assert!(calls_rx.recv_timeout(Duration::from_secs(2)).unwrap());
        sleep_with(
            &a,
            true,
            false,
            || panic!("disabled policy concealed"),
            |_| {},
        );
        assert!(
            a.borrow().inhibitor.is_none(),
            "disabled policy must not hold up sleep"
        );
        client.close_sync(gio::Cancellable::NONE).unwrap();
        sleep_with(
            &a,
            false,
            true,
            || panic!("lost connection concealed"),
            |caps| assert_eq!(caps, Capabilities::default()),
        );
        assert!(a.borrow().cycle.disconnected);
        main_loop.quit();
        serving.join().unwrap();
    }
}
