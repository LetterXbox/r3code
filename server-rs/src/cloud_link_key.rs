//! Persistent Ed25519 identity used to sign environment relay proofs.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredKey {
    private_key: String,
    public_key: String,
}
pub(crate) struct CloudLinkKey {
    key: Ed25519KeyPair,
    pub(crate) public_key: String,
}
struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn pem(kind: &str, bytes: &[u8]) -> String {
    let encoded = STANDARD.encode(bytes);
    let lines = encoded
        .as_bytes()
        .chunks(64)
        .map(|chunk| std::str::from_utf8(chunk).expect("base64 is ASCII"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("-----BEGIN {kind}-----\n{lines}\n-----END {kind}-----\n")
}
fn parse_private(value: &str) -> io::Result<Vec<u8>> {
    let value = value.replace("\\n", "\n");
    let body = value
        .trim()
        .strip_prefix("-----BEGIN PRIVATE KEY-----")
        .and_then(|v| v.strip_suffix("-----END PRIVATE KEY-----"))
        .ok_or_else(|| io::Error::other("Invalid cloud signing key"))?;
    STANDARD
        .decode(body.split_whitespace().collect::<String>())
        .map_err(|_| io::Error::other("Invalid cloud signing key"))
}
fn decode(stored: StoredKey) -> io::Result<CloudLinkKey> {
    let key = Ed25519KeyPair::from_pkcs8_maybe_unchecked(&parse_private(&stored.private_key)?)
        .map_err(|_| io::Error::other("Invalid cloud signing key"))?;
    let mut spki = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    spki.extend_from_slice(key.public_key().as_ref());
    let expected = pem("PUBLIC KEY", &spki);
    let public = stored.public_key.replace("\\n", "\n");
    let public = public
        .trim()
        .strip_prefix("-----BEGIN PUBLIC KEY-----")
        .and_then(|value| value.strip_suffix("-----END PUBLIC KEY-----"))
        .ok_or_else(|| io::Error::other("Invalid cloud public key"))?;
    let public = STANDARD
        .decode(public.split_whitespace().collect::<String>())
        .map_err(|_| io::Error::other("Invalid cloud public key"))?;
    if public != spki {
        return Err(io::Error::other("Cloud signing key pair mismatch"));
    }
    Ok(CloudLinkKey {
        key,
        public_key: expected,
    })
}
fn read(dir: &Path) -> io::Result<Option<StoredKey>> {
    match fs::read(dir.join("cloud-link-ed25519-key-pair.bin")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| io::Error::other("Invalid cloud signing key pair")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
pub(crate) fn load_or_create(dir: &Path) -> io::Result<CloudLinkKey> {
    crate::signing_key::secure_secrets_dir(dir).map_err(io::Error::other)?;
    if let Some(stored) = read(dir)? {
        return decode(stored);
    }
    let legacy = match (
        fs::read_to_string(dir.join("cloud-link-ed25519-private-key.bin")),
        fs::read_to_string(dir.join("cloud-link-ed25519-public-key.bin")),
    ) {
        (Ok(private_key), Ok(public_key)) => Some(StoredKey {
            private_key,
            public_key,
        }),
        (Err(a), Err(b))
            if a.kind() == io::ErrorKind::NotFound && b.kind() == io::ErrorKind::NotFound =>
        {
            None
        }
        (Ok(_), Err(e)) | (Err(e), Ok(_)) if e.kind() == io::ErrorKind::NotFound => None,
        (Err(e), _) | (_, Err(e)) => return Err(e),
    };
    let stored = if let Some(legacy) = legacy {
        decode(StoredKey {
            private_key: legacy.private_key.clone(),
            public_key: legacy.public_key.clone(),
        })?;
        legacy
    } else {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| io::Error::other("Could not generate cloud signing key"))?;
        let key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
            .map_err(|_| io::Error::other("Could not generate cloud signing key"))?;
        let mut spki = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        spki.extend_from_slice(key.public_key().as_ref());
        StoredKey {
            private_key: pem("PRIVATE KEY", pkcs8.as_ref()),
            public_key: pem("PUBLIC KEY", &spki),
        }
    };
    let temp = Temp(dir.join(format!("cloud-link-key-{}.tmp", uuid::Uuid::new_v4())));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&temp.0)?;
    file.write_all(&serde_json::to_vec(&stored)?)?;
    file.sync_all()?;
    match fs::hard_link(&temp.0, dir.join("cloud-link-ed25519-key-pair.bin")) {
        Ok(()) => decode(stored),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            decode(read(dir)?.ok_or_else(|| io::Error::other("Cloud signing key disappeared"))?)
        }
        Err(e) => Err(e),
    }
}
impl CloudLinkKey {
    pub(crate) fn sign(&self, payload: &serde_json::Value) -> io::Result<String> {
        self.sign_typed("t3-env-link+jwt", payload)
    }
    pub(crate) fn sign_typed(&self, typ: &str, payload: &serde_json::Value) -> io::Result<String> {
        let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(
            &serde_json::json!({"alg":"EdDSA","typ":typ}),
        )?);
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(payload)?);
        let input = format!("{header}.{body}");
        Ok(format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(self.key.sign(input.as_bytes()).as_ref())
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_identity_and_signs_verifiable_proofs() {
        let dir = std::env::temp_dir().join(format!("t3-cloud-key-{}", uuid::Uuid::new_v4()));
        let first = load_or_create(&dir).unwrap();
        let token = first
            .sign(&serde_json::json!({"challenge":"fixture"}))
            .unwrap();
        let parts: Vec<_> = token.split('.').collect();
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ED25519,
            first.key.public_key().as_ref(),
        )
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
        .unwrap();
        assert_eq!(load_or_create(&dir).unwrap().public_key, first.public_key);
        fs::remove_dir_all(dir).unwrap();
    }
}
