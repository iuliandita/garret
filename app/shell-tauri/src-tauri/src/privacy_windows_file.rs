use std::{fs, io, os::windows::ffi::OsStrExt, path::Path, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        MoveFileExW, SetFileAttributesW, FILE_ATTRIBUTE_NORMAL, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

fn sid_string() -> io::Result<String> {
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut bytes = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut bytes);
            if bytes == 0 || bytes > 4096 {
                return Err(io::Error::last_os_error());
            }
            let mut buffer = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
            if GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                bytes,
                &mut bytes,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
            let mut sid = ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut len = 0;
            while *sid.add(len) != 0 {
                len += 1;
            }
            let value = String::from_utf16(std::slice::from_raw_parts(sid, len))
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid user SID"));
            LocalFree(sid.cast());
            value
        })();
        CloseHandle(token);
        result
    }
}

pub fn restrict(path: &Path) -> io::Result<()> {
    let sid = sid_string()?;
    let sddl = format!("D:P(A;;FA;;;{sid})(A;;FA;;;SY)");
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(std::ffi::OsStr::new(&sddl)).as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let result = if SetFileSecurityW(
            wide(path.as_os_str()).as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        ) == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        };
        LocalFree(descriptor.cast());
        result
    }
}

pub fn persist(
    temp: tempfile::NamedTempFile,
    destination: &Path,
    expected: &[u8],
) -> io::Result<()> {
    temp.as_file().sync_all()?;
    let temp_path = temp.into_temp_path();
    unsafe {
        if SetFileAttributesW(wide(temp_path.as_os_str()).as_ptr(), FILE_ATTRIBUTE_NORMAL) == 0 {
            return Err(io::Error::last_os_error());
        }
        if MoveFileExW(
            wide(temp_path.as_os_str()).as_ptr(),
            wide(destination.as_os_str()).as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(destination)?
        .sync_all()?;
    if fs::read(destination)? != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "privacy record readback differs",
        ));
    }
    Ok(())
}
