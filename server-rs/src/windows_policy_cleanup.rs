//! Windows handle-relative CloudLink cleanup primitives.
use std::{
    ffi::OsStr,
    fs::{File, OpenOptions},
    io,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, Prefix},
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            NtCreateFile, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
            FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
        },
    },
    Win32::{
        Foundation::{RtlNtStatusToDosError, HANDLE, UNICODE_STRING},
        Storage::FileSystem::{
            FileAttributeTagInfo, FileDispositionInfo, GetFileInformationByHandleEx,
            SetFileInformationByHandle, DELETE, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

fn verify_directory(file: &File) -> io::Result<()> {
    let mut info: FILE_ATTRIBUTE_TAG_INFO = unsafe { std::mem::zeroed() };
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other(
            "Cloud state path contains a reparse point",
        ));
    }
    Ok(())
}
fn open_child(parent: &File, name: &OsStr, directory: bool) -> io::Result<File> {
    verify_directory(parent)?;
    let mut chars: Vec<u16> = name.encode_wide().collect();
    if chars.is_empty()
        || chars.len() > 32767
        || chars == [46]
        || chars == [46, 46]
        || chars.iter().any(|ch| matches!(*ch, 0 | 47 | 58 | 92))
    {
        return Err(io::Error::other("Invalid cloud state component"));
    }
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
    let access = if directory {
        FILE_GENERIC_READ
    } else {
        DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE
    };
    let result = unsafe {
        NtCreateFile(
            &mut raw,
            access,
            &attributes,
            &mut status,
            std::ptr::null(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | if directory {
                    FILE_DIRECTORY_FILE
                } else {
                    FILE_NON_DIRECTORY_FILE
                },
            std::ptr::null(),
            0,
        )
    };
    if result < 0 {
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        ));
    }
    let file = unsafe { File::from_raw_handle(raw as _) };
    verify_directory(&file)?;
    Ok(file)
}
/// Open every path component without following reparse points, then mark
/// only the named direct children for deletion by their own handles.
pub(crate) fn unlink_cloud_state(path: &Path, names: &[&str]) -> io::Result<()> {
    let absolute = std::path::absolute(path)?;
    let mut components = absolute.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return Err(io::Error::other("Unsupported cloud state root")),
        },
        _ => return Err(io::Error::other("Invalid cloud state root")),
    };
    if components.next() != Some(Component::RootDir) {
        return Err(io::Error::other("Invalid cloud state root"));
    }
    let root = format!("{}:\\", drive as char);
    let mut dir = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(root)?;
    verify_directory(&dir)?;
    for component in components {
        match component {
            Component::Normal(name) => match open_child(&dir, name, true) {
                Ok(next) => dir = next,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error),
            },
            Component::CurDir => {}
            _ => return Err(io::Error::other("Invalid cloud state path")),
        }
    }
    for name in names {
        let file = match open_child(&dir, OsStr::new(name), false) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle() as HANDLE,
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removes_only_selected_cloud_state_files() {
        let root =
            std::env::temp_dir().join(format!("t3-win-cloud-cleanup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("cloud-relay-url.bin"), b"cloud").unwrap();
        std::fs::write(root.join("unrelated.bin"), b"keep").unwrap();
        unlink_cloud_state(&root, &["cloud-relay-url.bin", "missing.bin"]).unwrap();
        assert!(!root.join("cloud-relay-url.bin").exists());
        assert_eq!(std::fs::read(root.join("unrelated.bin")).unwrap(), b"keep");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_reparse_directory_without_touching_target() {
        use std::os::windows::fs::symlink_dir;
        let root = std::env::temp_dir().join(format!("t3-win-cloud-link-{}", uuid::Uuid::new_v4()));
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("cloud-relay-url.bin"), b"keep").unwrap();
        let link = root.join("link");
        if symlink_dir(&outside, &link).is_err() {
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        assert!(unlink_cloud_state(&link, &["cloud-relay-url.bin"]).is_err());
        assert_eq!(
            std::fs::read(outside.join("cloud-relay-url.bin")).unwrap(),
            b"keep"
        );
        std::fs::remove_dir(link).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
