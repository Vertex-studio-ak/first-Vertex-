use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Extension {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub script: String, // JS code
    pub style: Option<String>, // Optional CSS
}

pub fn get_plugins_dir() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("brauser");
    path.push("plugins");
    fs::create_dir_all(&path).ok();
    path
}

pub fn load_all() -> Vec<Extension> {
    let dir = get_plugins_dir();
    let mut plugins = Vec::new();

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(plugin) = serde_json::from_str::<Extension>(&content) {
                        plugins.push(plugin);
                    }
                }
            }
        }
    }
    plugins
}

pub fn save(plugin: &Extension) -> Result<(), String> {
    let mut path = get_plugins_dir();
    path.push(format!("{}.json", plugin.id));
    let json = serde_json::to_string_pretty(plugin).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove(id: &str) -> Result<(), String> {
    let mut path = get_plugins_dir();
    path.push(format!("{}.json", id));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
