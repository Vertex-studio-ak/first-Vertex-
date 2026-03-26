// lib.rs — Tauri 2 requires this file to expose the run() function
// for mobile platforms and testing. Desktop uses main.rs which calls this.

mod adblocker;
mod bookmarks;
mod commands;
mod history;
mod passwords;
mod session;
mod downloads;
mod plugins;


use commands::*;
use tauri::{Emitter, Manager};



#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(initial_url: Option<String>) {

    // Initialize adblock engine once at startup
    adblocker::init();

    let vault = std::sync::Mutex::new(
        passwords::VaultState::new(passwords::vault_path())
    );
    let initial_url_state = std::sync::Mutex::new(initial_url);
    let download_state = downloads::DownloadState::new();



    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let url = args.get(1).filter(|s| s.starts_with("http") || s.contains("://")).cloned();
            if let Some(u) = url {
                let _ = app.emit("open-url", u);
            }
        }))
        .manage(vault)
        .manage(initial_url_state)
        .manage(download_state)
        .setup(|app| {
            Ok(())
        })







        .invoke_handler(tauri::generate_handler![
            // Bookmarks
            get_bookmarks,
            add_bookmark,
            remove_bookmark,
            search_bookmarks,
            // History
            get_history,
            add_history,
            search_history,
            clear_history,
            // Session
            save_session,
            load_session,
            // AdBlock
            check_adblock,
            // Settings
            get_settings,
            save_settings,
            // Webview
            webview_go_back,
            webview_go_forward,
            webview_reload,
            webview_get_url,
            webview_navigate,
            webview_eval,
            // Vault (Password Manager)
            vault_is_setup,
            vault_is_locked,
            vault_setup,
            vault_unlock,
            vault_lock,
            vault_get_entries,
            vault_add_entry,
            vault_delete_entry,
            vault_generate_password,
            // Default Browser
            register_as_default_browser,
            get_initial_url,
            // Downloads
            downloads::get_downloads,
            downloads::start_download,
            downloads::cancel_download,
            downloads::open_download_folder,
            downloads::open_downloads_window,
            // Plugins
            get_plugins,
            save_plugin,
            remove_plugin,
            // Onboarding
            check_is_default_browser,
            pin_to_taskbar,
        ])


        .run(tauri::generate_context!())
        .expect("error while running vertex");
}

