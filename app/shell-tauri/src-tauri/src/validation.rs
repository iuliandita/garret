//! One read-only database integrity report used by CLI, recovery, and transfer.

use crate::store;
use serde::Serialize;
use std::path::Path;

/// A second read-only connection for the handful of questions `Store` does not
/// expose -- aggregate counts and the referential checks `validate` reports.
///
/// A SEPARATE CONNECTION rather than a `conn()` accessor on `Store`, because the
/// store keeps its connection private deliberately and widening it for a
/// reporting command would put every future caller one field access away from a
/// write. The no-migration rule belongs here, at the shared validator's open.
pub(crate) fn readonly_conn(path: &Path) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("{}: {e}", path.display()))?;
    let _ = conn.pragma_update(None, "busy_timeout", 5000);
    Ok(conn)
}

// --------------------------------------------------------------- validate

/// One thing wrong with the file. `kind` is a stable machine token; `detail` is
/// the sentence a person reads.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Finding {
    pub kind: String,
    pub detail: String,
    pub item_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Validation {
    pub path: String,
    pub schema_version: i64,
    /// EVERY finding, not the first. A validator that stops at one problem makes
    /// a damaged file take as many runs to understand as it has faults.
    pub findings: Vec<Finding>,
    pub ok: bool,
}

/// The token for a walk that did not reach every row: an orphan, a cycle, or
/// nesting past the depth bound. The store already detects all three and returns
/// `Corrupt`; nothing surfaced it before this command.
pub(crate) const KIND_STRUCTURE: &str = "structure";
/// A stored body that is not a document this build can read.
pub(crate) const KIND_UNREADABLE_BODY: &str = "unreadable_body";
/// A `doc` row whose `item` is gone.
pub(crate) const KIND_ORPHAN_DOC: &str = "orphan_doc";

/// The token for a synopsis whose item is gone. Its own kind rather than
/// `orphan_doc`, because a script acting on the two would act differently: an
/// orphaned document is prose somebody may want back, and an orphaned synopsis
/// is a note about a row that no longer exists.
pub(crate) const KIND_ORPHAN_SYNOPSIS: &str = "orphan_synopsis";
/// The token for a detail field whose cast member is gone. Its own kind for the
/// reason the one above has one: a script acting on the two would act
/// differently, and a field with no member is a line of a character sheet whose
/// character no longer exists.
pub(crate) const KIND_ORPHAN_CAST_FIELD: &str = "orphan_cast_field";
/// The token for an alias whose cast member is gone. `KIND_ORPHAN_CAST_FIELD`'s
/// own reason, one table over: a script acting on the two would act
/// differently, and an alias with no member is a line of a character sheet
/// whose character no longer exists.
pub(crate) const KIND_ORPHAN_CAST_ALIAS: &str = "orphan_cast_alias";
/// The token for an appearance naming an item or a cast member that is gone.
/// ONE kind for both sides rather than two, and that is the difference from the
/// three above: those name a row that BELONGS to something absent, so which
/// side is missing is the whole of what happened. Here the row is a PAIR and
/// either end can be the missing one -- the detail sentence says which, and a
/// script acting on it does the same thing either way, because a tag naming
/// something that is not in the book is unusable regardless of which half is
/// gone.
pub(crate) const KIND_ORPHAN_APPEARANCE: &str = "orphan_appearance";
/// A `doc_version` row whose content-addressed blob is absent, so the version
/// exists in the listing and cannot be restored.
pub(crate) const KIND_MISSING_BLOB: &str = "missing_blob";
pub(crate) const KIND_INVALID_REVISION_TASK: &str = "invalid_revision_task";
pub(crate) const KIND_INVALID_REVISION_PASS: &str = "invalid_revision_pass";

pub fn validate(path: &Path) -> Result<Validation, String> {
    let store = store::Store::open_readonly(path).map_err(|e| e.to_string())?;
    let schema_version = store.user_version().map_err(|e| e.to_string())?;
    let conn = readonly_conn(path)?;
    let mut findings = Vec::new();

    // 1. The walk. Only `Corrupt` is a FINDING: every other error means the
    //    query itself could not run, which is "could not read" and belongs to
    //    exit 2, not to a report about the manuscript. Ok's items are kept --
    //    step 2 needs to know which ids are timelines, and a validator that
    //    walked the tree twice could see the file change shape between reads.
    let walked: Vec<store::Item> = match store.items() {
        Ok(items) => items,
        Err(store::StoreError::Corrupt(msg)) => {
            findings.push(Finding {
                kind: KIND_STRUCTURE.into(),
                detail: msg,
                item_id: None,
            });
            Vec::new()
        }
        Err(e) => return Err(e.to_string()),
    };
    let timeline_ids: std::collections::HashSet<&str> = walked
        .iter()
        .filter(|i| i.item_type == store::TIMELINE_TYPE)
        .map(|i| i.id.as_str())
        .collect();

    // 2. Bodies that do not parse. The acceptance rule is
    //    `store::document_text`'s -- the
    //    root must be a `doc`. Reused rather than restated on purpose: a
    //    validator with its own idea of a readable body would report scenes the
    //    application reads fine, or stay silent about ones it does not.
    //
    //    A TIMELINE'S BODY IS NEVER "UNREADABLE": it is not a document at
    //    all, by design -- `document_text` correctly returns None
    //    for its opaque JSON, and reporting that as damage would tell an
    //    operator every healthy timeline in the file is corrupt.
    let bodies = store.documents().map_err(|e| e.to_string())?;
    let mut unreadable: Vec<&String> = bodies
        .iter()
        .filter(|(id, _)| !timeline_ids.contains(id.as_str()))
        .filter(|(_, body)| store::document_text(body).is_none())
        .map(|(id, _)| id)
        .collect();
    unreadable.sort();
    for id in unreadable {
        findings.push(Finding {
            kind: KIND_UNREADABLE_BODY.into(),
            detail: format!("the body stored for {id} is not a document this build can read"),
            item_id: Some(id.clone()),
        });
    }

    // 3. `doc` rows with no `item`. The foreign key makes this unwritable while
    //    `foreign_keys = ON`, which `open_readonly` does NOT set and an external
    //    tool need not have set either -- so the check is about what the file
    //    holds, not about what this build would have written.
    for id in query_strings(
        &conn,
        "SELECT d.item_id FROM doc d LEFT JOIN item i ON i.id = d.item_id
          WHERE i.id IS NULL ORDER BY d.item_id",
    )? {
        findings.push(Finding {
            kind: KIND_ORPHAN_DOC.into(),
            detail: format!("a document is stored for {id}, which is not an item in this project"),
            item_id: Some(id),
        });
    }

    // 3b. `synopsis` rows with no `item`, on the same argument as the check
    //    above and guarded on the version the table arrived at.
    if schema_version >= 6 {
        for id in query_strings(
            &conn,
            "SELECT s.item_id FROM synopsis s LEFT JOIN item i ON i.id = s.item_id
              WHERE i.id IS NULL ORDER BY s.item_id",
        )? {
            findings.push(Finding {
                kind: KIND_ORPHAN_SYNOPSIS.into(),
                detail: format!(
                    "a synopsis is stored for {id}, which is not an item in this project"
                ),
                item_id: Some(id),
            });
        }
    }

    // 3c. `cast_field` rows with no `cast_member`, on the same argument as the
    //    two checks above and guarded on the version the tables arrived at.
    //    Reported by MEMBER id rather than by label: the label is the writer's
    //    word and two members can share one, so the id is the only thing that
    //    names the row a reader would go looking for.
    if schema_version >= 7 {
        for id in query_strings(
            &conn,
            "SELECT DISTINCT f.member_id FROM cast_field f
               LEFT JOIN cast_member m ON m.id = f.member_id
              WHERE m.id IS NULL ORDER BY f.member_id",
        )? {
            findings.push(Finding {
                kind: KIND_ORPHAN_CAST_FIELD.into(),
                detail: format!(
                    "detail fields are stored for {id}, which is not a character, place or point of interest in this project"
                ),
                item_id: Some(id),
            });
        }
    }

    // 3d. `cast_alias` rows with no `cast_member`, on the same argument
    //    as 3c, one table over and guarded on the version the table arrived
    //    at. Reported by MEMBER id for 3c's reason: the alias is the writer's
    //    word and two members could share one, so the id is the only thing
    //    that names the row a reader would go looking for.
    if schema_version >= 10 {
        for id in query_strings(
            &conn,
            "SELECT DISTINCT a.member_id FROM cast_alias a
               LEFT JOIN cast_member m ON m.id = a.member_id
              WHERE m.id IS NULL ORDER BY a.member_id",
        )? {
            findings.push(Finding {
                kind: KIND_ORPHAN_CAST_ALIAS.into(),
                detail: format!(
                    "aliases are stored for {id}, which is not a character, place or point of interest in this project"
                ),
                item_id: Some(id),
            });
        }
    }

    // 3e. `appearance` rows naming an item or a cast member that is gone, on
    //    the same argument as the four checks above and guarded on the version
    //    the table arrived at. BOTH SIDES, in one pass and in one ordering, so a
    //    file whose whole cast table was lost reports its tags once rather than
    //    twice per row.
    if schema_version >= 9 {
        let mut stmt = conn
            .prepare(
                "SELECT a.item_id, a.cast_member_id, i.id IS NULL, m.id IS NULL
                   FROM appearance a
                   LEFT JOIN item i ON i.id = a.item_id
                   LEFT JOIN cast_member m ON m.id = a.cast_member_id
                  WHERE i.id IS NULL OR m.id IS NULL
                  ORDER BY a.item_id, a.cast_member_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, bool>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut found = Vec::new();
        for row in rows {
            found.push(row.map_err(|e| e.to_string())?);
        }
        for (item_id, member_id, no_item, no_member) in found {
            let detail = if no_item && no_member {
                format!(
                    "an appearance records {member_id} in {item_id}, and neither is in this project"
                )
            } else if no_item {
                format!("an appearance records {member_id} in {item_id}, which is not an item in this project")
            } else {
                format!("an appearance records {member_id}, which is not a character, place or point of interest in this project, in {item_id}")
            };
            findings.push(Finding {
                kind: KIND_ORPHAN_APPEARANCE.into(),
                detail,
                // The ITEM, because that is the row a reader would go looking
                // for in their outline. The member id is in the sentence.
                item_id: Some(item_id),
            });
        }
    }

    // 4. Versions pointing at absent blobs. Guarded on the schema version for
    //    the reason `inspect` guards: a v1 file has no history tables and is not
    //    thereby damaged.
    if schema_version >= 2 {
        let mut stmt = conn
            .prepare(
                "SELECT v.id, v.item_id, v.blob_key FROM doc_version v
                   LEFT JOIN blob b ON b.key = v.blob_key
                  WHERE b.key IS NULL ORDER BY v.id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (version_id, item_id, key) = row.map_err(|e| e.to_string())?;
            findings.push(Finding {
                kind: KIND_MISSING_BLOB.into(),
                detail: format!(
                    "version {version_id} of {item_id} names blob {key}, which is not stored; \
                     that version cannot be restored"
                ),
                item_id: Some(item_id),
            });
        }
    }

    if schema_version >= 13 {
        let mut stmt = conn
            .prepare(
                "SELECT t.id,t.item_id,t.pass_id,t.body FROM revision_task t
              LEFT JOIN item i ON i.id=t.item_id
              LEFT JOIN revision_pass p ON p.id=t.pass_id
             WHERE trim(t.body)='' OR (t.item_id IS NOT NULL AND i.id IS NULL)
                OR (t.pass_id IS NOT NULL AND p.id IS NULL) ORDER BY t.id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, item_id, pass_id) = row.map_err(|e| e.to_string())?;
            findings.push(Finding { kind: KIND_INVALID_REVISION_TASK.into(),
                detail: format!("revision task {id} has empty text or a missing item/pass link ({item_id:?}, {pass_id:?})"), item_id });
        }
        for id in query_strings(
            &conn,
            "SELECT CAST(id AS TEXT) FROM revision_pass WHERE trim(name)='' ORDER BY id",
        )? {
            findings.push(Finding {
                kind: KIND_INVALID_REVISION_PASS.into(),
                detail: format!("revision pass {id} has an empty name"),
                item_id: None,
            });
        }
    }

    findings.extend(crate::review_validation::validate(&conn, schema_version));
    Ok(Validation {
        path: path.to_string_lossy().into_owned(),
        ok: findings.is_empty(),
        schema_version,
        findings,
    })
}

fn query_strings(conn: &rusqlite::Connection, sql: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    #[test]
    fn validator_and_export_agree_which_bodies_are_documents() {
        for body in [
            "",
            "{}",
            "[]",
            r#"{"type":"timeline","content":[]}"#,
            r#"{"type":"doc"}"#,
            r#"{"type":"doc","content":[]}"#,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hi"}]}]}"#,
            r#"{"type":"doc","content":"malformed"}"#,
        ] {
            assert_eq!(
                crate::store::document_text(body).is_some(),
                crate::export::document_markdown(body).is_some(),
                "{body}"
            );
        }
    }
}
