// main.rs — Desktop entry point for Brauser
// Tauri 2 pattern: all logic lives in lib.rs, main.rs just calls run()
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Capture the first URL argument if present
    let args: Vec<String> = std::env::args().collect();
    let initial_url = args.get(1).filter(|s| s.starts_with("http") || s.contains("://")).cloned();

    // Pass site-isolation and memory flags to WebView2
    let flags = "--disable-site-isolation-trials --renderer-process-limit=2 --js-flags='--lite-mode'";
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", flags);

    // Run the app with the initial URL if any
    vertex_lib::run(initial_url);
}

