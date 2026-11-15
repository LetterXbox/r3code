//! Windows handle-relative primitives for tracked project cloning.
use std::{
    ffi::OsStr,
    fs::File,
    io,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            NtCreateFile, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
            FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
        },
    },
    Win32::{
        Foundation::{RtlNtStatusToDosError, HANDLE, UNICODE_STRING},
        Storage::FileSystem::{
            FileAttributeTagInfo, FileBasicInfo, FileDispositionInfo, GetFileInformationByHandle,
            GetFileInformationByHandleEx, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY,
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_BASIC_INFO,
            FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

fn checked_name(name: &OsStr) -> io::Result<Vec<u16>> {
    let chars: Vec<u16> = name.encode_wide().collect();
    if chars.is_empty()
        || chars.len() > 32767
        || chars == [46]
        || chars == [46, 46]
        || chars.iter().any(|c| matches!(*c, 0 | 47 | 58 | 92))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid checkout component",
        ));
    }
    Ok(chars)
}
fn no_reparse(file: &File) -> io::Result<()> {
    let mut info: FILE_ATTRIBUTE_TAG_INFO = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other("reparse points are not permitted"));
    }
    Ok(())
}
fn open_nt_child(
    parent: &File,
    name: &OsStr,
    access: u32,
    disposition: u32,
    options: u32,
) -> io::Result<File> {
    no_reparse(parent)?;
    let mut chars = checked_name(name)?;
    let bytes = (chars.len() * 2) as u16;
    let name = UNICODE_STRING {
        Length: bytes,
        MaximumLength: bytes,
        Buffer: chars.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle() as HANDLE,
        ObjectName: &name,
        Attributes: 0x40,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut status: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let mut raw: HANDLE = std::ptr::null_mut();
    let result = unsafe {
        NtCreateFile(
            &mut raw,
            access,
            &attributes,
            &mut status,
            std::ptr::null(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            disposition,
            options,
            std::ptr::null(),
            0,
        )
    };
    if result < 0 {
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        ));
    }
    Ok(unsafe { File::from_raw_handle(raw as _) })
}
/// Open or exclusively create one child by a directory handle. Never follows
/// a child reparse point; callers must also hold a validated parent handle.
fn child(parent: &File, name: &OsStr, directory: bool, create: bool) -> io::Result<File> {
    let file = open_nt_child(
        parent,
        name,
        if create {
            FILE_GENERIC_WRITE
        } else {
            FILE_GENERIC_READ
        },
        if create { FILE_CREATE } else { FILE_OPEN },
        FILE_OPEN_REPARSE_POINT
            | FILE_SYNCHRONOUS_IO_NONALERT
            | if directory {
                FILE_DIRECTORY_FILE
            } else {
                FILE_NON_DIRECTORY_FILE
            },
    )?;
    no_reparse(&file)?;
    Ok(file)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_path_traversal_and_stream_names() {
        for name in ["", ".", "..", "a/b", "a\\b", "a:stream"] {
            assert!(checked_name(OsStr::new(name)).is_err())
        }
        assert!(checked_name(OsStr::new("safe-file")).is_ok());
    }
}

/// Enumerate names from the directory handle, never resolving its pathname.
/// Entries are bounded so a hostile tree cannot exhaust server memory.
fn children(directory: &File) -> io::Result<Vec<std::ffi::OsString>> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_NO_MORE_FILES},
        Storage::FileSystem::{
            FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, FILE_ID_BOTH_DIR_INFO,
        },
    };
    no_reparse(directory)?;
    let mut result = Vec::new();
    let mut first = true;
    let mut storage = vec![0u64; 8192];
    loop {
        let class = if first {
            FileIdBothDirectoryRestartInfo
        } else {
            FileIdBothDirectoryInfo
        };
        first = false;
        let ok = unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle() as HANDLE,
                class,
                storage.as_mut_ptr().cast(),
                (storage.len() * 8) as u32,
            )
        };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NO_MORE_FILES {
                break;
            }
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let len = storage.len() * 8;
        let bytes = storage.as_ptr().cast::<u8>();
        let mut offset = 0usize;
        loop {
            let header = std::mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
            if offset
                .checked_add(size_of::<FILE_ID_BOTH_DIR_INFO>())
                .is_none_or(|end| end > len)
            {
                return Err(io::Error::other("invalid directory entry"));
            }
            let entry = unsafe { &*(bytes.add(offset).cast::<FILE_ID_BOTH_DIR_INFO>()) };
            let n = entry.FileNameLength as usize;
            if n % 2 != 0
                || offset
                    .checked_add(header)
                    .and_then(|v| v.checked_add(n))
                    .is_none_or(|end| end > len)
            {
                return Err(io::Error::other("invalid directory name"));
            }
            let wide = unsafe {
                std::slice::from_raw_parts(bytes.add(offset + header).cast::<u16>(), n / 2)
            };
            if wide != [46] && wide != [46, 46] {
                result.push(std::ffi::OsString::from_wide(wide));
                if result.len() > 100_000 {
                    return Err(io::Error::other("checkout entry limit exceeded"));
                }
            }
            if entry.NextEntryOffset == 0 {
                break;
            }
            let step = entry.NextEntryOffset as usize;
            if step < header || step % 8 != 0 {
                return Err(io::Error::other("invalid directory offset"));
            }
            offset = offset
                .checked_add(step)
                .ok_or_else(|| io::Error::other("invalid directory offset"))?;
        }
    }
    Ok(result)
}

/// Copy a tree through held handles. This rejects reparse points and never
/// overwrites an existing child.
fn copy_tree(
    source: &File,
    destination: &File,
    cancelled: &impl Fn() -> bool,
    depth: usize,
) -> io::Result<()> {
    use std::io::{Read, Write};
    if depth > 128 {
        return Err(io::Error::other("checkout nesting limit exceeded"));
    }
    for name in children(source)? {
        if cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "clone cancelled",
            ));
        }
        if let Ok(src_dir) = child(source, &name, true, false) {
            let dst_dir = child(destination, &name, true, true)?;
            copy_tree(&src_dir, &dst_dir, cancelled, depth + 1)?;
            continue;
        }
        let mut src = child(source, &name, false, false)?;
        let mut dst = child(destination, &name, false, true)?;
        let mut buffer = [0u8; 65536];
        loop {
            if cancelled() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "clone cancelled",
                ));
            }
            let n = src.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            dst.write_all(&buffer[..n])?;
        }
    }
    Ok(())
}

fn file_info(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut info) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}

pub(crate) fn open_directory_no_reparse(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    no_reparse(&file)?;
    let info = file_info(&file)?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(io::Error::other("not a directory"));
    }
    Ok(file)
}

/// Verify that `handle` and `path` refer to the same non-reparse directory.
pub(crate) fn same_directory(handle: &File, path: &Path) -> bool {
    let Ok(expected) = file_info(handle) else {
        return false;
    };
    if expected.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || expected.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return false;
    }
    let Ok(actual_file) = open_directory_no_reparse(path) else {
        return false;
    };
    let Ok(actual) = file_info(&actual_file) else {
        return false;
    };
    expected.dwVolumeSerialNumber == actual.dwVolumeSerialNumber
        && expected.nFileIndexHigh == actual.nFileIndexHigh
        && expected.nFileIndexLow == actual.nFileIndexLow
}

/// Copy a validated staging tree into an empty, non-reparse destination directory.
pub(crate) fn install_checkout(
    handle: &File,
    staging: &Path,
    dest: &Path,
    cancelled: &impl Fn() -> bool,
) -> bool {
    if !same_directory(handle, staging) {
        return false;
    }
    let Ok(target) = open_directory_no_reparse(dest) else {
        return false;
    };
    if !same_directory(&target, dest) {
        return false;
    }
    let empty = children(&target).is_ok_and(|entries| entries.is_empty());
    if !empty {
        return false;
    }
    copy_tree(handle, &target, cancelled, 0).is_ok()
        && same_directory(handle, staging)
        && same_directory(&target, dest)
}

fn open_child_for_delete(parent: &File, name: &OsStr) -> io::Result<File> {
    open_nt_child(
        parent,
        name,
        FILE_GENERIC_READ | FILE_WRITE_ATTRIBUTES | DELETE,
        FILE_OPEN,
        FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
    )
}

fn clear_owned(dir: &File, depth: usize) -> io::Result<()> {
    if depth > 128 {
        return Err(io::Error::other("checkout nesting limit exceeded"));
    }
    for name in children(dir)? {
        let entry = open_child_for_delete(dir, &name)?;
        let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            GetFileInformationByHandleEx(
                entry.as_raw_handle() as HANDLE,
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let is_real_dir = basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
            && basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0;
        if is_real_dir {
            clear_owned(&entry, depth + 1)?;
        }
        if basic.FileAttributes & FILE_ATTRIBUTE_READONLY != 0 {
            let mut updated: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
            updated.FileAttributes = basic.FileAttributes & !FILE_ATTRIBUTE_READONLY;
            let ok = unsafe {
                SetFileInformationByHandle(
                    entry.as_raw_handle() as HANDLE,
                    FileBasicInfo,
                    (&updated as *const FILE_BASIC_INFO).cast(),
                    size_of::<FILE_BASIC_INFO>() as u32,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        let disp = FILE_DISPOSITION_INFO { DeleteFile: 1 };
        let ok = unsafe {
            SetFileInformationByHandle(
                entry.as_raw_handle() as HANDLE,
                FileDispositionInfo,
                (&disp as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Remove the contents of a verified staging directory without following reparse points.
pub(crate) fn remove_owned(handle: &File, staging: &Path) {
    if !same_directory(handle, staging) {
        return;
    }
    let _ = clear_owned(handle, 0);
}
