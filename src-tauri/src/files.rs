use std::fs;
use std::path::Path;

/// Read a file's contents as a string
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let file_path = Path::new(&path);

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    fs::read_to_string(file_path)
        .map_err(|e| format!("Failed to read file: {}", e))
}

/// Get the filename from a path
#[tauri::command]
pub fn get_filename(path: String) -> String {
    Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled")
        .to_string()
}
