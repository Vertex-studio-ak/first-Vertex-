use serde::{Serialize, Deserialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewWindowBuilder, WebviewUrl, Emitter};
use uuid::Uuid;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
use futures_util::StreamExt;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadItem {
    pub id: String,
    pub name: String,
    pub url: String,
    pub path: Option<String>,
    pub total_bytes: Option<u64>,
    pub downloaded_bytes: u64,
    pub status: String, // "Started", "Progress", "Finished", "Cancelled", "Error"
    pub started_at: u64,
}

pub struct DownloadState(pub Arc<Mutex<Vec<DownloadItem>>>);

impl DownloadState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(Vec::new())))
    }
}

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    url: String,
    suggested_filename: Option<String>,
    state: tauri::State<'_, DownloadState>
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let filename = suggested_filename.unwrap_or_else(|| {
        url.split('/').last().unwrap_or("download").to_string()
    });

    let download_dir = dirs::download_dir().ok_or("Could not find download directory")?;
    let path = download_dir.join(&filename);
    let path_str = path.to_string_lossy().to_string();

    let item = DownloadItem {
        id: id.clone(),
        name: filename.clone(),
        url: url.clone(),
        path: Some(path_str.clone()),
        total_bytes: None,
        downloaded_bytes: 0,
        status: "Started".to_string(),
        started_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
    };

    {
        let mut items = state.0.lock().unwrap();
        items.push(item.clone());
    }

    let _ = app.emit("download-update", item.clone());

    let state_clone = state.0.clone();
    let app_clone = app.clone();
    let id_clone = id.clone();

    tokio::spawn(async move {
        match download_task(app_clone, url, path, state_clone, id_clone).await {
            Ok(_) => {}
            Err(e) => {
                // Handle error status
                println!("Download error: {}", e);
            }
        }
    });

    Ok(id)
}

async fn download_task(
    app: AppHandle,
    url: String,
    path: PathBuf,
    state: Arc<Mutex<Vec<DownloadItem>>>,
    id: String
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    
    let total_bytes = response.content_length();
    
    {
        let mut items = state.lock().unwrap();
        if let Some(item) = items.iter_mut().find(|i| i.id == id) {
            item.total_bytes = total_bytes;
        }
    }

    let mut file = tokio::fs::File::create(&path).await.map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    while let Some(item_res) = stream.next().await {
        let chunk = item_res.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        // Check for cancellation
        {
            let items = state.lock().unwrap();
            if let Some(item) = items.iter().find(|i| i.id == id) {
                if item.status == "Cancelled" {
                    return Ok(());
                }
            }
        }

        // Throttle emits to avoid flooding the frontend (every 200ms or so)
        if last_emit.elapsed().as_millis() > 200 {
            let mut items = state.lock().unwrap();
            if let Some(item) = items.iter_mut().find(|i| i.id == id) {
                item.downloaded_bytes = downloaded;
                item.status = "Progress".to_string();
                let _ = app.emit("download-update", item.clone());
            }
            last_emit = std::time::Instant::now();
        }
    }

    // Finish
    {
        let mut items = state.lock().unwrap();
        if let Some(item) = items.iter_mut().find(|i| i.id == id) {
            item.downloaded_bytes = downloaded;
            item.status = "Finished".to_string();
            let _ = app.emit("download-update", item.clone());
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn open_downloads_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("downloads") {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let _win = WebviewWindowBuilder::new(&app, "downloads", WebviewUrl::App("downloads.html".into()))
        .title("Downloads - Vertex")
        .inner_size(400.0, 500.0)
        .resizable(true)
        .always_on_top(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn get_downloads(state: tauri::State<'_, DownloadState>) -> Vec<DownloadItem> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn cancel_download(id: String, state: tauri::State<'_, DownloadState>) {
    let mut items = state.0.lock().unwrap();
    if let Some(item) = items.iter_mut().find(|i| i.id == id) {
        item.status = "Cancelled".to_string();
    }
}

#[tauri::command]
pub fn open_download_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .arg("/select,")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
