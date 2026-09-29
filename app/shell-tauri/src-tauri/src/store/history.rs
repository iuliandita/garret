// app/shell-tauri/src-tauri/src/store/history.rs
// Past states of a document, and the named moments a writer chose to keep.
//
// The store holds current state only, and ProseMirror's undo history is per
// open document and dies with the window -- so before this module the
// application that exists to not lose a writer's words held exactly one copy of
// them. This is the other copy, and the inverse that manuscript-wide rewriting
// needs before it can be offered at all.
//
// NOT THE UNDO STACK. Ctrl+Z is per keystroke, per session, per document; this
// is per five minutes, across sessions, and survives the window closing. Both
// are kept and neither replaces the other.

use super::source_words::{self, DatedMovement, WordSource};
use super::{commit, now_ms, Result, Store, StoreError};
use crate::words;
use rusqlite::OptionalExtension;
use serde::Serialize;

/// How close together two automatic versions of one document may be.
///
/// Five minutes is a compromise with one side that matters: a writer who loses
/// work loses at most five minutes of it, and a writer with a long manuscript
/// pays one small row per document per five minutes of actually editing THAT
/// document. Flushes land about once a second, so an untrottled version per
/// flush would be three hundred times this and would be proportional to the
/// body every time.
pub const AUTO_INTERVAL_MS: i64 = 5 * 60 * 1000;

/// The most automatic versions any one document keeps. Snapshot versions are
/// not counted here and are never pruned.
pub const MAX_AUTO_VERSIONS: usize = 60;

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// One past state, as the panel lists it. No body: a listing of a long-lived
/// document would otherwise carry every historical copy of it across the IPC
/// boundary to render a column of times.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VersionSummary {
    pub id: i64,
    pub created_at: i64,
    pub words: u64,
    /// The label of the snapshot this version belongs to, or None when it is an
    /// automatic one. Carrying the LABEL rather than the id is what lets the
    /// panel render a row without a second lookup, and the id is still there
    /// for a caller that needs to act on the snapshot itself.
    pub snapshot_label: Option<String>,
    pub snapshot_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SnapshotSummary {
    pub id: i64,
    pub label: String,
    pub created_at: i64,
    /// How many documents the snapshot captured. Read from the version rows, so
    /// it cannot drift from what a restore would actually write.
    pub documents: i64,
}

/// One document an acceptance rewrote.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AcceptedDoc {
    pub item_id: String,
    /// The exact pre-accept version captured under this report's snapshot.
    pub version_id: i64,
    /// The document row's revision AFTER the write. The page registers it with
    /// the flush scheduler, which is holding the one before and would refuse
    /// the writer's very next keystroke as a Conflict without it.
    pub rev: i64,
    /// The body the store now holds, so the page can repaint without a second
    /// read that could be handed a different one.
    pub body: String,
}

/// What one acceptance did, and the way back from it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AcceptReport {
    pub documents: Vec<AcceptedDoc>,
    /// The snapshot taken BEFORE any of it, which IS the inverse: this
    /// repository has no structural undo, and the design's promise that an
    /// acceptance is undoable rests on nothing else.
    pub snapshot: SnapshotSummary,
    /// The net word delta the acceptance carried, as the day baseline absorbed
    /// it. Reported so the figure that moved is a figure a reader can see.
    pub net_words: i64,
}

/// What a manuscript-wide replace did, and the way back from it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReplaceReport {
    pub replaced: usize,
    /// Matches that crossed a paragraph break or the edge of an emphasised run.
    /// LEFT ALONE and reported: told "replaced 47" while a forty-eighth is
    /// still there, a writer has been misled and the reason is not something
    /// they could work out.
    pub spanning: usize,
    /// Documents actually rewritten.
    pub documents: usize,
    /// The snapshot taken BEFORE any of it. The writer's handle on the inverse.
    pub snapshot: SnapshotSummary,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RestoredDoc {
    pub rev: i64,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RestoredSnapshot {
    /// Documents whose body actually changed. A snapshot restore over a
    /// manuscript nobody has touched since reports 0, which is the truth and is
    /// distinguishable from a restore that failed to reach the store.
    pub documents: i64,
    /// Documents the snapshot covered, changed or not.
    pub covered: i64,
}

/// FNV-1a, 64-bit. Not cryptographic and does not need to be: `blob_key` below
/// VERIFIES rather than trusts, so the only property required of this function
/// is that it spreads. See `blob_key` for why that is not a shortcut.
/// FNV-64 offset basis. Named so `hash64` and `hash64_update` cannot drift.
pub const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;

/// Fold more bytes into a running FNV-64, so a caller hashing a FILE does not
/// have to read it whole. `hash64(b) == hash64_update(FNV_OFFSET, b)` by
/// construction, which is what keeps a streamed hash and an in-memory one the
/// same number.
pub fn hash64_update(mut h: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub fn hash64(bytes: &[u8]) -> u64 {
    hash64_update(FNV_OFFSET, bytes)
}

/// Which entries of a descending-by-time list of automatic versions to DELETE.
///
/// Pure, over timestamps alone, so the retention policy is testable and
/// mutation-testable with no database and no clock. `created` must be sorted
/// newest first, which is the order the query returns.
///
/// The policy thins rather than merely capping, because a flat cap of N loses
/// the whole morning by lunchtime:
///
///   - inside the last hour, every version is kept;
///   - from an hour to a day old, the NEWEST in each hour bucket;
///   - beyond a day, the newest in each day bucket;
///   - and whatever survives that is cut to `cap`, oldest first.
///
/// Buckets are absolute (epoch / HOUR_MS), not relative to `now`. A relative
/// bucket shifts under every call, so the version kept for "three hours ago"
/// changes as the afternoon passes and the history a writer looked at a minute
/// ago is not the history they see now.
pub fn thin_with_cap(now: i64, created: &[i64], cap: usize) -> Vec<usize> {
    let mut drop = Vec::new();
    let mut seen_hour: Option<i64> = None;
    let mut seen_day: Option<i64> = None;
    let mut kept = 0usize;
    for (i, &at) in created.iter().enumerate() {
        let age = now - at;
        let keep = if age <= HOUR_MS {
            true
        } else if age <= DAY_MS {
            let bucket = at.div_euclid(HOUR_MS);
            let first = seen_hour != Some(bucket);
            seen_hour = Some(bucket);
            first
        } else {
            let bucket = at.div_euclid(DAY_MS);
            let first = seen_day != Some(bucket);
            seen_day = Some(bucket);
            first
        };
        // The cap is applied to the SURVIVORS, in the same pass. Applying it to
        // the raw list first would spend the whole budget on the last hour and
        // drop every older version the thinning had deliberately kept.
        if keep && kept < cap {
            kept += 1;
        } else {
            drop.push(i);
        }
    }
    drop
}

/// The version policy: `thin_with_cap` at `MAX_AUTO_VERSIONS`.
pub fn thin(now: i64, created: &[i64]) -> Vec<usize> {
    thin_with_cap(now, created, MAX_AUTO_VERSIONS)
}

impl Store {
    /// The key a body is stored under, inserting the blob if it is new.
    ///
    /// THE HASH IS VERIFIED, NEVER TRUSTED. A 64-bit hash over a million blobs
    /// collides with probability around 10^-7 -- small, and the consequence is
    /// that a restore hands the writer SOMEONE ELSE'S PROSE, silently, in the
    /// application whose entire purpose is their words. So a key whose stored
    /// body differs is not used: the probe moves to `<key>-1`, `<key>-2`, and
    /// so on until a slot is free or holds this exact body.
    ///
    /// That makes the function correct for ANY hash, which is what lets the
    /// hash be fifteen lines of FNV rather than a cryptographic dependency.
    /// The probe loop is exercised by a test that plants a collision by hand;
    /// without one it is unreachable code a reader would credit.
    ///
    /// Runs inside the caller's transaction.
    fn blob_key(&self, body: &str) -> Result<String> {
        let base = format!("{:016x}", hash64(body.as_bytes()));
        for probe in 0u32.. {
            let key = if probe == 0 {
                base.clone()
            } else {
                format!("{base}-{probe}")
            };
            let existing: Option<String> = self
                .conn
                .query_row("SELECT body FROM blob WHERE key = ?1", [&key], |r| r.get(0))
                .optional()?;
            match existing {
                Some(stored) if stored == body => return Ok(key),
                Some(_) => continue,
                None => {
                    self.conn.execute(
                        "INSERT INTO blob (key, body) VALUES (?1, ?2)",
                        rusqlite::params![key, body],
                    )?;
                    return Ok(key);
                }
            }
        }
        unreachable!("u32 range is exhausted only by 4 billion collisions on one hash")
    }

    /// Insert one version row. Caller owns the transaction and the throttle.
    pub(super) fn insert_version(
        &self,
        item_id: &str,
        body: &str,
        at: i64,
        snapshot_id: Option<i64>,
    ) -> Result<i64> {
        let key = self.blob_key(body)?;
        // An unreadable body counts 0 rather than refusing the version. The
        // point of history is getting the bytes back; a body this build cannot
        // parse is exactly the case where that matters most, and a count is a
        // display detail.
        let words = super::document_text(body)
            .map(|t| words::count_words(&t))
            .unwrap_or(0);
        self.conn.execute(
            "INSERT INTO doc_version (item_id, blob_key, created_at, words, snapshot_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![item_id, key, at, words as i64, snapshot_id],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Apply the retention policy to ONE document's automatic versions, and
    /// free any blob that nothing references afterwards.
    ///
    /// The blob free is part of THIS statement rather than a periodic sweep: a
    /// second mechanism that decides what is garbage is a second mechanism that
    /// can disagree with the first, and the direction it would disagree in is
    /// deleting a blob a live version still points at.
    fn prune_versions(&self, item_id: &str, now: i64) -> Result<usize> {
        let mut stmt = self.conn.prepare(
            "SELECT id, created_at FROM doc_version
              WHERE item_id = ?1 AND snapshot_id IS NULL
              ORDER BY created_at DESC, id DESC",
        )?;
        let rows: Vec<(i64, i64)> = stmt
            .query_map([item_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        drop(stmt);
        let times: Vec<i64> = rows.iter().map(|(_, at)| *at).collect();
        let doomed = thin(now, &times);
        if doomed.is_empty() {
            return Ok(0);
        }
        for i in &doomed {
            self.conn
                .execute("DELETE FROM doc_version WHERE id = ?1", [rows[*i].0])?;
        }
        self.conn.execute_batch(
            "DELETE FROM blob WHERE key NOT IN (SELECT blob_key FROM doc_version)",
        )?;
        Ok(doomed.len())
    }

    /// Record automatic versions for the documents a flush just wrote.
    ///
    /// CALLED AFTER `flush` HAS COMMITTED, in its own transaction, and that
    /// ordering is the point rather than an implementation detail: the prose is
    /// durable before anything about history is attempted, so a failure here
    /// costs a version and never a manuscript.
    ///
    /// The cheap path -- every flush that is not at a version boundary, which
    /// is the overwhelming majority -- is one indexed SELECT per entry and NO
    /// transaction and NO fsync. `flush_p95_ms` is a graded gate, and the
    /// recorded word-count regression is exactly the shape to avoid here.
    ///
    /// Returns how many versions were written.
    pub fn record_versions(&self, entries: &[super::FlushEntry]) -> Result<usize> {
        self.record_versions_at(entries, now_ms())
    }

    /// The testable core. Time is an ARGUMENT because every claim this module
    /// makes is about time: a test that could not choose `now` could only
    /// assert the first version is written, which is the one branch the
    /// throttle does not govern.
    pub fn record_versions_at(&self, entries: &[super::FlushEntry], now: i64) -> Result<usize> {
        let mut due: Vec<&super::FlushEntry> = Vec::new();
        for e in entries {
            let newest: Option<(i64, String)> = self
                .conn
                .query_row(
                    "SELECT created_at, blob_key FROM doc_version
                      WHERE item_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
                    [&e.item_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            match newest {
                // No history at all: write one now, so a document always has a
                // floor to fall back to rather than five minutes of nothing.
                None => due.push(e),
                Some((at, key)) => {
                    if now - at < AUTO_INTERVAL_MS {
                        continue;
                    }
                    // Identical text is not a new state. Without this a writer
                    // who leaves a scene open accumulates a version every five
                    // minutes saying nothing happened, and the retention
                    // policy then spends its budget on them.
                    if key == format!("{:016x}", hash64(e.body.as_bytes())) {
                        continue;
                    }
                    due.push(e);
                }
            }
        }
        if due.is_empty() {
            return Ok(0);
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let mut written = 0usize;
        for e in &due {
            if let Err(err) = self
                .insert_version(&e.item_id, &e.body, now, None)
                .and_then(|_| self.prune_versions(&e.item_id, now))
            {
                let _ = self.conn.execute_batch("ROLLBACK");
                return Err(err);
            }
            written += 1;
        }
        commit(&self.conn)?;
        Ok(written)
    }

    /// One document's versions, newest first.
    pub fn doc_versions(&self, item_id: &str) -> Result<Vec<VersionSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT v.id, v.created_at, v.words, v.snapshot_id, s.label
               FROM doc_version v LEFT JOIN snapshot s ON s.id = v.snapshot_id
              WHERE v.item_id = ?1
              ORDER BY v.created_at DESC, v.id DESC",
        )?;
        let out = stmt
            .query_map([item_id], |r| {
                Ok(VersionSummary {
                    id: r.get(0)?,
                    created_at: r.get(1)?,
                    words: r.get::<_, i64>(2)? as u64,
                    snapshot_id: r.get(3)?,
                    snapshot_label: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(out)
    }

    pub fn version_body(&self, version_id: i64) -> Result<String> {
        self.conn
            .query_row(
                "SELECT b.body FROM doc_version v JOIN blob b ON b.key = v.blob_key
                  WHERE v.id = ?1",
                [version_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(StoreError::NotFound {
                item_id: format!("version {version_id}"),
            })
    }

    /// Put one document back to a past state.
    ///
    /// CAPTURES BEFORE IT REPLACES, in the same transaction: the body being
    /// overwritten becomes a version first, unthrottled. So restore is itself
    /// undoable -- by restoring the version restore just made -- and this
    /// feature has no path that loses work.
    ///
    /// Takes `base_rev` and refuses on a mismatch for the same reason `flush`
    /// does: a restore issued while an edit is in flight would otherwise
    /// discard the edit silently.
    pub fn doc_restore(
        &self,
        item_id: &str,
        version_id: i64,
        base_rev: i64,
    ) -> Result<RestoredDoc> {
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<RestoredDoc> {
            // THE VERSION MUST BELONG TO THIS ITEM, and nothing above this line
            // checks it. `version_body` looks a version up by id alone, so a
            // page holding a listing of scene A and a document id of scene B --
            // a stale panel, a switch the panel did not notice, a page bug --
            // would write A's old prose OVER B, in one transaction, reported as
            // a success. That is the worst thing this feature could do, and it
            // is one query away from being impossible.
            let owner: Option<String> = self
                .conn
                .query_row(
                    "SELECT item_id FROM doc_version WHERE id = ?1",
                    [version_id],
                    |r| r.get(0),
                )
                .optional()?;
            match owner {
                Some(ref owner) if owner == item_id => {}
                Some(_) | None => {
                    return Err(StoreError::NotFound {
                        item_id: format!("version {version_id} of {item_id}"),
                    })
                }
            }
            let body = self.version_body(version_id)?;
            let current: Option<(String, i64)> = self
                .conn
                .query_row(
                    "SELECT body, rev FROM doc WHERE item_id = ?1",
                    [item_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (current_body, rev) = current.ok_or(StoreError::NotFound {
                item_id: item_id.to_string(),
            })?;
            if rev != base_rev {
                return Err(StoreError::Conflict {
                    item_id: item_id.to_string(),
                });
            }
            let movement = source_words::eligible(&self.conn, item_id)?.then(|| {
                source_words::directional(
                    WordSource::Restored,
                    Some(&current_body),
                    &body,
                )
            });
            self.insert_version(item_id, &current_body, now, None)?;
            self.conn.execute(
                "UPDATE doc SET body = ?2, rev = rev + 1, updated_at = ?3 WHERE item_id = ?1",
                rusqlite::params![item_id, body, now],
            )?;
            // The notes described the body just overwritten. There is no
            // mapping between the two -- to this store they are unrelated
            // documents -- so the anchors become orphans in the same
            // transaction as the body they belonged to.
            self.orphan_comment_anchors(item_id, now)?;
            self.review_conflict_all(item_id, now)?;
            if let Some(movement) = movement {
                source_words::record(&self.conn, &[movement])?;
            }
            Ok(RestoredDoc { rev: rev + 1, body })
        })();
        match outcome {
            Ok(v) => {
                commit(&self.conn)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Capture every document under a label the writer chose.
    ///
    /// One transaction over the whole manuscript. It holds the store mutex for
    /// its duration and therefore blocks flushes, which is the correct trade:
    /// a snapshot that raced a flush would name a moment the manuscript was
    /// never in.
    pub fn snapshot_create(&self, label: &str) -> Result<SnapshotSummary> {
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<SnapshotSummary> {
            self.conn.execute(
                "INSERT INTO snapshot (label, created_at) VALUES (?1, ?2)",
                rusqlite::params![label, now],
            )?;
            let snapshot_id = self.conn.last_insert_rowid();
            let mut stmt = self.conn.prepare("SELECT item_id, body FROM doc")?;
            let docs: Vec<(String, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<_, _>>()?;
            drop(stmt);
            for (item_id, body) in &docs {
                self.insert_version(item_id, body, now, Some(snapshot_id))?;
            }
            Ok(SnapshotSummary {
                id: snapshot_id,
                label: label.to_string(),
                created_at: now,
                documents: docs.len() as i64,
            })
        })();
        match outcome {
            Ok(v) => {
                commit(&self.conn)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Rewrite a word across the whole manuscript, having FIRST captured every
    /// document under a name that says what is about to happen.
    ///
    /// One transaction, snapshot before rewrite. This operation was refused
    /// in as many words -- no inverse, performed on the thing the application
    /// exists to protect -- and the snapshot IS the inverse. It is not optional
    /// and there is no flag: an operation whose blast radius is the whole book
    /// does not get a preference that switches off the way back, and a writer
    /// who has just been told "47 replacements in 12 scenes" was in no position
    /// to have decided beforehand.
    ///
    /// The snapshot covers EVERY document, including trashed ones, because a
    /// snapshot is of the file. The REWRITE skips the excluded set, because
    /// rewriting deleted work would hand the writer text they never wrote if
    /// they ever restored it.
    ///
    /// Cheap for the reason content addressing exists: a snapshot of a
    /// manuscript nobody has edited since costs one row per document and no new
    /// blobs.
    pub fn replace_everywhere(
        &self,
        excluded: &std::collections::HashSet<String>,
        query: &str,
        replacement: &str,
        label: &str,
    ) -> Result<ReplaceReport> {
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<ReplaceReport> {
            self.conn.execute(
                "INSERT INTO snapshot (label, created_at) VALUES (?1, ?2)",
                rusqlite::params![label, now],
            )?;
            let snapshot_id = self.conn.last_insert_rowid();
            let mut stmt = self.conn.prepare("SELECT item_id, body FROM doc")?;
            let docs: Vec<(String, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<_, _>>()?;
            drop(stmt);
            for (item_id, body) in &docs {
                self.insert_version(item_id, body, now, Some(snapshot_id))?;
            }
            let mut replaced = 0usize;
            let mut spanning = 0usize;
            let mut documents = 0usize;
            let mut source_movements: Vec<DatedMovement> = Vec::new();
            for (item_id, body) in &docs {
                if excluded.contains(item_id) {
                    continue;
                }
                let Some(outcome) = crate::replace::replace_in_body(body, query, replacement)
                else {
                    // An unreadable body is skipped, never rewritten. Rewriting
                    // what we cannot parse is how a manuscript is destroyed.
                    continue;
                };
                spanning += outcome.spanning;
                if let Some(next) = outcome.body {
                    if source_words::eligible(&self.conn, item_id)? {
                        source_movements.push(source_words::directional(
                            WordSource::Unattributed,
                            Some(body),
                            &next,
                        ));
                    }
                    replaced += outcome.replaced;
                    documents += 1;
                    self.conn.execute(
                        "UPDATE doc SET body = ?2, rev = rev + 1, updated_at = ?3
                          WHERE item_id = ?1",
                        rusqlite::params![item_id, next, now],
                    )?;
                    // Same transaction, same reason as `doc_restore`: the
                    // rewrite shifts every position after each replacement and
                    // the store cannot map an anchor through it.
                    self.orphan_comment_anchors(item_id, now)?;
                    self.review_conflict_all(item_id, now)?;
                }
            }
            source_words::record(&self.conn, &source_movements)?;
            Ok(ReplaceReport {
                replaced,
                spanning,
                documents,
                snapshot: SnapshotSummary {
                    id: snapshot_id,
                    label: label.to_string(),
                    created_at: now,
                    documents: docs.len() as i64,
                },
            })
        })();
        match outcome {
            Ok(v) => {
                commit(&self.conn)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Take the words the writer changed in their readable folder INTO the book.
    ///
    /// **THE FOURTH BODY-REWRITE PATH IN THIS APPLICATION**, after
    /// `doc_restore`, `replace_everywhere` and `snapshot_restore`. Plan 001's
    /// write-back names it in advance -- "THERE ARE NOW THREE `replaceDoc`
    /// PATHS. A fourth is where this comes back" -- so every rule those three
    /// carry is restated here rather than inherited:
    ///
    ///  - **The snapshot comes first, in the same transaction.** It is the
    ///    writer's only handle on the inverse, and `replace_everywhere`'s note
    ///    is the argument: an operation whose blast radius is the manuscript
    ///    does not get to be irreversible. It covers EVERY document, because a
    ///    snapshot is of the file; the rewrite touches only what was accepted.
    ///  - **Every rewritten body orphans its OWN anchors and no others.** An
    ///    anchor is a pair of positions into a body that no longer exists; to
    ///    this store the two are unrelated documents, and silently re-anchoring
    ///    is what `comments.rs`' header calls the worst thing that feature can
    ///    do. A change set of twelve scenes must not orphan the notes on the
    ///    other 15,188.
    ///  - **`base_rev` per document, refused WHOLE on a mismatch.** `flush`'s
    ///    boundary and `doc_restore`'s: an accept issued while an edit is in
    ///    flight would discard the edit silently, and a partially accepted
    ///    change set is a state of the book nobody chose.
    ///
    /// **THE ITEM ROW NEVER MOVES.** The revision state lives there under the
    /// item's `rev` and the file cannot express one, so an accepted change
    /// carries no information about it; and the mirror's three-way skip
    /// compares `item.rev`, so bumping it would make the next pass rewrite the
    /// file for a change the file already holds.
    ///
    /// **THE DAY BASELINE ABSORBS THE NET DELTA**, in this transaction (design
    /// section 6). Today's figure is `total - day_baseline` and is read as a
    /// claim about the writer's day; a goal that goes green because five
    /// thousand words arrived from a folder is worth less than no figure. Only
    /// when a baseline exists: writing one where there is none would anchor
    /// today at an arbitrary moment instead of at the next read.
    ///
    /// **WHAT IS NOT UNDONE BY THE SNAPSHOT**: the orphaned anchors. An orphan
    /// cannot be un-orphaned, on any of the four paths. Restoring puts the
    /// prose back and leaves the notes collapsed, and that is the honest
    /// statement rather than a defect of this one.
    pub fn accept_from_mirror(
        &self,
        accepts: &[(String, i64, String)],
        label: &str,
    ) -> Result<AcceptReport> {
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<AcceptReport> {
            self.conn.execute(
                "INSERT INTO snapshot (label, created_at) VALUES (?1, ?2)",
                rusqlite::params![label, now],
            )?;
            let snapshot_id = self.conn.last_insert_rowid();
            let mut stmt = self.conn.prepare("SELECT item_id, body FROM doc")?;
            let docs: Vec<(String, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<_, _>>()?;
            drop(stmt);
            let mut snapshot_versions = std::collections::HashMap::new();
            for (item_id, body) in &docs {
                snapshot_versions.insert(
                    item_id.clone(),
                    self.insert_version(item_id, body, now, Some(snapshot_id))?,
                );
            }

            let mut written = Vec::with_capacity(accepts.len());
            let mut net_words = 0i64;
            let mut source_movements: Vec<DatedMovement> = Vec::new();
            for (item_id, base_rev, body) in accepts {
                let current: Option<(String, i64)> = self
                    .conn
                    .query_row(
                        "SELECT body, rev FROM doc WHERE item_id = ?1",
                        [item_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                let (was, rev) = current.ok_or(StoreError::NotFound {
                    item_id: item_id.to_string(),
                })?;
                if rev != *base_rev {
                    return Err(StoreError::Conflict {
                        item_id: item_id.to_string(),
                    });
                }
                if source_words::eligible(&self.conn, item_id)? {
                    source_movements.push(source_words::directional(
                        WordSource::Imported,
                        Some(&was),
                        body,
                    ));
                }
                self.conn.execute(
                    "UPDATE doc SET body = ?2, rev = rev + 1, updated_at = ?3 WHERE item_id = ?1",
                    rusqlite::params![item_id, body, now],
                )?;
                self.orphan_comment_anchors(item_id, now)?;
                self.review_conflict_all(item_id, now)?;
                // COUNTED THE WAY THE INDEX COUNTS, through `document_text`, so
                // the delta this subtracts from the baseline and the total the
                // bar reads cannot be two different arithmetics. A body that
                // cannot be read contributes nothing either way, which is what
                // `WordIndex` does with one.
                let words_of = |b: &str| -> i64 {
                    super::document_text(b)
                        .map(|t| crate::words::count_words(&t) as i64)
                        .unwrap_or(0)
                };
                net_words += words_of(body) - words_of(&was);
                let version_id = snapshot_versions.get(item_id).copied().ok_or(StoreError::NotFound {
                    item_id: item_id.to_string(),
                })?;
                written.push(AcceptedDoc {
                    item_id: item_id.clone(),
                    version_id,
                    rev: rev + 1,
                    body: body.clone(),
                });
            }

            source_words::record(&self.conn, &source_movements)?;

            if let Some(baseline) = self
                .get_meta(crate::projects::DAY_BASELINE_KEY)?
                .and_then(|v| v.parse::<i64>().ok())
            {
                // SATURATING AT ZERO. A baseline is a word count and a negative
                // one would make today's figure larger than the manuscript.
                let next = (baseline + net_words).max(0);
                self.set_meta(crate::projects::DAY_BASELINE_KEY, &next.to_string())?;
            }

            Ok(AcceptReport {
                documents: written,
                snapshot: SnapshotSummary {
                    id: snapshot_id,
                    label: label.to_string(),
                    created_at: now,
                    documents: docs.len() as i64,
                },
                net_words,
            })
        })();
        match outcome {
            Ok(v) => {
                commit(&self.conn)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Undo one accepted mirror document from its exact pre-accept snapshot.
    pub fn undo_mirror_accept(
        &self,
        item_id: &str,
        version_id: i64,
        snapshot_id: i64,
        accepted_rev: i64,
    ) -> Result<RestoredDoc> {
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<RestoredDoc> {
            let body: Option<String> = self
                .conn
                .query_row(
                    "SELECT b.body FROM doc_version v JOIN blob b ON b.key = v.blob_key
                     WHERE v.id = ?1 AND v.item_id = ?2 AND v.snapshot_id = ?3",
                    rusqlite::params![version_id, item_id, snapshot_id],
                    |r| r.get(0),
                )
                .optional()?;
            let body = body.ok_or(StoreError::NotFound {
                item_id: format!("version {version_id} of {item_id} in snapshot {snapshot_id}"),
            })?;
            let current: Option<(String, i64)> = self
                .conn
                .query_row(
                    "SELECT body, rev FROM doc WHERE item_id = ?1",
                    [item_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (current_body, rev) = current.ok_or(StoreError::NotFound {
                item_id: item_id.to_string(),
            })?;
            if rev != accepted_rev {
                return Err(StoreError::Conflict {
                    item_id: item_id.to_string(),
                });
            }
            let movement = source_words::eligible(&self.conn, item_id)?.then(|| {
                source_words::directional(
                    WordSource::Restored,
                    Some(&current_body),
                    &body,
                )
            });
            self.insert_version(item_id, &current_body, now, None)?;
            self.conn.execute(
                "UPDATE doc SET body = ?2, rev = rev + 1, updated_at = ?3 WHERE item_id = ?1",
                rusqlite::params![item_id, body, now],
            )?;
            self.orphan_comment_anchors(item_id, now)?;
            self.review_conflict_all(item_id, now)?;
            if let Some(movement) = movement {
                source_words::record(&self.conn, &[movement])?;
            }
            if let Some(baseline) = self
                .get_meta(crate::projects::DAY_BASELINE_KEY)?
                .and_then(|v| v.parse::<i64>().ok())
            {
                let words_of = |value: &str| -> i64 {
                    super::document_text(value)
                        .map(|text| crate::words::count_words(&text) as i64)
                        .unwrap_or(0)
                };
                let next = (baseline + words_of(&body) - words_of(&current_body)).max(0);
                self.set_meta(crate::projects::DAY_BASELINE_KEY, &next.to_string())?;
            }
            Ok(RestoredDoc { rev: rev + 1, body })
        })();
        match outcome {
            Ok(value) => {
                commit(&self.conn)?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn snapshots(&self) -> Result<Vec<SnapshotSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.label, s.created_at, COUNT(v.id)
               FROM snapshot s LEFT JOIN doc_version v ON v.snapshot_id = s.id
              GROUP BY s.id ORDER BY s.created_at DESC, s.id DESC",
        )?;
        let out = stmt
            .query_map([], |r| {
                Ok(SnapshotSummary {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    created_at: r.get(2)?,
                    documents: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(out)
    }

    /// Put the WHOLE manuscript back to a named moment.
    ///
    /// Captures each changed document's current body first, exactly as
    /// `doc_restore` does, so the operation with the largest blast radius in
    /// this application is also reversible.
    ///
    /// A document whose body already equals the snapshot's is left alone: no
    /// version, no rev bump. Otherwise a restore of an untouched manuscript
    /// would write fifteen thousand rows saying nothing changed, and every
    /// open document's rev would go stale for nothing.
    ///
    /// A document created SINCE the snapshot is not in it and is NOT deleted.
    /// Restoring a moment must not destroy work that moment did not contain --
    /// the writer asked to get something back, not to lose something else.
    pub fn snapshot_restore(&self, snapshot_id: i64) -> Result<RestoredSnapshot> {
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<RestoredSnapshot> {
            let mut stmt = self.conn.prepare(
                "SELECT v.item_id, b.body, d.body
                   FROM doc_version v
                   JOIN blob b ON b.key = v.blob_key
                   JOIN doc d ON d.item_id = v.item_id
                  WHERE v.snapshot_id = ?1",
            )?;
            let rows: Vec<(String, String, String)> = stmt
                .query_map([snapshot_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<std::result::Result<_, _>>()?;
            drop(stmt);
            if rows.is_empty() {
                return Err(StoreError::NotFound {
                    item_id: format!("snapshot {snapshot_id}"),
                });
            }
            let covered = rows.len() as i64;
            let mut changed = 0i64;
            let mut source_movements: Vec<DatedMovement> = Vec::new();
            for (item_id, was, current) in &rows {
                if was == current {
                    continue;
                }
                if source_words::eligible(&self.conn, item_id)? {
                    source_movements.push(source_words::directional(
                        WordSource::Restored,
                        Some(current),
                        was,
                    ));
                }
                self.insert_version(item_id, current, now, None)?;
                self.conn.execute(
                    "UPDATE doc SET body = ?2, rev = rev + 1, updated_at = ?3 WHERE item_id = ?1",
                    rusqlite::params![item_id, was, now],
                )?;
                // Every changed document, for `doc_restore`'s reason. Only the
                // changed ones: a document already equal to the snapshot was
                // not rewritten, so its notes still describe its prose.
                self.orphan_comment_anchors(item_id, now)?;
                self.review_conflict_all(item_id, now)?;
                changed += 1;
            }
            source_words::record(&self.conn, &source_movements)?;
            Ok(RestoredSnapshot {
                documents: changed,
                covered,
            })
        })();
        match outcome {
            Ok(v) => {
                commit(&self.conn)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::FlushEntry;
    use tempfile::tempdir;

    const HOUR: i64 = HOUR_MS;
    const DAY: i64 = DAY_MS;

    fn body(text: &str) -> String {
        format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":{}}}]}}]}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    /// A store with one scene holding `text`, and that scene's id and rev.
    fn seeded(text: &str) -> (tempfile::TempDir, Store, String, i64) {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let created = store.item_create(None, "scene", "One").unwrap();
        let acks = store
            .flush(&[FlushEntry {
                item_id: created.id.clone(),
                body: body(text),
                base_rev: created.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        let rev = acks[0].rev;
        (dir, store, created.id, rev)
    }

    fn write(store: &Store, id: &str, text: &str, base_rev: i64) -> i64 {
        store
            .flush(&[FlushEntry {
                item_id: id.to_string(),
                body: body(text),
                base_rev,
                comments: None,
            }])
            .unwrap()[0]
            .rev
    }

    fn blob_count(store: &Store) -> i64 {
        store
            .conn
            .query_row("SELECT COUNT(*) FROM blob", [], |r| r.get(0))
            .unwrap()
    }

    // ---- thin: the retention policy, over timestamps alone ----

    #[test]
    fn everything_inside_the_last_hour_survives() {
        let now = 10 * DAY;
        let created: Vec<i64> = (0..12).map(|i| now - i * 60_000).collect();
        assert!(thin(now, &created).is_empty());
    }

    #[test]
    fn beyond_an_hour_only_the_newest_in_each_hour_survives() {
        let now = 10 * DAY;
        // Three versions inside one hour bucket, two hours back, plus one in
        // the bucket before it. Only the newest of the three may survive.
        let base = (now - 2 * HOUR).div_euclid(HOUR) * HOUR;
        let created = vec![base + 3000, base + 2000, base + 1000, base - HOUR];
        assert_eq!(thin(now, &created), vec![1, 2]);
    }

    #[test]
    fn beyond_a_day_only_the_newest_in_each_day_survives() {
        let now = 10 * DAY;
        let base = (now - 3 * DAY).div_euclid(DAY) * DAY;
        let created = vec![base + 5000, base + 4000, base - DAY];
        assert_eq!(thin(now, &created), vec![1]);
    }

    #[test]
    fn the_last_hour_is_INCLUSIVE_at_exactly_one_hour() {
        // The boundary itself. Both versions here sit in ONE absolute hour
        // bucket, so the two readings of the boundary give different answers:
        // inclusive keeps both (the first is "inside the last hour", the second
        // is the first in its bucket); exclusive sends both to the bucket
        // branch and drops the older. A fixture with nothing AT the boundary
        // cannot tell them apart, which is how this went untested.
        let base = 100 * DAY + HOUR / 2;
        let created = vec![base - HOUR, base - HOUR - 1000];
        assert_eq!(thin(base, &created), Vec::<usize>::new());
    }

    #[test]
    fn the_cap_is_applied_to_survivors_not_to_the_raw_list() {
        // Every version is inside the last hour, so the thinning rules keep
        // them all and the cap is the only thing that cuts. Applying the cap
        // BEFORE thinning would spend the whole budget on the last hour and
        // drop older versions the policy deliberately kept - this is the
        // fixture that tells the two orders apart, because here they agree,
        // and the next test is where they do not.
        let now = 10 * DAY;
        let created: Vec<i64> = (0..MAX_AUTO_VERSIONS as i64 + 5)
            .map(|i| now - i * 1000)
            .collect();
        let doomed = thin(now, &created);
        assert_eq!(doomed.len(), 5);
        // The OLDEST five, not the newest.
        assert_eq!(doomed, vec![60, 61, 62, 63, 64]);
    }

    #[test]
    fn the_cap_counts_survivors_even_when_thinning_has_dropped_many_before_them() {
        // The fixture that tells the two orders apart, which the test below did
        // NOT: here the survivor index and the raw index diverge long before
        // the budget runs out, because bucketing drops every second old
        // version. Capping the RAW list stops at raw index 60 and throws away
        // every day older than that; capping the SURVIVORS carries on until 60
        // versions have actually been kept.
        let now = 200 * DAY;
        let mut created: Vec<i64> = (0..10).map(|i| now - i * 60_000).collect();
        // 55 distinct days, two versions in each: bucketing keeps one per day.
        for day in 2..57i64 {
            let base = (now - day * DAY).div_euclid(DAY) * DAY;
            created.push(base + 5000);
            created.push(base + 1000);
        }
        let doomed = thin(now, &created);
        let kept = created.len() - doomed.len();
        assert_eq!(kept, MAX_AUTO_VERSIONS);
        // And what survived reaches back past raw index 60, which is the half a
        // raw-index cap cannot do.
        let survived: Vec<usize> = (0..created.len()).filter(|i| !doomed.contains(i)).collect();
        assert!(
            survived.iter().any(|i| *i > MAX_AUTO_VERSIONS),
            "the policy kept something past raw index {MAX_AUTO_VERSIONS}: {survived:?}",
        );
    }

    #[test]
    fn a_kept_old_version_is_not_evicted_by_a_busy_last_hour() {
        // MAX_AUTO_VERSIONS inside the last hour plus one that is a week old.
        // Capping the raw list first keeps the week-old one (it is index 60 of
        // 61 and would survive a cap of 60 only by luck); capping the SURVIVORS
        // in one pass drops it, because the budget is already spent. Both
        // orders lose something here, which is why the policy states which:
        // the cap is a backstop on unbounded growth, and it cuts oldest-first.
        let now = 10 * DAY;
        let mut created: Vec<i64> = (0..MAX_AUTO_VERSIONS as i64)
            .map(|i| now - i * 1000)
            .collect();
        created.push(now - 7 * DAY);
        let doomed = thin(now, &created);
        assert_eq!(doomed, vec![MAX_AUTO_VERSIONS]);
    }

    #[test]
    fn buckets_are_absolute_so_the_kept_version_does_not_move_as_time_passes() {
        // A relative bucket shifts under every call, so the version kept for
        // "three hours ago" changes as the afternoon passes and the history a
        // writer looked at a minute ago is not the history they see now.
        //
        // THE FIXTURE STRADDLES A BUCKET EDGE, and it has to. Two versions
        // seconds apart land in the same bucket under either rule at any `now`,
        // so the first version of this test compared two answers that agreed
        // for a reason having nothing to do with the property -- and a relative
        // bucket survived it. These two are almost an hour apart and sit in ONE
        // absolute bucket; under a relative rule they share a bucket at the
        // first `now` and not at the second.
        let base = (100 * DAY).div_euclid(HOUR) * HOUR;
        let newer = base + HOUR - 100;
        let older = base + 100;
        let created = vec![newer, older];
        let early = thin(base + 2 * HOUR, &created);
        let later = thin(base + 2 * HOUR + 200, &created);
        assert_eq!(early, vec![1], "the older of two in one bucket is dropped");
        assert_eq!(
            later, early,
            "the same two versions, read 200 ms later, must give the same answer",
        );
    }

    // ---- blobs ----

    #[test]
    fn one_body_is_stored_once_however_many_versions_point_at_it() {
        let (_d, store, id, rev) = seeded("hello");
        store
            .record_versions_at(
                &[FlushEntry {
                    item_id: id.clone(),
                    body: body("hello"),
                    base_rev: rev,
                    comments: None,
                }],
                0,
            )
            .unwrap();
        store
            .insert_version(&id, &body("hello"), AUTO_INTERVAL_MS * 3, None)
            .unwrap();
        assert_eq!(store.doc_versions(&id).unwrap().len(), 2);
        assert_eq!(blob_count(&store), 1);
    }

    #[test]
    fn a_planted_collision_is_detected_and_probed_past() {
        // The probe loop is unreachable through any real body, so without a
        // planted collision it is code a reader would credit and nothing would
        // exercise. A hash is VERIFIED here rather than trusted because the
        // failure it prevents is a restore handing the writer someone else's
        // prose, silently.
        let (_d, store, _id, _rev) = seeded("hello");
        let mine = body("the real text");
        let key = format!("{:016x}", hash64(mine.as_bytes()));
        store
            .conn
            .execute(
                "INSERT INTO blob (key, body) VALUES (?1, ?2)",
                rusqlite::params![key, "SOMEBODY ELSE'S PROSE"],
            )
            .unwrap();

        let got = store.blob_key(&mine).unwrap();

        assert_eq!(got, format!("{key}-1"));
        let stored: String = store
            .conn
            .query_row("SELECT body FROM blob WHERE key = ?1", [&got], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, mine);
    }

    #[test]
    fn a_second_collision_on_the_same_key_probes_further() {
        let (_d, store, _id, _rev) = seeded("hello");
        let mine = body("mine");
        let key = format!("{:016x}", hash64(mine.as_bytes()));
        for suffix in ["", "-1"] {
            store
                .conn
                .execute(
                    "INSERT INTO blob (key, body) VALUES (?1, ?2)",
                    rusqlite::params![format!("{key}{suffix}"), format!("other{suffix}")],
                )
                .unwrap();
        }
        assert_eq!(store.blob_key(&mine).unwrap(), format!("{key}-2"));
    }

    #[test]
    fn a_probed_slot_holding_the_same_body_is_reused_rather_than_probed_past() {
        let (_d, store, _id, _rev) = seeded("hello");
        let mine = body("mine");
        let key = format!("{:016x}", hash64(mine.as_bytes()));
        store
            .conn
            .execute(
                "INSERT INTO blob (key, body) VALUES (?1, ?2)",
                rusqlite::params![key, "not mine"],
            )
            .unwrap();
        let first = store.blob_key(&mine).unwrap();
        let second = store.blob_key(&mine).unwrap();
        assert_eq!(first, second);
        assert_eq!(blob_count(&store), 2);
    }

    // ---- the automatic path ----

    #[test]
    fn a_document_with_no_history_gets_a_version_on_its_first_flush() {
        let (_d, store, id, rev) = seeded("one");
        let n = store
            .record_versions_at(
                &[FlushEntry {
                    item_id: id.clone(),
                    body: body("one"),
                    base_rev: rev,
                    comments: None,
                }],
                1_000,
            )
            .unwrap();
        assert_eq!(n, 1);
        let versions = store.doc_versions(&id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].words, 1);
        assert_eq!(versions[0].snapshot_id, None);
    }

    #[test]
    fn a_second_flush_inside_the_interval_records_nothing() {
        let (_d, store, id, rev) = seeded("one");
        let e = |t: &str| FlushEntry {
            item_id: id.clone(),
            body: body(t),
            base_rev: rev,
            comments: None,
        };
        store.record_versions_at(&[e("one")], 1_000).unwrap();

        let n = store
            .record_versions_at(&[e("one two")], 1_000 + AUTO_INTERVAL_MS - 1)
            .unwrap();

        assert_eq!(n, 0);
        assert_eq!(store.doc_versions(&id).unwrap().len(), 1);
    }

    #[test]
    fn a_flush_past_the_interval_records_a_version() {
        let (_d, store, id, rev) = seeded("one");
        let e = |t: &str| FlushEntry {
            item_id: id.clone(),
            body: body(t),
            base_rev: rev,
            comments: None,
        };
        store.record_versions_at(&[e("one")], 1_000).unwrap();

        let n = store
            .record_versions_at(&[e("one two")], 1_000 + AUTO_INTERVAL_MS)
            .unwrap();

        assert_eq!(n, 1);
        let versions = store.doc_versions(&id).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].words, 2, "newest first");
    }

    #[test]
    fn an_unchanged_body_past_the_interval_records_nothing() {
        // Without this a writer who leaves a scene open accumulates a version
        // every five minutes saying nothing happened, and the retention policy
        // then spends its budget on them.
        let (_d, store, id, rev) = seeded("one");
        let e = FlushEntry {
            item_id: id.clone(),
            body: body("one"),
            base_rev: rev,
            comments: None,
        };
        store
            .record_versions_at(std::slice::from_ref(&e), 1_000)
            .unwrap();

        let n = store
            .record_versions_at(std::slice::from_ref(&e), 1_000 + AUTO_INTERVAL_MS * 4)
            .unwrap();

        assert_eq!(n, 0);
        assert_eq!(store.doc_versions(&id).unwrap().len(), 1);
    }

    #[test]
    fn pruning_frees_a_blob_nothing_points_at_any_more() {
        let (_d, store, id, rev) = seeded("x");
        let e = |t: &str| FlushEntry {
            item_id: id.clone(),
            body: body(t),
            base_rev: rev,
            comments: None,
        };
        // Two days apart, so the day bucket keeps one of each and the middle
        // one is dropped along with its blob.
        store.record_versions_at(&[e("a")], 0).unwrap();
        store.record_versions_at(&[e("b")], DAY / 2).unwrap();
        assert_eq!(blob_count(&store), 2);

        store.record_versions_at(&[e("c")], 10 * DAY).unwrap();

        let versions = store.doc_versions(&id).unwrap();
        assert_eq!(
            versions.len(),
            2,
            "a and b share a day bucket; b survives it"
        );
        assert_eq!(blob_count(&store), 2);
    }

    #[test]
    fn a_snapshot_version_is_never_pruned() {
        let (_d, store, id, rev) = seeded("x");
        store.snapshot_create("before the cut").unwrap();
        let e = |t: &str| FlushEntry {
            item_id: id.clone(),
            body: body(t),
            base_rev: rev,
            comments: None,
        };
        for i in 0..80i64 {
            store
                .record_versions_at(&[e(&format!("t{i}"))], i * 40 * DAY)
                .unwrap();
        }
        let versions = store.doc_versions(&id).unwrap();
        assert!(versions
            .iter()
            .any(|v| v.snapshot_label.as_deref() == Some("before the cut")));
        let auto = versions.iter().filter(|v| v.snapshot_id.is_none()).count();
        assert!(
            auto <= MAX_AUTO_VERSIONS,
            "auto versions are capped, got {auto}"
        );
    }

    // ---- restore ----

    #[test]
    fn restore_returns_the_stored_text_and_bumps_the_rev() {
        let (_d, store, id, rev) = seeded("the first draft");
        store
            .record_versions_at(
                &[FlushEntry {
                    item_id: id.clone(),
                    body: body("the first draft"),
                    base_rev: rev,
                    comments: None,
                }],
                0,
            )
            .unwrap();
        let vid = store.doc_versions(&id).unwrap()[0].id;
        let rev = write(&store, &id, "a much worse draft", rev);

        let restored = store.doc_restore(&id, vid, rev).unwrap();

        assert_eq!(restored.body, body("the first draft"));
        assert_eq!(restored.rev, rev + 1);
        assert_eq!(store.load_doc(&id).unwrap().body, body("the first draft"));
    }

    #[test]
    fn restore_captures_what_it_overwrites_so_it_is_itself_undoable() {
        // The one property that keeps this feature from having a path that
        // loses work.
        let (_d, store, id, rev) = seeded("first");
        store
            .record_versions_at(
                &[FlushEntry {
                    item_id: id.clone(),
                    body: body("first"),
                    base_rev: rev,
                    comments: None,
                }],
                0,
            )
            .unwrap();
        let first_version = store.doc_versions(&id).unwrap()[0].id;
        let rev = write(&store, &id, "second", rev);

        store.doc_restore(&id, first_version, rev).unwrap();

        let after = store.doc_versions(&id).unwrap();
        let bodies: Vec<String> = after
            .iter()
            .map(|v| store.version_body(v.id).unwrap())
            .collect();
        assert!(
            bodies.contains(&body("second")),
            "the overwritten body is in history"
        );
        // And restoring THAT gets it back.
        let second_version = after
            .iter()
            .find(|v| store.version_body(v.id).unwrap() == body("second"))
            .unwrap()
            .id;
        let rev = store.load_doc(&id).unwrap().rev;
        let back = store.doc_restore(&id, second_version, rev).unwrap();
        assert_eq!(back.body, body("second"));
    }

    #[test]
    fn restore_refuses_a_stale_rev_and_changes_nothing() {
        let (_d, store, id, rev) = seeded("first");
        store
            .record_versions_at(
                &[FlushEntry {
                    item_id: id.clone(),
                    body: body("first"),
                    base_rev: rev,
                    comments: None,
                }],
                0,
            )
            .unwrap();
        let vid = store.doc_versions(&id).unwrap()[0].id;
        let rev = write(&store, &id, "second", rev);
        let versions_before = store.doc_versions(&id).unwrap().len();

        let err = store.doc_restore(&id, vid, rev - 1).unwrap_err();

        assert!(matches!(err, StoreError::Conflict { .. }), "got {err:?}");
        assert_eq!(store.load_doc(&id).unwrap().body, body("second"));
        assert_eq!(
            store.doc_versions(&id).unwrap().len(),
            versions_before,
            "the refused restore captured nothing"
        );
    }

    #[test]
    fn a_restore_orphans_the_notes_on_the_body_it_overwrote() {
        // The passage a note was about is gone, and the store has no mapping
        // from the replaced body to the restored one. Keeping the offsets would
        // silently re-anchor every note onto whatever prose now sits there.
        let (_dir, store, id, rev) = seeded("the alpine air");
        let note = store
            .comment_create(&id, "does she know?", 4, 10, "alpine")
            .unwrap();
        store
            .record_versions_at(
                &[FlushEntry {
                    item_id: id.clone(),
                    body: body("the alpine air"),
                    base_rev: rev,
                    comments: None,
                }],
                0,
            )
            .unwrap();
        let target = store.doc_versions(&id).unwrap()[0].id;
        let rev = write(&store, &id, "somewhere else entirely", rev);

        store.doc_restore(&id, target, rev).unwrap();

        let after = store.comments(&id).unwrap();
        // KEPT, not deleted: the writer wrote this about their own book.
        assert_eq!(after.len(), 1, "the note must survive the restore");
        assert_eq!(after[0].id, note.id);
        assert_eq!(after[0].body, "does she know?");
        // And it still says what the passage used to be.
        assert_eq!(after[0].quote, "alpine");
        assert!(after[0].orphaned, "the anchor must read as an orphan");
    }

    #[test]
    fn a_manuscript_wide_replace_orphans_the_notes_it_rewrote() {
        let (_dir, store, id, _rev) = seeded("the alpine air");
        store
            .comment_create(&id, "does she know?", 4, 10, "alpine")
            .unwrap();

        let report = store
            .replace_everywhere(
                &std::collections::HashSet::new(),
                "alpine",
                "coastal",
                "before replacing",
            )
            .unwrap();
        assert_eq!(
            report.documents, 1,
            "the fixture must actually be rewritten"
        );

        let after = store.comments(&id).unwrap();
        assert_eq!(after.len(), 1);
        assert!(after[0].orphaned, "the anchor must read as an orphan");
    }

    #[test]
    fn a_snapshot_restore_orphans_the_notes_on_every_document_it_changed() {
        let (_dir, store, id, rev) = seeded("the alpine air");
        store
            .comment_create(&id, "does she know?", 4, 10, "alpine")
            .unwrap();
        let snap = store.snapshot_create("act one").unwrap();
        write(&store, &id, "somewhere else entirely", rev);

        let restored = store.snapshot_restore(snap.id).unwrap();
        assert_eq!(restored.documents, 1, "the fixture must actually change");

        let after = store.comments(&id).unwrap();
        assert_eq!(after.len(), 1);
        assert!(after[0].orphaned, "the anchor must read as an orphan");
    }

    #[test]
    fn a_snapshot_restore_leaves_an_UNCHANGED_document_s_notes_alone() {
        // The counterpart claim, and the one that makes the three above mean
        // something: collapsing is not "a restore orphans everything", it is
        // "a rewritten body orphans its own notes". A document already equal to
        // the snapshot was never rewritten.
        let (_dir, store, id, _rev) = seeded("the alpine air");
        store
            .comment_create(&id, "does she know?", 4, 10, "alpine")
            .unwrap();
        let snap = store.snapshot_create("act one").unwrap();

        let restored = store.snapshot_restore(snap.id).unwrap();
        assert_eq!(restored.documents, 0, "nothing should have been rewritten");

        let after = store.comments(&id).unwrap();
        assert!(
            !after[0].orphaned,
            "an untouched document keeps its anchors"
        );
        assert_eq!((after[0].anchor_from, after[0].anchor_to), (4, 10));
    }

    #[test]
    fn a_version_of_ANOTHER_SCENE_cannot_be_restored_into_this_one() {
        // The worst thing this feature could do: write scene A's old prose over
        // scene B and report it as a success. `version_body` looks a version up
        // by id alone, so nothing but this check stands between a stale listing
        // and that.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let a = store.item_create(None, "scene", "A").unwrap();
        let b = store.item_create(None, "scene", "B").unwrap();
        write(&store, &a.id, "scene A's prose", a.doc_rev.unwrap());
        let b_rev = write(&store, &b.id, "scene B's prose", b.doc_rev.unwrap());
        store
            .record_versions_at(
                &[FlushEntry {
                    item_id: a.id.clone(),
                    body: body("scene A's prose"),
                    base_rev: 2,
                    comments: None,
                }],
                0,
            )
            .unwrap();
        let a_version = store.doc_versions(&a.id).unwrap()[0].id;

        let err = store.doc_restore(&b.id, a_version, b_rev).unwrap_err();

        assert!(matches!(err, StoreError::NotFound { .. }), "got {err:?}");
        assert_eq!(store.load_doc(&b.id).unwrap().body, body("scene B's prose"));
    }

    #[test]
    fn restoring_an_unknown_version_is_not_found() {
        let (_d, store, id, rev) = seeded("x");
        assert!(matches!(
            store.doc_restore(&id, 4242, rev).unwrap_err(),
            StoreError::NotFound { .. }
        ));
    }

    // ---- snapshots ----

    #[test]
    fn a_snapshot_covers_every_document() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        for i in 0..4 {
            let c = store.item_create(None, "scene", &format!("S{i}")).unwrap();
            write(&store, &c.id, &format!("scene {i}"), c.doc_rev.unwrap());
        }

        let snap = store.snapshot_create("end of act one").unwrap();

        assert_eq!(snap.documents, 4);
        assert_eq!(store.snapshots().unwrap(), vec![snap]);
    }

    #[test]
    fn a_second_snapshot_over_an_unedited_manuscript_adds_no_blobs() {
        // The whole affordability argument for content addressing. Without it
        // every snapshot is another copy of the book.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        for i in 0..6 {
            let c = store.item_create(None, "scene", &format!("S{i}")).unwrap();
            write(&store, &c.id, &format!("scene {i}"), c.doc_rev.unwrap());
        }
        store.snapshot_create("one").unwrap();
        let after_first = blob_count(&store);

        store.snapshot_create("two").unwrap();

        assert_eq!(blob_count(&store), after_first);
        assert!(
            after_first >= 6,
            "the first snapshot did write blobs: {after_first}"
        );
    }

    #[test]
    fn restoring_a_snapshot_reverts_every_changed_document_and_counts_only_those() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let mut ids = Vec::new();
        for i in 0..3 {
            let c = store.item_create(None, "scene", &format!("S{i}")).unwrap();
            let rev = write(&store, &c.id, &format!("original {i}"), c.doc_rev.unwrap());
            ids.push((c.id, rev));
        }
        let snap = store.snapshot_create("before the cut").unwrap();
        write(&store, &ids[0].0, "ruined", ids[0].1);
        write(&store, &ids[1].0, "also ruined", ids[1].1);

        let out = store.snapshot_restore(snap.id).unwrap();

        assert_eq!(out.covered, 3);
        assert_eq!(out.documents, 2, "the untouched document was left alone");
        for (i, (id, _)) in ids.iter().enumerate() {
            assert_eq!(
                store.load_doc(id).unwrap().body,
                body(&format!("original {i}"))
            );
        }
    }

    #[test]
    fn restoring_a_snapshot_captures_what_it_overwrites() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let c = store.item_create(None, "scene", "S").unwrap();
        let rev = write(&store, &c.id, "original", c.doc_rev.unwrap());
        let snap = store.snapshot_create("keep").unwrap();
        write(&store, &c.id, "a whole afternoon of new work", rev);

        store.snapshot_restore(snap.id).unwrap();

        let bodies: Vec<String> = store
            .doc_versions(&c.id)
            .unwrap()
            .iter()
            .map(|v| store.version_body(v.id).unwrap())
            .collect();
        assert!(
            bodies.contains(&body("a whole afternoon of new work")),
            "restoring a snapshot must not be the one operation that loses work"
        );
    }

    #[test]
    fn a_document_created_since_the_snapshot_is_left_alone() {
        // Restoring a moment must not destroy work that moment did not contain.
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("p.db")).unwrap();
        let old = store.item_create(None, "scene", "Old").unwrap();
        write(&store, &old.id, "original", old.doc_rev.unwrap());
        let snap = store.snapshot_create("before").unwrap();
        let new = store.item_create(None, "scene", "New").unwrap();
        write(
            &store,
            &new.id,
            "written after the snapshot",
            new.doc_rev.unwrap(),
        );

        store.snapshot_restore(snap.id).unwrap();

        assert_eq!(
            store.load_doc(&new.id).unwrap().body,
            body("written after the snapshot")
        );
        assert_eq!(store.items().unwrap().len(), 2);
    }

    #[test]
    fn restoring_an_unknown_snapshot_is_not_found() {
        let (_d, store, _id, _rev) = seeded("x");
        assert!(matches!(
            store.snapshot_restore(999).unwrap_err(),
            StoreError::NotFound { .. }
        ));
    }

    #[test]
    fn a_versions_listing_names_the_snapshot_a_version_belongs_to() {
        let (_d, store, id, rev) = seeded("x");
        store
            .record_versions_at(
                &[FlushEntry {
                    item_id: id.clone(),
                    body: body("x"),
                    base_rev: rev,
                    comments: None,
                }],
                0,
            )
            .unwrap();
        store.snapshot_create("act one").unwrap();

        let versions = store.doc_versions(&id).unwrap();

        let named: Vec<_> = versions
            .iter()
            .filter_map(|v| v.snapshot_label.as_deref())
            .collect();
        assert_eq!(named, vec!["act one"]);
    }

    /// `thin` is `thin_with_cap` at the version cap and nothing else. Pins the
    /// extraction as pure motion: a fixture long enough that the cap is what
    /// cuts it, so a wrong default would be visible here rather than only in a
    /// history run.
    #[test]
    fn thin_is_thin_with_cap_at_the_version_cap() {
        let now = 1_787_174_042_000i64;
        let created: Vec<i64> = (0..MAX_AUTO_VERSIONS as i64 + 10)
            .map(|i| now - i * 60_000)
            .collect();
        assert_eq!(
            thin(now, &created),
            thin_with_cap(now, &created, MAX_AUTO_VERSIONS)
        );
        assert!(
            !thin(now, &created).is_empty(),
            "the fixture must reach the cap"
        );
    }

    #[test]
    fn a_streamed_hash_equals_a_whole_buffer_hash() {
        let body = b"the quick brown fox jumps over the lazy dog";
        let streamed = body
            .chunks(7)
            .fold(FNV_OFFSET, |h, chunk| hash64_update(h, chunk));
        assert_eq!(streamed, hash64(body));
        // Vacuity guard: a chunk size that does not actually split the input
        // would make this test agree with any implementation.
        assert!(body.chunks(7).count() > 1);
    }

    // ---- accepting a change from the readable mirror ----------------------
    //
    // THE FOURTH BODY-REWRITE PATH. `doc_restore`, `replace_everywhere` and
    // `snapshot_restore` are the other three, and plan 001's write-back names
    // this one in advance as where its defect class comes back. Every rule
    // those three carry is restated here as a test rather than inherited by
    // analogy -- the recorded trap is exactly that a test inherited from a
    // passing precedent is not thereby earned.

    const MIRROR_LABEL: &str = "Before accepting 1 change from the readable folder";

    #[test]
    fn accepting_captures_what_it_overwrites_under_a_named_snapshot() {
        let (_dir, store, id, rev) = seeded("the words the book had");
        let report = store
            .accept_from_mirror(
                &[(id.clone(), rev, body("the words the file had"))],
                MIRROR_LABEL,
            )
            .unwrap();

        assert_eq!(report.snapshot.label, MIRROR_LABEL);
        assert_eq!(report.documents.len(), 1);
        assert_eq!(
            store.load_doc(&id).unwrap().body,
            body("the words the file had")
        );

        // THE SNAPSHOT IS THE INVERSE, and it is the only one. Restoring it
        // puts the book back, which is the whole of what "an accept is
        // undoable" is allowed to mean in a repository with no structural undo.
        store.snapshot_restore(report.snapshot.id).unwrap();
        assert_eq!(
            store.load_doc(&id).unwrap().body,
            body("the words the book had")
        );
    }

    #[test]
    fn an_accepted_body_orphans_ITS_OWN_notes_and_leaves_every_other_documents_alone() {
        // The rule plan 001 established across the other three paths, restated
        // on the fourth. An anchor is a pair of positions into a body that no
        // longer exists; to this store the two are unrelated documents, so
        // there is no mapping to attempt and silently re-anchoring is what
        // `comments.rs`' header calls the worst thing the feature can do.
        let (dir, store, id, rev) = seeded("the words the book had");
        let other = store.item_create(None, "scene", "Two").unwrap();
        store
            .flush(&[FlushEntry {
                item_id: other.id.clone(),
                body: body("a scene nobody accepted"),
                base_rev: other.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        let mine = store
            .comment_create(&id, "look here", 4, 11, "words")
            .unwrap();
        let theirs = store
            .comment_create(&other.id, "and here", 4, 11, "scene")
            .unwrap();

        store
            .accept_from_mirror(
                &[(id.clone(), rev, body("the words the file had"))],
                MIRROR_LABEL,
            )
            .unwrap();

        let mine_now = store.comments(&id).unwrap();
        assert_eq!(mine_now.len(), 1);
        assert_eq!(
            mine_now[0].anchor_from, mine_now[0].anchor_to,
            "an accepted body must orphan its own notes"
        );
        assert_eq!(mine_now[0].body, mine.body, "and must keep what they say");
        assert_eq!(mine_now[0].quote, mine.quote, "and what they quoted");

        let theirs_now = store.comments(&other.id).unwrap();
        assert!(
            theirs_now[0].anchor_from < theirs_now[0].anchor_to,
            "a document nobody accepted must keep its anchors: {theirs:?}"
        );
        drop(dir);
    }

    #[test]
    fn accepting_moves_the_DOCUMENT_revision_and_never_the_ITEM_revision() {
        // The revision state lives on the item row under the item's rev, and
        // the design is explicit that acceptance carries no information about
        // it. Moving `item.rev` would also make the mirror's three-way skip
        // rewrite the file on the next pass for a change it already holds.
        let (_dir, store, id, rev) = seeded("the words the book had");
        let item_rev_before = store
            .items()
            .unwrap()
            .into_iter()
            .find(|i| i.id == id)
            .unwrap()
            .rev;

        let report = store
            .accept_from_mirror(
                &[(id.clone(), rev, body("the words the file had"))],
                MIRROR_LABEL,
            )
            .unwrap();

        assert_eq!(report.documents[0].rev, rev + 1);
        assert_eq!(store.load_doc(&id).unwrap().rev, rev + 1);
        assert_eq!(
            store
                .items()
                .unwrap()
                .into_iter()
                .find(|i| i.id == id)
                .unwrap()
                .rev,
            item_rev_before,
            "the item row must not move"
        );
    }

    #[test]
    fn an_accept_against_a_revision_that_has_moved_is_refused_WHOLE() {
        // `doc_restore`'s rule and `flush`'s: an accept issued while an edit is
        // in flight would discard the edit silently. The refusal is the whole
        // batch -- a partially accepted change set, some scenes from the file
        // and some from the book, is a state of the book nobody chose.
        let (_dir, store, id, rev) = seeded("the words the book had");
        let other = store.item_create(None, "scene", "Two").unwrap();
        store
            .flush(&[FlushEntry {
                item_id: other.id.clone(),
                body: body("still the book's"),
                base_rev: other.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        let other_rev = store.load_doc(&other.id).unwrap().rev;

        let outcome = store.accept_from_mirror(
            &[
                (other.id.clone(), other_rev, body("the file's words")),
                (id.clone(), rev + 7, body("the file's words")),
            ],
            MIRROR_LABEL,
        );

        assert!(
            matches!(outcome, Err(StoreError::Conflict { .. })),
            "{outcome:?}"
        );
        assert_eq!(
            store.load_doc(&other.id).unwrap().body,
            body("still the book's"),
            "the good half of a refused batch must not land"
        );
        assert!(
            store.snapshots().unwrap().is_empty(),
            "a refused accept must leave no snapshot behind"
        );
    }

    #[test]
    fn accepting_moves_the_day_baseline_by_the_NET_word_delta() {
        // This figure is `current total - day_baseline`, and it is read as a
        // claim about the writer's day. A goal that goes green because 5,000
        // words arrived from a folder is a figure worth less than none. The
        // adjustment rides the same transaction as the bodies, so the two
        // cannot disagree.
        let (_dir, store, id, rev) = seeded("one two three");
        store
            .set_meta(crate::projects::DAY_BASELINE_KEY, "10")
            .unwrap();

        store
            .accept_from_mirror(
                &[(id.clone(), rev, body("one two three four five"))],
                MIRROR_LABEL,
            )
            .unwrap();

        assert_eq!(
            store.get_meta(crate::projects::DAY_BASELINE_KEY).unwrap(),
            Some("12".to_string()),
            "the baseline must absorb the two words that arrived from the folder"
        );
    }

    #[test]
    fn an_accept_with_no_baseline_recorded_writes_none() {
        // A project the writer has not asked a daily figure for today has no
        // baseline row, and the next read anchors one at the total it finds.
        // Writing one here would anchor today's figure at an arbitrary moment.
        let (_dir, store, id, rev) = seeded("one two three");
        store
            .accept_from_mirror(&[(id.clone(), rev, body("one two"))], MIRROR_LABEL)
            .unwrap();
        assert_eq!(
            store.get_meta(crate::projects::DAY_BASELINE_KEY).unwrap(),
            None
        );
    }

    #[test]
    fn undoing_an_accept_restores_its_snapshot_and_captures_the_accepted_words() {
        let (_dir, store, id, rev) = seeded("one two three");
        store
            .set_meta(crate::projects::DAY_BASELINE_KEY, "10")
            .unwrap();
        let report = store
            .accept_from_mirror(&[(id.clone(), rev, body("one two three four five"))], MIRROR_LABEL)
            .unwrap();
        let accepted = report.documents[0].clone();

        let restored = store
            .undo_mirror_accept(
                &id,
                accepted.version_id,
                report.snapshot.id,
                accepted.rev,
            )
            .unwrap();

        assert_eq!(restored.body, body("one two three"));
        assert_eq!(store.load_doc(&id).unwrap().body, body("one two three"));
        assert_eq!(
            store.get_meta(crate::projects::DAY_BASELINE_KEY).unwrap(),
            Some("10".to_string()),
            "undo must absorb its own negative delta into the existing baseline"
        );
        assert!(
            store
                .doc_versions(&id)
                .unwrap()
                .into_iter()
                .any(|version| store.version_body(version.id).unwrap() == body("one two three four five")),
            "the accepted body must be a durable version before undo overwrites it"
        );
    }

    #[test]
    fn a_stale_or_wrong_mirror_undo_rolls_back_every_effect() {
        let (_dir, store, id, rev) = seeded("one two three");
        store
            .set_meta(crate::projects::DAY_BASELINE_KEY, "10")
            .unwrap();
        let report = store
            .accept_from_mirror(&[(id.clone(), rev, body("one two three four"))], MIRROR_LABEL)
            .unwrap();
        let accepted = report.documents[0].clone();
        let before = store.load_doc(&id).unwrap();
        let versions_before = store.doc_versions(&id).unwrap().len();

        let outcome = store.undo_mirror_accept(
            &id,
            accepted.version_id,
            report.snapshot.id,
            accepted.rev + 1,
        );

        assert!(matches!(outcome, Err(StoreError::Conflict { .. })), "{outcome:?}");
        let after = store.load_doc(&id).unwrap();
        assert_eq!(after.body, before.body);
        assert_eq!(after.rev, before.rev);
        assert_eq!(store.doc_versions(&id).unwrap().len(), versions_before);
        assert_eq!(
            store.get_meta(crate::projects::DAY_BASELINE_KEY).unwrap(),
            Some("11".to_string())
        );
    }

    #[test]
    fn a_mirror_undo_handle_must_name_its_document_version_and_snapshot() {
        let (_dir, store, id, rev) = seeded("one two three");
        let other = store.item_create(None, "scene", "Two").unwrap();
        store
            .flush(&[FlushEntry {
                item_id: other.id.clone(),
                body: body("four five six"),
                base_rev: other.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        let other_rev = store.load_doc(&other.id).unwrap().rev;
        let report = store
            .accept_from_mirror(
                &[
                    (id.clone(), rev, body("one two three four")),
                    (other.id.clone(), other_rev, body("four five six seven")),
                ],
                MIRROR_LABEL,
            )
            .unwrap();
        let mine = report.documents.iter().find(|doc| doc.item_id == id).unwrap();
        let theirs = report.documents.iter().find(|doc| doc.item_id == other.id).unwrap();
        let before = store.load_doc(&id).unwrap();

        for outcome in [
            store.undo_mirror_accept(&id, theirs.version_id, report.snapshot.id, mine.rev),
            store.undo_mirror_accept(&id, mine.version_id, report.snapshot.id + 1, mine.rev),
        ] {
            assert!(matches!(outcome, Err(StoreError::NotFound { .. })), "{outcome:?}");
            let after = store.load_doc(&id).unwrap();
            assert_eq!(after.body, before.body);
            assert_eq!(after.rev, before.rev);
        }
    }

    #[test]
    fn undoing_one_document_from_a_batch_leaves_the_other_and_refuses_a_retry() {
        let (_dir, store, id, rev) = seeded("one two three");
        let other = store.item_create(None, "scene", "Two").unwrap();
        store
            .flush(&[FlushEntry {
                item_id: other.id.clone(),
                body: body("four five six"),
                base_rev: other.doc_rev.unwrap(),
                comments: None,
            }])
            .unwrap();
        let other_rev = store.load_doc(&other.id).unwrap().rev;
        let report = store
            .accept_from_mirror(
                &[
                    (id.clone(), rev, body("one two three four")),
                    (other.id.clone(), other_rev, body("four five six seven")),
                ],
                MIRROR_LABEL,
            )
            .unwrap();
        let mine = report.documents.iter().find(|doc| doc.item_id == id).unwrap().clone();
        let theirs = report.documents.iter().find(|doc| doc.item_id == other.id).unwrap().clone();
        let mine_note = store.comment_create(&id, "mine", 0, 3, "one").unwrap();
        let their_note = store.comment_create(&other.id, "theirs", 0, 4, "four").unwrap();

        store
            .undo_mirror_accept(&id, mine.version_id, report.snapshot.id, mine.rev)
            .unwrap();

        assert_eq!(store.load_doc(&id).unwrap().body, body("one two three"));
        assert_eq!(store.load_doc(&other.id).unwrap().body, theirs.body);
        let mine_after = store.comments(&id).unwrap();
        assert_eq!(mine_after[0].id, mine_note.id);
        assert_eq!(mine_after[0].anchor_from, mine_after[0].anchor_to);
        let theirs_after = store.comments(&other.id).unwrap();
        assert_eq!(theirs_after[0].id, their_note.id);
        assert!(theirs_after[0].anchor_from < theirs_after[0].anchor_to);
        let retry = store.undo_mirror_accept(&id, mine.version_id, report.snapshot.id, mine.rev);
        assert!(matches!(retry, Err(StoreError::Conflict { .. })), "{retry:?}");
    }

    #[test]
    fn undo_keeps_an_absent_baseline_absent_and_floors_a_negative_delta_at_zero() {
        let (_dir, store, id, rev) = seeded("one two three");
        let report = store
            .accept_from_mirror(&[(id.clone(), rev, body("one two three four five"))], MIRROR_LABEL)
            .unwrap();
        let accepted = report.documents[0].clone();
        store
            .undo_mirror_accept(&id, accepted.version_id, report.snapshot.id, accepted.rev)
            .unwrap();
        assert_eq!(store.get_meta(crate::projects::DAY_BASELINE_KEY).unwrap(), None);

        let report = store
            .accept_from_mirror(&[(id.clone(), rev + 2, body("one two three four five"))], MIRROR_LABEL)
            .unwrap();
        let accepted = report.documents[0].clone();
        store
            .set_meta(crate::projects::DAY_BASELINE_KEY, "1")
            .unwrap();
        store
            .undo_mirror_accept(&id, accepted.version_id, report.snapshot.id, accepted.rev)
            .unwrap();
        assert_eq!(
            store.get_meta(crate::projects::DAY_BASELINE_KEY).unwrap(),
            Some("0".to_string())
        );
    }
}
