// Shared, pure package bytes used by EPUB, DOCX and mobile review transport.
// Keep the archive writer, reader, CRC and UTC timestamp in one source module.

/// CRC-32/ISO-HDLC, reflected, polynomial 0xEDB88320, initial and final xor
/// 0xFFFFFFFF. Its published check value -- the CRC of `"123456789"` -- is
/// 0xCBF43926, and that vector is the test.
///
/// Table-free on purpose: this runs once per archive entry over bytes that were
/// just built, and a 1 KiB static table would be a cache line spent to save
/// microseconds on a path measured in hundreds of milliseconds.
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// One file in the container.
pub struct Entry {
    pub name: String,
    pub bytes: Vec<u8>,
}

impl Entry {
    pub fn text(name: &str, text: &str) -> Entry {
        Entry {
            name: name.to_string(),
            bytes: text.as_bytes().to_vec(),
        }
    }
}

/// A fixed MS-DOS timestamp on every entry: 1980-01-01 00:00, the earliest the
/// format can express.
///
/// DELIBERATELY NOT THE CLOCK. Two exports of an unchanged book differ only in
/// the one field the package document has to carry a real time in
/// (`dcterms:modified`); putting the clock on every entry as well would make
/// the archive's byte length the only stable thing about it, and a diff of two
/// exports useless. A reader shows a modification date from the package
/// document, not from the container.
const DOS_DATE: u16 = 0x0021;
const DOS_TIME: u16 = 0;

/// The version-needed-to-extract for a STORED entry with no zip64 and no
/// encryption.
const VERSION: u16 = 20;

fn push16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn push32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// The entries as one zip archive, every entry STORED.
///
/// ORDER IS PRESERVED and is load-bearing twice over: `mimetype` must be the
/// first entry in an OCF container, and the preview reads the documents back in
/// archive order and shows them in it, so archive order IS spine order by
/// construction rather than by a second rule that could drift.
pub fn zip(entries: &[Entry]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    let mut count: u16 = 0;
    for entry in entries {
        let offset = out.len() as u32;
        let crc = crc32(&entry.bytes);
        let size = entry.bytes.len() as u32;
        let name = entry.name.as_bytes();
        push32(&mut out, 0x0403_4b50);
        push16(&mut out, VERSION);
        push16(&mut out, 0);
        push16(&mut out, 0);
        push16(&mut out, DOS_TIME);
        push16(&mut out, DOS_DATE);
        push32(&mut out, crc);
        push32(&mut out, size);
        push32(&mut out, size);
        push16(&mut out, name.len() as u16);
        push16(&mut out, 0);
        out.extend_from_slice(name);
        out.extend_from_slice(&entry.bytes);

        push32(&mut central, 0x0201_4b50);
        push16(&mut central, VERSION);
        push16(&mut central, VERSION);
        push16(&mut central, 0);
        push16(&mut central, 0);
        push16(&mut central, DOS_TIME);
        push16(&mut central, DOS_DATE);
        push32(&mut central, crc);
        push32(&mut central, size);
        push32(&mut central, size);
        push16(&mut central, name.len() as u16);
        push16(&mut central, 0);
        push16(&mut central, 0);
        push16(&mut central, 0);
        push16(&mut central, 0);
        push32(&mut central, 0);
        push32(&mut central, offset);
        central.extend_from_slice(name);
        count += 1;
    }
    let central_offset = out.len() as u32;
    let central_size = central.len() as u32;
    out.extend_from_slice(&central);
    push32(&mut out, 0x0605_4b50);
    push16(&mut out, 0);
    push16(&mut out, 0);
    push16(&mut out, count);
    push16(&mut out, count);
    push32(&mut out, central_size);
    push32(&mut out, central_offset);
    push16(&mut out, 0);
    out
}

fn read16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]))
}

fn read32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *bytes.get(at)?,
        *bytes.get(at + 1)?,
        *bytes.get(at + 2)?,
        *bytes.get(at + 3)?,
    ]))
}

/// The archive's entries, in central-directory order, or a sentence saying why
/// not.
///
/// STORED AND DEFLATED, nothing else. This reader was written to read what
/// `zip` above wrote -- the preview's copy of the file this application just
/// rendered -- and read stored entries only. 093 made `import` read a DOCX, and
/// every DOCX a writer receives from Word, pandoc or LibreOffice is deflated, so
/// the one method those writers use is inflated here (`miniz_oxide`, already in
/// the build graph) with the entry's declared size as the output limit. It is
/// still NOT a general unzip: no other method, no zip64, no encryption, and the
/// import path bounds the archive's size before this is reached.
///
/// The CRC is VERIFIED, which is the whole reason to read the file back rather
/// than trust the buffer: a render whose bytes were corrupted between the
/// writer and the reader must not be shown as a preview of the writer's book.
/// The declared uncompressed size above which an entry is refused before
/// `miniz_oxide` is asked to allocate for it. Restated from
/// `main.rs::MAX_IMPORT_BYTES` rather than imported -- this module is pure
/// and holds no dependency on `main.rs`'s own state, on the same reasoning
/// `docx_import.rs`'s own header gives for hand-rolling rather than
/// sharing. A directory entry can claim any 32-bit size regardless of how
/// small the archive actually is, so the bound has to sit here, ahead of
/// the allocation, rather than trusting the file's own overall size check
/// upstream to have covered it.
pub(crate) const MAX_ENTRY_BYTES: usize = 64 * 1024 * 1024;

pub fn read_zip(archive: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    const EOCD: usize = 22;
    if archive.len() < EOCD {
        return Err("the archive is too short to hold a directory".to_string());
    }
    let eocd = archive.len() - EOCD;
    if read32(archive, eocd) != Some(0x0605_4b50) {
        return Err("the archive has no end-of-directory record".to_string());
    }
    let count = read16(archive, eocd + 10).ok_or("unreadable directory")? as usize;
    let mut at = read32(archive, eocd + 16).ok_or("unreadable directory")? as usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        if read32(archive, at) != Some(0x0201_4b50) {
            return Err("the archive's directory is not where it says it is".to_string());
        }
        let method = read16(archive, at + 10).ok_or("unreadable directory entry")?;
        let crc = read32(archive, at + 16).ok_or("unreadable directory entry")?;
        let compressed = read32(archive, at + 20).ok_or("unreadable directory entry")? as usize;
        let size = read32(archive, at + 24).ok_or("unreadable directory entry")? as usize;
        let name_len = read16(archive, at + 28).ok_or("unreadable directory entry")? as usize;
        let extra_len = read16(archive, at + 30).ok_or("unreadable directory entry")? as usize;
        let comment_len = read16(archive, at + 32).ok_or("unreadable directory entry")? as usize;
        let local = read32(archive, at + 42).ok_or("unreadable directory entry")? as usize;
        let name = archive
            .get(at + 46..at + 46 + name_len)
            .and_then(|b| std::str::from_utf8(b).ok())
            .ok_or("an entry name is not text")?
            .to_string();
        if read32(archive, local) != Some(0x0403_4b50) {
            return Err(format!("{name}: no local header where the directory says"));
        }
        // The CENTRAL directory's method and sizes, not the local header's: a
        // writer using data descriptors leaves the local sizes zero, and the
        // directory is the copy every reader trusts.
        let local_name = read16(archive, local + 26).ok_or("unreadable local header")? as usize;
        let local_extra = read16(archive, local + 28).ok_or("unreadable local header")? as usize;
        let from = local + 30 + local_name + local_extra;
        let bytes = match method {
            0 => archive
                .get(from..from + size)
                .ok_or_else(|| format!("{name}: the archive ends inside this entry"))?
                .to_vec(),
            8 => {
                if size > MAX_ENTRY_BYTES {
                    return Err(format!(
                        "{name}: declares {size} bytes uncompressed, over the {MAX_ENTRY_BYTES}-byte limit"
                    ));
                }
                let packed = archive
                    .get(from..from + compressed)
                    .ok_or_else(|| format!("{name}: the archive ends inside this entry"))?;
                let inflated = miniz_oxide::inflate::decompress_to_vec_with_limit(packed, size)
                    .map_err(|e| format!("{name}: the deflated entry does not inflate: {e:?}"))?;
                if inflated.len() != size {
                    return Err(format!(
                        "{name}: inflated to {} bytes where the directory says {size}",
                        inflated.len()
                    ));
                }
                inflated
            }
            other => {
                return Err(format!(
                    "{name}: this build reads stored and deflated entries only, not method {other}"
                ))
            }
        };
        if crc32(&bytes) != crc {
            return Err(format!(
                "{name}: the stored checksum does not match the bytes"
            ));
        }
        out.push((name, bytes));
        at += 46 + name_len + extra_len + comment_len;
    }
    Ok(out)
}

/// An instant as ISO-8601 UTC, which is the only form `dcterms:modified` takes.
///
/// The civil date from a day count is Howard Hinnant's `civil_from_days`, which
/// is exact for every date this arithmetic can be handed and needs no table and
/// no crate. Seconds since the Unix epoch in, `YYYY-MM-DDTHH:MM:SSZ` out.
pub fn iso8601_utc(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    // Shift the epoch to 0000-03-01, which puts the leap day at the end of the
    // year and makes every month length a straight line.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        (rest / 60) % 60,
        rest % 60
    )
}
