// passwords.rs — AES-256-GCM vault for Vertex Password Manager
// Crypto chain: Master password → Argon2id → 256-bit key → AES-256-GCM per entry

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use argon2::{Argon2, Algorithm, Version, Params, password_hash::{PasswordHasher, SaltString, rand_core::OsRng as HashOsRng}};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
};
use uuid::Uuid;

// ── Data structures ────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VaultEntry {
    pub id: String,
    pub title: String,
    pub url: String,
    pub username_enc: String, // base64(nonce + ciphertext)
    pub password_enc: String, // base64(nonce + ciphertext)
}

/// Public version returned to JS (plaintext, decrypted on the fly)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VaultEntryPublic {
    pub id: String,
    pub title: String,
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(Serialize, Deserialize, Default)]
struct VaultFile {
    /// Argon2id-encoded hash of the master password (used for verification only)
    master_hash: String,
    /// Per-entry salt used during Argon2 key derivation (one per vault, stored in hex)
    kdf_salt: String,
    entries: Vec<VaultEntry>,
}

// ── Global vault state ────────────────────────────────────────────

pub struct VaultState {
    /// Derived AES-256 key (in memory while unlocked, zeroed on lock)
    key: Option<Vec<u8>>,
    file: VaultFile,
    path: PathBuf,
}

impl VaultState {
    pub fn new(path: PathBuf) -> Self {
        let file = if path.exists() {
            let raw = fs::read_to_string(&path).unwrap_or_default();
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            VaultFile::default()
        };
        VaultState { key: None, file, path }
    }

    pub fn is_setup(&self) -> bool {
        !self.file.master_hash.is_empty()
    }

    pub fn is_locked(&self) -> bool {
        self.key.is_none()
    }

    /// First-time setup: sets master password and creates KDF salt
    pub fn setup(&mut self, master_pw: &str) -> Result<(), String> {
        // Generate a random 32-byte KDF salt
        let salt_bytes: [u8; 32] = rand::thread_rng().gen();
        let salt_hex = hex::encode(salt_bytes);
        self.file.kdf_salt = salt_hex;

        // Store an Argon2id hash of the master password for verification
        let salt = SaltString::generate(&mut HashOsRng);
        let argon2 = make_argon2();
        let hash = argon2
            .hash_password(master_pw.as_bytes(), &salt)
            .map_err(|e| e.to_string())?
            .to_string();

        self.file.master_hash = hash;
        self.derive_and_store_key(master_pw)?;
        self.save()
    }

    /// Unlocks the vault: verifies master password and derives key
    pub fn unlock(&mut self, master_pw: &str) -> Result<bool, String> {
        use argon2::password_hash::{PasswordHash, PasswordVerifier};
        let parsed = PasswordHash::new(&self.file.master_hash).map_err(|e| e.to_string())?;
        let ok = make_argon2().verify_password(master_pw.as_bytes(), &parsed).is_ok();
        if ok {
            self.derive_and_store_key(master_pw)?;
        }
        Ok(ok)
    }

    pub fn lock(&mut self) {
        // Overwrite key bytes before dropping
        if let Some(k) = &mut self.key {
            for b in k.iter_mut() { *b = 0; }
        }
        self.key = None;
    }

    pub fn get_entries(&self) -> Result<Vec<VaultEntryPublic>, String> {
        let key = self.require_key()?;
        self.file.entries.iter().map(|e| {
            let username = decrypt_field(&key, &e.username_enc)?;
            let password = decrypt_field(&key, &e.password_enc)?;
            Ok(VaultEntryPublic {
                id: e.id.clone(),
                title: e.title.clone(),
                url: e.url.clone(),
                username,
                password,
            })
        }).collect()
    }

    pub fn add_entry(&mut self, title: &str, url: &str, username: &str, password: &str) -> Result<VaultEntryPublic, String> {
        let key = self.require_key()?;
        let id = Uuid::new_v4().to_string();
        let username_enc = encrypt_field(&key, username)?;
        let password_enc = encrypt_field(&key, password)?;

        let entry = VaultEntry {
            id: id.clone(),
            title: title.to_string(),
            url: url.to_string(),
            username_enc,
            password_enc,
        };
        self.file.entries.push(entry);
        self.save()?;

        Ok(VaultEntryPublic {
            id,
            title: title.to_string(),
            url: url.to_string(),
            username: username.to_string(),
            password: password.to_string(),
        })
    }

    pub fn delete_entry(&mut self, id: &str) -> Result<(), String> {
        self.file.entries.retain(|e| e.id != id);
        self.save()
    }

    fn require_key(&self) -> Result<Vec<u8>, String> {
        self.key.clone().ok_or_else(|| "Vault is locked".to_string())
    }

    fn derive_and_store_key(&mut self, master_pw: &str) -> Result<(), String> {
        let salt = hex::decode(&self.file.kdf_salt)
            .map_err(|e| format!("Bad KDF salt: {e}"))?;
        let mut key = vec![0u8; 32];
        Argon2::default()
            .hash_password_into(master_pw.as_bytes(), &salt, &mut key)
            .map_err(|e| e.to_string())?;
        self.key = Some(key);
        Ok(())
    }

    fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&self.file).map_err(|e| e.to_string())?;
        fs::write(&self.path, json).map_err(|e| e.to_string())
    }
}

// ── Crypto helpers ────────────────────────────────────────────────

/// Encrypts a plaintext string → base64(nonce || ciphertext)
fn encrypt_field(key: &[u8], plaintext: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 96-bit random nonce
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encrypt error: {e}"))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(B64.encode(out))
}

/// Decrypts base64(nonce || ciphertext) → plaintext string
fn decrypt_field(key: &[u8], encoded: &str) -> Result<String, String> {
    let raw = B64.decode(encoded).map_err(|e| format!("Base64 decode: {e}"))?;
    if raw.len() < 12 {
        return Err("Ciphertext too short".to_string());
    }
    let (nonce_bytes, ciphertext) = raw.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Decryption failed — wrong master password?".to_string())?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

fn make_argon2<'a>() -> Argon2<'a> {
    // Argon2id with OWASP recommended params (2024)
    // m=64MB, t=3 iterations, p=4 lanes
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(65536, 3, 4, None).unwrap(),
    )
}

// ── Password Generator ────────────────────────────────────────────

pub fn generate_password(length: usize, use_symbols: bool) -> String {
    const ALPHA: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
    const DIGITS: &[u8] = b"23456789";
    const SYMBOLS: &[u8] = b"!@#$%^&*-_=+?";

    let mut charset: Vec<u8> = Vec::new();
    charset.extend_from_slice(ALPHA);
    charset.extend_from_slice(DIGITS);
    if use_symbols { charset.extend_from_slice(SYMBOLS); }

    let mut rng = rand::thread_rng();
    (0..length).map(|_| charset[rng.gen_range(0..charset.len())] as char).collect()
}

// ── Vault path helper ─────────────────────────────────────────────

pub fn vault_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("vertex")
        .join("vault.json")
}

// Needed by argon2-hex helpers — we use the `hex` crate inline
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
    pub fn decode(s: &str) -> Result<Vec<u8>, String> {
        (0..s.len()).step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i+2], 16).map_err(|e| e.to_string()))
            .collect()
    }
}
