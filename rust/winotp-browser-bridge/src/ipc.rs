use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::fs;
#[cfg(not(any(unix, windows)))]
use std::fs;
#[cfg(any(unix, windows))]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::time::Duration;

use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::framing::{MAX_MESSAGE_BYTES, ReadFrame, read_frame, write_frame};
use crate::protocol::{NativeRequest, PROTOCOL_VERSION, validate_forwarded_response};

const MAX_DESCRIPTOR_BYTES: u64 = 8 * 1024;
const MIN_AUTH_TOKEN_CHARS: usize = 43;

fn descriptor_open_error(error: io::Error) -> TransportError {
    if error.kind() == io::ErrorKind::NotFound {
        TransportError::AppUnavailable
    } else {
        TransportError::InvalidDescriptor
    }
}

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("WinOTP desktop endpoint is unavailable")]
    AppUnavailable,
    #[error("WinOTP desktop endpoint descriptor is invalid")]
    InvalidDescriptor,
    #[error("WinOTP desktop endpoint returned an invalid response")]
    InvalidResponse,
}

pub trait DesktopTransport {
    fn send(&self, request: &NativeRequest) -> Result<Value, TransportError>;
}

pub struct LocalIpcTransport {
    descriptor_path: PathBuf,
}

impl LocalIpcTransport {
    pub fn discover() -> Result<Self, TransportError> {
        Ok(Self {
            descriptor_path: default_descriptor_path()?,
        })
    }

    #[cfg(test)]
    pub fn with_descriptor_path(descriptor_path: PathBuf) -> Self {
        Self { descriptor_path }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EndpointDescriptor {
    version: u64,
    endpoint: Endpoint,
    auth_token: String,
    expires_at: u64,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Endpoint {
    Unix { path: PathBuf },
    WindowsNamedPipe { name: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticatedIpcRequest<'a> {
    version: u64,
    request_id: &'a str,
    auth: IpcAuth<'a>,
    request: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IpcAuth<'a> {
    scheme: &'static str,
    token: &'a str,
}

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

fn default_descriptor_path() -> Result<PathBuf, TransportError> {
    let base = BaseDirs::new().ok_or(TransportError::AppUnavailable)?;
    #[cfg(target_os = "linux")]
    if let Some(runtime_directory) = std::env::var_os("XDG_RUNTIME_DIR") {
        let runtime_directory = PathBuf::from(runtime_directory);
        if runtime_directory.is_absolute() {
            return Ok(runtime_directory.join("winotp-reborn/browser-bridge.json"));
        }
    }
    Ok(base
        .data_local_dir()
        .join("WinOTP_Reborn/runtime/browser-bridge.json"))
}

#[cfg(unix)]
fn open_descriptor(path: &Path) -> Result<File, TransportError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(descriptor_open_error)?;
    let metadata = file
        .metadata()
        .map_err(|_| TransportError::InvalidDescriptor)?;
    if !metadata.is_file()
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(TransportError::InvalidDescriptor);
    }
    Ok(file)
}

#[cfg(windows)]
fn open_descriptor(path: &Path) -> Result<File, TransportError> {
    use std::mem::{size_of, zeroed};
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use std::ptr::{addr_of, addr_of_mut, null_mut};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GENERIC_ALL, GENERIC_READ, HANDLE, LocalFree,
    };
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, CreateWellKnownSid,
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation, GetTokenInformation,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_MAX_SID_SIZE, TOKEN_QUERY,
        TOKEN_USER, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_DATA,
    };
    use windows_sys::Win32::System::SystemServices::{
        ACCESS_ALLOWED_ACE_TYPE, ACCESS_ALLOWED_CALLBACK_ACE_TYPE,
        ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE, ACCESS_ALLOWED_COMPOUND_ACE_TYPE,
        ACCESS_ALLOWED_OBJECT_ACE_TYPE,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    fn well_known_sid(kind: i32) -> Result<Vec<usize>, TransportError> {
        let mut buffer =
            vec![0_usize; (SECURITY_MAX_SID_SIZE as usize).div_ceil(size_of::<usize>())];
        let mut size = SECURITY_MAX_SID_SIZE;
        if unsafe { CreateWellKnownSid(kind, null_mut(), buffer.as_mut_ptr().cast(), &mut size) }
            == 0
        {
            return Err(TransportError::InvalidDescriptor);
        }
        Ok(buffer)
    }

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(descriptor_open_error)?;
    let metadata = file
        .metadata()
        .map_err(|_| TransportError::InvalidDescriptor)?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(TransportError::InvalidDescriptor);
    }

    let mut token: HANDLE = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(TransportError::InvalidDescriptor);
    }
    let mut required = 0;
    unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut required) };
    if required < size_of::<TOKEN_USER>() as u32 {
        unsafe { CloseHandle(token) };
        return Err(TransportError::InvalidDescriptor);
    }
    let mut token_buffer = vec![0_usize; (required as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            token_buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        unsafe { CloseHandle(token) };
        return Err(TransportError::InvalidDescriptor);
    }
    unsafe { CloseHandle(token) };
    let user_sid = unsafe { (*token_buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };

    let system_sid = well_known_sid(WinLocalSystemSid)?;
    let administrators_sid = well_known_sid(WinBuiltinAdministratorsSid)?;
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut security_descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let result = unsafe {
        GetSecurityInfo(
            file.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut security_descriptor,
        )
    };
    if result != 0 || security_descriptor.is_null() {
        if !security_descriptor.is_null() {
            unsafe { LocalFree(security_descriptor) };
        }
        return Err(TransportError::InvalidDescriptor);
    }

    let validation = (|| {
        if owner.is_null() || dacl.is_null() || unsafe { EqualSid(owner, user_sid) } == 0 {
            return Err(TransportError::InvalidDescriptor);
        }
        let mut information: ACL_SIZE_INFORMATION = unsafe { zeroed() };
        if unsafe {
            GetAclInformation(
                dacl,
                addr_of_mut!(information).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
        {
            return Err(TransportError::InvalidDescriptor);
        }

        let mut user_can_read = false;
        for index in 0..information.AceCount {
            let mut raw_ace = null_mut();
            if unsafe { GetAce(dacl, index, &mut raw_ace) } == 0 || raw_ace.is_null() {
                return Err(TransportError::InvalidDescriptor);
            }
            let header = unsafe { &*raw_ace.cast::<windows_sys::Win32::Security::ACE_HEADER>() };
            match header.AceType as u32 {
                ACCESS_ALLOWED_ACE_TYPE => {}
                ACCESS_ALLOWED_CALLBACK_ACE_TYPE
                | ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE
                | ACCESS_ALLOWED_COMPOUND_ACE_TYPE
                | ACCESS_ALLOWED_OBJECT_ACE_TYPE => {
                    return Err(TransportError::InvalidDescriptor);
                }
                _ => continue,
            }
            if header.AceSize < size_of::<ACCESS_ALLOWED_ACE>() as u16 {
                return Err(TransportError::InvalidDescriptor);
            }
            let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
            if ace.Mask & (GENERIC_READ | GENERIC_ALL | FILE_READ_DATA) == 0 {
                continue;
            }
            let sid = addr_of!(ace.SidStart).cast_mut().cast();
            if unsafe { EqualSid(sid, user_sid) } != 0 {
                user_can_read = true;
            } else if unsafe { EqualSid(sid, system_sid.as_ptr().cast_mut().cast()) } == 0
                && unsafe { EqualSid(sid, administrators_sid.as_ptr().cast_mut().cast()) } == 0
            {
                return Err(TransportError::InvalidDescriptor);
            }
        }
        if !user_can_read {
            return Err(TransportError::InvalidDescriptor);
        }
        Ok(())
    })();
    unsafe { LocalFree(security_descriptor) };
    validation?;
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
fn open_descriptor(path: &Path) -> Result<File, TransportError> {
    let metadata = fs::symlink_metadata(path).map_err(descriptor_open_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(TransportError::InvalidDescriptor);
    }
    File::open(path).map_err(descriptor_open_error)
}

fn read_descriptor(path: &Path) -> Result<EndpointDescriptor, TransportError> {
    let file = open_descriptor(path)?;
    let metadata = file
        .metadata()
        .map_err(|_| TransportError::InvalidDescriptor)?;
    if metadata.len() > MAX_DESCRIPTOR_BYTES {
        return Err(TransportError::InvalidDescriptor);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_DESCRIPTOR_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| TransportError::AppUnavailable)?;
    if bytes.len() as u64 > MAX_DESCRIPTOR_BYTES {
        return Err(TransportError::InvalidDescriptor);
    }
    let descriptor: EndpointDescriptor =
        serde_json::from_slice(&bytes).map_err(|_| TransportError::InvalidDescriptor)?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| TransportError::InvalidDescriptor)?
        .as_secs();
    if !descriptor_is_current(&descriptor, now) {
        return Err(TransportError::InvalidDescriptor);
    }
    Ok(descriptor)
}

fn descriptor_is_current(descriptor: &EndpointDescriptor, now: u64) -> bool {
    descriptor.version == PROTOCOL_VERSION
        && descriptor.expires_at > now
        && descriptor.expires_at <= now.saturating_add(24 * 60 * 60)
        && descriptor.auth_token.len() >= MIN_AUTH_TOKEN_CHARS
        && descriptor.auth_token.len() <= 128
        && descriptor
            .auth_token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(unix)]
fn connect(endpoint: &Endpoint) -> Result<Box<dyn ReadWrite>, TransportError> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::os::unix::net::UnixStream;

    let Endpoint::Unix { path } = endpoint else {
        return Err(TransportError::InvalidDescriptor);
    };
    if !path.is_absolute() || path.as_os_str().len() > 1024 {
        return Err(TransportError::InvalidDescriptor);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| TransportError::AppUnavailable)?;
    if !metadata.file_type().is_socket()
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(TransportError::InvalidDescriptor);
    }
    let stream = UnixStream::connect(path).map_err(|_| TransportError::AppUnavailable)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| TransportError::AppUnavailable)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| TransportError::AppUnavailable)?;
    Ok(Box::new(stream))
}

#[cfg(windows)]
fn connect(endpoint: &Endpoint) -> Result<Box<dyn ReadWrite>, TransportError> {
    let Endpoint::WindowsNamedPipe { name } = endpoint else {
        return Err(TransportError::InvalidDescriptor);
    };
    if !name.starts_with(r"\\.\pipe\winotp-reborn-browser-")
        || name.len() > 256
        || name[9..].contains(['/', '\\'])
    {
        return Err(TransportError::InvalidDescriptor);
    }
    let pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(name)
        .map_err(|_| TransportError::AppUnavailable)?;
    Ok(Box::new(pipe))
}

#[cfg(not(any(unix, windows)))]
fn connect(_endpoint: &Endpoint) -> Result<Box<dyn ReadWrite>, TransportError> {
    Err(TransportError::AppUnavailable)
}

impl DesktopTransport for LocalIpcTransport {
    fn send(&self, request: &NativeRequest) -> Result<Value, TransportError> {
        let descriptor = read_descriptor(&self.descriptor_path)?;
        let ipc_request = AuthenticatedIpcRequest {
            version: PROTOCOL_VERSION,
            request_id: &request.request_id,
            auth: IpcAuth {
                scheme: "ephemeral-token",
                token: &descriptor.auth_token,
            },
            request: request.as_value(),
        };
        let body =
            serde_json::to_vec(&ipc_request).map_err(|_| TransportError::InvalidDescriptor)?;
        if body.len() > MAX_MESSAGE_BYTES {
            return Err(TransportError::InvalidDescriptor);
        }

        let mut stream = connect(&descriptor.endpoint)?;
        write_frame(&mut stream, &body).map_err(|_| TransportError::AppUnavailable)?;
        let response = match read_frame(&mut stream).map_err(|_| TransportError::InvalidResponse)? {
            ReadFrame::Message(body) => body,
            ReadFrame::Eof => return Err(TransportError::InvalidResponse),
        };
        let value =
            serde_json::from_slice(&response).map_err(|_| TransportError::InvalidResponse)?;
        validate_forwarded_response(request, value).map_err(|_| TransportError::InvalidResponse)
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::time::SystemTime;

    use super::*;

    fn descriptor_with_token(auth_token: &str) -> EndpointDescriptor {
        EndpointDescriptor {
            version: PROTOCOL_VERSION,
            endpoint: Endpoint::Unix {
                path: PathBuf::from("/tmp/winotp-test.sock"),
            },
            auth_token: auth_token.to_owned(),
            expires_at: 1_001,
        }
    }

    #[test]
    fn descriptor_requires_a_256_bit_base64url_token() {
        assert!(!descriptor_is_current(
            &descriptor_with_token("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            1_000
        ));
        assert!(descriptor_is_current(
            &descriptor_with_token("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            1_000
        ));
    }

    #[test]
    fn missing_descriptor_means_the_app_is_unavailable() {
        let missing = std::env::temp_dir().join(format!(
            "winotp-missing-descriptor-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let transport = LocalIpcTransport::with_descriptor_path(missing);
        let request = NativeRequest {
            request_id: "request-1".to_owned(),
            method: crate::protocol::RequestMethod::GetStatus,
        };
        assert!(matches!(
            transport.send(&request),
            Err(TransportError::AppUnavailable)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_must_be_private_and_cannot_be_a_symlink() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("winotp-descriptor-{suffix}.json"));
        let link = std::env::temp_dir().join(format!("winotp-descriptor-link-{suffix}.json"));
        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 60;
        fs::write(
            &path,
            format!(
                r#"{{"version":1,"endpoint":{{"kind":"unix","path":"/tmp/winotp-test.sock"}},"authToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expiresAt":{expires_at}}}"#
            ),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            read_descriptor(&path),
            Err(TransportError::InvalidDescriptor)
        ));

        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_descriptor(&path).is_ok());
        symlink(&path, &link).unwrap();
        assert!(matches!(
            read_descriptor(&link),
            Err(TransportError::InvalidDescriptor)
        ));

        fs::remove_file(link).unwrap();
        fs::remove_file(path).unwrap();
    }
}
