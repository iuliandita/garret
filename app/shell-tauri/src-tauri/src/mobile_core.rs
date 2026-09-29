use crate::store::{self, source_words::FlushAttribution};

/// Android app policy forbids hard links. Publish by an atomic no-replace
/// rename; a collision leaves both the existing book and stage untouched.
#[cfg(any(target_os = "android", target_os = "linux"))]
pub fn move_new(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        from,
        rustix::fs::CWD,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(Into::into)
}

/// A mobile save uses the same transaction and post-commit history rule as the
/// desktop host. A stale page is rejected before any store write.
pub fn flush(
    store: &store::Store,
    opened_generation: u64,
    claimed_generation: u64,
    entries: &[store::FlushEntry],
    attribution: &[FlushAttribution],
) -> Result<Vec<store::FlushAck>, String> {
    if opened_generation != claimed_generation {
        return Err("this request belongs to an older book session".into());
    }
    let acks = store
        .flush_with_sources(entries, attribution)
        .map_err(|error| error.to_string())?;
    if let Err(error) = store.record_versions(entries) {
        eprintln!("history: could not record a version: {error}");
    }
    Ok(acks)
}
