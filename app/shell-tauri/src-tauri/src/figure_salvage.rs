//! Loss-aware readable recovery, independent of the production write gate.
use crate::{
    figures, pictures,
    salvage::Loss,
    store::{
        document_format,
        figure_assets::{self, FigureAsset},
    },
};
use serde_json::{json, Value};
use std::io::Read;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
};

fn loss(losses: &mut Vec<Loss>, kind: &str, detail: String, item: Option<&str>) {
    losses.push(Loss {
        kind: kind.into(),
        detail,
        item_id: item.map(str::to_string),
    });
}

fn registry(conn: &rusqlite::Connection) -> Result<BTreeMap<String, FigureAsset>, String> {
    figure_assets::read(conn)
        .map(|assets| {
            assets
                .into_iter()
                .map(|asset| (asset.id.clone(), asset))
                .collect()
        })
        .map_err(|e| e.to_string())
}

pub(crate) fn recover(
    conn: &rusqlite::Connection,
    source: &Path,
    out: &Path,
    losses: &mut Vec<Loss>,
) -> Result<(u64, u64, Option<String>), String> {
    let assets = match registry(conn) {
        Ok(assets) => assets,
        Err(error) => {
            loss(losses, "unreadable_figure_registry", error, None);
            BTreeMap::new()
        }
    };
    let from = pictures::dir_for(source);
    let mut names: BTreeMap<String, Option<&FigureAsset>> = assets
        .values()
        .map(|asset| (asset.stored_name.clone(), Some(asset)))
        .collect();
    // Failed registrations can leave independently copied originals. Salvage
    // retains them too, explicitly marked as having no registry record.
    match fs::symlink_metadata(&from) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            for entry in fs::read_dir(&from).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if let Some(name) = entry
                    .file_name()
                    .to_str()
                    .filter(|name| figure_assets::is_figure_name(name))
                {
                    names.entry(name.into()).or_insert(None);
                }
            }
        }
        _ if names.is_empty() => return Ok((0, 0, None)),
        _ => {
            loss(
                losses,
                "missing_figure_original",
                "figure directory is missing or unsafe".into(),
                None,
            );
            return write_registry(out, &assets, 0);
        }
    }
    let into = out.join("pictures");
    let mut copied = 0;
    for (name, asset) in &names {
        if asset.is_none() {
            loss(
                losses,
                "unregistered_figure_original",
                format!("{name}: original has no registry record"),
                None,
            );
        }
        fs::create_dir_all(&into).map_err(|e| e.to_string())?;
        let result = (|| {
            if let Some(asset) = asset {
                figures::verify_original(&from.join(name), asset)?;
            }
            let mut input = crate::backup_bundle::open_regular_with_limit(
                &from.join(name),
                pictures::MAX_PICTURE_BYTES,
            )
            .map_err(str::to_string)?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(into.join(name))
                .map_err(|e| e.to_string())?;
            let bytes = std::io::copy(
                &mut std::io::Read::by_ref(&mut input).take(pictures::MAX_PICTURE_BYTES + 1),
                &mut output,
            )
            .map_err(|e| e.to_string())?;
            if bytes > pictures::MAX_PICTURE_BYTES {
                return Err("figure exceeds byte limit".into());
            }
            output.sync_all().map_err(|e| e.to_string())?;
            if let Some(asset) = asset {
                figures::verify_original(&into.join(name), asset)?;
            }
            Ok::<(), String>(())
        })();
        match result {
            Ok(()) => copied += 1,
            Err(error) => loss(
                losses,
                "missing_figure_original",
                format!("{name}: {error}"),
                None,
            ),
        }
    }
    write_registry(out, &assets, copied)
}

fn write_registry(
    out: &Path,
    assets: &BTreeMap<String, FigureAsset>,
    copied: u64,
) -> Result<(u64, u64, Option<String>), String> {
    if assets.is_empty() {
        return Ok((0, copied, None));
    }
    let file = "figures.json";
    fs::write(
        out.join(file),
        serde_json::to_vec_pretty(&assets.values().collect::<Vec<_>>())
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok((assets.len() as u64, copied, Some(file.into())))
}

fn plain(text: &str) -> String {
    let body = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]});
    if text.is_empty() {
        String::new()
    } else {
        crate::export::document_markdown(&body.to_string()).unwrap_or_default()
    }
}

pub(crate) fn has_new_nodes(body: &str) -> bool {
    fn visit(value: &Value) -> bool {
        matches!(
            value["type"].as_str(),
            Some("figure" | "endnote" | "scene_break")
        ) || value
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|nodes| nodes.iter().any(visit))
    }
    serde_json::from_str(body).is_ok_and(|root| visit(&root))
}

pub(crate) fn document_markdown(
    conn: &rusqlite::Connection,
    body: &str,
    id: &str,
    prefix: &str,
    strings: crate::strings::Strings,
    losses: &mut Vec<Loss>,
) -> Option<String> {
    let normalized = crate::replace::normalize_legacy_text(body);
    let mut root: Value = serde_json::from_str(&normalized).ok()?;
    let assets = registry(conn).unwrap_or_default(); // recover() separately reports registry read failure.
    let mut ids: HashSet<String> = assets.keys().cloned().collect();
    // A readable placeholder can survive a missing mapping; its loss must be
    // reported, while unknown node fields/encodings still preserve raw bytes.
    for block in root.get("content")?.as_array()? {
        if block["type"] == "figure" {
            if let Some(id) = block["attrs"]["asset_id"].as_str() {
                ids.insert(id.into());
            }
        }
    }
    document_format::validate(&root, true, &ids).ok()?;
    let mut notes = Vec::new();
    let mut markdown = String::new();
    let mut flattened = false;
    for block in root["content"].as_array_mut()? {
        match block["type"].as_str()? {
            "paragraph" => {
                if let Some(content) = block["content"].as_array_mut() {
                    for node in content {
                        if node["type"] == "endnote" {
                            notes.push(node["attrs"]["body"].as_str()?.to_string());
                            *node = json!({"type":"text","text":format!("[{}]", notes.len())});
                            flattened = true;
                        }
                    }
                }
                markdown.push_str(&crate::export::document_markdown(
                    &json!({"type":"doc","content":[block]}).to_string(),
                )?);
                markdown.push_str("\n\n");
            }
            "figure" => {
                let attrs = &block["attrs"];
                let asset_id = attrs["asset_id"].as_str()?;
                markdown.push_str(&format!(
                    "[{}]\n\n{}\n\n{}: {}\n\n",
                    strings.f("salvage.figure", &[("id", attrs["id"].as_str()?)]),
                    plain(attrs["caption"].as_str()?),
                    strings.t("salvage.figure_alt"),
                    plain(attrs["alt"].as_str()?)
                ));
                if let Some(asset) = assets.get(asset_id) {
                    markdown.push_str(&format!(
                        "[{}]({prefix}/pictures/{})\n\n",
                        strings.t("salvage.figure_original"),
                        asset.stored_name
                    ));
                } else {
                    loss(
                        losses,
                        "missing_figure_original",
                        format!("{asset_id}: figure has no registry mapping"),
                        Some(id),
                    );
                }
                flattened = true;
            }
            "scene_break" => {
                markdown.push_str("---\n\n");
                flattened = true;
            }
            _ => return None,
        }
    }
    if !flattened {
        return crate::export::document_markdown(body);
    }
    for (n, note) in notes.iter().enumerate() {
        markdown.push_str(&format!("{}. {}\n\n", n + 1, plain(note)));
    }
    loss(losses, "document_structure_flattened", "readable recovery retains note text and figure placeholders; editor structure and figure layout are not preserved".into(), Some(id));
    Some(markdown.trim_end().into())
}
