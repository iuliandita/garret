use std::fs::{self, File, Metadata};
use std::io::{self, Read, Write};
use std::path::Path;

fn unsafe_path() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "unsafe readable-folder path")
}

fn regular(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x0000_0400 != 0 {
            return false;
        }
    }
    meta.is_file() && !meta.file_type().is_symlink()
}

struct Directory {
    #[cfg(unix)]
    handle: File,
    #[cfg(not(unix))]
    path: std::path::PathBuf,
}

impl Directory {
    fn open(path: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use rustix::fs::{open, Mode, OFlags};
            let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
            Ok(Self {
                handle: File::from(open(path, flags, Mode::empty())?),
            })
        }
        #[cfg(not(unix))]
        {
            let meta = fs::symlink_metadata(path)?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(unsafe_path());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x0000_0400 != 0 {
                    return Err(unsafe_path());
                }
            }
            Ok(Self {
                path: path.to_path_buf(),
            })
        }
    }

    fn child(&self, name: &str, create: bool) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use rustix::fs::{mkdirat, openat, Mode, OFlags};
            if create {
                match mkdirat(&self.handle, name, Mode::from_raw_mode(0o777)) {
                    Ok(()) | Err(rustix::io::Errno::EXIST) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
            Ok(Self {
                handle: File::from(openat(&self.handle, name, flags, Mode::empty())?),
            })
        }
        #[cfg(not(unix))]
        {
            let path = self.path.join(name);
            if create {
                match fs::create_dir(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
            }
            Self::open(&path)
        }
    }

    fn open_file(&self, name: &str, write: bool, exclusive: bool) -> io::Result<File> {
        #[cfg(unix)]
        let file = {
            use rustix::fs::{openat, Mode, OFlags};
            let mut flags = OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
            flags |= if write {
                OFlags::WRONLY | OFlags::CREATE
            } else {
                OFlags::RDONLY
            };
            if exclusive {
                flags |= OFlags::EXCL;
            }
            File::from(openat(
                &self.handle,
                name,
                flags,
                Mode::from_raw_mode(0o666),
            )?)
        };
        #[cfg(not(unix))]
        let file = {
            let path = self.path.join(name);
            match fs::symlink_metadata(&path) {
                Ok(meta) if !regular(&meta) => return Err(unsafe_path()),
                Ok(_) => {}
                Err(error) if write && error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            let mut options = fs::OpenOptions::new();
            options
                .read(!write)
                .write(write)
                .create(write)
                .create_new(exclusive);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x0020_0000);
            }
            options.open(path)?
        };
        // Check before truncating: a swapped FIFO/device must never block or receive prose.
        if !regular(&file.metadata()?) {
            return Err(unsafe_path());
        }
        Ok(file)
    }

    fn remove(&self, name: &str, directory: bool) -> io::Result<()> {
        #[cfg(unix)]
        {
            use rustix::fs::{unlinkat, AtFlags};
            unlinkat(
                &self.handle,
                name,
                if directory {
                    AtFlags::REMOVEDIR
                } else {
                    AtFlags::empty()
                },
            )?;
            Ok(())
        }
        #[cfg(not(unix))]
        {
            if directory {
                fs::remove_dir(self.path.join(name))
            } else {
                fs::remove_file(self.path.join(name))
            }
        }
    }

    fn entries(&self) -> io::Result<Vec<(String, bool)>> {
        let mut out = Vec::new();
        #[cfg(unix)]
        {
            use rustix::fs::{statat, AtFlags, Dir, FileType};
            for entry in Dir::read_from(&self.handle)? {
                let entry = entry?;
                let Some(name) = entry.file_name().to_str().ok() else {
                    continue;
                };
                if name == "." || name == ".." {
                    continue;
                }
                let meta = match statat(&self.handle, name, AtFlags::SYMLINK_NOFOLLOW) {
                    Ok(meta) => meta,
                    Err(rustix::io::Errno::NOENT) => continue,
                    Err(error) => return Err(error.into()),
                };
                let kind = FileType::from_raw_mode(meta.st_mode);
                if kind == FileType::Directory || kind == FileType::RegularFile {
                    out.push((name.to_string(), kind == FileType::Directory));
                }
            }
        }
        #[cfg(not(unix))]
        {
            for entry in fs::read_dir(&self.path)? {
                let entry = entry?;
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let meta = fs::symlink_metadata(entry.path())?;
                if meta.is_dir() && Self::open(&entry.path()).is_ok() {
                    out.push((name, true));
                } else if regular(&meta) {
                    out.push((name, false));
                }
            }
        }
        Ok(out)
    }
}

fn parent<'a>(root: &Path, relative: &'a str, create: bool) -> io::Result<(Directory, &'a str)> {
    if !crate::protection::mirror_path_safe(relative) {
        return Err(unsafe_path());
    }
    let mut directory = Directory::open(root)?;
    let mut parts = relative.split('/').peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            return Ok((directory, part));
        }
        directory = directory.child(part, create)?;
    }
    Err(unsafe_path())
}

pub(crate) fn create(root: &Path) -> io::Result<()> {
    fs::create_dir_all(root)?;
    Directory::open(root).map(|_| ())
}

pub(crate) fn metadata(root: &Path, relative: &str) -> io::Result<Metadata> {
    let (directory, name) = parent(root, relative, false)?;
    directory.open_file(name, false, false)?.metadata()
}

pub(crate) fn read(root: &Path, relative: &str, limit: u64) -> io::Result<Vec<u8>> {
    let (directory, name) = parent(root, relative, false)?;
    let file = directory.open_file(name, false, false)?;
    if file.metadata()?.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "readable-folder file exceeds byte limit",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "readable-folder file exceeds byte limit",
        ));
    }
    Ok(bytes)
}

pub(crate) fn read_text(root: &Path, relative: &str) -> io::Result<String> {
    String::from_utf8(read(root, relative, crate::MAX_IMPORT_BYTES)?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub(crate) fn write(root: &Path, relative: &str, bytes: &[u8]) -> io::Result<()> {
    let (directory, name) = parent(root, relative, true)?;
    let mut file = directory.open_file(name, true, false)?;
    file.set_len(0)?;
    file.write_all(bytes)
}

pub(crate) fn remove(root: &Path, relative: &str, directory: bool) -> io::Result<()> {
    let (parent, name) = parent(root, relative, false)?;
    parent.remove(name, directory)
}

pub(crate) fn atomic(root: &Path, relative: &str, temp: &str, bytes: &[u8]) -> io::Result<()> {
    let (directory, name) = parent(root, relative, false)?;
    if !crate::protection::mirror_path_safe(temp) || temp.contains('/') {
        return Err(unsafe_path());
    }
    let mut file = directory.open_file(temp, true, true)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = directory.remove(temp, false);
        return Err(error);
    }
    drop(file);
    #[cfg(unix)]
    {
        if let Err(error) = rustix::fs::renameat(&directory.handle, temp, &directory.handle, name) {
            let _ = directory.remove(temp, false);
            return Err(error.into());
        }
        directory.handle.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        if let Err(error) = fs::rename(directory.path.join(temp), directory.path.join(name)) {
            let _ = directory.remove(temp, false);
            return Err(error);
        }
    }
    Ok(())
}

/// Symlinked directories are refused at each open, so they cannot form a cycle.
pub(crate) fn walk(root: &Path) -> io::Result<Vec<(String, bool)>> {
    let root = Directory::open(root)?;
    let mut out = Vec::new();
    let mut pending = vec![String::new()];
    while let Some(relative) = pending.pop() {
        #[cfg(unix)]
        let mut directory = Directory {
            handle: root.handle.try_clone()?,
        };
        #[cfg(not(unix))]
        let mut directory = Directory::open(&root.path)?;
        let mut refused = false;
        for part in relative.split('/').filter(|part| !part.is_empty()) {
            match directory.child(part, false) {
                Ok(child) => directory = child,
                Err(_) => {
                    refused = true;
                    break;
                }
            }
        }
        if refused {
            continue;
        }
        out.push((relative.clone(), true));
        for (name, is_directory) in directory.entries()? {
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            if is_directory {
                pending.push(path);
            } else {
                out.push((path, false));
            }
        }
    }
    Ok(out)
}

pub(crate) fn retain(root: &Path, relative: &str, bytes: &[u8], limit: u64) -> io::Result<()> {
    let (directory, name) = parent(root, relative, true)?;
    match directory.open_file(name, true, true) {
        Ok(mut file) => {
            file.write_all(bytes).and_then(|_| file.sync_all())?;
            #[cfg(unix)]
            directory.handle.sync_all()?;
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if read(root, relative, limit)? != bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "mirror figure original differs; retained without replacement",
                ));
            }
            Ok(())
        }
        Err(error) => Err(error),
    }
}
