use crate::{
    epub::{wrap_marks, xml_escape},
    publication_plan::Plan,
};

pub(super) const CSS: &str = ".proof-leaf[data-kind=interior] .proof-runhead, .proof-leaf[data-kind=interior] .proof-folio { visibility: visible; }\n\
    figure.proof-figure { margin: 0; padding: 0; break-inside: avoid; }\n\
    .proof-figure img { display: block; margin: auto; image-orientation: from-image; }\n\
    .proof-figure figcaption { margin: 0; text-align: center; white-space: pre-wrap; overflow-wrap: anywhere; }\n\
    .proof-note { white-space: pre-wrap; text-indent: 0; }\n\
    .proof-noteref { vertical-align: super; font-size: smaller; }\n\
    .proof-scene-break { text-align: center; margin: 1.2em 0; }\n\
    .proof-scene-break::after { content: '* * *'; }\n";

pub(super) fn blocks(
    plan: &Plan,
    item: &str,
    flow: &mut String,
    opening: &mut bool,
    mut running: Option<&str>,
) -> Result<(), String> {
    for block in plan.documents[item]["content"].as_array().unwrap() {
        let run = running
            .take()
            .map(|title| format!(" data-proof-running=\"{}\"", xml_escape(title)))
            .unwrap_or_default();
        match block["type"].as_str().unwrap() {
            "paragraph" => {
                let mut inline = String::new();
                for node in block
                    .get("content")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if node["type"] == "text" {
                        inline.push_str(&wrap_marks(
                            &xml_escape(node["text"].as_str().unwrap()),
                            node,
                        ));
                    } else {
                        let index = plan.references[item][node["attrs"]["id"].as_str().unwrap()];
                        inline.push_str(&format!(
                            "<sup class=\"proof-noteref\">{}</sup>",
                            plan.notes[index].number
                        ));
                    }
                }
                let class = if *opening && !inline.trim().is_empty() {
                    *opening = false;
                    " class=\"opening\""
                } else {
                    ""
                };
                flow.push_str(&format!("<p{class}{run}>{inline}</p>\n"));
            }
            "figure" => {
                let attrs = &block["attrs"];
                let asset = &plan.assets[attrs["asset_id"].as_str().unwrap()];
                let (format, width, height) =
                    crate::pictures::inspect_original(&asset.bytes).map_err(|e| e.to_string())?;
                let orientation = crate::figures::orientation(&asset.bytes, format)?;
                let own = if attrs["width"] == "page" {
                    " data-proof-leaf=\"interior\""
                } else {
                    ""
                };
                flow.push_str(&format!("<figure class=\"proof-figure\"{own}{run} data-width=\"{}\" data-item=\"{}\" data-instance=\"{}\" data-pixels-width=\"{width}\" data-pixels-height=\"{height}\" data-orientation=\"{orientation}\"><img src=\"data:{};base64,{}\" alt=\"{}\"/><figcaption>{}</figcaption></figure>\n",
                    attrs["width"].as_str().unwrap(), xml_escape(item), attrs["id"].as_str().unwrap(), asset.mime,
                    crate::pictures::base64(&asset.bytes), xml_escape(attrs["alt"].as_str().unwrap()), xml_escape(attrs["caption"].as_str().unwrap())));
            }
            "scene_break" => flow.push_str(&format!(
                "<div class=\"proof-scene-break\" role=\"separator\"{run}></div>\n"
            )),
            _ => unreachable!("validated publication block"),
        }
    }
    Ok(())
}

pub(super) fn endnotes(plan: &Plan, item: &str, title: &str, flow: &mut String) {
    if let Some(scopes) = plan.endnotes.get(item) {
        for (scope, notes) in scopes {
            let label = &plan.scopes.rows[*scope].label;
            let heading = if label.is_empty() {
                xml_escape(title)
            } else {
                format!("{}: {}", xml_escape(title), xml_escape(label))
            };
            flow.push_str(&format!("<h2>{heading}</h2>\n"));
            for index in notes {
                let note = &plan.notes[*index];
                flow.push_str(&format!(
                    "<p class=\"proof-note\">{}. {}</p>\n",
                    note.number,
                    xml_escape(&note.body)
                ));
            }
        }
    }
}
