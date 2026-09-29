use std::collections::BTreeMap;

const MAX_PACKAGE: usize = 64 * 1024 * 1024;
const MAX_TOTAL: usize = 128 * 1024 * 1024;
pub(super) const MAX_XML: usize = 32 * 1024 * 1024;

fn u16_at(bytes: &[u8], at: usize) -> Result<usize, String> {
    let field = bytes.get(at..at + 2).ok_or("truncated ZIP header")?;
    Ok(u16::from_le_bytes(field.try_into().unwrap()) as usize)
}
fn u32_at(bytes: &[u8], at: usize) -> Result<usize, String> {
    let field = bytes.get(at..at + 4).ok_or("truncated ZIP header")?;
    Ok(u32::from_le_bytes(field.try_into().unwrap()) as usize)
}
pub(super) fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', ':', '%', '\0', '?', '#'])
        && !name.chars().any(char::is_control)
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn extra_fields(bytes: &[u8]) -> Result<(), String> {
    let mut at = 0;
    while at < bytes.len() {
        let kind = u16_at(bytes, at)?;
        let size = u16_at(bytes, at + 2)?;
        if matches!(kind, 1 | 0x9901 | 0x7075 | 0x6375) {
            return Err("unsupported ZIP64, encrypted or alternate-name extra field".into());
        }
        at = at.checked_add(4 + size).ok_or("ZIP extra overflow")?;
        if at > bytes.len() {
            return Err("truncated ZIP extra field".into());
        }
    }
    Ok(())
}

/// Validate all declarations before allocating any expanded entry. ZIP64,
/// encryption, trailing data and overlapping local records are not this format.
pub(super) fn read(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    if bytes.len() > MAX_PACKAGE || bytes.len() < 22 {
        return Err("review ZIP size is invalid".into());
    }
    let end = (bytes.len().saturating_sub(65_557)..=bytes.len() - 22)
        .rev()
        .find(|at| {
            u32_at(bytes, *at).ok() == Some(0x06054b50)
                && u16_at(bytes, *at + 20).is_ok_and(|n| *at + 22 + n == bytes.len())
        })
        .ok_or("missing ZIP directory")?;
    let count = u16_at(bytes, end + 10)?;
    if count == 0
        || count > 128
        || u16_at(bytes, end + 4)? != 0
        || u16_at(bytes, end + 6)? != 0
        || u16_at(bytes, end + 8)? != count
    {
        return Err("unsupported ZIP directory".into());
    }
    let directory = u32_at(bytes, end + 16)?;
    if directory.checked_add(u32_at(bytes, end + 12)?) != Some(end) {
        return Err("inconsistent ZIP directory bounds".into());
    }
    let mut at = directory;
    let mut expanded = 0usize;
    let mut xml_bytes = 0usize;
    let mut records = BTreeMap::new();
    let mut ranges = Vec::new();
    for _ in 0..count {
        if u32_at(bytes, at)? != 0x02014b50 {
            return Err("invalid ZIP directory entry".into());
        }
        let flags = u16_at(bytes, at + 8)?;
        let method = u16_at(bytes, at + 10)?;
        let crc = u32_at(bytes, at + 16)? as u32;
        let packed = u32_at(bytes, at + 20)?;
        let size = u32_at(bytes, at + 24)?;
        let name_len = u16_at(bytes, at + 28)?;
        let extra = u16_at(bytes, at + 30)?;
        let comment = u16_at(bytes, at + 32)?;
        let local = u32_at(bytes, at + 42)?;
        if u16_at(bytes, at + 6)? > 20
            || flags & !0x080e != 0
            || !matches!(method, 0 | 8)
            || (method == 0 && (packed != size || flags & 6 != 0))
            || u16_at(bytes, at + 34)? != 0
            || size > MAX_XML
        {
            return Err("unsupported ZIP entry flags, method or size".into());
        }
        let name = std::str::from_utf8(
            bytes
                .get(at + 46..at + 46 + name_len)
                .ok_or("truncated ZIP name")?,
        )
        .map_err(|_| "ZIP name is not UTF-8")?
        .to_string();
        if !safe_name(&name) || records.contains_key(&name) {
            return Err("unsafe or duplicate ZIP name".into());
        }
        expanded = expanded.checked_add(size).ok_or("ZIP size overflow")?;
        if expanded > MAX_TOTAL {
            return Err("ZIP expansion exceeds limit".into());
        }
        if name.ends_with(".xml") || name.ends_with(".rels") {
            xml_bytes += size;
            if xml_bytes > 64 * 1024 * 1024 {
                return Err("XML expansion exceeds limit".into());
            }
        }
        extra_fields(
            bytes
                .get(at + 46 + name_len..at + 46 + name_len + extra)
                .ok_or("truncated ZIP extras")?,
        )?;
        at = at
            .checked_add(46 + name_len + extra + comment)
            .ok_or("ZIP directory overflow")?;
        if at > end || u32_at(bytes, local)? != 0x04034b50 {
            return Err("invalid ZIP local header".into());
        }
        if u16_at(bytes, local + 4)? > 20
            || u16_at(bytes, local + 6)? != flags
            || u16_at(bytes, local + 8)? != method
        {
            return Err("ZIP headers disagree".into());
        }
        let local_name = u16_at(bytes, local + 26)?;
        let local_extra = u16_at(bytes, local + 28)?;
        if bytes.get(local + 30..local + 30 + local_name) != Some(name.as_bytes()) {
            return Err("ZIP entry names disagree".into());
        }
        extra_fields(
            bytes
                .get(local + 30 + local_name..local + 30 + local_name + local_extra)
                .ok_or("truncated local ZIP extras")?,
        )?;
        let from = local
            .checked_add(30 + local_name + local_extra)
            .ok_or("ZIP local overflow")?;
        let to = from.checked_add(packed).ok_or("ZIP data overflow")?;
        let mut record_end = to;
        if flags & 8 == 0 {
            if u32_at(bytes, local + 14)? != crc as usize
                || u32_at(bytes, local + 18)? != packed
                || u32_at(bytes, local + 22)? != size
            {
                return Err("ZIP sizes or checksums disagree".into());
            }
        } else {
            let descriptor = if u32_at(bytes, to)? == 0x08074b50 {
                to + 4
            } else {
                to
            };
            if u32_at(bytes, descriptor)? != crc as usize
                || u32_at(bytes, descriptor + 4)? != packed
                || u32_at(bytes, descriptor + 8)? != size
            {
                return Err("ZIP descriptor disagrees".into());
            }
            record_end = descriptor + 12;
        }
        if record_end > directory {
            return Err("ZIP entry overlaps directory".into());
        }
        ranges.push((local, record_end));
        records.insert(name, (from, to, size, method, crc));
    }
    if at != end {
        return Err("ZIP directory contains undeclared records".into());
    }
    ranges.sort();
    if ranges.first().map(|r| r.0) != Some(0)
        || ranges.last().map(|r| r.1) != Some(directory)
        || ranges.windows(2).any(|r| r[0].1 != r[1].0)
    {
        return Err("ZIP local records overlap or have hidden data".into());
    }
    let mut out = BTreeMap::new();
    for (name, (from, to, size, method, crc)) in records {
        let raw = bytes.get(from..to).ok_or("truncated ZIP data")?;
        let data = if method == 0 {
            raw.to_vec()
        } else {
            miniz_oxide::inflate::decompress_to_vec_with_limit(raw, size)
                .map_err(|_| "invalid bounded DEFLATE stream")?
        };
        if data.len() != size || crate::package_format::crc32(&data) != crc {
            return Err("ZIP size or CRC mismatch".into());
        }
        out.insert(name, data);
    }
    Ok(out)
}
