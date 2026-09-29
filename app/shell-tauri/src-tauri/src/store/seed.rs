// app/shell-tauri/src-tauri/src/store/seed.rs
// Builds a project from lab's GENERATED fixture output. Reading that data by
// path is how fixtures cross the freeze boundary; importing lab source is not.
// Seeding goes through this binary and not the TypeScript harness so the schema
// exists in exactly one language.

use super::position::seeded_position;
use super::{now_ms, Result, Store, StoreError, BIBLE_TYPE, TIMELINE_TYPE};
use crate::store::cast::CAST_KINDS;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Deserialize)]
struct FixtureProject {
    meta: FixtureMeta,
    items: Vec<FixtureItem>,
}

#[derive(Deserialize)]
struct FixtureMeta {
    seed: String,
    /// The book's name, written to the store's `project_name` row when
    /// present (094: the sample is a real book and the outline header should
    /// say so). lab's fixtures carry a name too, but theirs is the fixture's
    /// own ("tiny"), which is what every rig has always shown; absent, the
    /// header keeps naming the file.
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct FixtureItem {
    id: String,
    #[serde(rename = "type")]
    item_type: String,
    title: String,
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
}

#[derive(Deserialize)]
struct FixtureScene {
    id: String,
    #[serde(default)]
    blocks: Vec<FixtureBlock>,
    /// A whole ProseMirror document, straight from the generator's own
    /// `import` run rather than reconstructed from flat text. WINS OVER
    /// `blocks` when both are present, and is the only route by which a
    /// seeded body can carry MARKS: `pm_doc` below only ever emits bare
    /// paragraphs, so a bible note's `*em*`/`**strong**` would be silently
    /// flattened to plain text if this fell back to `blocks` instead.
    body: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct FixtureBlock {
    text: String,
}

/// One `cast.ndjson` line. Optional file: its absence means no row here seeds
/// a cast member, exactly as an absent `scenes.ndjson` body seeds no doc.
#[derive(Deserialize)]
struct FixtureCastMember {
    kind: String,
    name: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    fields: Vec<FixtureCastField>,
    /// Absent means none, `cast.ndjson`'s own rule for `fields` and `summary`.
    /// Run through `cast::normalise_aliases` before it is written, so a
    /// short alias fails the seed loudly rather than landing in a file
    /// `cast_set` would have refused to write.
    #[serde(default)]
    aliases: Vec<String>,
}

#[derive(Deserialize)]
struct FixtureCastField {
    label: String,
    value: String,
}

/// One `synopses.ndjson` line.
#[derive(Deserialize)]
struct FixtureSynopsis {
    #[serde(rename = "itemId")]
    item_id: String,
    body: String,
}

/// One `appearances.ndjson` line. `members` names cast members BY NAME, not by
/// id: the generator does not know the ids `cast_create` will hand out, so the
/// seeder resolves each name against the map it built while seeding
/// `cast.ndjson`, in the same pass.
#[derive(Deserialize)]
struct FixtureAppearance {
    #[serde(rename = "itemId")]
    item_id: String,
    members: Vec<String>,
}

/// One `timelines.ndjson` line. UNLIKE `synopses.ndjson`, `item_id` is not one
/// of `project.json`'s own items: a timeline has no place in that list at all,
/// so this
/// carries the id, the title and the whole body of a NEW item this seeder
/// creates under the bible, in the file's own order.
#[derive(Deserialize)]
struct FixtureTimeline {
    id: String,
    title: String,
    body: serde_json::Value,
}

fn pm_doc(blocks: &[FixtureBlock]) -> serde_json::Value {
    let paragraphs: Vec<serde_json::Value> = blocks
        .iter()
        .filter(|b| !b.text.is_empty())
        .map(|b| {
            serde_json::json!({
                "type": "paragraph",
                "content": [{ "type": "text", "text": b.text }]
            })
        })
        .collect();
    if paragraphs.is_empty() {
        serde_json::json!({ "type": "doc", "content": [{ "type": "paragraph" }] })
    } else {
        serde_json::json!({ "type": "doc", "content": paragraphs })
    }
}

/// `sample-build.ts` cannot know a cast member's id (it is minted by
/// `cast_create` right above, in this same pass) so a timeline's body still
/// carries cast members BY NAME under `tracks[].memberId` (cast-kind tracks)
/// and `events[].cast` -- exactly as `appearances.ndjson`'s `members` does,
/// resolved the same way and in the same pass. An unknown name fails the
/// seed rather than storing a `memberId` no cast member will ever match.
fn resolve_timeline_cast_names(
    body: &mut serde_json::Value,
    cast_name_to_id: &HashMap<String, String>,
) -> std::result::Result<(), String> {
    if let Some(tracks) = body.get_mut("tracks").and_then(|v| v.as_array_mut()) {
        for track in tracks {
            let is_cast = track.get("kind").and_then(|k| k.as_str()) == Some("cast");
            if !is_cast {
                continue;
            }
            let Some(name) = track
                .get("memberId")
                .and_then(|v| v.as_str())
                .map(str::to_string)
            else {
                continue;
            };
            let Some(id) = cast_name_to_id.get(&name) else {
                return Err(format!(
                    "timeline track names {name:?}, which matches no cast member"
                ));
            };
            track["memberId"] = serde_json::Value::String(id.clone());
        }
    }
    if let Some(events) = body.get_mut("events").and_then(|v| v.as_array_mut()) {
        for event in events {
            let Some(cast) = event.get_mut("cast").and_then(|v| v.as_array_mut()) else {
                continue;
            };
            for member in cast.iter_mut() {
                let Some(name) = member.as_str().map(str::to_string) else {
                    continue;
                };
                let Some(id) = cast_name_to_id.get(&name) else {
                    return Err(format!(
                        "timeline event names {name:?}, which matches no cast member"
                    ));
                };
                *member = serde_json::Value::String(id.clone());
            }
        }
    }
    Ok(())
}

/// Returns the number of items written.
pub fn seed_project(fixture_dir: &Path, db_path: &Path) -> Result<usize> {
    let raw = fs::read_to_string(fixture_dir.join("project.json")).map_err(|e| {
        StoreError::Seed(format!(
            "reading {}: {e}",
            fixture_dir.join("project.json").display()
        ))
    })?;
    let project: FixtureProject = serde_json::from_str(&raw)
        .map_err(|e| StoreError::Seed(format!("parsing project.json: {e}")))?;

    if project.items.is_empty() {
        return Err(StoreError::Seed(
            "fixture has no items: seeding an empty project would pass every check vacuously"
                .into(),
        ));
    }

    // The whole corpus is held in memory deliberately: this is a one-shot CLI
    // that exits, not a long-lived process. Measured 126 MB peak RSS on the
    // stress fixture (11.8 MB of ndjson text, ~11x blowup from per-node
    // serde_json::Value overhead) — acceptable here, would not be elsewhere.
    let mut bodies: HashMap<String, serde_json::Value> = HashMap::new();
    let scenes = fs::read_to_string(fixture_dir.join("scenes.ndjson")).map_err(|e| {
        StoreError::Seed(format!(
            "reading {}: {e}",
            fixture_dir.join("scenes.ndjson").display()
        ))
    })?;
    for (n, line) in scenes.lines().enumerate().filter(|(_, l)| !l.is_empty()) {
        let scene: FixtureScene = serde_json::from_str(line)
            .map_err(|e| StoreError::Seed(format!("parsing scenes.ndjson line {}: {e}", n + 1)))?;
        let doc = scene.body.unwrap_or_else(|| pm_doc(&scene.blocks));
        bodies.insert(scene.id, doc);
    }

    let store = Store::open(db_path)?;
    store.conn.execute_batch("BEGIN IMMEDIATE")?;

    let already_seeded: i64 = store
        .conn
        .query_row("SELECT count(*) FROM item", [], |r| r.get(0))
        .map_err(|e| {
            let _ = store.conn.execute_batch("ROLLBACK");
            StoreError::from(e)
        })?;
    if already_seeded > 0 {
        let _ = store.conn.execute_batch("ROLLBACK");
        return Err(StoreError::Seed(format!(
            "{} is already seeded; refusing to overwrite",
            db_path.display()
        )));
    }

    if let Err(e) = store.conn.execute(
        "INSERT INTO meta (key, value) VALUES ('seed', ?1)",
        [&project.meta.seed],
    ) {
        let _ = store.conn.execute_batch("ROLLBACK");
        return Err(e.into());
    }
    if let Some(name) = project
        .meta
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        if let Err(e) = store.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            rusqlite::params![crate::projects::NAME_KEY, name],
        ) {
            let _ = store.conn.execute_batch("ROLLBACK");
            return Err(e.into());
        }
    }
    // Number siblings within their own group, using the group's array order.
    // The fixture's `order` field is deliberately NOT read: it is a per-kind
    // counter (the generator numbers parts, chapters, scenes and docs
    // independently), so it collides across kinds that share a parent — 570 of
    // the stress fixture's 1,570 root values collide, because 570 parts and
    // 1,000 loose docs are both numbered from 0. Sorting by it interleaves
    // them. Array order inside a group is the generator's emission order and
    // has no collisions. Note this is order *within* a group: the original bug
    // used the GLOBAL array index as the ordinal, which is a different thing
    // and still wrong.
    let mut by_parent: HashMap<Option<&str>, Vec<&FixtureItem>> = HashMap::new();
    for item in &project.items {
        by_parent
            .entry(item.parent_id.as_deref())
            .or_default()
            .push(item);
    }
    let mut positions: HashMap<&str, String> = HashMap::new();
    for group in by_parent.values() {
        for (ordinal, item) in group.iter().enumerate() {
            let position = match seeded_position(ordinal as u64) {
                Ok(p) => p,
                Err(e) => {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(StoreError::Seed(e));
                }
            };
            positions.insert(item.id.as_str(), position);
        }
    }

    // Insert parents before children: parent_id is a foreign key and
    // foreign_keys is ON, so a child inserted first is rejected. Fixture array
    // order does not guarantee parents come first.
    let mut ordered: Vec<&FixtureItem> = Vec::with_capacity(project.items.len());
    let mut pending: Vec<&FixtureItem> = project.items.iter().collect();
    let mut placed: std::collections::HashSet<&str> = std::collections::HashSet::new();
    while !pending.is_empty() {
        let before = pending.len();
        pending.retain(|item| {
            let ready = match item.parent_id.as_deref() {
                None => true,
                Some(p) => placed.contains(p),
            };
            if ready {
                ordered.push(item);
                placed.insert(item.id.as_str());
            }
            !ready
        });
        if pending.len() == before {
            let _ = store.conn.execute_batch("ROLLBACK");
            return Err(StoreError::Seed(format!(
                "{} item(s) have a parentId that names no item in the fixture, or form a cycle",
                pending.len()
            )));
        }
    }

    for item in ordered {
        let position = positions
            .get(item.id.as_str())
            .expect("every item was assigned a position above");
        if let Err(e) = store.conn.execute(
            "INSERT INTO item (id, parent_id, type, title, position, rev)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)",
            rusqlite::params![
                item.id,
                item.parent_id,
                item.item_type,
                item.title,
                position
            ],
        ) {
            let _ = store.conn.execute_batch("ROLLBACK");
            return Err(e.into());
        }
        if let Some(body) = bodies.get(&item.id) {
            if let Err(e) = store.conn.execute(
                "INSERT INTO doc (item_id, body, rev, updated_at) VALUES (?1, ?2, 1, 0)",
                rusqlite::params![item.id, body.to_string()],
            ) {
                let _ = store.conn.execute_batch("ROLLBACK");
                return Err(e.into());
            }
        }
    }
    // ---------------------------------------------------------------- cast
    // OPTIONAL: a fixture carrying no `cast.ndjson` seeds an empty cast table,
    // exactly as every fixture did before this -- `lab/fixtures/out/*` never
    // carries this file.
    //
    // RAW SQL, NOT `Store::cast_create`/`cast_set`. Those commands open their
    // OWN `BEGIN IMMEDIATE`/`COMMIT`, and nesting one inside the transaction
    // already open here is a SQLite error ("cannot start a transaction within
    // a transaction") that would abort the whole seed rather than seed the
    // cast. The row shapes below are restated from those commands rather than
    // shared, which is this file's existing rule for `item` and `doc` too.
    //
    // NAMES ARE KEPT, NOT IDS: the id `cast_create` would have handed out does
    // not exist yet when `cast.ndjson` is written (the generator has no
    // project to create it in), so `appearances.ndjson` below names a member
    // by NAME and this map is what resolves it.
    // Items this pass creates that are not among `project.json`'s own --
    // today, only the timelines below (and the bible root, if none existed).
    // Added to `project.items.len()` in the return so the figure stays "the
    // number of items written" rather than silently becoming "the number of
    // items project.json named".
    let mut extra_items = 0usize;

    let cast_path = fixture_dir.join("cast.ndjson");
    let mut cast_name_to_id: HashMap<String, String> = HashMap::new();
    if cast_path.exists() {
        let raw = match fs::read_to_string(&cast_path) {
            Ok(s) => s,
            Err(e) => {
                let _ = store.conn.execute_batch("ROLLBACK");
                return Err(StoreError::Seed(format!(
                    "reading {}: {e}",
                    cast_path.display()
                )));
            }
        };
        for (n, line) in raw.lines().enumerate().filter(|(_, l)| !l.is_empty()) {
            let member: FixtureCastMember = match serde_json::from_str(line) {
                Ok(m) => m,
                Err(e) => {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(StoreError::Seed(format!(
                        "parsing cast.ndjson line {}: {e}",
                        n + 1
                    )));
                }
            };
            if !CAST_KINDS.contains(&member.kind.as_str()) {
                let _ = store.conn.execute_batch("ROLLBACK");
                return Err(StoreError::Seed(format!(
                    "cast.ndjson line {}: {:?} is not one of {CAST_KINDS:?}",
                    n + 1,
                    member.kind
                )));
            }
            let name = member.name.trim().to_string();
            if name.is_empty() {
                let _ = store.conn.execute_batch("ROLLBACK");
                return Err(StoreError::Seed(format!(
                    "cast.ndjson line {}: an empty name",
                    n + 1
                )));
            }
            let id = uuid::Uuid::now_v7().to_string();
            let now = now_ms();
            if let Err(e) = store.conn.execute(
                "INSERT INTO cast_member (id, kind, name, summary, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                rusqlite::params![id, member.kind, name, member.summary.trim(), now],
            ) {
                let _ = store.conn.execute_batch("ROLLBACK");
                return Err(e.into());
            }
            for (ordinal, field) in member.fields.iter().enumerate() {
                if let Err(e) = store.conn.execute(
                    "INSERT INTO cast_field (member_id, ordinal, label, value)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![id, ordinal as i64, field.label.trim(), field.value.trim()],
                ) {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(e.into());
                }
            }
            // DECIDED BEFORE ANY ROW MOVES, `cast_set`'s own rule: the same
            // check that would refuse a short, repeated or name-shaped alias
            // on the page's Save must refuse one here, or a fixture could
            // carry data `cast_set` would never have written.
            let aliases = match crate::store::cast::normalise_aliases(&member.aliases, &name) {
                Ok(a) => a,
                Err(e) => {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(StoreError::Seed(format!("cast.ndjson line {}: {e}", n + 1)));
                }
            };
            for (ordinal, alias) in aliases.iter().enumerate() {
                if let Err(e) = store.conn.execute(
                    "INSERT INTO cast_alias (member_id, ordinal, alias)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![id, ordinal as i64, alias],
                ) {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(e.into());
                }
            }
            cast_name_to_id.insert(name, id);
        }
    }

    // ------------------------------------------------------------ synopses
    // OPTIONAL, keyed by the fixture's own item id -- `synopses.ndjson` is
    // written by the same generator pass that writes `project.json`, so no
    // name resolution is needed here the way `appearances.ndjson` needs one
    // for the cast.
    let synopses_path = fixture_dir.join("synopses.ndjson");
    if synopses_path.exists() {
        let raw = match fs::read_to_string(&synopses_path) {
            Ok(s) => s,
            Err(e) => {
                let _ = store.conn.execute_batch("ROLLBACK");
                return Err(StoreError::Seed(format!(
                    "reading {}: {e}",
                    synopses_path.display()
                )));
            }
        };
        for (n, line) in raw.lines().enumerate().filter(|(_, l)| !l.is_empty()) {
            let syn: FixtureSynopsis = match serde_json::from_str(line) {
                Ok(s) => s,
                Err(e) => {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(StoreError::Seed(format!(
                        "parsing synopses.ndjson line {}: {e}",
                        n + 1
                    )));
                }
            };
            let now = now_ms();
            if let Err(e) = store.conn.execute(
                "INSERT INTO synopsis (item_id, body, rev, updated_at) VALUES (?1, ?2, 1, ?3)",
                rusqlite::params![syn.item_id, syn.body.trim(), now],
            ) {
                let _ = store.conn.execute_batch("ROLLBACK");
                return Err(e.into());
            }
        }
    }

    // --------------------------------------------------------- appearances
    // OPTIONAL. Runs AFTER the cast loop above, which is load-bearing: a
    // member's id does not exist until that loop has created it, so this is
    // the earliest point `members` (cast NAMES) can be resolved at all.
    let appearances_path = fixture_dir.join("appearances.ndjson");
    if appearances_path.exists() {
        let raw = match fs::read_to_string(&appearances_path) {
            Ok(s) => s,
            Err(e) => {
                let _ = store.conn.execute_batch("ROLLBACK");
                return Err(StoreError::Seed(format!(
                    "reading {}: {e}",
                    appearances_path.display()
                )));
            }
        };
        for (n, line) in raw.lines().enumerate().filter(|(_, l)| !l.is_empty()) {
            let appearance: FixtureAppearance = match serde_json::from_str(line) {
                Ok(a) => a,
                Err(e) => {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(StoreError::Seed(format!(
                        "parsing appearances.ndjson line {}: {e}",
                        n + 1
                    )));
                }
            };
            for member_name in &appearance.members {
                let Some(member_id) = cast_name_to_id.get(member_name) else {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(StoreError::Seed(format!(
                        "appearances.ndjson line {}: {member_name:?} matches no cast member",
                        n + 1
                    )));
                };
                if let Err(e) = store.conn.execute(
                    "INSERT OR IGNORE INTO appearance (item_id, cast_member_id) VALUES (?1, ?2)",
                    rusqlite::params![appearance.item_id, member_id],
                ) {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(e.into());
                }
            }
        }
    }

    // -------------------------------------------------------------- timelines
    // OPTIONAL, and ships EMPTY for the sample -- filled elsewhere. Each
    // line makes a NEW `timeline` item under the bible, never one of
    // `project.json`'s own: unlike a synopsis, a timeline has nowhere in that
    // list to belong.
    let timelines_path = fixture_dir.join("timelines.ndjson");
    if timelines_path.exists() {
        let raw = match fs::read_to_string(&timelines_path) {
            Ok(s) => s,
            Err(e) => {
                let _ = store.conn.execute_batch("ROLLBACK");
                return Err(StoreError::Seed(format!(
                    "reading {}: {e}",
                    timelines_path.display()
                )));
            }
        };
        let mut lines = raw.lines().filter(|l| !l.is_empty()).peekable();
        if lines.peek().is_some() {
            // The bible root, made if this fixture's own item list holds none
            // -- `note_in_bible`'s fallback (main.rs), restated here: a
            // fixture with a timeline and no note or synopsis is legal and
            // must not need one of those first.
            let bible_id: String = match store.conn.query_row(
                "SELECT id FROM item WHERE type = ?1 AND parent_id IS NULL
                  ORDER BY position LIMIT 1",
                [BIBLE_TYPE],
                |r| r.get(0),
            ) {
                Ok(id) => id,
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    let id = uuid::Uuid::now_v7().to_string();
                    // APPENDED AMONG THE ROOT ITEMS, never `seeded_position(0)`
                    // unconditionally -- `project.json`'s own roots already
                    // occupy the low end of that key space, and `item.position`
                    // carries a partial UNIQUE index over `parent_id IS NULL`
                    // that a second root at the seed floor collides with.
                    let last_root: Option<String> = match store.conn.query_row(
                        "SELECT position FROM item WHERE parent_id IS NULL ORDER BY position DESC LIMIT 1",
                        [],
                        |r| r.get(0),
                    ) {
                        Ok(p) => Some(p),
                        Err(rusqlite::Error::QueryReturnedNoRows) => None,
                        Err(e) => {
                            let _ = store.conn.execute_batch("ROLLBACK");
                            return Err(e.into());
                        }
                    };
                    let position = match match &last_root {
                        Some(k) => super::position::after(k),
                        None => seeded_position(0),
                    } {
                        Ok(p) => p,
                        Err(e) => {
                            let _ = store.conn.execute_batch("ROLLBACK");
                            return Err(StoreError::Seed(e));
                        }
                    };
                    if let Err(e) = store.conn.execute(
                        "INSERT INTO item (id, parent_id, type, title, position, rev)
                         VALUES (?1, NULL, ?2, 'Bible', ?3, 1)",
                        rusqlite::params![id, BIBLE_TYPE, position],
                    ) {
                        let _ = store.conn.execute_batch("ROLLBACK");
                        return Err(e.into());
                    }
                    extra_items += 1;
                    id
                }
                Err(e) => {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(e.into());
                }
            };
            for (n, line) in lines.enumerate() {
                let tl: FixtureTimeline = match serde_json::from_str(line) {
                    Ok(t) => t,
                    Err(e) => {
                        let _ = store.conn.execute_batch("ROLLBACK");
                        return Err(StoreError::Seed(format!(
                            "parsing timelines.ndjson line {}: {e}",
                            n + 1
                        )));
                    }
                };
                // Appended, following whatever the bible already holds --
                // `item_create`'s own rule, restated here because that
                // command opens its own transaction and cannot be called
                // inside this one.
                let last: Option<String> = match store.conn.query_row(
                    "SELECT position FROM item WHERE parent_id = ?1 ORDER BY position DESC LIMIT 1",
                    [&bible_id],
                    |r| r.get(0),
                ) {
                    Ok(p) => Some(p),
                    Err(rusqlite::Error::QueryReturnedNoRows) => None,
                    Err(e) => {
                        let _ = store.conn.execute_batch("ROLLBACK");
                        return Err(e.into());
                    }
                };
                let position = match match &last {
                    Some(k) => super::position::after(k),
                    None => seeded_position(0),
                } {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = store.conn.execute_batch("ROLLBACK");
                        return Err(StoreError::Seed(e));
                    }
                };
                let now = now_ms();
                if let Err(e) = store.conn.execute(
                    "INSERT INTO item (id, parent_id, type, title, position, rev)
                     VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                    rusqlite::params![tl.id, bible_id, TIMELINE_TYPE, tl.title, position],
                ) {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(e.into());
                }
                let mut resolved_body = tl.body;
                if let Err(msg) = resolve_timeline_cast_names(&mut resolved_body, &cast_name_to_id)
                {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(StoreError::Seed(msg));
                }
                let body = resolved_body.to_string();
                if let Err(e) = store.conn.execute(
                    "INSERT INTO doc (item_id, body, rev, updated_at) VALUES (?1, ?2, 1, ?3)",
                    rusqlite::params![tl.id, body, now],
                ) {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    return Err(e.into());
                }
                extra_items += 1;
            }
        }
    }

    store.conn.execute_batch("COMMIT")?;
    Ok(project.items.len() + extra_items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_fixture(dir: &std::path::Path) {
        fs::write(
            dir.join("project.json"),
            r#"{"meta":{"seed":"stress-v1"},"items":[
                 {"id":"it-1","type":"scene","parentId":null,"order":0,"title":"Alpha"},
                 {"id":"it-2","type":"scene","parentId":null,"order":1,"title":"Bravo"},
                 {"id":"it-3","type":"note","parentId":null,"order":2,"title":"A note"}
               ]}"#,
        )
        .unwrap();
        fs::write(
            dir.join("scenes.ndjson"),
            "{\"id\":\"it-1\",\"blocks\":[{\"type\":\"paragraph\",\"text\":\"hello\"}]}\n\
             {\"id\":\"it-2\",\"blocks\":[{\"type\":\"paragraph\",\"text\":\"world\"}]}\n",
        )
        .unwrap();
    }

    fn write_nested_fixture(dir: &std::path::Path) {
        fs::write(
            dir.join("project.json"),
            // Children deliberately precede their parents, so the array cannot
            // be inserted as-is under the parent_id foreign key. The `order`
            // values deliberately disagree with array order (c-1 is 5, c-3 is
            // 1): reading `order` would flip them, which is the per-kind
            // counter trap this fixture exists to catch.
            r#"{"meta":{"seed":"nested-v1"},"items":[
                 {"id":"s-1","type":"scene","parentId":"c-1","order":0,"title":"Sc 1"},
                 {"id":"c-1","type":"chapter","parentId":"p-1","order":5,"title":"Ch A"},
                 {"id":"c-3","type":"chapter","parentId":"p-1","order":1,"title":"Ch C"},
                 {"id":"p-1","type":"part","parentId":null,"order":0,"title":"Part One"},
                 {"id":"c-2","type":"chapter","parentId":"p-2","order":0,"title":"Ch B"},
                 {"id":"p-2","type":"part","parentId":null,"order":1,"title":"Part Two"}
               ]}"#,
        )
        .unwrap();
        fs::write(
            dir.join("scenes.ndjson"),
            "{\"id\":\"s-1\",\"blocks\":[{\"type\":\"paragraph\",\"text\":\"body\"}]}\n",
        )
        .unwrap();
    }

    #[test]
    fn siblings_are_numbered_per_parent_not_by_array_index() {
        let fixture = tempdir().unwrap();
        write_nested_fixture(fixture.path());
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");
        seed_project(fixture.path(), &db).unwrap();

        let store = Store::open(&db).unwrap();
        let conn = &store.conn;
        let pos = |id: &str| -> String {
            conn.query_row("SELECT position FROM item WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
        };
        let parent = |id: &str| -> Option<String> {
            conn.query_row("SELECT parent_id FROM item WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
        };

        // parent_id comes from the fixture, not NULL for everything.
        assert_eq!(parent("c-1").as_deref(), Some("p-1"));
        assert_eq!(parent("p-1"), None);

        // c-1 and c-3 are siblings under p-1, appearing in that array order.
        // Their `order` values are 5 and 1, so sorting by `order` inverts this.
        assert_eq!(pos("c-1"), seeded_position(0).unwrap());
        assert_eq!(pos("c-3"), seeded_position(1).unwrap());
        assert!(
            pos("c-1") < pos("c-3"),
            "c-1 {} < c-3 {}",
            pos("c-1"),
            pos("c-3")
        );

        // c-2 is the FIRST child of p-2, so it shares the first sibling key with
        // c-1 — which is only possible if numbering is per-parent. Numbering by
        // global array index would give c-2 a key after both of p-1's children.
        assert_eq!(pos("c-2"), pos("c-1"));

        // The array lists every child before its parent, so this only holds if
        // the insert order was topologically sorted.
        assert_eq!(parent("s-1").as_deref(), Some("c-1"));
        assert_eq!(store.items().unwrap().len(), 6);
    }

    #[test]
    fn a_parent_id_naming_no_item_is_refused_and_writes_nothing() {
        let fixture = tempdir().unwrap();
        fs::write(
            fixture.path().join("project.json"),
            r#"{"meta":{"seed":"dangling-v1"},"items":[
                 {"id":"p-1","type":"part","parentId":null,"title":"Part One"},
                 {"id":"x","type":"chapter","parentId":"nope","title":"Orphan"}
               ]}"#,
        )
        .unwrap();
        fs::write(fixture.path().join("scenes.ndjson"), "").unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");
        match seed_project(fixture.path(), &db) {
            Err(StoreError::Seed(msg)) => assert!(msg.contains("names no item"), "{msg}"),
            other => panic!("expected Seed error, got {other:?}"),
        }
        // Store::open creates the file, so erroring proves nothing on its own:
        // the rollback has to leave the project genuinely empty.
        let store = Store::open(&db).unwrap();
        assert_eq!(store.items().unwrap().len(), 0);
    }

    #[test]
    fn seeding_preserves_fixture_ids_and_orders_by_position() {
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        let count = seed_project(fixture.path(), &db).unwrap();
        assert_eq!(count, 3);

        let store = Store::open(&db).unwrap();
        let items = store.items().unwrap();
        // Fixture ids verbatim: a seeded project must stay reproducible and
        // diffable against the corpus.json path.
        assert_eq!(items[0].id, "it-1");
        assert!(items[0].position < items[1].position);
    }

    #[test]
    fn scene_bodies_become_prosemirror_documents() {
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");
        seed_project(fixture.path(), &db).unwrap();

        let store = Store::open(&db).unwrap();
        let doc: serde_json::Value =
            serde_json::from_str(&store.load_doc("it-1").unwrap().body).unwrap();
        assert_eq!(doc["type"], "doc");
        assert_eq!(doc["content"][0]["type"], "paragraph");
        assert_eq!(doc["content"][0]["content"][0]["text"], "hello");
    }

    #[test]
    fn a_non_scene_item_gets_no_document() {
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");
        seed_project(fixture.path(), &db).unwrap();

        let store = Store::open(&db).unwrap();
        assert!(store.load_doc("it-3").is_err());
    }

    #[test]
    fn re_seeding_an_existing_project_is_refused_with_an_intelligible_error() {
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");
        seed_project(fixture.path(), &db).unwrap();
        match seed_project(fixture.path(), &db) {
            Err(StoreError::Seed(msg)) => assert!(msg.contains("already seeded"), "{msg}"),
            other => panic!("expected Seed error, got {other:?}"),
        }
        // The existing project must be untouched.
        let store = Store::open(&db).unwrap();
        assert_eq!(store.items().unwrap().len(), 3);
    }

    #[test]
    fn seeding_an_empty_fixture_is_an_error_not_an_empty_project() {
        let fixture = tempdir().unwrap();
        fs::write(
            fixture.path().join("project.json"),
            r#"{"meta":{"seed":"x"},"items":[]}"#,
        )
        .unwrap();
        fs::write(fixture.path().join("scenes.ndjson"), "").unwrap();
        let out = tempdir().unwrap();
        assert!(seed_project(fixture.path(), &out.path().join("p.db")).is_err());
    }

    #[test]
    fn a_fixture_with_none_of_the_optional_files_seeds_an_empty_cast_exactly_as_before() {
        // `lab/fixtures/out/*` never carries cast.ndjson, synopses.ndjson or
        // appearances.ndjson -- this is the claim that seeding one of them is
        // byte-for-byte the same seed it always was.
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        let count = seed_project(fixture.path(), &db).unwrap();

        assert_eq!(count, 3);
        let store = Store::open(&db).unwrap();
        assert_eq!(store.cast_list().unwrap().len(), 0);
        assert_eq!(store.appearance_count().unwrap(), 0);
        assert_eq!(store.synopsis_item_ids().unwrap(), Vec::<String>::new());
    }

    /// THE BOOK'S NAME TRAVELS: `meta.name` becomes the store's
    /// `project_name` row, so the outline header names the book and not the
    /// file. Absent, no row is written and the header keeps the file's name,
    /// which is what every lab fixture has always shown.
    #[test]
    fn the_fixtures_meta_name_becomes_the_project_name_row() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("project.json"),
            r#"{"meta":{"seed":"s","name":" The Salt Cartographer "},"items":[
                 {"id":"it-1","type":"scene","parentId":null,"order":0,"title":"Alpha"}]}"#,
        )
        .unwrap();
        fs::write(dir.path().join("scenes.ndjson"), "").unwrap();
        let db = dir.path().join("p.db");
        seed_project(dir.path(), &db).unwrap();
        let store = Store::open(&db).unwrap();
        let name: String = store
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [crate::projects::NAME_KEY],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "The Salt Cartographer");

        let bare = tempdir().unwrap();
        write_fixture(bare.path());
        let db2 = bare.path().join("p.db");
        seed_project(bare.path(), &db2).unwrap();
        let rows: i64 = Store::open(&db2)
            .unwrap()
            .conn
            .query_row(
                "SELECT count(*) FROM meta WHERE key = ?1",
                [crate::projects::NAME_KEY],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0, "a fixture without a name writes no name row");
    }

    #[test]
    fn a_scene_body_field_wins_over_blocks_and_keeps_its_marks() {
        // `pm_doc` only ever emits bare paragraphs, so a mark surviving is
        // proof `body` was used rather than `blocks` being re-derived from it.
        let fixture = tempdir().unwrap();
        fs::write(
            fixture.path().join("project.json"),
            r#"{"meta":{"seed":"body-v1"},"items":[
                 {"id":"it-1","type":"scene","parentId":null,"title":"Alpha"}
               ]}"#,
        )
        .unwrap();
        fs::write(
            fixture.path().join("scenes.ndjson"),
            r#"{"id":"it-1","blocks":[{"text":"ignored"}],"body":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"salt","marks":[{"type":"strong"}]}]}]}}"#,
        )
        .unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        seed_project(fixture.path(), &db).unwrap();

        let store = Store::open(&db).unwrap();
        let doc: serde_json::Value =
            serde_json::from_str(&store.load_doc("it-1").unwrap().body).unwrap();
        let text_node = &doc["content"][0]["content"][0];
        assert_eq!(text_node["text"], "salt");
        assert_eq!(text_node["marks"][0]["type"], "strong");
    }

    fn write_cast_fixture(dir: &std::path::Path) {
        write_fixture(dir);
        fs::write(
            dir.join("cast.ndjson"),
            "{\"kind\":\"character\",\"name\":\"Ines Varo\",\"summary\":\"A cartographer's apprentice.\",\
             \"fields\":[{\"label\":\"wants\",\"value\":\"the truth\"}]}\n\
             {\"kind\":\"place\",\"name\":\"The Kelp Quay\",\"summary\":\"\",\"fields\":[]}\n",
        )
        .unwrap();
    }

    #[test]
    fn cast_ndjson_seeds_members_with_their_fields_in_file_order() {
        let fixture = tempdir().unwrap();
        write_cast_fixture(fixture.path());
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        seed_project(fixture.path(), &db).unwrap();

        let store = Store::open(&db).unwrap();
        let cast = store.cast_list().unwrap();
        assert_eq!(cast.len(), 2);
        let ines = cast.iter().find(|m| m.name == "Ines Varo").unwrap();
        assert_eq!(ines.kind, "character");
        assert_eq!(ines.summary, "A cartographer's apprentice.");
        assert_eq!(ines.fields.len(), 1);
        assert_eq!(ines.fields[0].label, "wants");
        let quay = cast.iter().find(|m| m.name == "The Kelp Quay").unwrap();
        assert_eq!(quay.kind, "place");
    }

    #[test]
    fn cast_ndjson_seeds_aliases_in_file_order() {
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        fs::write(
            fixture.path().join("cast.ndjson"),
            "{\"kind\":\"character\",\"name\":\"Ines Varo\",\"summary\":\"\",\"fields\":[],\
             \"aliases\":[\"Ines\",\"Varo\"]}\n\
             {\"kind\":\"place\",\"name\":\"The Kelp Quay\",\"summary\":\"\",\"fields\":[]}\n",
        )
        .unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        seed_project(fixture.path(), &db).unwrap();

        let store = Store::open(&db).unwrap();
        let cast = store.cast_list().unwrap();
        let ines = cast.iter().find(|m| m.name == "Ines Varo").unwrap();
        assert_eq!(ines.aliases, vec!["Ines", "Varo"]);
        // ABSENT MEANS NONE, exactly as an absent `fields` does.
        let quay = cast.iter().find(|m| m.name == "The Kelp Quay").unwrap();
        assert!(quay.aliases.is_empty());
    }

    #[test]
    fn cast_ndjson_ignoring_aliases_fails_the_seed_loudly() {
        // The mutation this pins: a seeder that silently dropped `aliases`
        // rather than running them through `cast::normalise_aliases` would
        // seed a project `cast_set` would never have let a writer save --
        // this file must never carry data the page's own Save refuses.
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        fs::write(
            fixture.path().join("cast.ndjson"),
            "{\"kind\":\"character\",\"name\":\"Ines Varo\",\"summary\":\"\",\"fields\":[],\
             \"aliases\":[\"In\"]}\n",
        )
        .unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        match seed_project(fixture.path(), &db) {
            // THE WHOLE SENTENCE, not a substring: `msg.contains("In")` also
            // matches "Ines Varo", the very name the fixture line is about,
            // which would pass even if the refusal named a different alias
            // entirely.
            Err(StoreError::Seed(msg)) => assert_eq!(
                msg,
                "cast.ndjson line 1: \"In\" is too short to use as an alias; nothing was saved"
            ),
            other => panic!("expected Seed error, got {other:?}"),
        }
        let store = Store::open(&db).unwrap();
        assert_eq!(store.cast_list().unwrap().len(), 0);
    }

    #[test]
    fn cast_ndjson_naming_an_unknown_kind_is_refused_and_writes_nothing() {
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        fs::write(
            fixture.path().join("cast.ndjson"),
            r#"{"kind":"villain","name":"Nobody","summary":"","fields":[]}"#,
        )
        .unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        match seed_project(fixture.path(), &db) {
            Err(StoreError::Seed(msg)) => assert!(msg.contains("villain"), "{msg}"),
            other => panic!("expected Seed error, got {other:?}"),
        }
        // The whole seed rolls back, items included -- `synopses.ndjson`'s and
        // `appearances.ndjson`'s writes are in the SAME transaction as the
        // items, and one file's refusal must not leave the others half-seeded.
        let store = Store::open(&db).unwrap();
        assert_eq!(store.items().unwrap().len(), 0);
    }

    #[test]
    fn synopses_ndjson_attaches_a_synopsis_to_its_named_item() {
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        fs::write(
            fixture.path().join("synopses.ndjson"),
            r#"{"itemId":"it-1","body":"She finds the letter and burns it."}"#,
        )
        .unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        seed_project(fixture.path(), &db).unwrap();

        let store = Store::open(&db).unwrap();
        assert_eq!(
            store.synopsis("it-1").unwrap().unwrap().body,
            "She finds the letter and burns it."
        );
        assert_eq!(store.synopsis("it-2").unwrap(), None);
    }

    /// A TIMELINE MAKES ITS OWN BIBLE ROOT WHEN NONE EXISTS -- `write_fixture`'s
    /// `it-3` is a root-level `note` with no bible around it (an older
    /// fixture shape, predating 035), so this is the "no note or synopsis
    /// first" case the fallback exists for, and it must not collide with the
    /// three root items `project.json` already placed at the seed floor.
    #[test]
    fn timelines_ndjson_inserts_a_timeline_and_makes_a_bible_root() {
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        // The body is `EMPTY_TIMELINE_BODY` itself, embedded as a JSON VALUE
        // (not re-typed): the constant IS the object `"body"` names here, and
        // a hand-copied duplicate is exactly what a later change to the
        // starter body would leave silently stale.
        fs::write(
            fixture.path().join("timelines.ndjson"),
            format!(
                r#"{{"id":"tl-1","title":"Timeline","body":{}}}"#,
                crate::store::EMPTY_TIMELINE_BODY
            ),
        )
        .unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        let written = seed_project(fixture.path(), &db).unwrap();
        assert_eq!(
            written, 5,
            "the three project.json items, the bible root and the timeline"
        );

        let store = Store::open(&db).unwrap();
        let items = store.items().unwrap();
        let bible = items
            .iter()
            .find(|i| i.item_type == "bible")
            .expect("no bible root was made");
        assert_eq!(bible.parent_id, None);
        let timeline = items
            .iter()
            .find(|i| i.id == "tl-1")
            .expect("the timeline was not seeded");
        assert_eq!(timeline.parent_id.as_deref(), Some(bible.id.as_str()));
        assert_eq!(timeline.title, "Timeline");
        assert_eq!(timeline.item_type, "timeline");
        let body = store.load_doc("tl-1").unwrap().body;
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["kind"], "timeline");
    }

    /// A CAST-KIND TRACK'S `memberId` AND AN EVENT'S `cast` NAME MEMBERS BY
    /// NAME, resolved here against `cast.ndjson` in the same pass that
    /// resolves `appearances.ndjson` -- so the stored body carries the real
    /// cast id, never the name `sample-build.ts` wrote.
    #[test]
    fn timeline_cast_names_are_resolved_to_real_cast_ids() {
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        fs::write(
            fixture.path().join("cast.ndjson"),
            r#"{"kind":"character","name":"Ada","summary":"","fields":[]}"#,
        )
        .unwrap();
        fs::write(
            fixture.path().join("timelines.ndjson"),
            r#"{"id":"tl-1","title":"Timeline","body":{"kind":"timeline","version":1,"scale":{"unit":"day","zero":"z","calendar":null,"eras":[]},"tracks":[{"id":"t1","name":"Ada","kind":"cast","memberId":"Ada","colour":1}],"branches":[],"events":[{"id":"v1","title":"E","at":0,"until":null,"tracks":["t1"],"branch":null,"scene":null,"cast":["Ada"],"note":""}]}}"#,
        )
        .unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        seed_project(fixture.path(), &db).unwrap();

        let store = Store::open(&db).unwrap();
        let ada_id = store
            .conn
            .query_row("SELECT id FROM cast_member WHERE name = 'Ada'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap();
        let body = store.load_doc("tl-1").unwrap().body;
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["tracks"][0]["memberId"], ada_id);
        assert_eq!(parsed["events"][0]["cast"][0], ada_id);
    }

    /// A TIMELINE NAMING A CAST MEMBER `cast.ndjson` DOES NOT HAVE FAILS THE
    /// SEED rather than storing a `memberId` no cast member will ever match --
    /// `sample-build.ts` already refuses this at build time, but the seeder
    /// cannot assume every fixture it is handed went through that build.
    #[test]
    fn an_unknown_cast_name_in_a_timeline_fails_the_seed() {
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        fs::write(
            fixture.path().join("timelines.ndjson"),
            r#"{"id":"tl-1","title":"Timeline","body":{"kind":"timeline","version":1,"scale":{"unit":"day","zero":"z","calendar":null,"eras":[]},"tracks":[],"branches":[],"events":[{"id":"v1","title":"E","at":0,"until":null,"tracks":[],"branch":null,"scene":null,"cast":["Nobody"],"note":""}]}}"#,
        )
        .unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        let err = seed_project(fixture.path(), &db).unwrap_err();
        assert!(
            format!("{err}").contains("Nobody"),
            "unexpected error: {err}"
        );
    }

    /// AN EMPTY `timelines.ndjson` SEEDS NO TIMELINE AND MAKES NO BIBLE ROOT.
    /// 101 ships the sample's own file empty (104 fills it), and this is the
    /// drift test the plan asks `sample-build.ts --check` to keep passing
    /// against: an empty file existing at all must not conjure a bible.
    #[test]
    fn an_empty_timelines_ndjson_seeds_nothing_and_makes_no_bible() {
        let fixture = tempdir().unwrap();
        // A bare fixture with no note -- `write_fixture` always gives one a
        // bible root, and this test needs to prove none is made when there is
        // nothing to make one for.
        fs::write(
            fixture.path().join("project.json"),
            r#"{"meta":{"seed":"stress-v1"},"items":[
                 {"id":"it-1","type":"scene","parentId":null,"order":0,"title":"Alpha"}
               ]}"#,
        )
        .unwrap();
        fs::write(
            fixture.path().join("scenes.ndjson"),
            "{\"id\":\"it-1\",\"blocks\":[{\"type\":\"paragraph\",\"text\":\"hello\"}]}\n",
        )
        .unwrap();
        fs::write(fixture.path().join("timelines.ndjson"), "").unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        let written = seed_project(fixture.path(), &db).unwrap();
        assert_eq!(written, 1, "the empty file adds nothing");

        let store = Store::open(&db).unwrap();
        let items = store.items().unwrap();
        assert!(
            !items.iter().any(|i| i.item_type == "bible"),
            "an empty timelines.ndjson must not conjure a bible root"
        );
    }

    /// EVERY MEMBER OF A LIST LANDS, not the last one. The sample's map showed
    /// one member per scene where the fixture lists five; the existing
    /// appearances test tags each item with ONE member and could not see it.
    #[test]
    fn appearances_ndjson_lands_every_member_of_one_items_list() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("project.json"),
            r#"{"meta":{"seed":"s"},"items":[{"id":"i1","type":"scene","parentId":null,"order":0,"title":"A"}]}"#,
        )
        .unwrap();
        fs::write(dir.path().join("scenes.ndjson"), "").unwrap();
        fs::write(
            dir.path().join("cast.ndjson"),
            "{\"kind\":\"character\",\"name\":\"Ann\",\"summary\":\"\",\"fields\":[]}\n\
             {\"kind\":\"place\",\"name\":\"Bay\",\"summary\":\"\",\"fields\":[]}\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("appearances.ndjson"),
            "{\"itemId\":\"i1\",\"members\":[\"Ann\",\"Bay\"]}\n",
        )
        .unwrap();
        let db = dir.path().join("p.db");
        seed_project(dir.path(), &db).unwrap();
        let store = Store::open(&db).unwrap();
        let rows: i64 = store
            .conn
            .query_row(
                "SELECT count(*) FROM appearance WHERE item_id = 'i1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 2);
    }

    #[test]
    fn appearances_ndjson_resolves_each_member_by_name_not_by_file_order() {
        // THE FIXTURE THAT CATCHES AN OFF-BY-ONE: two items, each tagged with
        // a DIFFERENT single member, and the two members are seeded in the
        // OPPOSITE order from the one appearances.ndjson lists them in. A
        // resolver that paired names to ids by position rather than by the
        // name map would swap these two.
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        fs::write(
            fixture.path().join("cast.ndjson"),
            "{\"kind\":\"character\",\"name\":\"Ruben\",\"summary\":\"\",\"fields\":[]}\n\
             {\"kind\":\"character\",\"name\":\"Ines Varo\",\"summary\":\"\",\"fields\":[]}\n",
        )
        .unwrap();
        fs::write(
            fixture.path().join("appearances.ndjson"),
            "{\"itemId\":\"it-1\",\"members\":[\"Ines Varo\"]}\n\
             {\"itemId\":\"it-2\",\"members\":[\"Ruben\"]}\n",
        )
        .unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        seed_project(fixture.path(), &db).unwrap();

        let store = Store::open(&db).unwrap();
        let cast = store.cast_list().unwrap();
        let ines_id = &cast.iter().find(|m| m.name == "Ines Varo").unwrap().id;
        let ruben_id = &cast.iter().find(|m| m.name == "Ruben").unwrap().id;
        let all = store.appearances().unwrap();
        assert_eq!(all.get("it-1").unwrap(), &vec![ines_id.clone()]);
        assert_eq!(all.get("it-2").unwrap(), &vec![ruben_id.clone()]);
    }

    #[test]
    fn appearances_ndjson_naming_an_unknown_member_is_a_seed_error_naming_it() {
        let fixture = tempdir().unwrap();
        write_fixture(fixture.path());
        fs::write(
            fixture.path().join("appearances.ndjson"),
            r#"{"itemId":"it-1","members":["Nobody"]}"#,
        )
        .unwrap();
        let out = tempdir().unwrap();
        let db = out.path().join("project.db");

        match seed_project(fixture.path(), &db) {
            Err(StoreError::Seed(msg)) => assert!(msg.contains("Nobody"), "{msg}"),
            other => panic!("expected Seed error, got {other:?}"),
        }
        let store = Store::open(&db).unwrap();
        assert_eq!(store.items().unwrap().len(), 0);
    }
}
