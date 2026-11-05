use super::*;

pub(crate) const MARKERS: &[&[u8]] = &[
    b"Original image author",
    b"Original EXIF artist",
    b"Original XMP creator",
    b"Original IPTC byline",
    b"Original image comment",
    b"Original trailing text",
];

pub(crate) fn chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut chunk = (payload.len() as u32).to_be_bytes().to_vec();
    chunk.extend_from_slice(kind);
    chunk.extend_from_slice(payload);
    chunk.extend_from_slice(&crate::epub::crc32(&chunk[4..]).to_be_bytes());
    chunk
}

fn segment(marker: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0xff, marker];
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn tiff(orientation: u8) -> Vec<u8> {
    let mut out = b"II\x2a\0\x08\0\0\0\x02\0\x12\x01\x03\0\x01\0\0\0".to_vec();
    out.extend_from_slice(&[orientation, 0, 0, 0]);
    // Artist ASCII value stored outside the IFD, followed by a null next-IFD.
    out.extend_from_slice(&[0x3b, 1, 2, 0, 21, 0, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0]);
    out.extend_from_slice(b"Original EXIF artist\0");
    out
}

pub(crate) fn png_fixture() -> Vec<u8> {
    let source = crate::figures::tests::PNG;
    let mut out = source[..33].to_vec();
    out.extend(chunk(b"tEXt", b"Author\0Original image author"));
    let mut compressed = b"Comment\0\0".to_vec();
    compressed.extend(miniz_oxide::deflate::compress_to_vec_zlib(
        b"Original image comment",
        6,
    ));
    out.extend(chunk(b"zTXt", &compressed));
    out.extend(chunk(
        b"iTXt",
        b"XML:com.adobe.xmp\0\0\0\0\0<xmp:Creator>Original XMP creator</xmp:Creator>",
    ));
    out.extend(chunk(b"eXIf", &tiff(1)));
    out.extend(chunk(b"tIME", &[0x07, 0xea, 10, 17, 12, 0, 0]));
    out.extend_from_slice(&source[33..]);
    out.extend_from_slice(b"Original trailing text");
    out
}

pub(crate) fn jpeg_fixture(orientation: u8) -> Vec<u8> {
    let source = include_bytes!("../../../fixtures/two-halves.jpg");
    let mut out = source[..2].to_vec();
    let mut exif = b"Exif\0\0".to_vec();
    exif.extend(tiff(orientation));
    out.extend(segment(0xe1, &exif));
    out.extend(segment(
        0xe1,
        b"http://ns.adobe.com/xap/1.0/\0<dc:creator>Original XMP creator</dc:creator>",
    ));
    out.extend(segment(0xed, b"Photoshop 3.0\0Original IPTC byline"));
    out.extend(segment(0xfe, b"Original image comment"));
    out.extend_from_slice(&source[2..]);
    out.extend_from_slice(b"Original trailing text");
    out
}

pub(crate) fn assert_no_metadata(data: &[u8]) {
    for marker in MARKERS {
        assert!(
            !data.windows(marker.len()).any(|window| window == *marker),
            "source metadata remained: {}",
            String::from_utf8_lossy(marker)
        );
    }
}

#[test]
fn publication_images_preserve_rendering_chunks_pixels_and_orientation() {
    let source = png_fixture();
    let mut png = source[..33].to_vec();
    let rendering = [
        chunk(b"gAMA", &45455u32.to_be_bytes()),
        chunk(b"cHRM", &[0; 32]),
        chunk(b"sRGB", &[0]),
        chunk(b"iCCP", b"profile\0\0\x78\x9c\x03\0\0\0\0\x01"),
    ];
    for chunk in &rendering {
        png.extend_from_slice(chunk);
    }
    png.extend_from_slice(&source[33..]);
    let clean = sanitize(&png).unwrap();
    assert_no_metadata(&clean);
    for kind in [b"tEXt", b"iTXt", b"zTXt", b"eXIf", b"tIME"] {
        assert!(!clean.windows(4).any(|window| window == kind));
    }
    for chunk in rendering {
        assert!(clean.windows(chunk.len()).any(|window| window == chunk));
    }
    assert_eq!(sanitize(&clean).unwrap(), clean);
    assert_eq!(
        crate::pictures::figure_preview(&source, 1).unwrap(),
        crate::pictures::figure_preview(&sanitize(&source).unwrap(), 1).unwrap()
    );
    for orientation in 1..=8 {
        let original = jpeg_fixture(orientation);
        let clean = sanitize(&original).unwrap();
        assert_no_metadata(&clean);
        assert_eq!(
            crate::figures::orientation(&clean, Format::Jpeg).unwrap(),
            orientation
        );
        assert_eq!(
            crate::pictures::figure_preview(&original, orientation).unwrap(),
            crate::pictures::figure_preview(&clean, orientation).unwrap()
        );
        assert_eq!(sanitize(&clean).unwrap(), clean);
        if orientation == 1 {
            assert!(!clean.windows(6).any(|window| window == b"Exif\0\0"));
        }
    }
}

#[test]
fn publication_images_filter_metadata_between_jpeg_scans() {
    let mut data = b"\xff\xd8\xff\xda\x00\x02scan\xff\x00stuffed\xff\xd0restart".to_vec();
    data.extend(segment(0xfe, b"Original image comment"));
    data.extend(segment(0xe1, b"Original XMP creator"));
    data.extend_from_slice(b"\xff\xda\x00\x02second\xff\xd9Original trailing text");
    let clean = sanitize(&data).unwrap();
    assert_no_metadata(&clean);
    assert_eq!(
        clean,
        b"\xff\xd8\xff\xda\x00\x02scan\xff\x00stuffed\xff\xd0restart\xff\xda\x00\x02second\xff\xd9"
    );
}

#[test]
fn publication_images_refuse_truncated_chunks_and_segments() {
    for data in [
        &b"\x89PNG\r\n\x1a\n\xff\xff\xff\xfftEXt"[..],
        &b"\x89PNG\r\n\x1a\n\x00\x00\x00\x01tEXt"[..],
        &b"\xff\xd8\xff\xe1\x00\x01"[..],
        &b"\xff\xd8\xff\xe1\xff\xffExif\0\0"[..],
        &b"\xff\xd8\xff\xda\x00\x02scan\xff"[..],
        &b"\xff\xd8\xff\xda\x00\x02scan"[..],
        &b"GIF89a"[..],
    ] {
        assert!(sanitize(data).is_err(), "{data:?}");
    }
}
