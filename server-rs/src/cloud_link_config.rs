//! Validate and persist manual relay configuration without starting a connector.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
static LOCK: Mutex<()> = Mutex::new(());
struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn save(dir: &Path, name: &str, value: &str) -> io::Result<()> {
    let temp = Temp(dir.join(format!("cloud-config-{}.tmp", uuid::Uuid::new_v4())));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp.0)?;
    file.write_all(value.as_bytes())?;
    file.sync_all()?;
    fs::rename(&temp.0, dir.join(format!("{name}.bin")))
}
fn secure_url(value: &str) -> bool {
    url::Url::parse(value.trim()).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path().chars().all(|c| c == '/')
    })
}
fn valid_public_key(value: &str) -> bool {
    let text = value.replace("\\n", "\n");
    let Some(body) = text
        .trim()
        .strip_prefix("-----BEGIN PUBLIC KEY-----")
        .and_then(|v| v.strip_suffix("-----END PUBLIC KEY-----"))
    else {
        return false;
    };
    let Ok(bytes) = STANDARD.decode(body.split_whitespace().collect::<String>()) else {
        return false;
    };
    bytes.len() == 44
        && bytes.starts_with(&[
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ])
}
pub(crate) enum Error {
    Invalid(&'static str),
    AccountMismatch,
    Unsupported,
    OriginUnconfirmed,
    NeedsRegistration,
    Storage,
}
pub(crate) fn unlink(dir: &Path) -> io::Result<()> {
    let _guard = LOCK
        .lock()
        .map_err(|_| io::Error::other("Cloud state lock unavailable"))?;
    crate::managed_policy::unlink_cloud_state(dir)
}
pub(crate) fn confirm_origin(dir: &Path, runtime: &Value, origin: &Value) -> io::Result<()> {
    let _guard = LOCK
        .lock()
        .map_err(|_| io::Error::other("Cloud state lock unavailable"))?;
    let bytes = serde_json::to_string(&serde_json::json!({"config":runtime,"origin":origin}))?;
    save(dir, "cloud-endpoint-confirmed-origin", &bytes)
}
pub(crate) fn mark_revoked(dir: &Path) -> io::Result<()> {
    let _guard = LOCK
        .lock()
        .map_err(|_| io::Error::other("Cloud state lock unavailable"))?;
    save(dir, "cloud-link-revoked", "true")
}
pub(crate) fn record_http2_fallback(dir: &Path, at: u128) -> io::Result<()> {
    let _guard = LOCK
        .lock()
        .map_err(|_| io::Error::other("Cloud state lock unavailable"))?;
    save(
        dir,
        "cloud-endpoint-http2-fallback",
        &serde_json::json!({"fellBackAt":at}).to_string(),
    )
}
pub(crate) fn is_current(dir: &Path, input: &Value) -> io::Result<bool> {
    let _guard = LOCK
        .lock()
        .map_err(|_| io::Error::other("Cloud state lock unavailable"))?;
    let read = |name: &str| -> io::Result<Option<String>> {
        match fs::read_to_string(dir.join(format!("{name}.bin"))) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    };
    let Some(runtime) = read("cloud-endpoint-runtime-config")? else {
        return Ok(false);
    };
    let Ok(runtime) = serde_json::from_str::<Value>(&runtime) else {
        return Ok(false);
    };
    Ok(runtime == input["endpointRuntime"]
        && read("cloud-relay-url")?.as_deref() == input["relayUrl"].as_str()
        && read("cloud-relay-issuer")?.as_deref()
            == input["relayIssuer"]
                .as_str()
                .or_else(|| input["relayUrl"].as_str())
        && read("cloud-linked-user-id")?.as_deref() == input["cloudUserId"].as_str()
        && read("cloud-relay-environment-credential")?.as_deref()
            == input["environmentCredential"].as_str())
}
pub(crate) fn stored_registration(dir: &Path) -> io::Result<Option<Value>> {
    use std::io::Read as _;
    let read = |name: &str| -> io::Result<Option<String>> {
        let file = match fs::File::open(dir.join(format!("{name}.bin"))) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 1024 * 1024 {
            return Err(io::Error::other("Cloud state is too large"));
        }
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| io::Error::other("Invalid cloud state"))
    };
    if read("cloud-cli-desired-link")?.as_deref() == Some("publish_only") {
        return Ok(None);
    }
    let Some(runtime) = read("cloud-endpoint-runtime-config")? else {
        return Ok(None);
    };
    let runtime: Value =
        serde_json::from_str(&runtime).map_err(|_| io::Error::other("Invalid cloud runtime"))?;
    if runtime["providerKind"] != "cloudflare_tunnel" {
        return Ok(None);
    }
    let (Some(relay), Some(user), Some(credential)) = (
        read("cloud-relay-url")?,
        read("cloud-linked-user-id")?,
        read("cloud-relay-environment-credential")?,
    ) else {
        return Ok(None);
    };
    let issuer = read("cloud-relay-issuer")?.unwrap_or_else(|| relay.clone());
    if !secure_url(&relay) || !secure_url(&issuer) {
        return Err(io::Error::other("Invalid stored relay origin"));
    }
    Ok(Some(
        serde_json::json!({"endpointRuntime":runtime,"relayUrl":relay,"relayIssuer":issuer,"cloudUserId":user,"environmentCredential":credential}),
    ))
}
pub(crate) fn replace_recovered_runtime(dir: &Path, runtime: &Value) -> io::Result<()> {
    let _guard = LOCK
        .lock()
        .map_err(|_| io::Error::other("Cloud state lock unavailable"))?;
    let serialized = serde_json::to_string(runtime)?;
    save(dir, "cloud-endpoint-runtime-config", &serialized)?;
    for name in ["cloud-endpoint-confirmed-origin", "cloud-link-revoked"] {
        match fs::remove_file(dir.join(format!("{name}.bin"))) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
pub(crate) fn validate(dir: &Path, input: &Value) -> Result<(), Error> {
    let field = |name: &str| input[name].as_str().unwrap_or("");
    if !secure_url(field("relayUrl")) {
        return Err(Error::Invalid(
            "Relay URL must be a secure absolute HTTPS URL.",
        ));
    }
    if input.get("relayIssuer").is_some() && !secure_url(field("relayIssuer")) {
        return Err(Error::Invalid(
            "Relay issuer must be a secure absolute HTTPS URL.",
        ));
    }
    if field("environmentCredential").trim().is_empty() {
        return Err(Error::Invalid("Relay environment credential is required."));
    }
    if field("cloudUserId").trim().is_empty() {
        return Err(Error::Invalid("Cloud user id is required."));
    }
    match fs::read_to_string(dir.join("cloud-linked-user-id.bin")) {
        Ok(old) if old != field("cloudUserId") => return Err(Error::AccountMismatch),
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(Error::Storage),
    }
    if !valid_public_key(field("cloudMintPublicKey")) {
        return Err(Error::Invalid(
            "Cloud mint public key must be a valid Ed25519 public key.",
        ));
    }
    let runtime = &input["endpointRuntime"];
    let managed = runtime["providerKind"] == "cloudflare_tunnel";
    if !runtime.is_null() && !managed {
        return Err(Error::Unsupported);
    }
    Ok(())
}
pub(crate) fn apply(dir: &Path, input: &Value) -> Result<(), Error> {
    let _guard = LOCK.lock().map_err(|_| Error::Storage)?;
    validate(dir, input)?;
    let field = |name: &str| input[name].as_str().unwrap_or("");
    let runtime = &input["endpointRuntime"];
    let managed = runtime["providerKind"] == "cloudflare_tunnel";
    crate::signing_key::secure_secrets_dir(dir).map_err(|_| Error::Storage)?;
    for name in [
        "cloud-endpoint-confirmed-origin",
        "cloud-endpoint-runtime-config",
    ] {
        match fs::remove_file(dir.join(format!("{name}.bin"))) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(Error::Storage),
        }
    }
    for (name, value) in [
        ("cloud-relay-url", field("relayUrl")),
        (
            "cloud-relay-issuer",
            input["relayIssuer"].as_str().unwrap_or(field("relayUrl")),
        ),
        ("cloud-linked-user-id", field("cloudUserId")),
        (
            "cloud-relay-environment-credential",
            field("environmentCredential"),
        ),
        ("cloud-mint-ed25519-public-key", field("cloudMintPublicKey")),
    ] {
        save(dir, name, value).map_err(|_| Error::Storage)?;
    }
    match fs::remove_file(dir.join("cloud-link-revoked.bin")) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(Error::Storage),
    }
    if managed {
        let serialized = serde_json::to_string(runtime).map_err(|_| Error::Storage)?;
        save(dir, "cloud-endpoint-runtime-config", &serialized).map_err(|_| Error::Storage)?;
        return Err(if runtime.get("tunnelId").is_none() {
            Error::OriginUnconfirmed
        } else {
            Error::NeedsRegistration
        });
    }
    Ok(())
}
