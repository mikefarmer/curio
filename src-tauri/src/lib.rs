mod files;
mod annotations;

use files::{read_file, get_filename};
use annotations::{
    read_sidecar, write_sidecar, delete_sidecar, list_sidecars,
    write_md_atomic, write_file_new, read_curio_config, write_curio_config,
};
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::path::PathBuf;

// Counter for unique window IDs
static WINDOW_COUNTER: AtomicUsize = AtomicUsize::new(1);

// Store for CLI file arguments
struct CliFiles(Mutex<Vec<String>>);

// Buffer for files delivered via macOS file association (RunEvent::Opened).
// Drained by the frontend on mount via `take_pending_opens` to handle the
// race where Opened fires before the first window has registered its listener.
struct PendingOpens(Mutex<Vec<String>>);

/// Get files passed via CLI arguments (called once on startup)
#[tauri::command]
fn get_cli_files(state: tauri::State<CliFiles>) -> Vec<String> {
    let mut files = state.0.lock().unwrap();
    let result = files.clone();
    files.clear(); // Clear after reading so they're only opened once
    result
}

/// Drain any file-association opens that arrived before the frontend mounted.
#[tauri::command]
fn take_pending_opens(state: tauri::State<PendingOpens>) -> Vec<String> {
    let mut files = state.0.lock().unwrap();
    let result = files.clone();
    files.clear();
    result
}

/// Write a log message to file for debugging production builds
#[tauri::command]
fn write_log(message: String) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::Write;

    let log_path = dirs::home_dir()
        .ok_or("Could not find home directory")?
        .join(".curio_debug.log");

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|e| e.to_string())?;

    writeln!(file, "[{}] {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"), message)
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Create a new window, optionally with a file path to load
#[tauri::command]
async fn create_window(app: tauri::AppHandle, file_path: Option<String>) -> Result<String, String> {
    let window_id = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
    let label = format!("curio-{}", window_id);

    // Build URL with optional file path query parameter
    let url = match &file_path {
        Some(path) => {
            let encoded = urlencoding::encode(path);
            WebviewUrl::App(format!("index.html?file={}", encoded).into())
        }
        None => WebviewUrl::App("index.html".into())
    };

    let title = match &file_path {
        Some(path) => {
            PathBuf::from(path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Curio")
                .to_string()
        }
        None => "Curio".to_string()
    };

    WebviewWindowBuilder::new(&app, &label, url)
        .title(&title)
        .inner_size(900.0, 700.0)
        .min_inner_size(400.0, 300.0)
        .build()
        .map_err(|e| format!("Failed to create window: {}", e))?;

    Ok(label)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Collect CLI arguments (skip the first one which is the program name)
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Filter to only existing files with markdown extensions
    let cli_files: Vec<String> = args
        .into_iter()
        .filter(|arg| {
            let path = PathBuf::from(arg);
            if !path.exists() {
                return false;
            }
            match path.extension().and_then(|e| e.to_str()) {
                Some(ext) => matches!(ext.to_lowercase().as_str(),
                    "md" | "markdown" | "mdown" | "mkd" | "mkdown"),
                None => false,
            }
        })
        .map(|arg| {
            // Convert to absolute path
            std::fs::canonicalize(&arg)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(arg)
        })
        .collect();

    // Run sidecar GC on startup (best effort; never blocks startup on errors)
    annotations::run_gc();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(CliFiles(Mutex::new(cli_files)))
        .manage(PendingOpens(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![
            read_file,
            get_filename,
            create_window,
            get_cli_files,
            take_pending_opens,
            write_log,
            read_sidecar,
            write_sidecar,
            delete_sidecar,
            list_sidecars,
            write_md_atomic,
            write_file_new,
            read_curio_config,
            write_curio_config
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Opened { urls } = event {
            // Files opened via macOS file association. We do NOT spawn a window
            // here — the default window already exists (or another window is
            // visible). Instead we hand the path to the frontend, which decides
            // whether to load it in the current empty window or spawn a new one.
            //
            // Buffer in PendingOpens to cover the cold-launch race where this
            // event fires before any frontend has registered an `open-file`
            // listener. The frontend drains the buffer in onMounted.
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if let Some(path_str) = path.to_str() {
                        let file_path = path_str.to_string();

                        if let Some(state) = app_handle.try_state::<PendingOpens>() {
                            state.0.lock().unwrap().push(file_path.clone());
                        }
                        // Emit to exactly one window — preferring "main", else
                        // any existing window — so multi-window setups don't
                        // race to handle the same open.
                        let windows = app_handle.webview_windows();
                        let target = windows.get("main").cloned()
                            .or_else(|| windows.values().next().cloned());
                        if let Some(win) = target {
                            let _ = win.emit("open-file", file_path);
                        }
                    }
                }
            }
        }
    });
}
