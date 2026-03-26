use crate::{bookmarks, history, session, adblocker, passwords, plugins};
use bookmarks::Bookmark;
use history::HistoryEntry;
use session::{Session, SessionTab};
use std::process::Command;
#[cfg(windows)]
use winreg::{enums::*, RegKey};


// ─── Bookmark Commands ────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_bookmarks() -> Vec<Bookmark> {
    bookmarks::load()
}

#[tauri::command]
pub fn add_bookmark(title: String, url: String) -> Bookmark {
    bookmarks::add(title, url)
}

#[tauri::command]
pub fn remove_bookmark(id: String) {
    bookmarks::remove(&id)
}

#[tauri::command]
pub fn search_bookmarks(query: String) -> Vec<Bookmark> {
    bookmarks::search(&query)
}

// ─── History Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_history() -> Vec<HistoryEntry> {
    history::load()
}

#[tauri::command]
pub fn add_history(title: String, url: String) {
    history::add(title, url)
}

#[tauri::command]
pub fn search_history(query: String) -> Vec<HistoryEntry> {
    history::search(&query)
}

#[tauri::command]
pub fn clear_history() {
    history::clear()
}

// ─── Session Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn save_session(tabs: Vec<SessionTab>, active_index: usize) {
    let session = Session { tabs, active_index };
    session::save(&session)
}

#[tauri::command]
pub fn load_session() -> Option<Session> {
    session::load()
}

// ─── AdBlock Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn check_adblock(url: String, source_url: String, resource_type: String) -> bool {
    crate::adblocker::should_block(url, source_url, resource_type).await
}

// ─── Settings Commands ────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_settings() -> serde_json::Value {
    let path = get_settings_path();
    if !path.exists() {
        return default_settings();
    }
    let data = std::fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str(&data).unwrap_or_else(|_| default_settings())
}

#[tauri::command]
pub fn save_settings(settings: serde_json::Value) {
    let path = get_settings_path();
    let json = serde_json::to_string_pretty(&settings).unwrap_or_default();
    std::fs::write(path, json).ok();
}

fn get_settings_path() -> std::path::PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    path.push("brauser");
    std::fs::create_dir_all(&path).ok();
    path.push("settings.json");
    path
}

fn default_settings() -> serde_json::Value {
    serde_json::json!({
        "theme": "dark",
        "search_engine": "https://duckduckgo.com/?q=",
        "home_page": "vertex://newtab",
        "adblock_enabled": true,
        "show_bookmarks_bar": true,
        "onboarding_completed": false,
    })
}

// ─── Webview Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn webview_go_back(app: tauri::AppHandle, id: String) {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(&id) {
        let _ = wv.eval("window.history.back()");
    }
}

#[tauri::command]
pub fn webview_go_forward(app: tauri::AppHandle, id: String) {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(&id) {
        let _ = wv.eval("window.history.forward()");
    }
}

#[tauri::command]
pub fn webview_reload(app: tauri::AppHandle, id: String) {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(&id) {
        let _ = wv.eval("location.reload()");
    }
}

#[tauri::command]
pub fn webview_get_url(app: tauri::AppHandle, id: String) -> Option<String> {
    use tauri::Manager;
    app.get_webview(&id).and_then(|wv| wv.url().map(|u| u.to_string()).ok())
}

#[tauri::command]
pub fn webview_navigate(app: tauri::AppHandle, id: String, url: String) {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(&id) {
        let script = format!("location.href = '{}';", url.replace('\'', "\\'"));
        let _ = wv.eval(&script);
    }
}

#[tauri::command]
pub fn webview_eval(app: tauri::AppHandle, id: String, script: String) {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(&id) {
        let _ = wv.eval(&script);
    }
}


// ─── Password Manager Vault Commands ─────────────────────────────────────────

use crate::passwords::{VaultEntryPublic, VaultState, generate_password};
pub type VaultMutex = std::sync::Mutex<VaultState>;

/// Returns true if the vault has been set up with a master password
#[tauri::command]
pub fn vault_is_setup(vault: tauri::State<VaultMutex>) -> bool {
    vault.lock().unwrap().is_setup()
}

/// Returns true if the vault is currently locked
#[tauri::command]
pub fn vault_is_locked(vault: tauri::State<VaultMutex>) -> bool {
    vault.lock().unwrap().is_locked()
}

/// First-time setup — create a master password and initialise the vault
#[tauri::command]
pub fn vault_setup(vault: tauri::State<VaultMutex>, master_pw: String) -> Result<(), String> {
    vault.lock().unwrap().setup(&master_pw)
}

/// Unlock with master password — returns true if correct
#[tauri::command]
pub fn vault_unlock(vault: tauri::State<VaultMutex>, master_pw: String) -> Result<bool, String> {
    vault.lock().unwrap().unlock(&master_pw)
}

/// Lock the vault (clears the key from memory)
#[tauri::command]
pub fn vault_lock(vault: tauri::State<VaultMutex>) {
    vault.lock().unwrap().lock();
}

/// Get all decrypted entries (only works when unlocked)
#[tauri::command]
pub fn vault_get_entries(vault: tauri::State<VaultMutex>) -> Result<Vec<VaultEntryPublic>, String> {
    vault.lock().unwrap().get_entries()
}

/// Add a new encrypted entry to the vault
#[tauri::command]
pub fn vault_add_entry(
    vault: tauri::State<VaultMutex>,
    title: String, url: String, username: String, password: String,
) -> Result<VaultEntryPublic, String> {
    vault.lock().unwrap().add_entry(&title, &url, &username, &password)
}

/// Delete an entry by ID
#[tauri::command]
pub fn vault_delete_entry(vault: tauri::State<VaultMutex>, id: String) -> Result<(), String> {
    vault.lock().unwrap().delete_entry(&id)
}

#[tauri::command]
pub fn vault_generate_password(length: usize, symbols: bool) -> String {
    passwords::generate_password(length, symbols)
}

#[tauri::command]
pub async fn get_initial_url(initial_url: tauri::State<'_, std::sync::Mutex<Option<String>>>) -> Result<Option<String>, String> {
    let mut lock = initial_url.lock().map_err(|_| "Failed to lock initial URL")?;
    Ok(lock.take())
}

#[tauri::command]
pub async fn register_as_default_browser() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::env;
        let exe_path = env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe_path.to_str().ok_or("Invalid exe path")?;
        let exe_quoted = format!("\"{}\"", exe_str);
        
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        
        // Register as a Client
        let (client_key, _) = hkcu.create_subkey(r"Software\Clients\StartMenuInternet\Vertex")
            .map_err(|e| format!("Registry error (client): {}", e))?;
        client_key.set_value("", &"Vertex").map_err(|e| e.to_string())?;
        
        let (cap_key, _) = client_key.create_subkey("Capabilities")
            .map_err(|e| e.to_string())?;
        cap_key.set_value("ApplicationDescription", &"Advanced minimal browser").map_err(|e| e.to_string())?;
        cap_key.set_value("ApplicationIcon", &format!("{},0", exe_str)).map_err(|e| e.to_string())?;
        cap_key.set_value("ApplicationName", &"Vertex").map_err(|e| e.to_string())?;
        
        let (assoc_key, _) = cap_key.create_subkey("URLAssociations")
            .map_err(|e| e.to_string())?;
        assoc_key.set_value("http", &"VertexHTML").map_err(|e| e.to_string())?;
        assoc_key.set_value("https", &"VertexHTML").map_err(|e| e.to_string())?;
        
        let (shell_key, _) = client_key.create_subkey(r"shell\open\command")
            .map_err(|e| e.to_string())?;
        shell_key.set_value("", &exe_quoted).map_err(|e| e.to_string())?;

        // Register ProgID
        let (prog_key, _) = hkcu.create_subkey(r"Software\Classes\VertexHTML")
            .map_err(|e| e.to_string())?;
        prog_key.set_value("", &"Vertex HTML Document").map_err(|e| e.to_string())?;
        let (prog_icon, _) = prog_key.create_subkey("DefaultIcon")
            .map_err(|e| e.to_string())?;
        prog_icon.set_value("", &format!("{},0", exe_str)).map_err(|e| e.to_string())?;
        let (prog_shell, _) = prog_key.create_subkey(r"shell\open\command")
             .map_err(|e| e.to_string())?;
        prog_shell.set_value("", &format!("{} \"%1\"", exe_quoted)).map_err(|e| e.to_string())?;

        // 3. Register in RegisteredApplications
        let (reg_apps, _) = hkcu.create_subkey(r"Software\RegisteredApplications")
            .map_err(|e| e.to_string())?;
        reg_apps.set_value("Vertex", &r"Software\Clients\StartMenuInternet\Vertex\Capabilities").map_err(|e| e.to_string())?;

        // 4. Open Windows Default Apps Settings
        let _ = Command::new("cmd")
            .args(&["/C", "start ms-settings:defaultapps"])
            .spawn();
            
        Ok(())
    }
    
    #[cfg(not(windows))]
    {
        Err("Default browser setting is currently only supported on Windows".into())
    }
}

#[tauri::command]
pub fn check_is_default_browser() -> bool {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey(r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice") {
            if let Ok(prog_id) = key.get_value::<String, _>("ProgId") {
                return prog_id == "VertexHTML";
            }
        }
    }
    false
}

#[tauri::command]
pub async fn pin_to_taskbar() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::env;
        let exe_path = env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe_path.to_str().ok_or("Invalid exe path")?;
        
        // PowerShell script to pin to taskbar
        // Note: This is a best-effort approach as Windows restricts this
        let script = format!(
            "$shell = New-Object -ComObject Shell.Application; \
             $folder = $shell.NameSpace((Split-Path '{}')); \
             $item = $folder.ParseName((Split-Path '{}' -Leaf)); \
             $verb = $item.Verbs() | Where-Object {{ $_.Name -replace '&' -match 'Pin to taskbar' }}; \
             if ($verb) {{ $verb.DoIt() }}",
            exe_str, exe_str
        );

        Command::new("powershell")
            .args(&["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .spawn()
            .map_err(|e| e.to_string())?;
            
        Ok(())
    }
    
    #[cfg(not(windows))]
    {
        Err("Taskbar pinning is currently only supported on Windows".into())
    }
}
// ─── Plugin (Extension) Commands ─────────────────────────────────────────────

#[tauri::command]
pub fn get_plugins() -> Vec<plugins::Extension> {
    plugins::load_all()
}

#[tauri::command]
pub fn save_plugin(plugin: plugins::Extension) -> Result<(), String> {
    plugins::save(&plugin)
}

#[tauri::command]
pub fn remove_plugin(id: String) -> Result<(), String> {
    plugins::remove(&id)
}
