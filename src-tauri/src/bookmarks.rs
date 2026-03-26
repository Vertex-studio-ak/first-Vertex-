// Bookmark data structures and persistence
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;
use chrono::Utc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub title: String,
    pub url: String,
    pub favicon: Option<String>,
    pub created_at: String,
}

/// Returns path to bookmarks.json in user's data dir
fn bookmarks_path() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("brauser");
    fs::create_dir_all(&path).ok();
    path.push("bookmarks.json");
    path
}

/// Load all bookmarks from disk
pub fn load() -> Vec<Bookmark> {
    let path = bookmarks_path();
    if !path.exists() {
        return vec![];
    }
    let data = fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str(&data).unwrap_or_default()
}

/// Save bookmarks list to disk
fn save(bookmarks: &[Bookmark]) {
    let path = bookmarks_path();
    let json = serde_json::to_string_pretty(bookmarks).unwrap_or_default();
    fs::write(path, json).ok();
}

/// Add a new bookmark, returns uuid
pub fn add(title: String, url: String) -> Bookmark {
    let mut list = load();
    let bookmark = Bookmark {
        id: Uuid::new_v4().to_string(),
        title,
        url,
        favicon: None,
        created_at: Utc::now().to_rfc3339(),
    };
    list.push(bookmark.clone());
    save(&list);
    bookmark
}

/// Remove bookmark by id
pub fn remove(id: &str) {
    let mut list = load();
    list.retain(|b| b.id != id);
    save(&list);
}

/// Search bookmarks by title or url
pub fn search(query: &str) -> Vec<Bookmark> {
    let q = query.to_lowercase();
    load()
        .into_iter()
        .filter(|b| b.title.to_lowercase().contains(&q) || b.url.to_lowercase().contains(&q))
        .collect()
}
