//! Retained, immutable figure originals. No deletion or update API.
use super::{document_format, Result, Store, StoreError, TIMELINE_TYPE};
use rusqlite::Connection;
use std::collections::{BTreeMap, HashSet};

pub const SCHEMA_VERSION: i64 = 18;

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
    uuid::Uuid::parse_str(stem).is_ok_and(|id| {
        id.get_version_num() == 7
            && id.get_variant() == uuid::Variant::RFC4122
            && id.to_string() == stem
    })
}

fn valid_asset(asset: &FigureAsset) -> bool {
    uuid::Uuid::parse_str(&asset.id).is_ok_and(|id| {
        id.get_version_num() == 7
            && id.get_variant() == uuid::Variant::RFC4122
            && id.to_string() == asset.id
    }) && is_figure_name(&asset.stored_name)
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

pub(crate) fn read(conn: &Connection) -> Result<Vec<FigureAsset>> {
    let present: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='figure_asset')",
        [],
        |r| r.get(0),
    )?;
    if !present {
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version >= SCHEMA_VERSION {
            return Err(StoreError::Corrupt("figure registry is missing".into()));
        }
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare("SELECT id, stored_name, mime, bytes, sha256, width_px, height_px, orientation FROM figure_asset ORDER BY id")?;
    let rows = stmt.query_map([], |r| {
        Ok(FigureAsset {
            id: r.get(0)?,
            stored_name: r.get(1)?,
            mime: r.get(2)?,
            bytes: u64::from(r.get::<_, u32>(3)?),
            sha256: r.get(4)?,
            width_px: r.get(5)?,
            height_px: r.get(6)?,
            orientation: r.get(7)?,
        })
    })?;
    let mut assets = Vec::new();
    for row in rows {
        let asset = row?;
        if !valid_asset(&asset) {
            return Err(StoreError::Corrupt("invalid figure registry record".into()));
        }
        assets.push(asset);
    }
    Ok(assets)
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
        read(&self.conn)
    }

    pub(crate) fn register_figure_asset(&self, asset: &FigureAsset) -> Result<()> {
        if !document_format::new_nodes_allowed() || self.user_version()? < SCHEMA_VERSION {
            return Err(StoreError::InvalidDocument(
                "figure registration is disabled".into(),
            ));
        }
        insert(&self.conn, asset)
    }

    /// All registered originals, including abandoned insertions. References in
    /// the bin and every retained automatic/named version must also resolve.
    pub(crate) fn figure_inventory(&self) -> Result<BTreeMap<String, FigureAsset>> {
        let assets = self.figure_assets()?;
        let ids: HashSet<String> = assets.iter().map(|a| a.id.clone()).collect();
        let validate = |id: &str, body: &str| -> Result<()> {
            let normalized = crate::replace::normalize_legacy_text(body);
            let value = serde_json::from_str(&normalized).map_err(|_| {
                StoreError::InvalidDocument(format!("{id}: unreadable figure references"))
            })?;
            document_format::validate(&value, true, &ids)
        };
        let mut stmt = self.conn.prepare("SELECT d.item_id, d.body FROM doc d LEFT JOIN item i ON i.id=d.item_id WHERE i.type IS NULL OR i.type != ?1")?;
        for row in stmt.query_map([TIMELINE_TYPE], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (id, body) = row?;
            validate(&id, &body)?;
        }
        if self.user_version()? >= 2 {
            let mut stmt = self.conn.prepare("SELECT v.item_id, b.body FROM doc_version v LEFT JOIN blob b ON b.key=v.blob_key LEFT JOIN item i ON i.id=v.item_id WHERE i.type IS NULL OR i.type != ?1")?;
            for row in stmt.query_map([TIMELINE_TYPE], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })? {
                let (id, body) = row?;
                validate(&id, &body)?;
            }
        }
        Ok(assets
            .into_iter()
            .map(|a| (a.stored_name.clone(), a))
            .collect())
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    pub fn install(store: &Store) {
        assert_eq!(store.user_version().unwrap(), 17);
        store.conn.execute_batch(PROPOSED_MIGRATION).unwrap();
    }
    pub fn register(store: &Store, asset: &FigureAsset) -> std::result::Result<(), String> {
        insert(&store.conn, asset).map_err(|e| e.to_string())
    }
}
