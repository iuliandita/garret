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

/// Check raw metadata before any writable open or migration. Unknown layouts
/// must stay closed even when a newer desktop build treats them leniently.
pub fn supported(store: &store::Store) -> Result<(), String> {
    match store
        .get_meta("project.preset")
        .map_err(|error| error.to_string())?
        .as_deref()
    {
        None | Some("novel" | "short" | "nonfiction") => Ok(()),
        _ => Err("unsupported_project_preset".into()),
    }
}

pub fn open_supported(path: &std::path::Path) -> Result<store::Store, String> {
    let reader = store::Store::open_readonly(path).map_err(|error| match error {
        store::StoreError::NewerSchema { .. } => "unsupported_schema".to_string(),
        _ => "transfer_invalid".to_string(),
    })?;
    supported(&reader)?;
    Ok(reader)
}
