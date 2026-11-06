use super::image_metadata;
use crate::store::figure_assets::FigureAsset;
use sha2::{Digest, Sha256};

pub(crate) struct Asset {
    pub(crate) href: String,
    pub(crate) mime: String,
    pub(crate) bytes: Vec<u8>,
}

impl Asset {
    pub(crate) fn verified(record: &FigureAsset, bytes: Vec<u8>) -> Result<Self, String> {
        let mut asset = Self::verified_original(record, bytes)?;
        asset.bytes = image_metadata::sanitize(&asset.bytes)?;
        let extension = asset.href.rsplit('.').next().unwrap();
        asset.href = format!("assets/{:x}.{extension}", Sha256::digest(&asset.bytes));
        Ok(asset)
    }

    pub(crate) fn verified_original(record: &FigureAsset, bytes: Vec<u8>) -> Result<Self, String> {
        if bytes.len() as u64 != record.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != record.sha256
        {
            return Err(format!(
                "figure {}: original hash or size mismatch",
                record.id
            ));
        }
        let (format, width, height) =
            crate::pictures::inspect_original(&bytes).map_err(|e| e.to_string())?;
        if format.mime() != record.mime || (width, height) != (record.width_px, record.height_px) {
            return Err(format!("figure {}: original media mismatch", record.id));
        }
        Ok(Self {
            href: format!("assets/{}.{}", record.sha256, format.extension()),
            mime: record.mime.clone(),
            bytes,
        })
    }
}
