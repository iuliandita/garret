//! Preserve recoverable review cells without applying them to accepted prose.
use crate::review_validation::{self, Counts};
use crate::salvage::Loss;
use rusqlite::Connection;
use serde_json::json;
use std::path::Path;

pub(crate) fn recover(
    conn: &Connection,
    out: &Path,
    losses: &mut Vec<Loss>,
) -> Result<(String, Counts), String> {
    let (tables, mut issues) = review_validation::read(conn);
    review_validation::check(conn, &tables, &mut issues);
    losses.extend(issues.into_iter().map(|finding| Loss {
        kind: finding.kind,
        detail: finding.detail,
        item_id: finding.item_id,
    }));
    let count = |table: &str| tables.get(table).map_or(0, |rows| rows.len() as u64);
    let state = |name: &str| {
        tables.get("review_hunk").map_or(0, |rows| {
            rows.iter()
                .filter(|row| {
                    row.values.get("state").and_then(|value| value.as_str()) == Some(name)
                })
                .count() as u64
        })
    };
    let counts = Counts {
        authors: count("review_author"),
        groups: count("review_group"),
        hunks: count("review_hunk"),
        messages: count("review_message"),
        pending: state("pending"),
        conflicted: state("conflicted"),
        accepted: state("accepted"),
        rejected: state("rejected"),
    };
    let name = "review.json";
    let value = json!({"format": "raw-review-v1", "note": "Recoverable SQLite review rows, including historical and damaged records. These are not accepted manuscript text or ready-to-apply proposals. See manifest.json and recovery-report.txt.", "tables": tables});
    std::fs::write(
        out.join(name),
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| e.to_string())?;
    Ok((name.into(), counts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_validation::test_support::seed;
    use tempfile::tempdir;

    #[test]
    fn review_salvage_preserves_every_table_state_and_keeps_proposals_out_of_prose() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("book.db");
        let (store, _) = seed(&path);
        drop(store);
        let source = std::fs::read(&path).unwrap();
        let out = dir.path().join("recovered");
        let recovered = crate::salvage::salvage(&path, &out).unwrap();
        assert!(recovered.complete, "{:?}", recovered.losses);
        assert_eq!(recovered.review.as_deref(), Some("review.json"));
        assert_eq!(
            (
                recovered.review_recovered.authors,
                recovered.review_recovered.groups,
                recovered.review_recovered.hunks,
                recovered.review_recovered.messages
            ),
            (2, 4, 4, 1)
        );
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(out.join("review.json")).unwrap()).unwrap();
        assert_eq!(json["format"], "raw-review-v1");
        assert_eq!(
            json["tables"]["review_message"][0]["values"]["author_name"],
            "Editor Ben"
        );
        let manuscript = std::fs::read_to_string(out.join(recovered.manuscript.unwrap())).unwrap();
        assert!(manuscript.contains("aBcdxfgh"));
        assert!(!manuscript.contains("Reviewer Alice"));
        assert!(!manuscript.contains("aBcdxfgH"));
        assert_eq!(std::fs::read(&path).unwrap(), source);
    }

    #[test]
    fn review_salvage_retains_raw_type_damage_orphans_and_healthy_siblings() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("book.db");
        let (store, _) = seed(&path);
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(
                "PRAGMA foreign_keys=OFF;
            UPDATE review_message SET group_id=999;
            UPDATE review_hunk SET before_json=CAST(x'ff' AS TEXT) WHERE state='rejected';
            DROP TABLE review_author;",
            )
            .unwrap();
        drop(store);
        let out = dir.path().join("recovered");
        let result = crate::salvage::salvage(&path, &out).unwrap();
        assert!(!result.complete);
        assert_eq!(result.review_recovered.hunks, 4);
        assert_eq!(result.review_recovered.messages, 1);
        assert!(result
            .losses
            .iter()
            .any(|loss| loss.kind == review_validation::UNREADABLE
                && loss.detail.contains("review_author")));
        assert!(
            result
                .losses
                .iter()
                .any(|loss| loss.kind == review_validation::INVALID
                    && loss.detail.contains("message"))
        );
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(out.join("review.json")).unwrap()).unwrap();
        assert_eq!(
            json["tables"]["review_hunk"][1]["values"]["before_json"]["sqlite_text_hex"],
            "ff"
        );
        assert_eq!(
            json["tables"]["review_message"][0]["values"]["group_id"],
            999
        );
        let report = std::fs::read_to_string(out.join(crate::salvage::LOSS_REPORT_NAME)).unwrap();
        assert!(report.contains("A review record"));
    }

    #[test]
    fn review_salvage_keeps_retained_rows_when_the_schema_header_is_lowered() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("book.db");
        let (store, _) = seed(&path);
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(
                "UPDATE review_hunk SET state='unknown' WHERE state='pending';
                 PRAGMA user_version=16;",
            )
            .unwrap();
        drop(store);
        let out = dir.path().join("recovered");
        let result = crate::salvage::salvage(&path, &out).unwrap();
        assert_eq!(result.review.as_deref(), Some("review.json"));
        assert_eq!(result.review_recovered.hunks, 4);
        assert!(!result.complete);
        assert!(result.losses.iter().any(|loss| loss
            .detail
            .contains("review tables exist below schema version 17")));
        assert!(result
            .losses
            .iter()
            .any(|loss| loss.kind == review_validation::INVALID
                && loss.detail.contains("invalid state")));
        let recovered: serde_json::Value =
            serde_json::from_slice(&std::fs::read(out.join("review.json")).unwrap()).unwrap();
        assert!(recovered["tables"]["review_hunk"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["values"]["state"] == "unknown"));
    }
}
