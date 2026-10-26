//! 密匣的加密格式。桌面（今天的本地模式、将来的客户端模式）与测试共用；网页端用 WebCrypto + Argon2 wasm
//! 实现同一格式，靠 `tests/fixtures/` 里的固定向量互相解密保证一致。
//!
//! - 主密钥（32 字节随机）用两份包裹存在 manifest 里：口令派生的密钥一份，恢复密钥派生的一份。
//!   派生用 Argon2id（m = 19456 KiB、t = 2、p = 1），包裹与内容都用 AES-256-GCM（12 字节随机 nonce）。
//! - 免密写入：manifest 里存一对 RSA-2048 密钥，公钥明文、私钥用主密钥加密。锁着时新内容用一次性内容密钥加密，
//!   内容密钥再用 RSA-OAEP-SHA256 包给公钥；解锁后用主密钥解出私钥读取。解锁状态下的写入直接用主密钥。
//! - 信封（`.shard` 文件的原文）是 pretty JSON；manifest 是 `.shard/lockbox.json` 的原文。字段名与旧版一字不改。
//!
//! 这里只管加解密，不碰文件系统，也不解析载荷（载荷是调用方的 JSON）。报错文案与界面一致，前端按原文显示。

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use rsa::{
    pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey},
    Oaep, RsaPrivateKey, RsaPublicKey,
};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

pub const VERSION: u32 = 1;
pub const MASTER_KEY_BYTES: usize = 32;
pub const FRAGMENT_KEY_BYTES: usize = 32;
pub const WRITE_KEY_BITS: usize = 2048;
pub const SALT_BYTES: usize = 16;
pub const NONCE_BYTES: usize = 12;
pub const FRAGMENT_KEY_ALGORITHM: &str = "rsa-oaep-sha256-aes-256-gcm";
/// Argon2id 参数（KiB、迭代、并行）。
pub const KDF_MEMORY_KIB: u32 = 19_456;
pub const KDF_ITERATIONS: u32 = 2;
pub const KDF_PARALLELISM: u32 = 1;

/// `.shard/lockbox.json`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub created_at: String,
    pub updated_at: String,
    pub password_salt: String,
    pub password_nonce: String,
    pub password_encrypted_master_key: String,
    pub recovery_salt: String,
    pub recovery_nonce: String,
    pub recovery_encrypted_master_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_public_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_private_key_nonce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_private_key_ciphertext: Option<String>,
}

/// 一条密匣内容（`.shard` 文件）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    pub version: u32,
    pub id: String,
    pub nonce: String,
    pub ciphertext: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_algorithm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ciphertext: Option<String>,
}

/// 写入用的密钥：解锁时用主密钥，锁着时用 manifest 里的公钥。
pub enum WriteKey {
    Master(Vec<u8>),
    Public(RsaPublicKey),
}

/// 读取用的密钥：主密钥，以及（有免密写入时）解出来的写入私钥。
#[derive(Clone)]
pub struct ReadKeys {
    pub master_key: Vec<u8>,
    pub write_private_key: Option<RsaPrivateKey>,
}

pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

fn decode(value: &str) -> Result<Vec<u8>, String> {
    BASE64.decode(value).map_err(|error| error.to_string())
}

/// 口令（或规整后的恢复密钥）派生 32 字节包裹密钥。
pub fn derive_key(secret: &str, salt: &[u8]) -> Result<Vec<u8>, String> {
    if secret.trim().is_empty() {
        return Err("密匣密码不能为空。".to_string());
    }
    let params = Params::new(KDF_MEMORY_KIB, KDF_ITERATIONS, KDF_PARALLELISM, Some(MASTER_KEY_BYTES))
        .map_err(|error| error.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = vec![0; MASTER_KEY_BYTES];
    argon2.hash_password_into(secret.as_bytes(), salt, &mut key).map_err(|error| error.to_string())?;
    Ok(key)
}

/// AES-256-GCM 加密，随机 nonce。返回 (nonce, 密文+标签)，均为 base64。
pub fn encrypt_bytes(key: &[u8], plaintext: &[u8]) -> Result<(String, String), String> {
    encrypt_with_aad(key, plaintext, b"")
}

fn encrypt_with_aad(key: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<(String, String), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| error.to_string())?;
    let nonce = random_bytes(NONCE_BYTES);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad })
        .map_err(|_| "密匣加密失败。".to_string())?;
    Ok((BASE64.encode(nonce), BASE64.encode(ciphertext)))
}

pub fn decrypt_bytes(key: &[u8], nonce: &str, ciphertext: &str) -> Result<Vec<u8>, String> {
    decrypt_with_aad(key, nonce, ciphertext, b"")
}

fn decrypt_with_aad(key: &[u8], nonce: &str, ciphertext: &str, aad: &[u8]) -> Result<Vec<u8>, String> {
    let nonce = decode(nonce)?;
    let ciphertext = decode(ciphertext)?;
    if nonce.len() != NONCE_BYTES {
        return Err("密匣解密失败。".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| error.to_string())?;
    cipher
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ciphertext, aad })
        .map_err(|_| "密匣解密失败。".to_string())
}

pub fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < 8 {
        return Err("密匣密码至少需要 8 个字符。".to_string());
    }
    Ok(())
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `shard-xxxxxx-xxxxxx-…`：24 字节随机数（192 bit）的十六进制，6 位一组。
pub fn generate_recovery_key() -> String {
    let hex = to_hex(&random_bytes(24));
    let groups = hex.as_bytes().chunks(6).map(|chunk| String::from_utf8_lossy(chunk).to_string()).collect::<Vec<_>>();
    format!("shard-{}", groups.join("-"))
}

/// 只留字母数字并转小写（`shard-` 前缀也保留在内）：用户输入时的空格、连字符、大小写都不影响。
pub fn normalize_recovery_key(value: &str) -> String {
    value.chars().filter(|character| character.is_ascii_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// 用口令包裹主密钥：返回 (salt, nonce, 密文)。
pub fn wrap_master_key(secret: &str, master_key: &[u8]) -> Result<(String, String, String), String> {
    let salt = random_bytes(SALT_BYTES);
    let wrapping_key = derive_key(secret, &salt)?;
    let (nonce, encrypted) = encrypt_bytes(&wrapping_key, master_key)?;
    Ok((BASE64.encode(salt), nonce, encrypted))
}

fn unwrap_master_key(secret: &str, salt: &str, nonce: &str, encrypted: &str) -> Result<Vec<u8>, String> {
    let wrapping_key = derive_key(secret, &decode(salt)?)?;
    decrypt_bytes(&wrapping_key, nonce, encrypted)
}

impl Manifest {
    /// 新建 manifest：两份包裹 + 免密写入密钥对。
    pub fn build(password: &str, recovery_key: &str, master_key: &[u8]) -> Result<Self, String> {
        let (password_salt, password_nonce, password_encrypted_master_key) = wrap_master_key(password, master_key)?;
        let (recovery_salt, recovery_nonce, recovery_encrypted_master_key) =
            wrap_master_key(&normalize_recovery_key(recovery_key), master_key)?;
        let now = now();
        let mut manifest = Self {
            version: VERSION,
            created_at: now.clone(),
            updated_at: now,
            password_salt,
            password_nonce,
            password_encrypted_master_key,
            recovery_salt,
            recovery_nonce,
            recovery_encrypted_master_key,
            write_public_key: None,
            write_private_key_nonce: None,
            write_private_key_ciphertext: None,
        };
        manifest.ensure_write_key(master_key)?;
        Ok(manifest)
    }

    /// 解析 `.shard/lockbox.json` 原文。
    pub fn parse(text: &str) -> Result<Self, String> {
        let manifest = serde_json::from_str::<Self>(text).map_err(|error| error.to_string())?;
        if manifest.version != VERSION {
            return Err("不支持的密匣版本。".to_string());
        }
        Ok(manifest)
    }

    pub fn to_text(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|error| error.to_string())
    }

    pub fn unwrap_with_password(&self, password: &str) -> Result<Vec<u8>, String> {
        unwrap_master_key(password, &self.password_salt, &self.password_nonce, &self.password_encrypted_master_key)
            .map_err(|_| "密码不正确。".to_string())
    }

    pub fn unwrap_with_recovery(&self, recovery_key: &str) -> Result<Vec<u8>, String> {
        unwrap_master_key(
            &normalize_recovery_key(recovery_key),
            &self.recovery_salt,
            &self.recovery_nonce,
            &self.recovery_encrypted_master_key,
        )
        .map_err(|_| "恢复密钥不正确。".to_string())
    }

    /// 换口令：只重包口令那一份。
    pub fn rewrap_password(&mut self, new_password: &str, master_key: &[u8]) -> Result<(), String> {
        let (salt, nonce, encrypted) = wrap_master_key(new_password, master_key)?;
        self.password_salt = salt;
        self.password_nonce = nonce;
        self.password_encrypted_master_key = encrypted;
        self.ensure_write_key(master_key)?;
        self.updated_at = now();
        Ok(())
    }

    /// 用恢复密钥重置：口令与恢复密钥两份都换，返回新的恢复密钥。
    pub fn reset(&mut self, new_password: &str, master_key: &[u8]) -> Result<String, String> {
        let next_recovery_key = generate_recovery_key();
        let (password_salt, password_nonce, password_encrypted_master_key) = wrap_master_key(new_password, master_key)?;
        let (recovery_salt, recovery_nonce, recovery_encrypted_master_key) =
            wrap_master_key(&normalize_recovery_key(&next_recovery_key), master_key)?;
        self.password_salt = password_salt;
        self.password_nonce = password_nonce;
        self.password_encrypted_master_key = password_encrypted_master_key;
        self.recovery_salt = recovery_salt;
        self.recovery_nonce = recovery_nonce;
        self.recovery_encrypted_master_key = recovery_encrypted_master_key;
        self.ensure_write_key(master_key)?;
        self.updated_at = now();
        Ok(next_recovery_key)
    }

    pub fn has_write_key(&self) -> bool {
        self.write_public_key.is_some() && self.write_private_key_nonce.is_some() && self.write_private_key_ciphertext.is_some()
    }

    /// 旧 manifest 没有免密写入密钥对时补上。返回是否改动了 manifest。
    pub fn ensure_write_key(&mut self, master_key: &[u8]) -> Result<bool, String> {
        if self.has_write_key() {
            return Ok(false);
        }
        let private_key = RsaPrivateKey::new(&mut OsRng, WRITE_KEY_BITS).map_err(|error| error.to_string())?;
        let public_key = RsaPublicKey::from(&private_key);
        let private_der = private_key.to_pkcs8_der().map_err(|error| error.to_string())?;
        let public_der = public_key.to_public_key_der().map_err(|error| error.to_string())?;
        let (private_nonce, private_ciphertext) = encrypt_bytes(master_key, private_der.as_bytes())?;
        self.write_public_key = Some(BASE64.encode(public_der.as_bytes()));
        self.write_private_key_nonce = Some(private_nonce);
        self.write_private_key_ciphertext = Some(private_ciphertext);
        self.updated_at = now();
        Ok(true)
    }

    pub fn write_public_key(&self) -> Result<Option<RsaPublicKey>, String> {
        let Some(encoded) = self.write_public_key.as_deref() else {
            return Ok(None);
        };
        RsaPublicKey::from_public_key_der(&decode(encoded)?).map(Some).map_err(|error| error.to_string())
    }

    pub fn write_private_key(&self, master_key: &[u8]) -> Result<Option<RsaPrivateKey>, String> {
        let (Some(nonce), Some(ciphertext)) =
            (self.write_private_key_nonce.as_deref(), self.write_private_key_ciphertext.as_deref())
        else {
            return Ok(None);
        };
        let der = decrypt_bytes(master_key, nonce, ciphertext)?;
        RsaPrivateKey::from_pkcs8_der(&der).map(Some).map_err(|error| error.to_string())
    }

    /// 解锁后读取用的全部密钥。
    pub fn read_keys(&self, master_key: &[u8]) -> Result<ReadKeys, String> {
        Ok(ReadKeys { master_key: master_key.to_vec(), write_private_key: self.write_private_key(master_key)? })
    }
}

impl Envelope {
    /// 加密一条内容。`plaintext` 是调用方序列化好的载荷。
    pub fn seal(write_key: &WriteKey, id: &str, plaintext: &[u8]) -> Result<Self, String> {
        let (nonce, ciphertext, key_algorithm, key_ciphertext) = match write_key {
            WriteKey::Master(master_key) => {
                let (nonce, ciphertext) = encrypt_bytes(master_key, plaintext)?;
                (nonce, ciphertext, None, None)
            }
            WriteKey::Public(public_key) => {
                let fragment_key = random_bytes(FRAGMENT_KEY_BYTES);
                let (nonce, ciphertext) = encrypt_bytes(&fragment_key, plaintext)?;
                let encrypted_key = public_key
                    .encrypt(&mut OsRng, Oaep::new::<Sha256>(), &fragment_key)
                    .map_err(|_| "密匣加密失败。".to_string())?;
                (nonce, ciphertext, Some(FRAGMENT_KEY_ALGORITHM.to_string()), Some(BASE64.encode(encrypted_key)))
            }
        };
        Ok(Self { version: VERSION, id: id.to_string(), nonce, ciphertext, key_algorithm, key_ciphertext })
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let envelope = serde_json::from_str::<Self>(text).map_err(|error| error.to_string())?;
        if envelope.version != VERSION {
            return Err("不支持的密匣片段版本。".to_string());
        }
        Ok(envelope)
    }

    /// `.shard` 文件的原文（pretty JSON，与旧版逐字节同形）。
    pub fn to_text(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|error| error.to_string())
    }

    /// 解密出载荷字节。
    pub fn open(&self, read_keys: &ReadKeys) -> Result<Vec<u8>, String> {
        if let Some(key_ciphertext) = self.key_ciphertext.as_deref() {
            if self.key_algorithm.as_deref() != Some(FRAGMENT_KEY_ALGORITHM) {
                return Err("不支持的密匣片段加密方式。".to_string());
            }
            let private_key = read_keys
                .write_private_key
                .as_ref()
                .ok_or_else(|| "密匣读取密钥缺失。请重置密匣密码后重试。".to_string())?;
            let fragment_key = private_key
                .decrypt(Oaep::new::<Sha256>(), &decode(key_ciphertext)?)
                .map_err(|_| "密匣解密失败。".to_string())?;
            decrypt_bytes(&fragment_key, &self.nonce, &self.ciphertext)
        } else {
            if self.key_algorithm.is_some() {
                return Err("不支持的密匣片段加密方式。".to_string());
            }
            decrypt_bytes(&read_keys.master_key, &self.nonce, &self.ciphertext)
        }
    }
}

/// 解析并解密 `.shard` 原文。
pub fn open_text(text: &str, read_keys: &ReadKeys) -> Result<Vec<u8>, String> {
    Envelope::parse(text)?.open(read_keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_keys_normalize_regardless_of_spacing_and_case() {
        let key = generate_recovery_key();
        assert!(key.starts_with("shard-"));
        assert_eq!(key.len(), "shard-".len() + 48 + 7);
        assert_eq!(normalize_recovery_key(&key), normalize_recovery_key(&format!(" {} ", key.to_uppercase().replace('-', " "))));
    }

    #[test]
    fn aes_gcm_rejects_tampering_and_short_nonces() {
        let key = random_bytes(32);
        let (nonce, ciphertext) = encrypt_bytes(&key, b"hello").unwrap();
        assert_eq!(decrypt_bytes(&key, &nonce, &ciphertext).unwrap(), b"hello");
        let mut tampered = decode(&ciphertext).unwrap();
        tampered[0] ^= 1;
        assert_eq!(decrypt_bytes(&key, &nonce, &BASE64.encode(tampered)).unwrap_err(), "密匣解密失败。");
        assert_eq!(decrypt_bytes(&key, &BASE64.encode([0u8; 4]), &ciphertext).unwrap_err(), "密匣解密失败。");
    }
}
