//! Attributed proposals stay separate from accepted prose. Every body written
//! by a decision is computed from stored hunks inside the same transaction.

use super::source_words::{self, WordSource};
use super::{commit, now_ms, Result, Store, StoreError, TIMELINE_TYPE};
use crate::review_document::{self, FragmentToken, ReviewHunk};
use crate::review_docx::{
    self, GroupSnapshot, HunkSnapshot, MessageSnapshot, OldDecision, ReviewPlan, SceneSnapshot,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub const SCHEMA_V17: &str = "
CREATE TABLE review_author (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE review_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES doc(item_id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES review_author(id),
  author_name TEXT NOT NULL,
  rev INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX review_group_item ON review_group(item_id, id);
CREATE TABLE review_hunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES review_group(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  original_from INTEGER NOT NULL,
  original_to INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  mapped_from INTEGER NOT NULL,
  mapped_to INTEGER NOT NULL,
  state TEXT NOT NULL,
  conflicted_at INTEGER,
  decided_at INTEGER,
  decision_author_id INTEGER REFERENCES review_author(id),
  decision_author_name TEXT,
  UNIQUE(group_id, ordinal)
);
CREATE INDEX review_hunk_group ON review_hunk(group_id, state, id);
CREATE TABLE review_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES review_group(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES review_author(id),
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX review_message_group ON review_message(group_id, id);
";

const MAX_AUTHORS: i64 = 100;
const MAX_AUTHOR_NAME: usize = 80;
const MAX_GROUPS_PER_DOCUMENT: i64 = 500;
const MAX_HUNKS_PER_GROUP: usize = 64;
const MAX_PENDING_PER_DOCUMENT: i64 = 500;
const MAX_MESSAGES_PER_GROUP: i64 = 500;
const MAX_MESSAGE_BYTES: usize = 4_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReviewAuthor {
    pub id: i64,
    pub display_name: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReviewMessage {
    pub id: i64,
    pub group_id: i64,
    pub author_id: i64,
    pub author_name: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StoredHunk {
    pub id: i64,
    pub original: ReviewHunk,
    pub mapped_from: usize,
    pub mapped_to: usize,
    pub state: String,
    pub conflicted_at: Option<i64>,
    pub decided_at: Option<i64>,
    pub decision_author_id: Option<i64>,
    pub decision_author_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReviewGroup {
    pub id: i64,
    pub item_id: String,
    pub author_id: i64,
    pub author_name: String,
    pub rev: i64,
    pub created_at: i64,
    pub hunks: Vec<StoredHunk>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Accept,
    Reject,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReviewDecisionResult {
    pub group_id: i64,
    pub group_rev: i64,
    pub doc_rev: i64,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReviewAuthorChoice {
    Existing(i64),
    Create(String),
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ReviewReturnAuthors {
    pub sources: Vec<(String, ReviewAuthorChoice)>,
    pub deciding_actor: Option<ReviewAuthorChoice>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReviewReturnResult {
    pub item_id: String,
    pub doc_rev: i64,
    pub body: Option<String>,
    pub created_authors: Vec<ReviewAuthor>,
    pub created_groups: Vec<i64>,
    pub created_messages: Vec<i64>,
    pub group_revs: Vec<(i64, i64)>,
}

fn invalid(reason: &str) -> StoreError {
    StoreError::InvalidReview(reason.into())
}

fn required(value: &str, limit: usize, label: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > limit || trimmed.chars().any(char::is_control) {
        return Err(StoreError::InvalidReview(format!("invalid {label}")));
    }
    Ok(trimmed.into())
}

fn required_message(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_MESSAGE_BYTES
        || trimmed
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err(invalid("invalid review message"));
    }
    Ok(trimmed.into())
}

fn decoded_hunk(from: i64, to: i64, before: &str, after: &str) -> Result<ReviewHunk> {
    let from = usize::try_from(from).map_err(|_| invalid("negative review position"))?;
    let to = usize::try_from(to).map_err(|_| invalid("negative review position"))?;
    let before: Vec<FragmentToken> =
        serde_json::from_str(before).map_err(|_| invalid("invalid stored before fragment"))?;
    let after: Vec<FragmentToken> =
        serde_json::from_str(after).map_err(|_| invalid("invalid stored after fragment"))?;
    Ok(ReviewHunk {
        from,
        to,
        before,
        after,
    })
}

impl Store {
    fn review_author_name(&self, id: i64) -> Result<String> {
        self.conn
            .query_row(
                "SELECT display_name FROM review_author WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| invalid("unknown review author"))
    }

    pub fn review_author_create(&self, display_name: &str) -> Result<ReviewAuthor> {
        let display_name = required(display_name, MAX_AUTHOR_NAME, "review author name")?;
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<ReviewAuthor> {
            let count: i64 =
                self.conn
                    .query_row("SELECT COUNT(*) FROM review_author", [], |r| r.get(0))?;
            if count >= MAX_AUTHORS {
                return Err(invalid("too many review authors"));
            }
            self.conn.execute(
                "INSERT INTO review_author (display_name, created_at) VALUES (?1, ?2)",
                params![display_name, now],
            )?;
            Ok(ReviewAuthor {
                id: self.conn.last_insert_rowid(),
                display_name,
                created_at: now,
            })
        })();
        finish(&self.conn, result)
    }

    pub fn review_authors(&self) -> Result<Vec<ReviewAuthor>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, display_name, created_at FROM review_author ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(ReviewAuthor {
                id: r.get(0)?,
                display_name: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn review_group_create(
        &self,
        item_id: &str,
        expected_doc_rev: i64,
        author_id: i64,
        hunks: &[ReviewHunk],
    ) -> Result<ReviewGroup> {
        if hunks.is_empty() || hunks.len() > MAX_HUNKS_PER_GROUP {
            return Err(invalid("invalid review hunk count"));
        }
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<ReviewGroup> {
            let author_name = self.review_author_name(author_id)?;
            let current: Option<(String, i64, String)> = self.conn.query_row(
                "SELECT d.body, d.rev, i.type FROM doc d JOIN item i ON i.id = d.item_id WHERE d.item_id = ?1",
                [item_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ).optional()?;
            let (body, rev, item_type) = current.ok_or(StoreError::NotFound {
                item_id: item_id.into(),
            })?;
            if rev != expected_doc_rev {
                return Err(StoreError::Conflict {
                    item_id: item_id.into(),
                });
            }
            if item_type == TIMELINE_TYPE {
                return Err(invalid("timeline cannot carry prose proposals"));
            }
            let group_count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM review_group WHERE item_id = ?1",
                [item_id],
                |r| r.get(0),
            )?;
            let pending_count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM review_hunk h JOIN review_group g ON g.id = h.group_id
                  WHERE g.item_id = ?1 AND h.state = 'pending'",
                [item_id],
                |r| r.get(0),
            )?;
            if group_count >= MAX_GROUPS_PER_DOCUMENT
                || pending_count + hunks.len() as i64 > MAX_PENDING_PER_DOCUMENT
            {
                return Err(invalid("review limit reached for document"));
            }
            let mut ordered: Vec<(usize, &ReviewHunk)> = hunks.iter().enumerate().collect();
            ordered.sort_by_key(|(_, hunk)| (hunk.from, hunk.to));
            for pair in ordered.windows(2) {
                let previous = pair[0].1;
                let next = pair[1].1;
                if previous.to > next.from
                    || (previous.to == next.from
                        && (previous.from == previous.to || next.from == next.to))
                {
                    return Err(invalid("overlapping review hunks"));
                }
            }
            let mut candidate = body.clone();
            for (_, hunk) in ordered.iter().rev() {
                candidate = review_document::apply_hunk(&candidate, hunk)
                    .map_err(|reason| StoreError::InvalidReview(reason))?;
            }
            self.conn.execute(
                "INSERT INTO review_group (item_id, author_id, author_name, rev, created_at)
                 VALUES (?1, ?2, ?3, 1, ?4)",
                params![item_id, author_id, author_name, now],
            )?;
            let group_id = self.conn.last_insert_rowid();
            for (ordinal, hunk) in hunks.iter().enumerate() {
                // The independent validation catches a hunk whose combined
                // candidate happens to mask a stale or malformed before span.
                review_document::apply_hunk(&body, hunk).map_err(StoreError::InvalidReview)?;
                self.conn.execute(
                    "INSERT INTO review_hunk
                     (group_id, ordinal, original_from, original_to, before_json, after_json,
                      mapped_from, mapped_to, state)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?3, ?4, 'pending')",
                    params![
                        group_id,
                        ordinal as i64,
                        hunk.from as i64,
                        hunk.to as i64,
                        serde_json::to_string(&hunk.before)
                            .map_err(|_| invalid("invalid before fragment"))?,
                        serde_json::to_string(&hunk.after)
                            .map_err(|_| invalid("invalid after fragment"))?
                    ],
                )?;
            }
            self.review_group(group_id)
        })();
        finish(&self.conn, result)
    }

    pub fn review_group(&self, group_id: i64) -> Result<ReviewGroup> {
        let group: Option<(String, i64, String, i64, i64)> = self
            .conn
            .query_row(
                "SELECT item_id, author_id, author_name, rev, created_at
               FROM review_group WHERE id = ?1",
                [group_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let (item_id, author_id, author_name, rev, created_at) =
            group.ok_or_else(|| invalid("unknown review group"))?;
        let mut stmt = self.conn.prepare(
            "SELECT id, original_from, original_to, before_json, after_json,
                    mapped_from, mapped_to, state, conflicted_at, decided_at,
                    decision_author_id, decision_author_name
               FROM review_hunk WHERE group_id = ?1 ORDER BY ordinal",
        )?;
        let rows = stmt.query_map([group_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, Option<i64>>(8)?,
                r.get::<_, Option<i64>>(9)?,
                r.get::<_, Option<i64>>(10)?,
                r.get::<_, Option<String>>(11)?,
            ))
        })?;
        let mut hunks = Vec::new();
        for row in rows {
            let (
                id,
                from,
                to,
                before,
                after,
                mapped_from,
                mapped_to,
                state,
                conflicted_at,
                decided_at,
                decision_author_id,
                decision_author_name,
            ) = row?;
            hunks.push(StoredHunk {
                id,
                original: decoded_hunk(from, to, &before, &after)?,
                mapped_from: usize::try_from(mapped_from)
                    .map_err(|_| invalid("negative mapped position"))?,
                mapped_to: usize::try_from(mapped_to)
                    .map_err(|_| invalid("negative mapped position"))?,
                state,
                conflicted_at,
                decided_at,
                decision_author_id,
                decision_author_name,
            });
        }
        Ok(ReviewGroup {
            id: group_id,
            item_id,
            author_id,
            author_name,
            rev,
            created_at,
            hunks,
        })
    }

    pub fn review_groups(&self, item_id: &str) -> Result<Vec<ReviewGroup>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM review_group WHERE item_id = ?1 ORDER BY id")?;
        let ids: Vec<i64> = stmt
            .query_map([item_id], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        ids.into_iter().map(|id| self.review_group(id)).collect()
    }

    pub fn review_messages(&self, group_id: i64) -> Result<Vec<ReviewMessage>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, author_id, author_name, body, created_at
               FROM review_message WHERE group_id = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map([group_id], |r| {
            Ok(ReviewMessage {
                id: r.get(0)?,
                group_id,
                author_id: r.get(1)?,
                author_name: r.get(2)?,
                body: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub(crate) fn review_scene_snapshot(&self, item_id: &str) -> Result<SceneSnapshot> {
        let book_id = self
            .book_id()?
            .ok_or_else(|| invalid("missing review book identity"))?;
        let row: Option<(String, i64, String)> = self.conn.query_row(
            "SELECT d.body, d.rev, i.type FROM doc d JOIN item i ON i.id = d.item_id WHERE d.item_id = ?1",
            [item_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let (body, doc_rev, item_type) = row.ok_or(StoreError::NotFound {
            item_id: item_id.into(),
        })?;
        if item_type != "scene" {
            return Err(invalid("review DOCX requires a scene"));
        }
        let conflicted: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM review_hunk h JOIN review_group g ON g.id = h.group_id
             WHERE g.item_id = ?1 AND h.state = 'conflicted'",
            [item_id],
            |row| row.get(0),
        )?;
        if conflicted != 0 {
            return Err(invalid("conflicted review hunks cannot travel"));
        }
        let message_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM review_message m JOIN review_group g ON g.id = m.group_id
             WHERE g.item_id = ?1 AND EXISTS
               (SELECT 1 FROM review_hunk h WHERE h.group_id = g.id AND h.state = 'pending')",
            [item_id],
            |row| row.get(0),
        )?;
        if message_count > 2_000 {
            return Err(invalid("too many review comments for DOCX"));
        }
        let mut stmt = self.conn.prepare(
            "SELECT g.id FROM review_group g WHERE g.item_id = ?1 AND EXISTS
               (SELECT 1 FROM review_hunk h WHERE h.group_id = g.id AND h.state = 'pending')
             ORDER BY g.id",
        )?;
        let group_ids: Vec<i64> = stmt
            .query_map([item_id], |row| row.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        drop(stmt);
        if group_ids.len() as i64 > MAX_GROUPS_PER_DOCUMENT {
            return Err(invalid("too many review groups for DOCX"));
        }
        let mut groups = Vec::with_capacity(group_ids.len());
        for group_id in group_ids {
            let group = self.review_group(group_id)?;
            let hunks = group
                .hunks
                .into_iter()
                .filter(|hunk| hunk.state == "pending")
                .map(|hunk| HunkSnapshot {
                    id: hunk.id,
                    state: hunk.state,
                    from: hunk.mapped_from,
                    to: hunk.mapped_to,
                    original: hunk.original,
                })
                .collect();
            let messages = self
                .review_messages(group_id)?
                .into_iter()
                .map(|message| MessageSnapshot {
                    id: message.id,
                    author_name: message.author_name,
                    body: message.body,
                    created_at: message.created_at,
                })
                .collect();
            groups.push(GroupSnapshot {
                id: group.id,
                rev: group.rev,
                author_name: group.author_name,
                created_at: group.created_at,
                hunks,
                messages,
            });
        }
        let ordinary_comments = self
            .comments(item_id)?
            .into_iter()
            .map(|comment| {
                Ok(review_docx::NoteSnapshot {
                    id: comment.id,
                    from: usize::try_from(comment.anchor_from)
                        .map_err(|_| invalid("invalid scene comment anchor"))?,
                    to: usize::try_from(comment.anchor_to)
                        .map_err(|_| invalid("invalid scene comment anchor"))?,
                    body: comment.body,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(SceneSnapshot {
            book_id,
            item_id: item_id.into(),
            doc_rev,
            body,
            groups,
            ordinary_comments,
        })
    }

    fn review_return_author(
        &self,
        choice: &ReviewAuthorChoice,
        created_by_name: &mut BTreeMap<String, i64>,
        created: &mut Vec<ReviewAuthor>,
        now: i64,
    ) -> Result<(i64, String)> {
        match choice {
            ReviewAuthorChoice::Existing(id) => Ok((*id, self.review_author_name(*id)?)),
            ReviewAuthorChoice::Create(display_name) => {
                let display_name = required(display_name, MAX_AUTHOR_NAME, "review author name")?;
                if let Some(id) = created_by_name.get(&display_name) {
                    return Ok((*id, display_name));
                }
                let count: i64 =
                    self.conn
                        .query_row("SELECT COUNT(*) FROM review_author", [], |row| row.get(0))?;
                if count >= MAX_AUTHORS {
                    return Err(invalid("too many review authors"));
                }
                self.conn.execute(
                    "INSERT INTO review_author (display_name, created_at) VALUES (?1, ?2)",
                    params![display_name, now],
                )?;
                let id = self.conn.last_insert_rowid();
                created_by_name.insert(display_name.clone(), id);
                created.push(ReviewAuthor {
                    id,
                    display_name: display_name.clone(),
                    created_at: now,
                });
                Ok((id, display_name))
            }
        }
    }

    pub fn review_message_add(
        &self,
        group_id: i64,
        expected_group_rev: i64,
        author_id: i64,
        body: &str,
    ) -> Result<ReviewMessage> {
        let body = required_message(body)?;
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<ReviewMessage> {
            let author_name = self.review_author_name(author_id)?;
            let rev: Option<i64> = self
                .conn
                .query_row(
                    "SELECT rev FROM review_group WHERE id = ?1",
                    [group_id],
                    |r| r.get(0),
                )
                .optional()?;
            if rev != Some(expected_group_rev) {
                return Err(StoreError::ReviewConflict { group_id });
            }
            let count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM review_message WHERE group_id = ?1",
                [group_id],
                |r| r.get(0),
            )?;
            if count >= MAX_MESSAGES_PER_GROUP {
                return Err(invalid("too many review messages"));
            }
            self.conn.execute(
                "INSERT INTO review_message (group_id, author_id, author_name, body, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![group_id, author_id, author_name, body, now],
            )?;
            self.conn.execute(
                "UPDATE review_group SET rev = rev + 1 WHERE id = ?1",
                [group_id],
            )?;
            Ok(ReviewMessage {
                id: self.conn.last_insert_rowid(),
                group_id,
                author_id,
                author_name,
                body,
                created_at: now,
            })
        })();
        finish(&self.conn, result)
    }

    pub fn review_decide(
        &self,
        group_id: i64,
        expected_group_rev: i64,
        expected_doc_rev: i64,
        selected_ids: &[i64],
        decision: ReviewDecision,
        deciding_author_id: i64,
    ) -> Result<ReviewDecisionResult> {
        if selected_ids.is_empty()
            || selected_ids.len() > MAX_HUNKS_PER_GROUP
            || selected_ids.iter().copied().collect::<HashSet<_>>().len() != selected_ids.len()
        {
            return Err(invalid("invalid selected review hunks"));
        }
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<ReviewDecisionResult> {
            let deciding_name = self.review_author_name(deciding_author_id)?;
            let group: Option<(String, i64)> = self
                .conn
                .query_row(
                    "SELECT item_id, rev FROM review_group WHERE id = ?1",
                    [group_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (item_id, group_rev) = group.ok_or_else(|| invalid("unknown review group"))?;
            if group_rev != expected_group_rev {
                return Err(StoreError::ReviewConflict { group_id });
            }
            let current: Option<(String, i64)> = self
                .conn
                .query_row(
                    "SELECT body, rev FROM doc WHERE item_id = ?1",
                    [&item_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (old_body, doc_rev) = current.ok_or(StoreError::NotFound {
                item_id: item_id.clone(),
            })?;
            if doc_rev != expected_doc_rev {
                return Err(StoreError::Conflict { item_id });
            }
            let mut selected = Vec::new();
            for id in selected_ids {
                let row: Option<(i64, i64, String, String, String)> = self
                    .conn
                    .query_row(
                        "SELECT mapped_from, mapped_to, before_json, after_json, state
                       FROM review_hunk WHERE id = ?1 AND group_id = ?2",
                        params![id, group_id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                    )
                    .optional()?;
                let (from, to, before, after, state) =
                    row.ok_or_else(|| invalid("unknown review hunk"))?;
                if state != "pending"
                    && !(decision == ReviewDecision::Reject && state == "conflicted")
                {
                    return Err(invalid("review hunk is not pending"));
                }
                selected.push((*id, decoded_hunk(from, to, &before, &after)?));
            }
            selected.sort_by(|a, b| b.1.from.cmp(&a.1.from));
            let skip: HashSet<i64> = selected_ids.iter().copied().collect();
            let mut body = old_body.clone();
            if decision == ReviewDecision::Accept {
                for (id, hunk) in &selected {
                    let next = review_document::apply_hunk(&body, hunk)
                        .map_err(StoreError::InvalidReview)?;
                    self.conn.execute(
                        "UPDATE review_hunk SET state = 'accepted', decided_at = ?2,
                         decision_author_id = ?3, decision_author_name = ?4 WHERE id = ?1",
                        params![id, now, deciding_author_id, deciding_name],
                    )?;
                    if !review_document::same_unmarked_content(&hunk.before, &hunk.after) {
                        self.review_map_comments(
                            &item_id,
                            hunk.from,
                            hunk.to,
                            review_document::fragment_width(&hunk.after),
                            now,
                        )?;
                    }
                    self.review_map_pending_known(
                        &item_id,
                        &next,
                        hunk.from,
                        hunk.to,
                        hunk.from + review_document::fragment_width(&hunk.after),
                        now,
                        &skip,
                    )?;
                    body = next;
                }
                self.insert_version(&item_id, &old_body, now, None)?;
                self.conn.execute(
                    "UPDATE doc SET body = ?2, rev = rev + 1, updated_at = ?3 WHERE item_id = ?1",
                    params![item_id, body, now],
                )?;
                if source_words::eligible(&self.conn, &item_id)? {
                    source_words::record(
                        &self.conn,
                        &[source_words::directional(
                            WordSource::Imported,
                            Some(&old_body),
                            &body,
                        )],
                    )?;
                    self.review_absorb_day_delta(&old_body, &body)?;
                }
            } else {
                for (id, _) in &selected {
                    self.conn.execute(
                        "UPDATE review_hunk SET state = 'rejected', decided_at = ?2,
                         decision_author_id = ?3, decision_author_name = ?4 WHERE id = ?1",
                        params![id, now, deciding_author_id, deciding_name],
                    )?;
                }
            }
            self.conn.execute(
                "UPDATE review_group SET rev = rev + 1 WHERE id = ?1",
                [group_id],
            )?;
            let new_group_rev: i64 = self.conn.query_row(
                "SELECT rev FROM review_group WHERE id = ?1",
                [group_id],
                |r| r.get(0),
            )?;
            Ok(ReviewDecisionResult {
                group_id,
                group_rev: new_group_rev,
                doc_rev: if decision == ReviewDecision::Accept {
                    doc_rev + 1
                } else {
                    doc_rev
                },
                body: (decision == ReviewDecision::Accept).then_some(body),
            })
        })();
        finish(&self.conn, result)
    }

    pub(crate) fn review_return_apply(
        &self,
        plan: &ReviewPlan,
        authors: &ReviewReturnAuthors,
    ) -> Result<ReviewReturnResult> {
        let now = now_ms();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<ReviewReturnResult> {
            let snapshot = self.review_scene_snapshot(&plan.expected.item_id)?;
            let current_manifest =
                review_docx::manifest(&snapshot).map_err(StoreError::InvalidReview)?;
            if current_manifest != plan.expected {
                return Err(invalid("review DOCX source changed after export"));
            }
            let mut pending = BTreeMap::new();
            for group in &snapshot.groups {
                for hunk in &group.hunks {
                    pending.insert(
                        hunk.id,
                        (
                            group.id,
                            ReviewHunk {
                                from: hunk.from,
                                to: hunk.to,
                                before: hunk.original.before.clone(),
                                after: hunk.original.after.clone(),
                            },
                        ),
                    );
                }
            }
            let mut decisions = BTreeMap::new();
            for decision in &plan.decisions {
                let (id, accept) = match decision {
                    OldDecision::Accept(id) => (*id, true),
                    OldDecision::Reject(id) => (*id, false),
                };
                if !pending.contains_key(&id) || decisions.insert(id, accept).is_some() {
                    return Err(invalid("unknown or repeated returned review decision"));
                }
            }
            let required_names: BTreeSet<String> = plan
                .new_hunks
                .iter()
                .map(|h| h.author_name.clone())
                .chain(plan.new_messages.iter().map(|m| m.author_name.clone()))
                .collect();
            for source_name in &required_names {
                if source_name.trim().is_empty()
                    || source_name.len() > MAX_AUTHOR_NAME
                    || source_name.chars().any(char::is_control)
                {
                    return Err(invalid("invalid returned review author name"));
                }
            }
            let mut choices = BTreeMap::new();
            for (source_name, choice) in &authors.sources {
                if !required_names.contains(source_name)
                    || choices.insert(source_name.clone(), choice).is_some()
                {
                    return Err(invalid(
                        "missing or repeated explicit review author mapping",
                    ));
                }
            }
            if choices.len() != required_names.len()
                || authors.deciding_actor.is_some() != !decisions.is_empty()
            {
                return Err(invalid(
                    "missing or unexpected review decision actor or author mapping",
                ));
            }
            if plan.new_hunks.len() > MAX_PENDING_PER_DOCUMENT as usize
                || plan.new_messages.len() > 2_000
            {
                return Err(invalid("returned review exceeds limits"));
            }
            let known_groups: BTreeSet<i64> =
                snapshot.groups.iter().map(|group| group.id).collect();
            for message in &plan.new_messages {
                if !known_groups.contains(&message.group_id)
                    || required_message(&message.body)? != message.body
                {
                    return Err(invalid("invalid returned review message or target"));
                }
            }
            let mut created_by_name = BTreeMap::new();
            let mut created_authors = Vec::new();
            let mut mapped_authors = BTreeMap::new();
            for (source_name, choice) in choices {
                mapped_authors.insert(
                    source_name,
                    self.review_return_author(
                        choice,
                        &mut created_by_name,
                        &mut created_authors,
                        now,
                    )?,
                );
            }
            let deciding_actor = authors
                .deciding_actor
                .as_ref()
                .map(|choice| {
                    self.review_return_author(
                        choice,
                        &mut created_by_name,
                        &mut created_authors,
                        now,
                    )
                })
                .transpose()?;
            let skip: HashSet<i64> = decisions.keys().copied().collect();
            let mut accepted: Vec<(i64, i64, ReviewHunk)> = decisions
                .iter()
                .filter(|(_, accept)| **accept)
                .map(|(id, _)| {
                    let (group_id, hunk) = &pending[id];
                    (*id, *group_id, hunk.clone())
                })
                .collect();
            accepted.sort_by(|a, b| (b.2.from, b.2.to, b.0).cmp(&(a.2.from, a.2.to, a.0)));
            let old_body = snapshot.body;
            let mut body = old_body.clone();
            let mut decided_groups = HashSet::new();
            for (id, group_id, hunk) in &accepted {
                let next =
                    review_document::apply_hunk(&body, hunk).map_err(StoreError::InvalidReview)?;
                let (actor_id, actor_name) =
                    deciding_actor.as_ref().expect("decisions require an actor");
                self.conn.execute(
                    "UPDATE review_hunk SET state = 'accepted', decided_at = ?2,
                     decision_author_id = ?3, decision_author_name = ?4 WHERE id = ?1",
                    params![id, now, actor_id, actor_name],
                )?;
                if !review_document::same_unmarked_content(&hunk.before, &hunk.after) {
                    self.review_map_comments(
                        &plan.expected.item_id,
                        hunk.from,
                        hunk.to,
                        review_document::fragment_width(&hunk.after),
                        now,
                    )?;
                }
                self.review_map_pending_known(
                    &plan.expected.item_id,
                    &next,
                    hunk.from,
                    hunk.to,
                    hunk.from + review_document::fragment_width(&hunk.after),
                    now,
                    &skip,
                )?;
                body = next;
                decided_groups.insert(*group_id);
            }
            for (id, accept) in &decisions {
                if *accept {
                    continue;
                }
                let (group_id, _) = &pending[id];
                let (actor_id, actor_name) =
                    deciding_actor.as_ref().expect("decisions require an actor");
                self.conn.execute(
                    "UPDATE review_hunk SET state = 'rejected', decided_at = ?2,
                     decision_author_id = ?3, decision_author_name = ?4 WHERE id = ?1",
                    params![id, now, actor_id, actor_name],
                )?;
                decided_groups.insert(*group_id);
            }
            self.review_bump_groups(&decided_groups)?;
            let conflicted: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM review_hunk h JOIN review_group g ON g.id = h.group_id
                 WHERE g.item_id = ?1 AND h.state = 'conflicted'",
                [&plan.expected.item_id],
                |row| row.get(0),
            )?;
            if conflicted != 0 {
                return Err(invalid("returned review would conflict a pending proposal"));
            }
            if review_document::changed_interval(&body, &plan.rejected_projection)
                .map_err(StoreError::InvalidReview)?
                .is_some()
            {
                return Err(invalid(
                    "returned review projection disagrees with stored decisions",
                ));
            }
            if !accepted.is_empty() {
                self.insert_version(&plan.expected.item_id, &old_body, now, None)?;
                self.conn.execute(
                    "UPDATE doc SET body = ?2, rev = rev + 1, updated_at = ?3 WHERE item_id = ?1",
                    params![plan.expected.item_id, body, now],
                )?;
                if source_words::eligible(&self.conn, &plan.expected.item_id)? {
                    source_words::record(
                        &self.conn,
                        &[source_words::directional(
                            WordSource::Imported,
                            Some(&old_body),
                            &body,
                        )],
                    )?;
                    self.review_absorb_day_delta(&old_body, &body)?;
                }
            }
            let mut new_hunks: Vec<&ReviewHunk> =
                plan.new_hunks.iter().map(|entry| &entry.hunk).collect();
            new_hunks.sort_by_key(|hunk| (hunk.from, hunk.to));
            let mut pending_stmt = self.conn.prepare(
                "SELECT h.mapped_from, h.mapped_to FROM review_hunk h
                 JOIN review_group g ON g.id = h.group_id
                 WHERE g.item_id = ?1 AND h.state = 'pending'",
            )?;
            let mut spans: Vec<(usize, usize)> = pending_stmt
                .query_map([&plan.expected.item_id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })?
                .map(|row| {
                    let (from, to) = row?;
                    Ok((
                        usize::try_from(from)
                            .map_err(|_| invalid("invalid mapped review range"))?,
                        usize::try_from(to).map_err(|_| invalid("invalid mapped review range"))?,
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            drop(pending_stmt);
            spans.extend(new_hunks.iter().map(|hunk| (hunk.from, hunk.to)));
            spans.sort();
            if spans.windows(2).any(|pair| {
                let (a, b) = (pair[0], pair[1]);
                a.1 > b.0 || (a.1 == b.0 && (a.0 == a.1 || b.0 == b.1))
            }) {
                return Err(invalid("returned review hunks overlap pending proposals"));
            }
            let existing_groups: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM review_group WHERE item_id = ?1",
                [&plan.expected.item_id],
                |row| row.get(0),
            )?;
            if existing_groups + plan.new_hunks.len() as i64 > MAX_GROUPS_PER_DOCUMENT
                || spans.len() as i64 > MAX_PENDING_PER_DOCUMENT
            {
                return Err(invalid("review limit reached for document"));
            }
            new_hunks
                .into_iter()
                .rev()
                .try_fold(body.clone(), |candidate, hunk| {
                    review_document::apply_hunk(&candidate, hunk).map_err(StoreError::InvalidReview)
                })?;
            let mut created_groups = Vec::new();
            for entry in &plan.new_hunks {
                review_document::apply_hunk(&body, &entry.hunk)
                    .map_err(StoreError::InvalidReview)?;
                let (author_id, author_name) = &mapped_authors[&entry.author_name];
                self.conn.execute(
                    "INSERT INTO review_group (item_id, author_id, author_name, rev, created_at)
                     VALUES (?1, ?2, ?3, 1, ?4)",
                    params![plan.expected.item_id, author_id, author_name, now],
                )?;
                let group_id = self.conn.last_insert_rowid();
                self.conn.execute(
                    "INSERT INTO review_hunk
                     (group_id, ordinal, original_from, original_to, before_json, after_json,
                      mapped_from, mapped_to, state)
                     VALUES (?1, 0, ?2, ?3, ?4, ?5, ?2, ?3, 'pending')",
                    params![
                        group_id,
                        entry.hunk.from as i64,
                        entry.hunk.to as i64,
                        serde_json::to_string(&entry.hunk.before)
                            .map_err(|_| invalid("invalid before fragment"))?,
                        serde_json::to_string(&entry.hunk.after)
                            .map_err(|_| invalid("invalid after fragment"))?
                    ],
                )?;
                created_groups.push(group_id);
            }
            let mut created_messages = Vec::new();
            for message in &plan.new_messages {
                let count: i64 = self.conn.query_row(
                    "SELECT COUNT(*) FROM review_message WHERE group_id = ?1",
                    [message.group_id],
                    |row| row.get(0),
                )?;
                if count >= MAX_MESSAGES_PER_GROUP {
                    return Err(invalid("too many review messages"));
                }
                let (author_id, author_name) = &mapped_authors[&message.author_name];
                self.conn.execute(
                    "INSERT INTO review_message (group_id, author_id, author_name, body, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![message.group_id, author_id, author_name, message.body, now],
                )?;
                created_messages.push(self.conn.last_insert_rowid());
                self.conn.execute(
                    "UPDATE review_group SET rev = rev + 1 WHERE id = ?1",
                    [message.group_id],
                )?;
            }
            let mut group_revs = Vec::new();
            for group_id in known_groups
                .into_iter()
                .chain(created_groups.iter().copied())
            {
                let rev: i64 = self.conn.query_row(
                    "SELECT rev FROM review_group WHERE id = ?1",
                    [group_id],
                    |row| row.get(0),
                )?;
                group_revs.push((group_id, rev));
            }
            Ok(ReviewReturnResult {
                item_id: plan.expected.item_id.clone(),
                doc_rev: plan
                    .expected
                    .doc_rev
                    .checked_add(i64::from(!accepted.is_empty()))
                    .ok_or_else(|| invalid("review document revision overflow"))?,
                body: (!accepted.is_empty()).then_some(body),
                created_authors,
                created_groups,
                created_messages,
                group_revs,
            })
        })();
        finish(&self.conn, result)
    }

    fn review_absorb_day_delta(&self, old: &str, new: &str) -> Result<()> {
        if let Some(baseline) = self
            .get_meta(crate::projects::DAY_BASELINE_KEY)?
            .and_then(|value| value.parse::<i64>().ok())
        {
            let words = |body: &str| -> i64 {
                super::document_text(body)
                    .map(|text| crate::words::count_words(&text) as i64)
                    .unwrap_or(0)
            };
            let next = (baseline + words(new) - words(old)).max(0);
            self.set_meta(crate::projects::DAY_BASELINE_KEY, &next.to_string())?;
        }
        Ok(())
    }

    fn review_map_comments(
        &self,
        item_id: &str,
        from: usize,
        to: usize,
        inserted: usize,
        now: i64,
    ) -> Result<()> {
        let mut stmt = self.conn.prepare(
            "SELECT id, anchor_from, anchor_to FROM comment WHERE item_id = ?1 AND anchor_from <= anchor_to",
        )?;
        let rows: Vec<(i64, i64, i64)> = stmt
            .query_map([item_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?;
        drop(stmt);
        let from = from as i64;
        let to = to as i64;
        let delta = inserted as i64 - (to - from);
        for (id, start, end) in rows {
            let mapped = if end <= from {
                (start, end)
            } else if start >= to {
                (start + delta, end + delta)
            } else if start >= from && end <= to {
                (from, from)
            } else {
                let new_start = if start < from { start } else { from };
                let new_end = if end > to {
                    end + delta
                } else {
                    from + inserted as i64
                };
                (new_start, new_end.max(new_start))
            };
            if mapped != (start, end) {
                self.conn.execute(
                    "UPDATE comment SET anchor_from = ?2, anchor_to = ?3, updated_at = ?4 WHERE id = ?1",
                    params![id, mapped.0, mapped.1, now],
                )?;
            }
        }
        Ok(())
    }

    fn review_pending_count(&self, item_id: &str) -> Result<i64> {
        let count = self.conn.query_row(
            "SELECT COUNT(*) FROM review_hunk h JOIN review_group g ON g.id = h.group_id
              WHERE g.item_id = ?1 AND h.state = 'pending'",
            [item_id],
            |r| r.get(0),
        );
        match count {
            Ok(count) => Ok(count),
            Err(_) if self.user_version()? < 17 => Ok(0),
            Err(error) => Err(error.into()),
        }
    }

    fn review_bump_groups(&self, changed: &HashSet<i64>) -> Result<()> {
        for group_id in changed {
            self.conn.execute(
                "UPDATE review_group SET rev = rev + 1 WHERE id = ?1",
                [group_id],
            )?;
        }
        Ok(())
    }

    pub(super) fn review_conflict_all(&self, item_id: &str, now: i64) -> Result<()> {
        if self.review_pending_count(item_id)? == 0 {
            return Ok(());
        }
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT h.group_id FROM review_hunk h
             JOIN review_group g ON g.id = h.group_id
             WHERE g.item_id = ?1 AND h.state = 'pending'",
        )?;
        let groups: HashSet<i64> = stmt
            .query_map([item_id], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        drop(stmt);
        if groups.is_empty() {
            return Ok(());
        }
        self.conn.execute(
            "UPDATE review_hunk SET state = 'conflicted', conflicted_at = ?2
              WHERE state = 'pending' AND group_id IN
                (SELECT id FROM review_group WHERE item_id = ?1)",
            params![item_id, now],
        )?;
        self.review_bump_groups(&groups)
    }

    /// Runs inside the caller's manuscript transaction. With no pending hunk,
    /// typing pays one indexed count and does not parse either document.
    pub(super) fn review_map_flush(
        &self,
        item_id: &str,
        old: &str,
        new: &str,
        now: i64,
    ) -> Result<()> {
        if self.review_pending_count(item_id)? == 0 {
            return Ok(());
        }
        let interval = match review_document::changed_interval(old, new) {
            Ok(value) => value,
            Err(_) => return self.review_conflict_all(item_id, now),
        };
        if let Some((from, old_end, new_end)) = interval {
            self.review_map_pending_known(
                item_id,
                new,
                from,
                old_end,
                new_end,
                now,
                &HashSet::new(),
            )?;
        }
        Ok(())
    }

    fn review_map_pending_known(
        &self,
        item_id: &str,
        new_body: &str,
        from: usize,
        old_end: usize,
        new_end: usize,
        now: i64,
        skip: &HashSet<i64>,
    ) -> Result<()> {
        let mut stmt = self.conn.prepare(
            "SELECT h.id, h.group_id, h.mapped_from, h.mapped_to, h.before_json, h.after_json
               FROM review_hunk h JOIN review_group g ON g.id = h.group_id
              WHERE g.item_id = ?1 AND h.state = 'pending'",
        )?;
        let rows: Vec<(i64, i64, i64, i64, String, String)> = stmt
            .query_map([item_id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<std::result::Result<_, _>>()?;
        drop(stmt);
        let parsed =
            review_document::parse_review_body(new_body).map_err(StoreError::InvalidReview)?;
        let mut changed_groups = HashSet::new();
        let delta = new_end as i64 - old_end as i64;
        for (id, group_id, mapped_from, mapped_to, before, after) in rows {
            if skip.contains(&id) {
                continue;
            }
            let mut hunk = decoded_hunk(mapped_from, mapped_to, &before, &after)?;
            let mapped = if hunk.to < from || (hunk.to == from && hunk.from < hunk.to) {
                Some((hunk.from, hunk.to))
            } else if hunk.from > old_end || (hunk.from == old_end && hunk.from < hunk.to) {
                let a = i64::try_from(hunk.from)
                    .ok()
                    .and_then(|v| usize::try_from(v + delta).ok());
                let b = i64::try_from(hunk.to)
                    .ok()
                    .and_then(|v| usize::try_from(v + delta).ok());
                a.zip(b)
            } else {
                None
            };
            let valid = mapped.and_then(|(a, b)| {
                hunk.from = a;
                hunk.to = b;
                review_document::apply_hunk_to_tokens(&parsed, &hunk)
                    .ok()
                    .map(|_| (a, b))
            });
            if let Some((a, b)) = valid {
                if a != mapped_from as usize || b != mapped_to as usize {
                    self.conn.execute(
                        "UPDATE review_hunk SET mapped_from = ?2, mapped_to = ?3 WHERE id = ?1",
                        params![id, a as i64, b as i64],
                    )?;
                    changed_groups.insert(group_id);
                }
            } else {
                self.conn.execute(
                    "UPDATE review_hunk SET state = 'conflicted', conflicted_at = ?2 WHERE id = ?1",
                    params![id, now],
                )?;
                changed_groups.insert(group_id);
            }
        }
        self.review_bump_groups(&changed_groups)
    }
}

fn finish<T>(conn: &rusqlite::Connection, result: Result<T>) -> Result<T> {
    match result {
        Ok(value) => {
            commit(conn)?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_document::FragmentToken::{Close, Open, Text};
    use crate::review_document::Mark;
    use crate::review_docx::{AuthoredHunk, NewMessage};
    use crate::store::{FlushEntry, SCHEMA_VERSION};
    use tempfile::tempdir;

    fn doc(text: &str) -> String {
        serde_json::json!({"type":"doc","content":[{"type":"paragraph",
            "content":[{"type":"text","text":text}]}]})
        .to_string()
    }

    fn write(store: &Store, id: &str, rev: i64, body: &str) -> i64 {
        store
            .flush(&[FlushEntry {
                item_id: id.into(),
                body: body.into(),
                base_rev: rev,
                comments: None,
            }])
            .unwrap()[0]
            .rev
    }

    fn setup(text: &str) -> (tempfile::TempDir, Store, String, i64, i64) {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let scene = store.item_create(None, "scene", "Scene").unwrap();
        let rev = write(&store, &scene.id, scene.doc_rev.unwrap(), &doc(text));
        let author = store.review_author_create("Alice").unwrap();
        (dir, store, scene.id, rev, author.id)
    }

    fn replace(from: usize, before: &str, after: &str) -> ReviewHunk {
        ReviewHunk {
            from,
            to: from + before.encode_utf16().count(),
            before: if before.is_empty() {
                vec![]
            } else {
                vec![Text {
                    text: before.into(),
                    marks: vec![],
                }]
            },
            after: if after.is_empty() {
                vec![]
            } else {
                vec![Text {
                    text: after.into(),
                    marks: vec![],
                }]
            },
        }
    }

    fn return_plan(store: &Store, item_id: &str) -> ReviewPlan {
        let snapshot = store.review_scene_snapshot(item_id).unwrap();
        ReviewPlan {
            expected: review_docx::manifest(&snapshot).unwrap(),
            decisions: Vec::new(),
            new_hunks: Vec::new(),
            new_messages: Vec::new(),
            rejected_projection: snapshot.body.clone(),
            accepted_projection: snapshot.body,
        }
    }

    fn version_count(store: &Store, item_id: &str) -> i64 {
        store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM doc_version WHERE item_id = ?1",
                [item_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn returned_review_applies_mixed_old_decisions_and_new_work_once() {
        let (_dir, store, id, rev, alice) = setup("one");
        let group = store
            .review_group_create(
                &id,
                rev,
                alice,
                &[replace(4, "", " two"), replace(2, "n", "N")],
            )
            .unwrap();
        let before_versions = version_count(&store, &id);
        store
            .set_meta(crate::projects::DAY_BASELINE_KEY, "10")
            .unwrap();
        let mut plan = return_plan(&store, &id);
        plan.decisions = vec![
            OldDecision::Accept(group.hunks[0].id),
            OldDecision::Reject(group.hunks[1].id),
        ];
        plan.rejected_projection = doc("one two");
        plan.new_hunks.push(AuthoredHunk {
            author_name: "Word Writer".into(),
            hunk: replace(8, "", " three"),
        });
        plan.new_messages.push(NewMessage {
            group_id: group.id,
            author_name: "Word Commenter".into(),
            body: "Keep this ending.".into(),
        });
        let authors = ReviewReturnAuthors {
            sources: vec![
                (
                    "Word Writer".into(),
                    ReviewAuthorChoice::Create("Bob".into()),
                ),
                ("Word Commenter".into(), ReviewAuthorChoice::Existing(alice)),
            ],
            deciding_actor: Some(ReviewAuthorChoice::Existing(alice)),
        };
        let result = store.review_return_apply(&plan, &authors).unwrap();
        assert_eq!(result.doc_rev, rev + 1);
        assert_eq!(result.body.as_deref(), Some(doc("one two").as_str()));
        assert_eq!(store.load_doc(&id).unwrap().body, doc("one two"));
        assert_eq!(version_count(&store, &id), before_versions + 1);
        assert_eq!(
            store.review_group(group.id).unwrap().hunks[0].state,
            "accepted"
        );
        assert_eq!(
            store.review_group(group.id).unwrap().hunks[1].state,
            "rejected"
        );
        let new_group = store.review_group(result.created_groups[0]).unwrap();
        assert_eq!(new_group.author_name, "Bob");
        assert_eq!(
            (new_group.hunks[0].mapped_from, new_group.hunks[0].mapped_to),
            (8, 8)
        );
        assert_eq!(
            store.review_messages(group.id).unwrap()[0].author_name,
            "Alice"
        );
        assert_eq!(
            store
                .get_meta(crate::projects::DAY_BASELINE_KEY)
                .unwrap()
                .as_deref(),
            Some("11")
        );
        assert_eq!(
            store
                .source_word_summary("2026-09-25")
                .unwrap()
                .totals
                .imported
                .added,
            1
        );
    }

    #[test]
    fn returned_review_stale_manifest_and_missing_mapping_write_nothing() {
        let (_dir, store, id, rev, alice) = setup("one");
        let group = store
            .review_group_create(&id, rev, alice, &[replace(4, "", " two")])
            .unwrap();
        let mut plan = return_plan(&store, &id);
        plan.decisions.push(OldDecision::Accept(group.hunks[0].id));
        plan.rejected_projection = doc("one two");
        let before = store.load_doc(&id).unwrap();
        let before_versions = version_count(&store, &id);
        assert!(store
            .review_return_apply(&plan, &ReviewReturnAuthors::default())
            .is_err());
        let current = store.load_doc(&id).unwrap();
        assert_eq!(
            (current.body, current.rev),
            (before.body.clone(), before.rev)
        );
        assert_eq!(version_count(&store, &id), before_versions);
        let authors = ReviewReturnAuthors {
            deciding_actor: Some(ReviewAuthorChoice::Existing(alice)),
            ..Default::default()
        };
        store
            .review_message_add(group.id, group.rev, alice, "new discussion")
            .unwrap();
        let current_group = store.review_group(group.id).unwrap();
        assert!(store.review_return_apply(&plan, &authors).is_err());
        let current = store.load_doc(&id).unwrap();
        assert_eq!((current.body, current.rev), (before.body, before.rev));
        assert_eq!(store.review_group(group.id).unwrap(), current_group);
        assert_eq!(version_count(&store, &id), before_versions);
    }

    #[test]
    fn return_snapshot_scopes_pending_hunks_and_refuses_conflicts() {
        let (_dir, store, id, rev, alice) = setup("one");
        let group = store
            .review_group_create(
                &id,
                rev,
                alice,
                &[replace(4, "", " two"), replace(2, "n", "N")],
            )
            .unwrap();
        store
            .review_decide(
                group.id,
                group.rev,
                rev,
                &[group.hunks[1].id],
                ReviewDecision::Reject,
                alice,
            )
            .unwrap();
        let snapshot = store.review_scene_snapshot(&id).unwrap();
        assert_eq!(snapshot.groups.len(), 1);
        assert_eq!(snapshot.groups[0].hunks.len(), 1);
        assert_eq!(snapshot.groups[0].hunks[0].id, group.hunks[0].id);
        assert_eq!(snapshot.groups[0].rev, group.rev + 1);
        store.review_conflict_all(&id, now_ms()).unwrap();
        assert!(store.review_scene_snapshot(&id).is_err());
    }

    #[test]
    fn returned_new_hunk_cannot_overlap_an_undecided_hunk() {
        let (_dir, store, id, rev, alice) = setup("one");
        let group = store
            .review_group_create(&id, rev, alice, &[replace(4, "", " two")])
            .unwrap();
        let mut plan = return_plan(&store, &id);
        plan.new_hunks.push(AuthoredHunk {
            author_name: "Word Writer".into(),
            hunk: replace(4, "", " three"),
        });
        let authors = ReviewReturnAuthors {
            sources: vec![("Word Writer".into(), ReviewAuthorChoice::Existing(alice))],
            deciding_actor: None,
        };
        assert!(store.review_return_apply(&plan, &authors).is_err());
        assert_eq!(store.load_doc(&id).unwrap().rev, rev);
        assert_eq!(store.review_groups(&id).unwrap().len(), 1);
        assert_eq!(
            store.review_group(group.id).unwrap().hunks[0].state,
            "pending"
        );
    }

    #[test]
    fn returned_review_late_message_failure_rolls_back_prose_authors_and_history() {
        let (_dir, store, id, rev, alice) = setup("one");
        let group = store
            .review_group_create(&id, rev, alice, &[replace(4, "", " two")])
            .unwrap();
        store
            .set_meta(crate::projects::DAY_BASELINE_KEY, "10")
            .unwrap();
        let before = store.load_doc(&id).unwrap();
        let before_group = store.review_group(group.id).unwrap();
        let before_versions = version_count(&store, &id);
        let before_authors = store.review_authors().unwrap();
        let before_blobs: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM blob", [], |row| row.get(0))
            .unwrap();
        let before_sources = store.source_word_summary("2026-09-25").unwrap();
        let mut plan = return_plan(&store, &id);
        plan.decisions.push(OldDecision::Accept(group.hunks[0].id));
        plan.rejected_projection = doc("one two");
        plan.new_hunks.push(AuthoredHunk {
            author_name: "Word Writer".into(),
            hunk: replace(8, "", " three"),
        });
        plan.new_messages.push(NewMessage {
            group_id: group.id,
            author_name: "Word Writer".into(),
            body: "Later".into(),
        });
        let authors = ReviewReturnAuthors {
            sources: vec![(
                "Word Writer".into(),
                ReviewAuthorChoice::Create("Bob".into()),
            )],
            deciding_actor: Some(ReviewAuthorChoice::Existing(alice)),
        };
        store
            .conn
            .execute_batch(
                "CREATE TRIGGER refuse_return_message BEFORE INSERT ON review_message
             BEGIN SELECT RAISE(ABORT, 'late return failure'); END",
            )
            .unwrap();
        assert!(store.review_return_apply(&plan, &authors).is_err());
        let current = store.load_doc(&id).unwrap();
        assert_eq!((current.body, current.rev), (before.body, before.rev));
        assert_eq!(store.review_group(group.id).unwrap(), before_group);
        assert_eq!(store.review_authors().unwrap(), before_authors);
        assert_eq!(store.review_groups(&id).unwrap().len(), 1);
        assert_eq!(store.review_messages(group.id).unwrap().len(), 0);
        assert_eq!(version_count(&store, &id), before_versions);
        assert_eq!(
            store
                .conn
                .query_row("SELECT COUNT(*) FROM blob", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            before_blobs
        );
        assert_eq!(
            store
                .get_meta(crate::projects::DAY_BASELINE_KEY)
                .unwrap()
                .as_deref(),
            Some("10")
        );
        assert_eq!(
            store.source_word_summary("2026-09-25").unwrap(),
            before_sources
        );
    }

    #[test]
    fn exported_package_noop_keeps_revision_and_history() {
        let (_dir, store, id, rev, alice) = setup("one");
        store
            .review_group_create(&id, rev, alice, &[replace(4, "", " two")])
            .unwrap();
        let snapshot = store.review_scene_snapshot(&id).unwrap();
        let package = review_docx::export(&snapshot).unwrap();
        let plan = review_docx::inspect_return(&package.bytes, &snapshot).unwrap();
        let before_versions = version_count(&store, &id);
        let result = store
            .review_return_apply(&plan, &ReviewReturnAuthors::default())
            .unwrap();
        assert_eq!(result.doc_rev, rev);
        assert_eq!(result.body, None);
        assert_eq!(store.load_doc(&id).unwrap().rev, rev);
        assert_eq!(version_count(&store, &id), before_versions);
    }

    #[test]
    fn schema17_migrates_without_rewriting_prose_history_or_state() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("book.db");
        let store = Store::open(&path).unwrap();
        let scene = store.item_create(None, "scene", "Scene").unwrap();
        let rev = write(&store, &scene.id, scene.doc_rev.unwrap(), &doc("draft"));
        store
            .insert_version(&scene.id, &doc("draft"), now_ms(), None)
            .unwrap();
        store
            .conn
            .execute("UPDATE item SET state = 'draft' WHERE id = ?1", [&scene.id])
            .unwrap();
        store
            .conn
            .execute_batch(
                "DROP TABLE review_message; DROP TABLE review_hunk;
            DROP TABLE review_group; DROP TABLE review_author; PRAGMA user_version = 16;",
            )
            .unwrap();
        drop(store);
        let reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(reopened.load_doc(&scene.id).unwrap().body, doc("draft"));
        assert_eq!(reopened.load_doc(&scene.id).unwrap().rev, rev);
        assert_eq!(reopened.doc_versions(&scene.id).unwrap().len(), 1);
        let state: String = reopened
            .conn
            .query_row("SELECT state FROM item WHERE id = ?1", [&scene.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(state, "draft");
    }

    #[test]
    fn selected_accept_is_host_computed_and_partial_group_survives() {
        let (_dir, store, id, rev, author) = setup("abcde");
        let group = store
            .review_group_create(
                &id,
                rev,
                author,
                &[replace(2, "b", "B"), replace(4, "d", "D")],
            )
            .unwrap();
        let decided = store
            .review_decide(
                group.id,
                group.rev,
                rev,
                &[group.hunks[1].id],
                ReviewDecision::Accept,
                author,
            )
            .unwrap();
        assert_eq!(decided.body.as_deref(), Some(doc("abcDe").as_str()));
        assert_eq!(store.load_doc(&id).unwrap().body, doc("abcDe"));
        let remaining = store.review_group(group.id).unwrap();
        assert_eq!(remaining.hunks[0].state, "pending");
        assert_eq!(remaining.hunks[1].state, "accepted");
        assert_eq!(store.doc_versions(&id).unwrap().len(), 1);
        let final_decision = store
            .review_decide(
                group.id,
                remaining.rev,
                decided.doc_rev,
                &[remaining.hunks[0].id],
                ReviewDecision::Reject,
                author,
            )
            .unwrap();
        assert_eq!(final_decision.body, None);
        assert_eq!(store.load_doc(&id).unwrap().body, doc("abcDe"));
    }

    #[test]
    fn adjacent_hunks_remain_decidable_after_partial_accept() {
        let (_dir, store, id, rev, author) = setup("abcde");
        let group = store
            .review_group_create(
                &id,
                rev,
                author,
                &[replace(2, "b", "B"), replace(3, "c", "C")],
            )
            .unwrap();
        let first = store
            .review_decide(
                group.id,
                group.rev,
                rev,
                &[group.hunks[0].id],
                ReviewDecision::Accept,
                author,
            )
            .unwrap();
        let remaining = store.review_group(group.id).unwrap();
        assert_eq!(remaining.hunks[1].state, "pending");
        assert_eq!(
            (remaining.hunks[1].mapped_from, remaining.hunks[1].mapped_to),
            (3, 4)
        );
        let second = store
            .review_decide(
                group.id,
                remaining.rev,
                first.doc_rev,
                &[remaining.hunks[1].id],
                ReviewDecision::Accept,
                author,
            )
            .unwrap();
        assert_eq!(second.body.as_deref(), Some(doc("aBCde").as_str()));
    }

    #[test]
    fn insertion_at_hunk_start_shifts_the_intact_hunk() {
        let (_dir, store, id, rev, author) = setup("the cat");
        let group = store
            .review_group_create(&id, rev, author, &[replace(5, "cat", "dog")])
            .unwrap();
        let rev = write(&store, &id, rev, &doc("the big cat"));
        let mapped = store.review_group(group.id).unwrap();
        assert_eq!(mapped.hunks[0].state, "pending");
        assert_eq!(
            (mapped.hunks[0].mapped_from, mapped.hunks[0].mapped_to),
            (9, 12)
        );
        let result = store
            .review_decide(
                group.id,
                mapped.rev,
                rev,
                &[mapped.hunks[0].id],
                ReviewDecision::Accept,
                author,
            )
            .unwrap();
        assert_eq!(result.body.as_deref(), Some(doc("the big dog").as_str()));
    }

    #[test]
    fn accepting_two_hunks_remaps_another_groups_pending_hunk() {
        let (_dir, store, id, rev, author) = setup("abcde");
        let chosen = store
            .review_group_create(
                &id,
                rev,
                author,
                &[replace(2, "b", "BBBB"), replace(4, "d", "D")],
            )
            .unwrap();
        let other = store
            .review_group_create(&id, rev, author, &[replace(5, "e", "E")])
            .unwrap();
        let accepted = store
            .review_decide(
                chosen.id,
                chosen.rev,
                rev,
                &[chosen.hunks[0].id, chosen.hunks[1].id],
                ReviewDecision::Accept,
                author,
            )
            .unwrap();
        assert_eq!(accepted.body.as_deref(), Some(doc("aBBBBcDe").as_str()));
        assert!(store
            .review_group(chosen.id)
            .unwrap()
            .hunks
            .iter()
            .all(|hunk| hunk.state == "accepted"));
        let shifted = store.review_group(other.id).unwrap();
        assert!(shifted.rev > other.rev);
        assert_eq!(shifted.hunks[0].state, "pending");
        assert_eq!(
            (shifted.hunks[0].mapped_from, shifted.hunks[0].mapped_to),
            (8, 9)
        );
    }

    #[test]
    fn stale_revisions_and_a_later_bad_hunk_roll_back_all_accept_effects() {
        let (_dir, store, id, rev, author) = setup("abcde");
        let group = store
            .review_group_create(
                &id,
                rev,
                author,
                &[replace(2, "b", "B"), replace(4, "d", "D")],
            )
            .unwrap();
        assert!(matches!(
            store.review_decide(
                group.id,
                group.rev + 1,
                rev,
                &[group.hunks[0].id],
                ReviewDecision::Accept,
                author
            ),
            Err(StoreError::ReviewConflict { .. })
        ));
        assert!(matches!(
            store.review_decide(
                group.id,
                group.rev,
                rev - 1,
                &[group.hunks[0].id],
                ReviewDecision::Accept,
                author
            ),
            Err(StoreError::Conflict { .. })
        ));
        store
            .conn
            .execute(
                "UPDATE doc SET body = ?2 WHERE item_id = ?1",
                params![id, doc("axcde")],
            )
            .unwrap();
        let before_versions = store.doc_versions(&id).unwrap().len();
        assert!(store
            .review_decide(
                group.id,
                group.rev,
                rev,
                &[group.hunks[0].id, group.hunks[1].id],
                ReviewDecision::Accept,
                author
            )
            .is_err());
        assert_eq!(store.load_doc(&id).unwrap().body, doc("axcde"));
        assert_eq!(store.doc_versions(&id).unwrap().len(), before_versions);
        assert!(store
            .review_group(group.id)
            .unwrap()
            .hunks
            .iter()
            .all(|h| h.state == "pending"));
    }

    #[test]
    fn flush_maps_astral_offsets_and_conflicts_touching_edits() {
        let (_dir, store, id, rev, author) = setup("a😀bc");
        let group = store
            .review_group_create(&id, rev, author, &[replace(5, "c", "C")])
            .unwrap();
        let rev = write(&store, &id, rev, &doc("Xa😀bc"));
        let mapped = store.review_group(group.id).unwrap();
        assert_eq!(
            (mapped.hunks[0].mapped_from, mapped.hunks[0].mapped_to),
            (6, 7)
        );
        assert!(mapped.rev > group.rev);
        write(&store, &id, rev, &doc("Xa😀bq"));
        let conflicted = store.review_group(group.id).unwrap();
        assert_eq!(conflicted.hunks[0].state, "conflicted");
        assert!(conflicted.rev > mapped.rev);
    }

    #[test]
    fn discussion_keeps_author_snapshot_and_restore_conflicts_pending() {
        let (_dir, store, id, rev, author) = setup("abc");
        let group = store
            .review_group_create(&id, rev, author, &[replace(2, "b", "B")])
            .unwrap();
        let message = store
            .review_message_add(group.id, group.rev, author, "A reason")
            .unwrap();
        store
            .conn
            .execute(
                "UPDATE review_author SET display_name = 'Alicia' WHERE id = ?1",
                [author],
            )
            .unwrap();
        assert_eq!(store.review_group(group.id).unwrap().author_name, "Alice");
        assert_eq!(
            store.review_messages(group.id).unwrap()[0].author_name,
            "Alice"
        );
        assert_eq!(message.author_name, "Alice");
        let snapshot = store.snapshot_create("Before").unwrap();
        let rev = write(&store, &id, rev, &doc("xyz"));
        assert_eq!(
            store.review_group(group.id).unwrap().hunks[0].state,
            "conflicted"
        );
        store.snapshot_restore(snapshot.id).unwrap();
        assert_eq!(store.load_doc(&id).unwrap().body, doc("abc"));
        assert!(store.load_doc(&id).unwrap().rev > rev);
        assert_eq!(
            store.review_group(group.id).unwrap().hunks[0].state,
            "conflicted"
        );
    }

    #[test]
    fn structural_hunk_is_stored_and_accepts_exactly() {
        let (_dir, store, id, rev, author) = setup("abc");
        let hunk = ReviewHunk {
            from: 2,
            to: 2,
            before: vec![],
            after: vec![Close, Open],
        };
        let group = store
            .review_group_create(&id, rev, author, &[hunk])
            .unwrap();
        let result = store
            .review_decide(
                group.id,
                group.rev,
                rev,
                &[group.hunks[0].id],
                ReviewDecision::Accept,
                author,
            )
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&result.body.unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"type":"doc","content":[
                {"type":"paragraph","content":[{"type":"text","text":"a"}]},
                {"type":"paragraph","content":[{"type":"text","text":"bc"}]}
            ]})
        );
    }

    #[test]
    fn acceptance_maps_other_comments_and_collapses_the_replaced_subject() {
        let (_dir, store, id, rev, author) = setup("abcde");
        let on_b = store.comment_create(&id, "About b", 2, 3, "b").unwrap();
        let on_e = store.comment_create(&id, "About e", 5, 6, "e").unwrap();
        let group = store
            .review_group_create(&id, rev, author, &[replace(2, "b", "LONG")])
            .unwrap();
        store
            .review_decide(
                group.id,
                group.rev,
                rev,
                &[group.hunks[0].id],
                ReviewDecision::Accept,
                author,
            )
            .unwrap();
        let comments = store.comments(&id).unwrap();
        let replaced = comments.iter().find(|c| c.id == on_b.id).unwrap();
        let shifted = comments.iter().find(|c| c.id == on_e.id).unwrap();
        assert_eq!((replaced.anchor_from, replaced.anchor_to), (2, 2));
        assert_eq!((shifted.anchor_from, shifted.anchor_to), (8, 9));
    }

    #[test]
    fn collapsed_comment_still_shifts_through_a_later_hunk_in_the_same_decision() {
        let (_dir, store, id, rev, author) = setup("abcde");
        let note = store.comment_create(&id, "About d", 4, 5, "d").unwrap();
        let group = store
            .review_group_create(
                &id,
                rev,
                author,
                &[replace(2, "b", "BBBB"), replace(4, "d", "")],
            )
            .unwrap();
        store
            .review_decide(
                group.id,
                group.rev,
                rev,
                &[group.hunks[0].id, group.hunks[1].id],
                ReviewDecision::Accept,
                author,
            )
            .unwrap();
        assert_eq!(store.load_doc(&id).unwrap().body, doc("aBBBBce"));
        let comment = store
            .comments(&id)
            .unwrap()
            .into_iter()
            .find(|row| row.id == note.id)
            .unwrap();
        assert_eq!((comment.anchor_from, comment.anchor_to), (7, 7));
        assert!(comment.orphaned);
    }

    #[test]
    fn unsupported_flush_keeps_the_save_and_conflicts_the_proposal() {
        let (_dir, store, id, rev, author) = setup("abc");
        let group = store
            .review_group_create(&id, rev, author, &[replace(2, "b", "B")])
            .unwrap();
        write(&store, &id, rev, "not supported document JSON");
        assert_eq!(
            store.load_doc(&id).unwrap().body,
            "not supported document JSON"
        );
        assert_eq!(
            store.review_group(group.id).unwrap().hunks[0].state,
            "conflicted"
        );
    }

    #[test]
    fn formatting_only_flush_conflicts_the_exact_marked_span() {
        let (_dir, store, id, rev, author) = setup("abc");
        let group = store
            .review_group_create(&id, rev, author, &[replace(2, "b", "B")])
            .unwrap();
        let changed = serde_json::json!({"type":"doc","content":[{"type":"paragraph",
            "content":[{"type":"text","text":"a"},
                {"type":"text","text":"b","marks":[{"type":"strong"}]},
                {"type":"text","text":"c"}]}]})
        .to_string();
        write(&store, &id, rev, &changed);
        assert_eq!(
            store.review_group(group.id).unwrap().hunks[0].state,
            "conflicted"
        );
    }

    #[test]
    fn discussion_accepts_paragraphs_and_conflicted_hunks_can_be_rejected() {
        let (_dir, store, id, rev, author) = setup("abc");
        let group = store
            .review_group_create(&id, rev, author, &[replace(2, "b", "B")])
            .unwrap();
        let message = store
            .review_message_add(group.id, group.rev, author, "First line\nSecond line")
            .unwrap();
        assert_eq!(message.body, "First line\nSecond line");
        let rev = write(&store, &id, rev, &doc("axc"));
        let conflicted = store.review_group(group.id).unwrap();
        assert_eq!(conflicted.hunks[0].state, "conflicted");
        assert!(store
            .review_decide(
                group.id,
                conflicted.rev,
                rev,
                &[conflicted.hunks[0].id],
                ReviewDecision::Accept,
                author
            )
            .is_err());
        let rejected = store
            .review_decide(
                group.id,
                conflicted.rev,
                rev,
                &[conflicted.hunks[0].id],
                ReviewDecision::Reject,
                author,
            )
            .unwrap();
        assert_eq!(rejected.doc_rev, rev);
        assert_eq!(
            store.review_group(group.id).unwrap().hunks[0].state,
            "rejected"
        );
    }

    #[test]
    fn formatting_acceptance_preserves_comment_subject() {
        let (_dir, store, id, rev, author) = setup("abc");
        let note = store.comment_create(&id, "Emphasis", 2, 3, "b").unwrap();
        let hunk = ReviewHunk {
            from: 2,
            to: 3,
            before: vec![Text {
                text: "b".into(),
                marks: vec![],
            }],
            after: vec![Text {
                text: "b".into(),
                marks: vec![Mark::Strong],
            }],
        };
        let group = store
            .review_group_create(&id, rev, author, &[hunk])
            .unwrap();
        store
            .review_decide(
                group.id,
                group.rev,
                rev,
                &[group.hunks[0].id],
                ReviewDecision::Accept,
                author,
            )
            .unwrap();
        let after = store.comments(&id).unwrap();
        let anchored = after.iter().find(|comment| comment.id == note.id).unwrap();
        assert_eq!((anchored.anchor_from, anchored.anchor_to), (2, 3));
        assert!(!anchored.orphaned);
    }

    #[test]
    fn bible_proposal_does_not_move_manuscript_day_baseline() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let bible = store.item_create(None, "bible", "Bible").unwrap();
        let note = store.item_create(Some(&bible.id), "note", "Note").unwrap();
        let rev = write(&store, &note.id, note.doc_rev.unwrap(), &doc("one"));
        let author = store.review_author_create("Alice").unwrap();
        let hunk = ReviewHunk {
            from: 4,
            to: 4,
            before: vec![],
            after: vec![Text {
                text: " two".into(),
                marks: vec![],
            }],
        };
        let group = store
            .review_group_create(&note.id, rev, author.id, &[hunk])
            .unwrap();
        store
            .set_meta(crate::projects::DAY_BASELINE_KEY, "10")
            .unwrap();
        store
            .review_decide(
                group.id,
                group.rev,
                rev,
                &[group.hunks[0].id],
                ReviewDecision::Accept,
                author.id,
            )
            .unwrap();
        assert_eq!(
            store
                .get_meta(crate::projects::DAY_BASELINE_KEY)
                .unwrap()
                .as_deref(),
            Some("10")
        );
    }

    #[test]
    fn manuscript_accept_records_source_and_day_baseline_inside_decision() {
        let (_dir, store, id, rev, author) = setup("one");
        let group = store
            .review_group_create(&id, rev, author, &[replace(4, "", " two")])
            .unwrap();
        store
            .set_meta(crate::projects::DAY_BASELINE_KEY, "10")
            .unwrap();
        store
            .review_decide(
                group.id,
                group.rev,
                rev,
                &[group.hunks[0].id],
                ReviewDecision::Accept,
                author,
            )
            .unwrap();
        assert_eq!(store.load_doc(&id).unwrap().body, doc("one two"));
        assert_eq!(
            store
                .get_meta(crate::projects::DAY_BASELINE_KEY)
                .unwrap()
                .as_deref(),
            Some("11")
        );
        let ledger = store.source_word_summary("2026-09-25").unwrap();
        assert_eq!(ledger.totals.imported.added, 1);
    }
}
