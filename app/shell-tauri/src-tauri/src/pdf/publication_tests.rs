use super::*;
use crate::publication_plan::{Asset, Plan, Scopes};
use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) fn document(caption: &str) -> String {
    document_with_original(caption, None)
}

pub(crate) fn exif_document() -> String {
    let jpeg = include_bytes!("../../fixtures/two-halves.jpg");
    let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
    exif.extend([6, 0, 0, 0, 0, 0, 0, 0]);
    let mut bytes = jpeg[..2].to_vec();
    bytes.extend([0xff, 0xe1]);
    bytes.extend(((exif.len() + 2) as u16).to_be_bytes());
    bytes.extend(exif);
    bytes.extend(&jpeg[2..]);
    document_with_original("Rotatedcaption: EXIF orientation six.", Some(bytes))
}

pub(crate) fn png_exif_document() -> String {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 300, 200);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_chunk(png::chunk::eXIf, b"II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0").unwrap();
        writer.write_image_data(&[35, 90, 125].repeat(300 * 200)).unwrap();
    }
    document_with_original("PNGcaption: PNG eXIf orientation six.", Some(bytes))
}

pub(crate) fn legacy_cover_document(bytes: &[u8], media_type: &'static str) -> String {
    let rows = vec![("one".into(), "Chapter".into(), 0)];
    let book = Book { publication: None, single_scene: false, name: "Legacy cover",
        contents_title: "Contents", front: &[], chapters: &rows, back: &[] };
    let bodies = HashMap::from([("one".into(), json!({"type":"doc","content":[
        {"type":"paragraph","content":[{"type":"text","text":"Legacycoverprose: retained after a damaged cover."}]}
    ]}).to_string())]);
    proof_document(&Proof { book: &book, bodies: &bodies, language: "en",
        design: &crate::design::default_design(), style: Default::default(),
        openings: Default::default(), front_cover: Some(Cover { bytes: bytes.to_vec(),
            media_type, fit: crate::covers::CoverFit::Contain }),
        back_cover: None, markup_limit: None, pin: None })
}

fn document_with_original(caption: &str, original: Option<Vec<u8>>) -> String {
    let rows = vec![
        ("one".into(), "The crossing".into(), 0),
        ("two".into(), "Arrival".into(), 0),
    ];
    let book = Book {
        publication: None,
        single_scene: false,
        name: "Notes and figures",
        contents_title: "Contents",
        front: &[],
        chapters: &rows,
        back: &[],
    };
    let asset_id = "0199ed16-8c00-7000-8000-000000000090";
    let figure = |id: &str, width: &str, caption: &str| {
        json!({"type":"figure", "attrs":{
        "id":id,"asset_id":asset_id,"width":width,"caption":caption,"alt":"Blue and ochre survey grid"}})
    };
    let paragraph =
        |text: String| json!({"type":"paragraph","content":[{"type":"text","text":text}]});
    let bodies = HashMap::from([
        ("one".into(), json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"The river narrowed at the crossing."},
                {"type":"endnote","attrs":{"id":"0199ed16-8c00-7000-8000-000000000001","fmt":"text","body":"Crossingnote: the survey was made in spring.\nSecond line retained."}}]},
            paragraph("The banks were quiet and the path followed the water. ".repeat(45)),
            figure("0199ed16-8c00-7000-8000-000000000002", "full", "Fullcaption: the river survey, kept with its image."),
            {"type":"scene_break"},
            paragraph("Afterbreak: they continued toward the bridge.".into()),
            figure("0199ed16-8c00-7000-8000-000000000003", "page", caption),
            paragraph("Afterplate: the journey continues on a separate page.".into())
        ]}).to_string()),
        ("two".into(), json!({"type":"doc","content":[
            paragraph("Arrivalprose: a smaller survey is printed at half the text width.".into()),
            figure("0199ed16-8c00-7000-8000-000000000004", "half", "Halfcaption: detail from the survey.")
        ]}).to_string()),
    ]);
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 1200, 1800);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let pixels: Vec<u8> = (0..1800)
            .flat_map(|y| {
                (0..1200).flat_map(move |x| {
                    if x % 200 < 8 || y % 200 < 8 {
                        [245, 242, 230]
                    } else if x > y / 2 {
                        [35, 90, 125]
                    } else {
                        [185, 130, 55]
                    }
                })
            })
            .collect();
        writer.write_image_data(&pixels).unwrap();
    }
    if let Some(original) = original {
        bytes = original;
    }
    let (format, width_px, height_px) = crate::pictures::inspect_original(&bytes).unwrap();
    let orientation = crate::figures::orientation(&bytes, format).unwrap();
    let record = crate::store::figure_assets::FigureAsset {
        id: asset_id.into(),
        stored_name: format!("fig-{asset_id}.{}", format.extension()),
        mime: format.mime().into(),
        bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        width_px,
        height_px,
        orientation,
    };
    let plan = Plan::build(&book, &bodies, Scopes::book(&book), |_| {
        Asset::verified(&record, bytes.clone())
    })
    .unwrap();
    if record.mime == "image/png" && record.orientation == 6 {
        assert_eq!((width_px, height_px), (300, 200));
        let docx = crate::docx::render_planned(&book, &bodies, "en", Some(&plan)).unwrap();
        let entries = crate::epub::read_zip(&docx.bytes).unwrap();
        assert!(entries.iter().any(|(name, data)| name.starts_with("word/media/") && data == &bytes));
        let xml = &entries.iter().find(|(name, _)| name == "word/document.xml").unwrap().1;
        assert!(String::from_utf8_lossy(xml).contains("<wp:extent cx=\"5943600\" cy=\"3962400\"/>"));
        let epub = crate::epub::render(&crate::epub::Epub { book: &book, plan: Some(&plan),
            notes_title: "Notes", bodies: &bodies, book_id: None, story_id: None,
            language: "en", font: "serif", style: Default::default(),
            openings: Default::default(), cover: None, modified: "2026-10-17T00:00:00Z", pin: None });
        let entries = crate::epub::read_zip(&epub).unwrap();
        assert!(entries.iter().any(|(name, data)| name.ends_with(".png") && data == &bytes));
        let css = &entries.iter().find(|(name, _)| name == "OEBPS/style.css").unwrap().1;
        assert!(String::from_utf8_lossy(css).contains("height: auto"));
    }
    proof_document_planned(
        &Proof {
            book: &book,
            bodies: &bodies,
            language: "en",
            design: &crate::design::default_design(),
            style: ChapterStyle {
                glyph: None,
                new_page: false,
                drop_cap: false,
                caps_title: false,
                ..Default::default()
            },
            openings: Default::default(),
            front_cover: None,
            back_cover: None,
            markup_limit: None,
            pin: None,
        },
        Some(&plan),
        "Notes",
    )
    .unwrap()
}

#[test]
fn pdf_new_content_cannot_bypass_the_plan_validation() {
    let rows = vec![("scene".into(), "Scene".into(), 0)];
    let book = Book {
        publication: None,
        single_scene: false,
        name: "Book",
        contents_title: "Contents",
        front: &[],
        chapters: &rows,
        back: &[],
    };
    for body in [
        json!({"type":"doc","content":[{"type":"scene_break"},{"type":"future"}]}),
        json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"endnote","attrs":{"id":"0199ed16-8c00-7000-8000-000000000001","fmt":"text","body":"bad\u{b}note"}}]}]}),
        json!({"type":"doc","content":[{"type":"figure","attrs":{"id":"0199ed16-8c00-7000-8000-000000000002","asset_id":"0199ed16-8c00-7000-8000-000000000090","width":"full","caption":"Caption","alt":"View"}}]}),
    ] {
        let bodies = HashMap::from([("scene".into(), body.to_string())]);
        let design = crate::design::default_design();
        let proof = Proof {
            book: &book,
            bodies: &bodies,
            language: "en",
            design: &design,
            style: Default::default(),
            openings: Default::default(),
            front_cover: None,
            back_cover: None,
            markup_limit: None,
            pin: None,
        };
        assert!(proof_document_planned(&proof, None, "Notes").is_err());
    }
}
