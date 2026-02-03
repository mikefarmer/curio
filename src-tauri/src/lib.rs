mod files;

use files::{read_file, get_filename};
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::path::PathBuf;

// Counter for unique window IDs
static WINDOW_COUNTER: AtomicUsize = AtomicUsize::new(1);

// Store for CLI file arguments
struct CliFiles(Mutex<Vec<String>>);

/// Get files passed via CLI arguments (called once on startup)
#[tauri::command]
fn get_cli_files(state: tauri::State<CliFiles>) -> Vec<String> {
    let mut files = state.0.lock().unwrap();
    let result = files.clone();
    files.clear(); // Clear after reading so they're only opened once
    result
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

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(CliFiles(Mutex::new(cli_files)))
        .invoke_handler(tauri::generate_handler![
            read_file,
            get_filename,
            create_window,
            get_cli_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Opened { urls } = event {
            // Handle files opened via macOS file association
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if let Some(path_str) = path.to_str() {
                        let file_path = path_str.to_string();
                        let handle = app_handle.clone();

                        // Create a new window for this file
                        tauri::async_runtime::spawn(async move {
                            let window_id = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
                            let label = format!("curio-{}", window_id);
                            let encoded = urlencoding::encode(&file_path);
                            let url = WebviewUrl::App(format!("index.html?file={}", encoded).into());

                            let title = PathBuf::from(&file_path)
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("Curio")
                                .to_string();

                            let _ = WebviewWindowBuilder::new(&handle, &label, url)
                                .title(&title)
                                .inner_size(900.0, 700.0)
                                .min_inner_size(400.0, 300.0)
                                .build();
                        });
                    }
                }
            }
        }
    });
}
