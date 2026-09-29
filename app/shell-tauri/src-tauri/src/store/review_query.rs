use super::{Result, Store, StoreError};
use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ReviewSummary {
    pub id: i64,
    pub author_name: String,
    pub rev: i64,
    pub created_at: i64,
    pub pending: i64,
    pub conflicted: i64,
    pub accepted: i64,
    pub rejected: i64,
    pub messages: i64,
}

#[derive(Debug, Serialize)]
pub struct ReviewPage {
    pub groups: Vec<ReviewSummary>,
    pub before_id: Option<i64>,
}

const PAGE_SQL: &str = "SELECT g.id, g.author_name, g.rev, g.created_at,
    (SELECT count(*) FROM review_hunk h WHERE h.group_id=g.id AND h.state='pending'),
    (SELECT count(*) FROM review_hunk h WHERE h.group_id=g.id AND h.state='conflicted'),
    (SELECT count(*) FROM review_hunk h WHERE h.group_id=g.id AND h.state='accepted'),
    (SELECT count(*) FROM review_hunk h WHERE h.group_id=g.id AND h.state='rejected'),
    (SELECT count(*) FROM review_message m WHERE m.group_id=g.id)
    FROM review_group g WHERE g.item_id=?1 AND (?2 IS NULL OR g.id<?2)
    AND (?3=0 OR EXISTS(SELECT 1 FROM review_hunk h WHERE h.group_id=g.id AND h.state IN ('pending','conflicted')))
    ORDER BY g.id DESC LIMIT ?4";

impl Store {
    /// Lists metadata only; full fragments and discussion load on selection.
    pub fn review_page(
        &self,
        item_id: &str,
        before_id: Option<i64>,
        pending_only: bool,
        limit: usize,
    ) -> Result<ReviewPage> {
        if limit == 0 || limit > 50 || before_id.is_some_and(|id| id <= 0) {
            return Err(StoreError::InvalidReview("invalid review page".into()));
        }
        let mut stmt = self.conn.prepare(PAGE_SQL)?;
        let mut groups = stmt
            .query_map(
                params![item_id, before_id, pending_only, limit as i64 + 1],
                |r| {
                    Ok(ReviewSummary {
                        id: r.get(0)?,
                        author_name: r.get(1)?,
                        rev: r.get(2)?,
                        created_at: r.get(3)?,
                        pending: r.get(4)?,
                        conflicted: r.get(5)?,
                        accepted: r.get(6)?,
                        rejected: r.get(7)?,
                        messages: r.get(8)?,
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let more = groups.len() > limit;
        groups.truncate(limit);
        let before_id = more.then(|| groups.last().unwrap().id);
        Ok(ReviewPage { groups, before_id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_document::{FragmentToken, ReviewHunk};
    use crate::store::review::ReviewDecision;

    #[test]
    fn review_pages_are_newest_first_bounded_and_filter_settled_groups() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let item = store.item_create(None, "scene", "One").unwrap();
        let author = store.review_author_create("Mara").unwrap();
        let mut ids = Vec::new();
        for n in 0..5 {
            let group = store
                .review_group_create(
                    &item.id,
                    item.doc_rev.unwrap(),
                    author.id,
                    &[ReviewHunk {
                        from: 1,
                        to: 1,
                        before: vec![],
                        after: vec![FragmentToken::Text {
                            text: format!("Suggestion {n}"),
                            marks: vec![],
                        }],
                    }],
                )
                .unwrap();
            ids.push(group.id);
            if n == 3 {
                store
                    .review_decide(
                        group.id,
                        group.rev,
                        item.doc_rev.unwrap(),
                        &[group.hunks[0].id],
                        ReviewDecision::Reject,
                        author.id,
                    )
                    .unwrap();
            }
        }
        // The query uses the item/id index; dropping DESC returns oldest first.
        let mut explain = store
            .conn
            .prepare(&format!("EXPLAIN QUERY PLAN {PAGE_SQL}"))
            .unwrap();
        let plan = explain
            .query_map(params![item.id, Option::<i64>::None, true, 3], |r| {
                r.get::<_, String>(3)
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            plan.iter().any(|line| line.contains("review_group_item")),
            "{plan:?}"
        );
        let first = store.review_page(&item.id, None, true, 2).unwrap();
        assert_eq!(
            first.groups.iter().map(|g| g.id).collect::<Vec<_>>(),
            vec![ids[4], ids[2]]
        );
        assert_eq!(first.before_id, Some(ids[2]));
        let second = store
            .review_page(&item.id, first.before_id, true, 2)
            .unwrap();
        assert_eq!(
            second.groups.iter().map(|g| g.id).collect::<Vec<_>>(),
            vec![ids[1], ids[0]]
        );
        assert!(second.before_id.is_none());
        let all = store.review_page(&item.id, None, false, 50).unwrap();
        assert_eq!(all.groups.len(), 5);
        assert_eq!(all.groups[1].rejected, 1);
        assert!(store.review_page(&item.id, None, false, 51).is_err());
        assert!(store.review_page(&item.id, Some(0), false, 1).is_err());
    }
}
