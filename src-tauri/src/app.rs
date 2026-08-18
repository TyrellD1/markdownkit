use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Manager;
use tauri::{AppHandle, Emitter, State};

use crate::markdown::{self, RenderedDocument};

pub struct AppState {
    pub current: Mutex<Option<PathBuf>>,
    pub pending: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    last_emit: Mutex<Instant>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
            pending: Mutex::new(None),
            watcher: Mutex::new(None),
            last_emit: Mutex::new(Instant::now()
                .checked_sub(Duration::from_secs(1))
                .unwrap_or_else(Instant::now)),
        }
    }
}

impl AppState {
    pub fn take_pending(&self) -> Option<PathBuf> {
        self.pending.lock().expect("pending lock").take()
    }

    pub fn set_pending(&self, path: PathBuf) {
        *self.pending.lock().expect("pending lock") = Some(path);
    }

    pub fn set_current(&self, path: PathBuf) {
        *self.current.lock().expect("current lock") = Some(path);
    }
}

#[derive(Clone, Serialize)]
struct FilePayload {
    path: String,
}

pub fn remember_path(app: &AppHandle, path: PathBuf) {
    let state = app.state::<AppState>();
    state.set_pending(path.clone());
    let _ = app.emit(
        "open-file",
        FilePayload {
            path: path.to_string_lossy().into_owned(),
        },
    );
}

pub fn paths_from_urls(urls: impl IntoIterator<Item = tauri::Url>) -> Vec<PathBuf> {
    urls.into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter(|path| path.is_file())
        .collect()
}

pub fn paths_from_cli_args() -> Vec<PathBuf> {
    std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(PathBuf::from)
        .filter(|path| path.is_file() && markdown::is_markdown_path(path))
        .collect()
}

#[tauri::command]
pub fn take_pending_path(state: State<'_, AppState>) -> Option<String> {
    state
        .take_pending()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_document(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<RenderedDocument, String> {
    let path = PathBuf::from(path);
    open_path(&app, &state, path)
}

pub fn open_path(
    app: &AppHandle,
    state: &AppState,
    path: PathBuf,
) -> Result<RenderedDocument, String> {
    if !path.is_file() {
        return Err(format!("File not found: {}", path.display()));
    }
    if !markdown::is_markdown_path(&path) {
        return Err("MarkdownKit opens .md, .markdown, .mdown, and .mkd files.".into());
    }

    let source = std::fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let rendered = markdown::render(&source, &path);

    allow_asset_access(app, &path);
    state.set_current(path.clone());
    watch_current_file(app, state, path)?;
    Ok(rendered)
}

fn allow_asset_access(app: &AppHandle, path: &Path) {
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_file(path);
    if let Some(parent) = path.parent() {
        let _ = scope.allow_directory(parent, true);
    }
}

fn watch_current_file(app: &AppHandle, state: &AppState, path: PathBuf) -> Result<(), String> {
    let watch_root = path.parent().unwrap_or(&path).to_path_buf();
    let watched = path.clone();
    let handle = app.clone();

    let mut watcher = notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        let Ok(event) = result else {
            return;
        };
        if !matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        ) {
            return;
        }
        let matches_file = event.paths.iter().any(|changed| {
            changed == &watched || changed.file_name() == watched.file_name()
        });
        if !matches_file {
            return;
        }

        let state = handle.state::<AppState>();
        let mut last = state.last_emit.lock().expect("debounce lock");
        let now = Instant::now();
        if now.duration_since(*last) < Duration::from_millis(160) {
            return;
        }
        *last = now;
        drop(last);

        let _ = handle.emit(
            "file-changed",
            FilePayload {
                path: watched.to_string_lossy().into_owned(),
            },
        );
    })
    .map_err(|err| err.to_string())?;

    watcher
        .watch(&watch_root, RecursiveMode::NonRecursive)
        .map_err(|err| err.to_string())?;

    *state.watcher.lock().expect("watcher lock") = Some(watcher);
    Ok(())
}

pub fn build_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let app_menu = Submenu::with_items(
        app,
        "MarkdownKit",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About MarkdownKit"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu])
}
