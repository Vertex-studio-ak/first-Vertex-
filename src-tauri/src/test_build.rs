use tauri::WebviewEvent;

fn test() {
    let e = WebviewEvent::DragDrop(tauri::DragDropEvent::Cancelled);
    match e {
        WebviewEvent::Navigation(_) => {},
        _ => {}
    }
}
