//! Retained, immutable figure originals. No deletion or update API.
use super::{document_format, Result, Store, StoreError, READ_SCHEMA_VERSION, TIMELINE_TYPE};
use rusqlite::Connection;
use std::collections::{BTreeMap, HashSet};

// Deliberately absent from the production migration ladder. Activation must use
// this same SQL; tests install only the proposed table in disposable v17 books.
#[cfg(test)]
pub(crate) const PROPOSED_MIGRATION: &str = include_str!("figure_assets.sql");

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FigureAsset {
    pub id: String,
    pub stored_name: String,
    pub mime: String,
    pub bytes: u64,
    pub sha256: String,
    pub width_px: u32,
    pub height_px: u32,
    pub orientation: u8,
}

pub fn is_figure_name(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix("fig-")
        .and_then(|s| s.strip_suffix(".png").or_else(|| s.strip_suffix(".jpg")))
    else {
        return false;
    };
    is_uuid_v7(stem)
}

fn is_uuid_v7(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        id.get_version_num() == 7
            && id.get_variant() == uuid::Variant::RFC4122
            && id.to_string() == value
    })
}

fn valid_asset(asset: &FigureAsset) -> bool {
    is_uuid_v7(&asset.id)
        && asset.stored_name
            == format!(
                "fig-{}.{}",
                asset.id,
                if asset.mime == "image/png" {
                    "png"
                } else {
                    "jpg"
                }
            )
        && matches!(asset.mime.as_str(), "image/png" | "image/jpeg")
        && (1..=16 * 1024 * 1024).contains(&asset.bytes)
        && asset.sha256.len() == 64
        && asset
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && asset.width_px > 0
        && asset.height_px > 0
        && u64::from(asset.width_px) * u64::from(asset.height_px) <= 50_000_000
        && (1..=8).contains(&asset.orientation)
}

#[derive(Default)]
pub(crate) struct Registry {
    pub present: bool,
    pub assets: BTreeMap<String, FigureAsset>,
    pub errors: Vec<String>,
    pub uncertain_names: HashSet<String>,
}

pub(crate) fn read(conn: &Connection) -> Result<Registry> {
    let present: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='figure_asset')",
        [],
        |r| r.get(0),
    )?;
    if !present {
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version >= READ_SCHEMA_VERSION {
            return Err(StoreError::Corrupt(
                "figure registry: table is missing".into(),
            ));
        }
        return Ok(Registry::default());
    }
    let mut registry = Registry {
        present: true,
        ..Registry::default()
    };
    let mut stmt = conn.prepare("SELECT id, stored_name, mime, bytes, sha256, width_px, height_px, orientation FROM figure_asset ORDER BY id")?;
    let mut rows = stmt.query([])?;
    loop {
        let row = match rows.next() {
            Ok(Some(row)) => row,
            Ok(None) => break,
            Err(error) => {
                registry.errors.push(format!(
                    "figure <unknown>: registry enumeration stopped: {error}"
                ));
                break;
            }
        };
        let id = row
            .get::<_, String>(0)
            .unwrap_or_else(|_| "<unknown>".into());
        let asset = (|| -> rusqlite::Result<FigureAsset> {
            Ok(FigureAsset {
                id: row.get(0)?,
                stored_name: row.get(1)?,
                mime: row.get(2)?,
                bytes: row.get::<_, u32>(3)?.into(),
                sha256: row.get(4)?,
                width_px: row.get(5)?,
                height_px: row.get(6)?,
                orientation: row.get(7)?,
            })
        })();
        if !asset.as_ref().is_ok_and(valid_asset) {
            for extension in ["png", "jpg"] {
                let name = format!("fig-{id}.{extension}");
                if is_figure_name(&name) {
                    registry.uncertain_names.insert(name);
                }
            }
        }
        match asset {
            Ok(asset) if valid_asset(&asset) => {
                registry.assets.insert(asset.stored_name.clone(), asset);
            }
            Ok(_) => registry
                .errors
                .push(format!("figure {id}: invalid registry record")),
            Err(error) => registry
                .errors
                .push(format!("figure {id}: unreadable registry record: {error}")),
        }
    }
    Ok(registry)
}

fn insert(conn: &Connection, asset: &FigureAsset) -> Result<()> {
    if !valid_asset(asset) {
        return Err(StoreError::Corrupt("invalid figure registry record".into()));
    }
    conn.execute("INSERT INTO figure_asset (id, stored_name, mime, bytes, sha256, width_px, height_px, orientation) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", rusqlite::params![asset.id, asset.stored_name, asset.mime, asset.bytes as i64, asset.sha256, asset.width_px, asset.height_px, asset.orientation])?;
    Ok(())
}

impl Store {
    pub fn figure_assets(&self) -> Result<Vec<FigureAsset>> {
        let registry = self.figure_registry()?;
        if !registry.errors.is_empty() {
            return Err(StoreError::Corrupt(registry.errors.join("; ")));
        }
        Ok(registry.assets.into_values().collect())
    }

    pub(crate) fn register_figure_asset(&self, asset: &FigureAsset) -> Result<()> {
        if !document_format::new_nodes_allowed() || self.user_version()? < READ_SCHEMA_VERSION {
            return Err(StoreError::InvalidDocument(
                "figure registration is disabled".into(),
            ));
        }
        insert(&self.conn, asset)
    }

    pub(crate) fn figure_registry(&self) -> Result<Registry> {
        read(&self.conn)
    }

    /// Inspect only figure references, without imposing write validation on
    /// retained prose, including damaged legacy books without a registry.
    pub(crate) fn figure_inventory(&self) -> Result<Registry> {
        let mut registry = self.figure_registry()?;
        let ids: HashSet<String> = registry.assets.values().map(|a| a.id.clone()).collect();
        let mut scan = |id: &str, body: Option<&str>| match body
            .filter(|body| registry.present || body.contains("figure"))
            .and_then(|body| serde_json::from_str(body).ok())
        {
            Some(value) => scan_references(&value, id, &ids, &mut registry.errors),
            None if registry.present => registry.errors.push(format!(
                "figure <unknown>: unreadable references in item {id}"
            )),
            None => {},
        };
        let mut stmt = self.conn.prepare("SELECT d.item_id, d.body FROM doc d LEFT JOIN item i ON i.id=d.item_id WHERE i.type IS NULL OR i.type != ?1")?;
        for row in stmt.query_map([TIMELINE_TYPE], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })? {
            let (id, body) = row?;
            scan(&id, body.as_deref());
        }
        if self.user_version()? >= 2 {
            let mut stmt = self.conn.prepare("SELECT v.item_id, b.body FROM doc_version v LEFT JOIN blob b ON b.key=v.blob_key LEFT JOIN item i ON i.id=v.item_id WHERE i.type IS NULL OR i.type != ?1")?;
            for row in stmt.query_map([TIMELINE_TYPE], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })? {
                let (id, body) = row?;
                scan(&id, body.as_deref());
            }
        }
        Ok(registry)
    }
}

fn scan_references(
    value: &serde_json::Value,
    item: &str,
    assets: &HashSet<String>,
    errors: &mut Vec<String>,
) {
    if value["type"] == "figure" {
        let id = value["attrs"]["id"].as_str().unwrap_or("<unknown>");
        match value["attrs"]["asset_id"].as_str() {
            Some(asset) if assets.contains(asset) => {}
            Some(asset) => errors.push(format!(
                "figure {id}: asset {asset} has no readable registry mapping (item {item})"
            )),
            None => errors.push(format!(
                "figure {id}: missing asset reference (item {item})"
            )),
        }
    }
    if let Some(children) = value.get("content").and_then(serde_json::Value::as_array) {
        for child in children {
            scan_references(child, item, assets, errors);
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    pub fn install(store: &Store) {
        assert_eq!(store.user_version().unwrap(), 17);
        store.conn.execute_batch(PROPOSED_MIGRATION).unwrap();
    }
    pub fn allow_corruption(conn: &Connection) {
        conn.execute_batch("ALTER TABLE figure_asset RENAME TO unchecked_source; CREATE TABLE figure_asset AS SELECT * FROM unchecked_source; DROP TABLE unchecked_source;").unwrap();
    }
    pub fn register(store: &Store, asset: &FigureAsset) -> std::result::Result<(), String> {
        insert(&store.conn, asset).map_err(|e| e.to_string())
    }
}
