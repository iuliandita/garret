use super::*;
use crate::publication_plan::Plan;

const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WP_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";

fn section(start: usize) -> String {
    format!("<w:sectPr><w:endnotePr><w:pos w:val=\"sectEnd\"/><w:numFmt w:val=\"decimal\"/><w:numStart w:val=\"{start}\"/><w:numRestart w:val=\"eachSect\"/></w:endnotePr><w:type w:val=\"continuous\"/><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr>")
}

// Scoped labels remain native custom marks in readers that ignore eachSect.
fn custom_marks(plan: &Plan) -> bool {
    plan.notes
        .iter()
        .enumerate()
        .any(|(index, note)| note.number != index + 1)
}

fn endnotes(plan: &Plan) -> String {
    let mut out = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:endnotes xmlns:w=\"{W_NS}\"><w:endnote w:type=\"separator\" w:id=\"-1\"><w:p><w:r><w:separator/></w:r></w:p></w:endnote><w:endnote w:type=\"continuationSeparator\" w:id=\"0\"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>");
    for (index, note) in plan.notes.iter().enumerate() {
        out.push_str(&format!("<w:endnote w:id=\"{}\"><w:p><w:pPr><w:ind w:firstLine=\"0\"/></w:pPr><w:r><w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr><w:endnoteRef/></w:r>{}</w:p></w:endnote>", index + 1, run_xml(&format!(" {}", note.body), &serde_json::Value::Null)));
    }
    out.push_str("</w:endnotes>");
    out
}

fn figure(node: &serde_json::Value, plan: &Plan, drawing: usize) -> Result<String, String> {
    let attrs = &node["attrs"];
    let asset_id = attrs["asset_id"].as_str().unwrap();
    let asset = &plan.assets[asset_id];
    let media = plan.assets.keys().position(|id| id == asset_id).unwrap() + 2;
    let (_, width, height) =
        crate::pictures::inspect_original(&asset.bytes).map_err(|e| e.to_string())?;
    let page = attrs["width"] == "page";
    let available_width = if attrs["width"] == "half" {
        2_971_800u64
    } else {
        5_943_600
    };
    let available_height = 7_315_200u64;
    let cx = available_width.min(available_height * u64::from(width) / u64::from(height));
    let cy = cx * u64::from(height) / u64::from(width);
    let alt = xml_escape(attrs["alt"].as_str().unwrap());
    let mut out = format!("<w:p><w:pPr><w:keepNext/><w:pageBreakBefore w:val=\"{}\"/><w:ind w:firstLine=\"0\"/><w:jc w:val=\"center\"/></w:pPr><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"{drawing}\" name=\"Figure {drawing}\" descr=\"{alt}\"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri=\"{PIC_NS}\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"0\" name=\"Figure {drawing}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"rId{media}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>", if page { 1 } else { 0 });
    out.push_str(&format!("<w:p><w:pPr><w:keepLines/><w:ind w:firstLine=\"0\"/><w:jc w:val=\"center\"/></w:pPr>{}</w:p>", run_xml(attrs["caption"].as_str().unwrap(), &serde_json::Value::Null)));
    if page {
        out.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
    }
    Ok(out)
}

fn blocks(id: &str, plan: &Plan, drawing: &mut usize, custom: bool) -> Result<String, String> {
    let mut out = String::new();
    for node in plan.documents[id]["content"].as_array().unwrap() {
        match node["type"].as_str().unwrap() {
            "paragraph" => {
                let mut inline = String::new();
                let mut content = false;
                for child in node.get("content").and_then(serde_json::Value::as_array).into_iter().flatten() {
                    if child["type"] == "endnote" {
                        let index = plan.references[id][child["attrs"]["id"].as_str().unwrap()];
                        let mark = if custom {
                            format!("<w:endnoteReference w:id=\"{}\" w:customMarkFollows=\"1\"/><w:t>{}</w:t>", index + 1, plan.notes[index].number)
                        } else { format!("<w:endnoteReference w:id=\"{}\"/>", index + 1) };
                        inline.push_str(&format!("<w:r><w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr>{mark}</w:r>"));
                        content = true;
                    } else {
                        append_inline(child, &mut inline, &mut content);
                    }
                }
                if content { out.push_str(&format!("<w:p>{inline}</w:p>")); }
            }
            "figure" => {
                *drawing += 1;
                out.push_str(&figure(node, plan, *drawing)?);
            }
            "scene_break" => out.push_str("<w:p><w:pPr><w:ind w:firstLine=\"0\"/><w:jc w:val=\"center\"/></w:pPr><w:r><w:t>* * *</w:t></w:r></w:p>"),
            _ => unreachable!("validated publication blocks"),
        }
    }
    Ok(out)
}

pub(super) fn render(
    book: &Book,
    bodies: &HashMap<String, String>,
    lang: &str,
    plan: &Plan,
) -> Result<Manuscript, String> {
    let mut body = publication_preamble(book);
    let mut items = Vec::new();
    for (run_index, run) in [book.front, book.chapters, book.back]
        .into_iter()
        .enumerate()
    {
        for item in run {
            items.push((run_index, item));
        }
    }
    let mut drawing = 0;
    let mut start = None;
    let custom = custom_marks(plan);
    for (index, (run, (id, title, depth))) in items.iter().enumerate() {
        if !book.suppresses_heading(*run, title) {
            body.push_str(&styled_paragraph(
                &heading_style(*depth),
                &heading_text(title),
            ));
        }
        if let Some(author) = book.byline(id) {
            body.push_str(&byline_paragraph(author));
        }
        if plan.documents.contains_key(id) {
            body.push_str(&blocks(id, plan, &mut drawing, custom)?);
        } else if let Some(paragraphs) = bodies.get(id).and_then(|b| document_paragraphs(b)) {
            for paragraph in paragraphs {
                body.push_str(&paragraph);
            }
        }
        if start.is_none() {
            start = plan.references.get(id).and_then(|references| references.values().min())
                .map(|index| plan.notes[*index].number);
        }
        let scope = plan.scopes.by_item[id];
        let end = items
            .get(index + 1)
            .is_none_or(|(_, next)| plan.scopes.by_item[&next.0] != scope);
        if end {
            let properties = section(start.unwrap_or(1));
            if index + 1 == items.len() {
                body.push_str(&properties);
            } else {
                body.push_str(&format!("<w:p><w:pPr>{properties}</w:pPr></w:p>"));
            }
            start = None;
        }
    }
    let document = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"{W_NS}\" xmlns:r=\"{R_NS}\" xmlns:wp=\"{WP_NS}\" xmlns:a=\"{A_NS}\" xmlns:pic=\"{PIC_NS}\"><w:body>{body}</w:body></w:document>");
    let mut types = content_types_xml();
    let mut rels = document_rels_xml();
    let mut entries = Vec::new();
    let mut media_names = std::collections::BTreeSet::new();
    let mut extensions = std::collections::BTreeSet::new();
    for (index, asset) in plan.assets.values().enumerate() {
        let name = asset.href.strip_prefix("assets/").unwrap();
        if extensions.insert(name.rsplit('.').next().unwrap()) {
            types = types.replace(
                "</Types>",
                &format!(
                    "<Default Extension=\"{}\" ContentType=\"{}\"/></Types>",
                    name.rsplit('.').next().unwrap(),
                    asset.mime
                ),
            );
        }
        if media_names.insert(name) {
            entries.push(Entry {
                name: format!("word/media/{name}"),
                bytes: asset.bytes.clone(),
            });
        }
        rels = rels.replace("</Relationships>", &format!("<Relationship Id=\"rId{}\" Type=\"{R_NS}/image\" Target=\"media/{name}\"/></Relationships>", index + 2));
    }
    if !plan.notes.is_empty() {
        types = types.replace("</Types>", "<Override PartName=\"/word/endnotes.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml\"/></Types>");
        rels = rels.replace("</Relationships>", &format!("<Relationship Id=\"rIdEndnotes\" Type=\"{R_NS}/endnotes\" Target=\"endnotes.xml\"/></Relationships>"));
        entries.push(Entry::text("word/endnotes.xml", &endnotes(plan)));
    }
    entries.extend([
        Entry::text("[Content_Types].xml", &types),
        Entry::text("_rels/.rels", &package_rels_xml()),
        Entry::text("word/_rels/document.xml.rels", &rels),
        Entry::text("word/styles.xml", &styles_xml(lang)),
        Entry::text("word/document.xml", &document),
    ]);
    Ok(Manuscript {
        assets: Default::default(),
        bytes: zip(&entries),
        format: Format::Docx,
        underlined_runs: 0,
    })
}
