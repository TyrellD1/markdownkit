use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Manager;
use tauri::{AppHandle, Emitter, State};

use markdownkit_engine::{self as markdown, RenderedDocument};

pub struct AppState {
    pub current: Mutex<Option<PathBuf>>,
    pub pending: Mutex<Option<PathBuf>>,
    live_reload: Mutex<bool>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    last_emit: Mutex<Instant>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
            pending: Mutex::new(None),
            live_reload: Mutex::new(true),
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

    fn current_path(&self) -> Result<PathBuf, String> {
        self.current
            .lock()
            .expect("current lock")
            .clone()
            .ok_or_else(|| "Open a markdown file first.".into())
    }

    fn live_reload_enabled(&self) -> bool {
        *self.live_reload.lock().expect("live reload lock")
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
    apply_watch(app, state, path)?;
    Ok(rendered)
}

#[tauri::command]
pub fn set_live_reload(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    *state.live_reload.lock().expect("live reload lock") = enabled;
    let current = state.current.lock().expect("current lock").clone();
    match current {
        Some(path) => apply_watch(&app, &state, path),
        None => {
            *state.watcher.lock().expect("watcher lock") = None;
            Ok(())
        }
    }
}

#[tauri::command]
pub fn set_always_on_top(app: AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Window not found.".to_string())?;
    window
        .set_always_on_top(enabled)
        .map_err(|err| err.to_string())
}

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
}

#[tauri::command]
pub async fn check_for_update() -> Result<Option<UpdateInfo>, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        markdownkit_update::check(env!("CARGO_PKG_VERSION"))
    })
    .await
    .map_err(|err| err.to_string())?;

    match result {
        Ok(Some(latest)) => Ok(Some(UpdateInfo {
            version: latest.version,
            url: latest.html_url,
        })),
        Ok(None) | Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn reveal_in_finder(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.current_path()?;
    let status = Command::new("open")
        .args(["-R", &path.to_string_lossy()])
        .status()
        .map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not reveal the file in Finder.".into())
    }
}

#[tauri::command]
pub fn copy_current_path(state: State<'_, AppState>) -> Result<String, String> {
    let path = state.current_path()?;
    let text = path.to_string_lossy().into_owned();
    let mut child = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|err| err.to_string())?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Could not copy the path.".to_string())?;
        stdin
            .write_all(text.as_bytes())
            .map_err(|err| err.to_string())?;
    }
    child.wait().map_err(|err| err.to_string())?;
    Ok(text)
}

fn allow_asset_access(app: &AppHandle, path: &Path) {
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_file(path);
    if let Some(parent) = path.parent() {
        let _ = scope.allow_directory(parent, true);
    }
}

fn apply_watch(app: &AppHandle, state: &AppState, path: PathBuf) -> Result<(), String> {
    if !state.live_reload_enabled() {
        *state.watcher.lock().expect("watcher lock") = None;
        return Ok(());
    }
    watch_current_file(app, state, path)
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
        if !state.live_reload_enabled() {
            return;
        }
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
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let open = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let reveal = MenuItem::with_id(app, "reveal", "Open in Finder", true, Some("CmdOrCtrl+Alt+R"))?;
    let copy_path =
        MenuItem::with_id(app, "copy-path", "Copy File Path", true, Some("CmdOrCtrl+Shift+C"))?;
    let back = MenuItem::with_id(app, "back", "Back", true, Some("CmdOrCtrl+["))?;
    let forward = MenuItem::with_id(app, "forward", "Forward", true, Some("CmdOrCtrl+]"))?;
    let app_menu = Submenu::with_items(
        app,
        "MarkdownKit",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About MarkdownKit"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
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
            &reveal,
            &copy_path,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(app, "View", true, &[&back, &forward])?;
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
    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu])
}
