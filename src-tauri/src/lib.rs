mod app;

use tauri::Emitter;

use crate::app::{
    build_menu, copy_current_path, open_document, paths_from_cli_args, paths_from_urls,
    remember_path, reveal_in_finder, set_always_on_top, set_live_reload, take_pending_path,
    check_for_update, AppState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_document,
            take_pending_path,
            set_live_reload,
            set_always_on_top,
            check_for_update,
            reveal_in_finder,
            copy_current_path
        ])
        .setup(|app| {
            app.set_menu(build_menu(app)?)?;

            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str();
                match id {
                    "open" | "settings" | "back" | "forward" | "reveal" | "copy-path" => {
                        let _ = handle.emit("menu", id);
                    }
                    _ => {}
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
