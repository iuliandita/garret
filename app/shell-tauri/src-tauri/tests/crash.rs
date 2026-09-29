// Integration test: SIGKILL a writing child, reopen, and require that every
// ACKNOWLEDGED write survived.
//
// SCOPE: this proves ATOMICITY, not fsync durability. SIGKILL leaves the kernel
// and page cache intact. Power-loss evidence for SQLite comes from a
// root-gated dm-flakey path and is not re-derived here. A green run of this
// test is not a power-loss result.
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_garret")
}

/// Runs the child in `mode`, kills it after `kill_after` acknowledgements, and
/// returns (last acknowledged index, body found in the reopened database).
fn run_and_kill(db: &Path, mode: &str, kill_after: usize) -> (usize, Option<String>) {
    let mut child = Command::new(binary())
        .args(["--crash-child", db.to_str().unwrap(), mode, "500"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn crash child");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut last = 0usize;
    let mut seen = 0usize;
    for line in BufReader::new(stdout).lines() {
        let line = line.unwrap_or_default();
        if let Some(n) = line.strip_prefix("ack ") {
            last = n.parse().unwrap_or(0);
            seen += 1;
            if seen >= kill_after {
                break;
            }
        }
    }
    // SIGKILL: no destructors, no flush, no chance to clean up.
    let _ = child.kill();
    let _ = child.wait();

    let conn = rusqlite::Connection::open(db).expect("reopen");
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .expect("integrity_check");
    assert_eq!(integrity, "ok", "database corrupt after SIGKILL");

    let body = conn
        .query_row("SELECT body FROM doc WHERE item_id = 'c1'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok();
    (last, body)
}

#[test]
fn acknowledged_writes_survive_sigkill() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("durable.db");
    let (last, body) = run_and_kill(&db, "durable", 40);
    assert_eq!(
        body.as_deref(),
        Some(format!("body-{last}").as_str()),
        "the last acknowledged write is missing after SIGKILL"
    );
}

#[test]
fn the_negative_control_loses_acknowledged_writes() {
    // If this passes, the test above proves nothing: a rig that cannot lose
    // data cannot demonstrate that the real path does not.
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("control.db");
    let (last, body) = run_and_kill(&db, "control", 40);

    // A row must EXIST and be strictly behind the last ack. Row-missing and
    // never-inserted would both satisfy a bare assert_ne!, and neither
    // demonstrates "an acknowledged write was lost".
    let body = body.expect(
        "control lost the whole doc row, not just an acknowledged write; \
         the child's setup is broken, so this control demonstrates nothing",
    );
    let acked = format!("body-{last}");
    assert_ne!(
        body, acked,
        "the ack-before-commit control survived; the crash test cannot \
         distinguish a durable write path from a broken one, so its PASS is meaningless"
    );
    let stored_n: usize = body
        .strip_prefix("body-")
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("unexpected stored body {body:?}"));
    assert!(
        stored_n < last,
        "stored body {stored_n} is not behind the last ack {last}"
    );
}
