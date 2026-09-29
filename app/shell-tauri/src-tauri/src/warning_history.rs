use crate::identity::{Finding, Preflight, SEVERITY_WARNING};
use crate::store::{history::hash64, Store};

pub const META_KEY: &str = "preflight.warning_reasons";
const VERSION: u32 = 1;
const MAX_ENTRIES: usize = 100;
const MAX_REASON_CHARS: usize = 500;
const MAX_BYTES: usize = 128 * 1024;
const MAX_TIMESTAMP_MS: i64 = 8_640_000_000_000_000;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReasonEntry {
    pub check: String,
    pub format: String,
    pub surface: String,
    pub item_id: Option<String>,
    pub offset: Option<usize>,
    pub fingerprint: String,
    pub reason: String,
    pub at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ReasonHistoryView {
    Available { entries: Vec<ReasonEntry> },
    Unavailable,
}

impl Default for ReasonHistoryView {
    fn default() -> Self {
        Self::Available {
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WarningToken {
    pub finding_index: usize,
    pub token: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    entries: Vec<ReasonEntry>,
}

fn valid_reason(reason: &str) -> bool {
    let trimmed = reason.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= MAX_REASON_CHARS
        && !trimmed
            .chars()
            .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
}

fn parse(raw: Option<&str>) -> Result<Envelope, String> {
    let Some(raw) = raw else {
        return Ok(Envelope {
            version: VERSION,
            entries: Vec::new(),
        });
    };
    if raw.len() > MAX_BYTES {
        return Err("warning reason history exceeds its size limit".into());
    }
    let envelope: Envelope =
        serde_json::from_str(raw).map_err(|_| "warning reason history is malformed".to_owned())?;
    if envelope.version != VERSION {
        return Err("warning reason history uses an unsupported version".into());
    }
    if envelope.entries.len() > MAX_ENTRIES
        || envelope.entries.iter().any(|entry| {
            !valid_reason(&entry.reason)
                || entry.check.is_empty()
                || entry.check.len() > 64
                || entry.surface.is_empty()
                || entry.surface.len() > 64
                || !matches!(entry.format.as_str(), "markdown" | "epub" | "pdf" | "docx")
                || entry.item_id.as_ref().is_some_and(|id| id.len() > 128)
                || entry.fingerprint.len() != 16
                || !entry.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
                || !(0..=MAX_TIMESTAMP_MS).contains(&entry.at_ms)
        })
    {
        return Err("warning reason history has invalid entries".into());
    }
    Ok(envelope)
}

pub fn read(store: &Store) -> Result<ReasonHistoryView, String> {
    let raw = store.get_meta(META_KEY).map_err(|e| e.to_string())?;
    Ok(match parse(raw.as_deref()) {
        Ok(envelope) => ReasonHistoryView::Available {
            entries: envelope.entries,
        },
        Err(_) => ReasonHistoryView::Unavailable,
    })
}

pub fn token_for(format: &str, finding: &Finding) -> String {
    let data = serde_json::to_vec(&(
        format,
        finding.kind,
        finding.severity,
        finding.surface,
        &finding.item_id,
        finding.offset,
        &finding.matched,
    ))
    .expect("finding tuple serializes");
    format!("{:016x}", hash64(&data))
}

pub fn current_tokens(report: &Preflight) -> Vec<WarningToken> {
    report
        .findings
        .iter()
        .enumerate()
        .filter(|(_, finding)| finding.severity == SEVERITY_WARNING)
        .map(|(finding_index, finding)| WarningToken {
            finding_index,
            token: token_for(report.format, finding),
        })
        .collect()
}

/// Call only inside `Store::with_immediate`, after generating `fresh` from
/// that same connection. The page supplies no finding fields or severity.
pub fn append(
    store: &Store,
    fresh: &Preflight,
    token: &str,
    reason: &str,
    at_ms: i64,
) -> Result<ReasonHistoryView, String> {
    if !valid_reason(reason) {
        return Err("reason must be plain text of 1 to 500 characters".into());
    }
    if !(0..=MAX_TIMESTAMP_MS).contains(&at_ms) {
        return Err("invalid warning reason timestamp".into());
    }
    let Some((_, finding)) = fresh.findings.iter().enumerate().find(|(_, finding)| {
        finding.severity == SEVERITY_WARNING && token_for(fresh.format, finding) == token
    }) else {
        return Err("the warning changed; refresh preflight before recording a reason".into());
    };
    let raw = store.get_meta(META_KEY).map_err(|e| e.to_string())?;
    let mut envelope = parse(raw.as_deref())
        .map_err(|error| format!("{error}; existing history was preserved"))?;
    if envelope.entries.len() >= MAX_ENTRIES {
        return Err("warning reason history is full; no prior reason was removed".into());
    }
    envelope.entries.push(ReasonEntry {
        check: finding.kind.into(),
        format: fresh.format.into(),
        surface: finding.surface.into(),
        item_id: finding.item_id.clone(),
        offset: finding.offset,
        fingerprint: token.into(),
        reason: reason.trim().into(),
        at_ms,
    });
    let encoded = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
    if encoded.len() > MAX_BYTES {
        return Err("warning reason history is full; no prior reason was removed".into());
    }
    store
        .set_meta(META_KEY, &encoded)
        .map_err(|e| e.to_string())?;
    Ok(ReasonHistoryView::Available {
        entries: envelope.entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::Format;
    use crate::identity::{self, Subject, Vault};

    fn warning_report() -> Preflight {
        identity::check(&Subject {
            format: Format::Markdown,
            project_name: "Book",
            titles: &[],
            bodies: &[],
            planning: &[],
            pin: None,
            vault: &Vault::default(),
        })
    }

    #[test]
    fn records_only_a_current_warning_and_keeps_the_warning() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let report = warning_report();
        let token = &report.warning_tokens[0].token;
        let view = store
            .with_immediate(|store| append(store, &report, token, " Deliberately no byline. ", 42))
            .unwrap();
        let ReasonHistoryView::Available { entries } = view else {
            panic!("history unavailable")
        };
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].reason, "Deliberately no byline.");
        assert_eq!(entries[0].check, identity::FINDING_IDENTITY_UNSET);
        assert_eq!(report.findings[0].severity, SEVERITY_WARNING);
        assert_eq!(
            read(&store).unwrap(),
            ReasonHistoryView::Available { entries }
        );
        let before = store.get_meta(META_KEY).unwrap();
        assert!(store
            .with_immediate(|store| append(store, &report, "stale", "Reason", 43))
            .is_err());
        assert_eq!(store.get_meta(META_KEY).unwrap(), before);
        let mut blocker = warning_report();
        blocker.findings[0].severity = identity::SEVERITY_BLOCKER;
        assert!(store
            .with_immediate(|store| append(store, &blocker, token, "Reason", 43))
            .is_err());
        assert_eq!(store.get_meta(META_KEY).unwrap(), before);
    }

    #[test]
    fn preserves_unknown_or_malformed_history_and_refuses_append() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let report = warning_report();
        for raw in ["{bad", r#"{"version":2,"entries":[]}"#] {
            store.set_meta(META_KEY, raw).unwrap();
            assert_eq!(read(&store).unwrap(), ReasonHistoryView::Unavailable);
            assert!(store
                .with_immediate(|store| append(
                    store,
                    &report,
                    &report.warning_tokens[0].token,
                    "Reason",
                    42
                ))
                .is_err());
            assert_eq!(store.get_meta(META_KEY).unwrap().as_deref(), Some(raw));
        }
    }

    #[test]
    fn refuses_an_overlong_reason_and_a_full_history_without_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("book.db")).unwrap();
        let report = warning_report();
        let token = &report.warning_tokens[0].token;
        assert!(store
            .with_immediate(|store| append(
                store,
                &report,
                token,
                &"x".repeat(MAX_REASON_CHARS + 1),
                42
            ))
            .is_err());
        assert!(store.get_meta(META_KEY).unwrap().is_none());
        let full = Envelope {
            version: VERSION,
            entries: (0..MAX_ENTRIES)
                .map(|n| ReasonEntry {
                    check: identity::FINDING_IDENTITY_UNSET.into(),
                    format: "markdown".into(),
                    surface: "project".into(),
                    item_id: None,
                    offset: None,
                    fingerprint: token.clone(),
                    reason: format!("Reason {n}"),
                    at_ms: n as i64,
                })
                .collect(),
        };
        let raw = serde_json::to_string(&full).unwrap();
        store.set_meta(META_KEY, &raw).unwrap();
        assert!(store
            .with_immediate(|store| append(store, &report, token, "Another", 42))
            .is_err());
        assert_eq!(
            store.get_meta(META_KEY).unwrap().as_deref(),
            Some(raw.as_str())
        );
    }

    #[test]
    fn complete_backup_and_salvage_keep_the_meta_value_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("book.db");
        let store = Store::open(&db).unwrap();
        let report = warning_report();
        store
            .with_immediate(|store| {
                append(
                    store,
                    &report,
                    &report.warning_tokens[0].token,
                    "Private review context",
                    42,
                )
            })
            .unwrap();
        let raw = store.get_meta(META_KEY).unwrap().unwrap();
        let bundle = dir.path().join("complete.bundle");
        crate::backup_bundle::write(&db, &store, &bundle).unwrap();
        let backed_up = Store::open_readonly(&crate::backup_bundle::db_path(&bundle)).unwrap();
        assert_eq!(
            backed_up.get_meta(META_KEY).unwrap().as_deref(),
            Some(raw.as_str())
        );
        drop(store);
        let salvaged = crate::salvage::salvage(&db, &dir.path().join("salvaged")).unwrap();
        assert_eq!(
            salvaged.meta.as_ref().and_then(|meta| meta.get(META_KEY)),
            Some(&raw)
        );
    }
}
