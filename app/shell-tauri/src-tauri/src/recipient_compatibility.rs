//! Capabilities checked by the writer on the receiving device before export.
use crate::store::Store;

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Recipient { Reader006, Legacy005 }

pub(crate) fn check(store: &Store, recipient: Option<Recipient>) -> Result<(), String> {
    let recipient = recipient.ok_or("recipient_unknown")?;
    let schema = store.user_version().map_err(|error| error.to_string())?;
    let ceiling = match recipient { Recipient::Reader006 => 18, Recipient::Legacy005 => 17 };
    if schema > ceiling { return Err("recipient_schema".into()); }
    let preset = store.get_meta("project.preset").map_err(|error| error.to_string())?;
    let supported = match recipient {
        Recipient::Reader006 => crate::core_constants::PROJECT_PRESETS,
        Recipient::Legacy005 => &["novel"],
    };
    if !supported.contains(&preset.as_deref().unwrap_or("novel")) { return Err("recipient_preset".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_schema_and_preset_refusals_precede_transfer_writes() {
        let root = tempfile::tempdir().unwrap();
        for version in [17, 18] {
            let db = root.path().join(format!("{version}.db"));
            let store = crate::store::historical_test_store(&db, 17);
            if version == 18 {
                crate::store::figure_assets::test_support::install(&store);
                rusqlite::Connection::open(&db).unwrap().pragma_update(None, "user_version", 18).unwrap();
            }
            for preset in ["novel", "short", "nonfiction", "collection", "zzz"] {
                store.set_meta("project.preset", preset).unwrap();
                assert_eq!(check(&store, None).unwrap_err(), "recipient_unknown");
                let legacy = check(&store, Some(Recipient::Legacy005));
                if version == 18 { assert_eq!(legacy.unwrap_err(), "recipient_schema"); }
                else if preset != "novel" { assert_eq!(legacy.unwrap_err(), "recipient_preset"); }
                else { legacy.unwrap(); }
                let current = check(&store, Some(Recipient::Reader006));
                if preset == "zzz" { assert_eq!(current.unwrap_err(), "recipient_preset"); }
                else { current.unwrap(); }
            }
        }
    }
}
