// app/shell-tauri/src-tauri/src/store/crash_child.rs
// The child half of the SIGKILL test. Two modes:
//   durable  — flush through the store, THEN acknowledge on stdout
//   control  — acknowledge FIRST, commit after; must lose data under SIGKILL
// The control is not optional. Two fault-rig runs once reported PASS on both
// backends while testing nothing at all, and the only thing that would have
// caught it is a control that must fail.
use super::{FlushEntry, Store};
use std::io::Write;
use std::path::Path;

pub fn run(db: &Path, mode: &str, count: usize) -> ! {
    let store = match Store::open(db) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("crash-child: {e}");
            std::process::exit(1);
        }
    };
    store
        .conn
        .execute(
            "INSERT INTO item (id, parent_id, type, title, position, rev)
             VALUES ('c1', NULL, 'scene', 'Crash', '0000', 1)",
            [],
        )
        .ok();

    let mut rev = 0i64;
    for n in 0..count {
        let body = format!("body-{n}");
        let entry = FlushEntry {
            item_id: "c1".into(),
            body,
            base_rev: rev,
            comments: None,
        };
        if mode == "control" {
            // Acknowledge before the data is anywhere. Under SIGKILL this loses
            // acknowledged writes, which is exactly what must happen. The sleep
            // widens the exposure window so the kill lands inside it reliably.
            println!("ack {n}");
            let _ = std::io::stdout().flush();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        match store.flush(&[entry]) {
            Ok(acks) => rev = acks[0].rev,
            Err(e) => {
                eprintln!("crash-child flush: {e}");
                std::process::exit(1);
            }
        }
        if mode != "control" {
            println!("ack {n}");
            let _ = std::io::stdout().flush();
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // Never returns normally in the test: the parent kills it.
    std::thread::sleep(std::time::Duration::from_secs(60));
    std::process::exit(0);
}
