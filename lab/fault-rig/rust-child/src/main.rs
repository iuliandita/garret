// lab/fault-rig/rust-child/src/main.rs
//
// Disposable child writer for the Q3 rusqlite spot-check. It is a deliberate
// re-implementation of `lab/fault-rig/src/backend-sqlite.ts` against a second
// SQLite binding: same schema, same pragmas, same per-op delta writes, same
// stdout protocol. If a verdict differs from the `bun:sqlite` candidate, the
// binding is implicated; that is the whole point of running it.
use rusqlite::{Connection, params};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

// Truly synchronous write to fd 1: the ACK ledger is the basis of REGRESSION
// detection, so a line must reach the pipe before SIGKILL can land. Mirrors the
// `writeSync` in child.ts — a buffered writer could drop trailing ACKs.
fn emit(line: &str) {
    let mut out = std::io::stdout().lock();
    out.write_all(line.as_bytes()).expect("write to fd 1");
    out.write_all(b"\n").expect("write to fd 1");
    out.flush().expect("flush fd 1");
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_millis()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditOp {
    seq: i64,
    kind: String,
    scene_id: Option<String>,
    text: Option<String>,
    from_order: Option<usize>,
    to_order: Option<usize>,
    asset_name: Option<String>,
    asset_hash: Option<String>,
}

#[derive(Clone, Default)]
struct ProjectState {
    scenes: BTreeMap<String, String>,
    order: Vec<String>,
    assets: BTreeMap<String, String>,
    version: i64,
}

// Port of refmodel.applyPure. The JS `splice` edge cases are load-bearing: an
// out-of-range `fromOrder` removes nothing (the op is a no-op), and a `toOrder`
// past the end clamps to the end. The workload draws both indices from the
// fixture scene count, which is larger than `order` early in a run, so these
// paths are hit on every seed.
fn apply_pure(state: &ProjectState, op: &EditOp) -> ProjectState {
    let mut next = state.clone();
    match op.kind.as_str() {
        "type" => {
            let id = op.scene_id.clone().expect("type op without sceneId");
            let text = op.text.clone().unwrap_or_default();
            next.scenes.entry(id.clone()).or_default().push_str(&text);
            if !next.order.contains(&id) {
                next.order.push(id);
            }
        }
        "reorder" => {
            let from = op.from_order.expect("reorder op without fromOrder");
            let to = op.to_order.expect("reorder op without toOrder");
            if from < next.order.len() {
                let moved = next.order.remove(from);
                let at = to.min(next.order.len());
                next.order.insert(at, moved);
            }
        }
        "import-asset" => {
            next.assets.insert(
                op.asset_name.clone().expect("import-asset without assetName"),
                op.asset_hash.clone().expect("import-asset without assetHash"),
            );
        }
        "migrate" => next.version += 1,
        "snapshot" => {} // durability barrier only; no state change
        other => panic!("unknown op kind: {other}"),
    }
    next
}

fn read_state(conn: &Connection) -> ProjectState {
    let mut state = ProjectState::default();
    {
        let mut stmt = conn
            .prepare("SELECT id, text FROM scenes ORDER BY ord")
            .expect("prepare scenes read");
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .expect("query scenes");
        for row in rows {
            let (id, text) = row.expect("scene row");
            state.scenes.insert(id.clone(), text);
            state.order.push(id);
        }
    }
    {
        let mut stmt = conn
            .prepare("SELECT name, hash FROM assets")
            .expect("prepare assets read");
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .expect("query assets");
        for row in rows {
            let (name, hash) = row.expect("asset row");
            state.assets.insert(name, hash);
        }
    }
    state.version = conn
        .query_row("SELECT v FROM meta WHERE k = 'version'", [], |r| {
            r.get::<_, String>(0)
        })
        .map(|v| v.parse::<i64>().unwrap_or(0))
        .unwrap_or(0);
    state
}

// Apply one op as the smallest set of row writes that reaches `target`, inside
// one transaction. Writing only the delta is the whole argument for a database
// encoding, so the spot-check must not rewrite the manuscript per commit either.
fn write_delta(
    conn: &mut Connection,
    prev: &ProjectState,
    target: &ProjectState,
    op: &EditOp,
) {
    let tx = conn.transaction().expect("begin transaction");
    match op.kind.as_str() {
        "type" => {
            let id = op.scene_id.as_ref().expect("type op without sceneId");
            let ord = target
                .order
                .iter()
                .position(|s| s == id)
                .expect("typed scene missing from order") as i64;
            tx.execute(
                "INSERT INTO scenes (id, text, ord) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(id) DO UPDATE SET text = excluded.text, ord = excluded.ord",
                params![id, target.scenes.get(id).map(String::as_str).unwrap_or(""), ord],
            )
            .expect("write scene");
        }
        "reorder" => {
            // Only the scenes whose position actually moved are rewritten.
            for (i, id) in target.order.iter().enumerate() {
                if prev.order.get(i) != Some(id) {
                    tx.execute(
                        "UPDATE scenes SET ord = ?1 WHERE id = ?2",
                        params![i as i64, id],
                    )
                    .expect("write scene order");
                }
            }
        }
        "import-asset" => {
            tx.execute(
                "INSERT INTO assets (name, hash) VALUES (?1, ?2) \
                 ON CONFLICT(name) DO UPDATE SET hash = excluded.hash",
                params![
                    op.asset_name.as_ref().expect("import-asset without assetName"),
                    op.asset_hash.as_ref().expect("import-asset without assetHash")
                ],
            )
            .expect("write asset");
        }
        "migrate" => {
            tx.execute(
                "INSERT OR REPLACE INTO meta (k, v) VALUES ('version', ?1)",
                params![target.version.to_string()],
            )
            .expect("write version");
        }
        "snapshot" => {} // durability barrier only: the commit below is the point
        other => panic!("unknown op kind: {other}"),
    }
    tx.commit().expect("commit"); // durable: synchronous = FULL
}

fn open_db(project_dir: &str) -> Connection {
    std::fs::create_dir_all(project_dir).expect("create project dir");
    let conn = Connection::open(Path::new(project_dir).join("project.db"))
        .expect("open project.db");
    // Identical to backend-sqlite.ts. `journal_mode` returns a row, so it has to
    // go through query_row rather than execute_batch.
    let mode: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .expect("set journal_mode");
    assert_eq!(mode.to_lowercase(), "wal", "WAL mode not honoured");
    conn.execute_batch(
        "PRAGMA synchronous = FULL;
         CREATE TABLE IF NOT EXISTS scenes (id TEXT PRIMARY KEY, text TEXT, ord INTEGER);
         CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, hash TEXT);
         CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);",
    )
    .expect("apply pragmas and schema");
    conn
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Recorded alongside the verdicts: a SQLite version gap would explain a
    // divergence without implicating either binding.
    if args.get(1).map(String::as_str) == Some("--sqlite-version") {
        println!("{}", rusqlite::version());
        return;
    }
    let (project_dir, workload_path) = match (args.get(1), args.get(2)) {
        (Some(d), Some(w)) => (d.clone(), w.clone()),
        _ => {
            eprintln!("usage: fault-rig-rust-child <projectDir> <workloadJson>");
            std::process::exit(2);
        }
    };

    let raw = std::fs::read_to_string(&workload_path).expect("read workload");
    let ops: Vec<EditOp> = serde_json::from_str(&raw).expect("parse workload");

    let mut conn = open_db(&project_dir);
    let mut state = read_state(&conn);

    for op in &ops {
        let next = apply_pure(&state, op);
        emit(&format!("MARK {} begin-txn", op.seq));
        write_delta(&mut conn, &state, &next, op);
        emit(&format!("MARK {} fsync", op.seq));
        // WAL checkpoint makes the commit durable in the main db file.
        conn.execute_batch("PRAGMA wal_checkpoint(FULL);")
            .expect("checkpoint");
        emit(&format!("MARK {} rename", op.seq));
        state = next;
        emit(&format!("MARK {} commit-done", op.seq));
        emit(&format!("ACK {} {}", op.seq, now_ms()));
    }
    conn.close().expect("close db");
    emit("DONE");
}
