// Session save/restore — persists tab URLs between browser restarts
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTab {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub tabs: Vec<SessionTab>,
    pub active_index: usize,
}

fn session_path() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("brauser");
    fs::create_dir_all(&path).ok();
    path.push("session.json");
    path
}

pub fn save(session: &Session) {
    let path = session_path();
    let json = serde_json::to_string_pretty(session).unwrap_or_default();
    fs::write(path, json).ok();
}

pub fn load() -> Option<Session> {
    let path = session_path();
    if !path.exists() {
        return None;
    }
    let data = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}
