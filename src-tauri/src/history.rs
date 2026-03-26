// History tracking with persistence
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;
use chrono::Utc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub title: String,
    pub url: String,
    pub visited_at: String,
}

fn history_path() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("brauser");
    fs::create_dir_all(&path).ok();
    path.push("history.json");
    path
}

pub fn load() -> Vec<HistoryEntry> {
    let path = history_path();
    if !path.exists() {
        return vec![];
    }
    let data = fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str(&data).unwrap_or_default()
}

fn save(entries: &[HistoryEntry]) {
    let path = history_path();
    let json = serde_json::to_string_pretty(entries).unwrap_or_default();
    fs::write(path, json).ok();
}

/// Record a page visit
pub fn add(title: String, url: String) {
    let mut list = load();
    // Remove duplicate URL if already present
    list.retain(|h| h.url != url);
    let entry = HistoryEntry {
        id: Uuid::new_v4().to_string(),
        title,
        url,
        visited_at: Utc::now().to_rfc3339(),
    };
    // Prepend most recent
    list.insert(0, entry);
    // Keep last 1000 entries
    list.truncate(1000);
    save(&list);
}

/// Search history by title or url
pub fn search(query: &str) -> Vec<HistoryEntry> {
    let q = query.to_lowercase();
    load()
        .into_iter()
        .filter(|h| h.title.to_lowercase().contains(&q) || h.url.to_lowercase().contains(&q))
        .take(20)
        .collect()
}

/// Clear all history
pub fn clear() {
    save(&[]);
}
