mod app;
mod markdown;

use tauri::Emitter;

use crate::app::{
    build_menu, open_document, paths_from_cli_args, paths_from_urls, remember_path,
    take_pending_path, AppState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![open_document, take_pending_path])
        .setup(|app| {
            app.set_menu(build_menu(app)?)?;

            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                if event.id() == "open" {
                    let _ = handle.emit("menu-open", ());
                }
            });

            for path in paths_from_cli_args() {
                remember_path(app.handle(), path);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building MarkdownKit")
        .run(|app, event| {
            if let tauri::RunEvent::Opened { urls } = event {
                for path in paths_from_urls(urls) {
                    remember_path(app, path);
                }
            }
        });
}
