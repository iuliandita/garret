use std::fs::{DirBuilder, OpenOptions};
use std::path::Path;

pub(crate) fn dir_builder() -> DirBuilder {
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
}

/// Existing directories retain their permissions.
pub(crate) fn create_dir_all(path: &Path) -> std::io::Result<()> {
    dir_builder().recursive(true).create(path)
}

pub(crate) fn file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

/// Claim a new SQLite file before SQLite creates its journal and shared memory.
#[cfg(unix)]
pub(crate) fn prepare_database(path: &Path) -> std::io::Result<()> {
    match file_options().write(true).create_new(true).open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}
