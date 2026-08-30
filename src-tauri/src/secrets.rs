//! Secure secret storage.
//!
//! Release builds use the OS credential store (macOS Keychain, Windows
//! Credential Manager, Linux Secret Service).
//!
//! Debug builds use a local JSON file instead: unsigned `tauri dev` binaries
//! change signature every rebuild, so the macOS Keychain never honors
//! "Always Allow" and re-prompts for the login password on every key read.
//! The file store is DEV-ONLY (`#[cfg(debug_assertions)]`) — release is
//! unaffected. Android has no keyring backend and stores keys via the
//! frontend bridge (see src/services/secret-store.ts).

// ── Release backend: OS credential store ──
#[cfg(not(debug_assertions))]
mod backend {
    const SERVICE: &str = "com.lilongtao.talkio";

    pub fn set(account: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        entry.set_password(secret).map_err(|e| e.to_string())
    }

    pub fn get(account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

// ── Dev backend: local JSON file (avoids Keychain re-prompt hell) ──
#[cfg(debug_assertions)]
mod backend {
    use std::collections::HashMap;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::Mutex;

    static LOCK: Mutex<()> = Mutex::new(());

    fn path() -> PathBuf {
        std::env::temp_dir().join("talkio-dev-secrets.json")
    }

    fn load() -> Result<HashMap<String, String>, String> {
        match fs::read_to_string(path()) {
            Ok(contents) => serde_json::from_str(&contents).map_err(|e| e.to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(error) => Err(error.to_string()),
        }
    }

    fn persist(map: &HashMap<String, String>) -> Result<(), String> {
        let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
        let secret_path = path();
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(0o600);
            if secret_path.exists() {
                fs::set_permissions(&secret_path, fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
            }
        }
        let mut file = options.open(secret_path).map_err(|e| e.to_string())?;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn set(account: &str, secret: &str) -> Result<(), String> {
        let _guard = LOCK.lock().map_err(|e| e.to_string())?;
        let mut map = load()?;
        map.insert(account.to_string(), secret.to_string());
        persist(&map)
    }

    pub fn get(account: &str) -> Result<Option<String>, String> {
        let _guard = LOCK.lock().map_err(|e| e.to_string())?;
        Ok(load()?.get(account).cloned())
    }

    pub fn delete(account: &str) -> Result<(), String> {
        let _guard = LOCK.lock().map_err(|e| e.to_string())?;
        let mut map = load()?;
        map.remove(account);
        persist(&map)
    }
}

#[tauri::command]
pub fn secret_set(account: String, secret: String) -> Result<(), String> {
    backend::set(&account, &secret)
}

#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    backend::get(&account)
}

#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    backend::delete(&account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_delete_roundtrip() {
        let account = format!("test-account-{}", uuid::Uuid::new_v4());
        secret_set(account.clone(), "sk-test-secret".into()).expect("set should succeed");
        assert_eq!(
            secret_get(account.clone()).unwrap(),
            Some("sk-test-secret".into())
        );
        secret_delete(account.clone()).expect("delete should succeed");
        assert_eq!(secret_get(account).unwrap(), None);
    }

    #[test]
    fn get_missing_returns_none() {
        let account = format!("missing-account-{}", uuid::Uuid::new_v4());
        assert_eq!(secret_get(account).unwrap(), None);
    }

    #[test]
    fn delete_missing_is_ok() {
        let account = format!("missing-account-{}", uuid::Uuid::new_v4());
        secret_delete(account).expect("delete of missing entry should be a no-op");
    }
}
