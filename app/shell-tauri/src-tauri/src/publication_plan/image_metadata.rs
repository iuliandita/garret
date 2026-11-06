//! Publication copies only. Retained originals remain byte-exact for recovery.
use crate::pictures::Format;

pub(crate) fn sanitize(data: &[u8]) -> Result<Vec<u8>, String> {
    match crate::pictures::sniff(data) {
        Some(Format::Png) => png(data),
        Some(Format::Jpeg) => jpeg(data),
        None => Err("unsupported publication image format".into()),
    }
}

fn png(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = data[..8].to_vec();
    let mut at = 8usize;
    loop {
        let header = data
            .get(at..at + 8)
            .ok_or("truncated publication PNG chunk")?;
        let len = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let end = at
            .checked_add(12)
            .and_then(|v| v.checked_add(len))
            .filter(|&end| end <= data.len())
            .ok_or("truncated publication PNG chunk")?;
        let kind = &header[4..8];
        if !matches!(kind, b"tEXt" | b"iTXt" | b"zTXt" | b"eXIf" | b"tIME") {
            out.extend_from_slice(&data[at..end]);
        }
        at = end;
        if kind == b"IEND" {
            if len != 0 {
                return Err("invalid publication PNG end chunk".into());
            }
            // Nothing after the image belongs to a publication copy.
            return Ok(out);
        }
    }
}

fn jpeg(data: &[u8]) -> Result<Vec<u8>, String> {
    let orientation = crate::figures::orientation(data, Format::Jpeg)?;
    let mut out = vec![0xff, 0xd8];
    if orientation != 1 {
        // Keep only the orientation IFD, without pointers to source metadata.
        out.extend_from_slice(
            b"\xff\xe1\x00\x22Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0",
        );
        out.extend_from_slice(&[orientation, 0, 0, 0, 0, 0, 0, 0]);
    }
    let mut at = 2usize;
    let mut entropy = false;
    loop {
        if entropy {
            let start = at;
            while let Some(&byte) = data.get(at) {
                if byte == 0xff {
                    let mut next = at + 1;
                    while data.get(next) == Some(&0xff) {
                        next += 1;
                    }
                    match data.get(next) {
                        Some(0x00 | 0xd0..=0xd7) => {
                            at = next + 1;
                        }
                        Some(_) => break,
                        None => return Err("truncated publication JPEG scan".into()),
                    }
                } else {
                    at += 1;
                }
            }
            out.extend_from_slice(&data[start..at]);
            entropy = false;
        }
        if data.get(at) != Some(&0xff) {
            return Err("invalid publication JPEG marker".into());
        }
        let start = at;
        while data.get(at) == Some(&0xff) {
            at += 1;
        }
        let marker = *data.get(at).ok_or("truncated publication JPEG marker")?;
        at += 1;
        if marker == 0xd9 {
            out.extend_from_slice(&[0xff, 0xd9]);
            return Ok(out);
        }
        if marker == 0x01 {
            out.extend_from_slice(&data[start..at]);
            continue;
        }
        if matches!(marker, 0x00 | 0xd0..=0xd8) {
            return Err("invalid publication JPEG marker".into());
        }
        let length = data
            .get(at..at + 2)
            .ok_or("truncated publication JPEG segment")?;
        let len = u16::from_be_bytes(length.try_into().unwrap()) as usize;
        if len < 2 {
            return Err("invalid publication JPEG segment length".into());
        }
        let end = at
            .checked_add(len)
            .filter(|&end| end <= data.len())
            .ok_or("truncated publication JPEG segment")?;
        let payload = &data[at + 2..end];
        if marker == 0xe0 && payload.starts_with(b"JFIF\0") {
            let header = payload
                .get(..14)
                .ok_or("truncated publication JFIF header")?;
            out.extend_from_slice(b"\xff\xe0\x00\x10");
            out.extend_from_slice(&header[..12]);
            // The thumbnail is not needed to render the full image.
            out.extend_from_slice(&[0, 0]);
            at = end;
            continue;
        }
        // Retain recognized color/rendering segments. Other APP segments and
        // comments can carry source metadata, including between JPEG scans.
        let keep = match marker {
            0xe2 => payload.starts_with(b"ICC_PROFILE\0"),
            0xee => payload.starts_with(b"Adobe") && payload.len() == 12,
            0xe0..=0xef | 0xfe => false,
            _ => true,
        };
        if keep {
            out.extend_from_slice(&data[start..end]);
        }
        at = end;
        if marker == 0xda {
            entropy = true;
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
