use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use serde_json::Value;

const GC_GRACE_DAYS: i64 = 30;

/// Resolve the ~/.curio/ directory, creating it if needed.
fn curio_dir() -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".curio");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create ~/.curio/: {}", e))?;
    }
    Ok(dir)
}

fn sidecar_path(uuid: &str) -> Result<PathBuf, String> {
    // Defensive: reject UUIDs containing path separators or oddities.
    if uuid.is_empty() || uuid.contains('/') || uuid.contains('\\') || uuid.contains("..") {
        return Err(format!("Invalid sidecar UUID: {}", uuid));
    }
    Ok(curio_dir()?.join(format!("{}.json", uuid)))
}

fn config_path() -> Result<PathBuf, String> {
    Ok(curio_dir()?.join("config.json"))
}

fn debug_log_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".curio_debug.log"))
}

fn log_line(msg: &str) {
    if let Some(p) = debug_log_path() {
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(
                f,
                "[{}] [Annotate] {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                msg
            );
        }
    }
}

/// Atomic write: write to .tmp then rename. Renames are atomic on POSIX
/// within the same filesystem.
fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension(
        format!("{}.tmp", path.extension().and_then(|s| s.to_str()).unwrap_or("")),
    );
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| format!("Failed to create temp file {:?}: {}", tmp, e))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("Failed to write temp file: {}", e))?;
        f.sync_all().map_err(|e| format!("Failed to fsync: {}", e))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("Failed to rename temp file: {}", e))?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Sidecar IPC
// ────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn read_sidecar(uuid: String) -> Result<Option<Value>, String> {
    let path = sidecar_path(&uuid)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read sidecar {:?}: {}", path, e))?;
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse sidecar {:?}: {}", path, e))?;
    Ok(Some(parsed))
}

#[tauri::command]
pub fn write_sidecar(uuid: String, data: Value) -> Result<(), String> {
    let path = sidecar_path(&uuid)?;
    let serialized = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize sidecar: {}", e))?;
    atomic_write(&path, &serialized)?;
    log_line(&format!("sidecar write uuid={}", uuid));
    Ok(())
}

#[tauri::command]
pub fn delete_sidecar(uuid: String) -> Result<(), String> {
    let path = sidecar_path(&uuid)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete sidecar: {}", e))?;
        log_line(&format!("sidecar delete uuid={}", uuid));
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct SidecarSummary {
    pub uuid: String,
    pub path: Option<String>,
    pub missing_since: Option<String>,
}

#[tauri::command]
pub fn list_sidecars() -> Result<Vec<SidecarSummary>, String> {
    let dir = curio_dir()?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read ~/.curio/: {}", e))?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let stem = match p.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if stem == "config" {
            continue;
        }
        let parsed: Option<Value> = fs::read_to_string(&p)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        let (path, missing_since) = match parsed {
            Some(v) => (
                v.get("path").and_then(|x| x.as_str()).map(|s| s.to_string()),
                v.get("missing_since").and_then(|x| x.as_str()).map(|s| s.to_string()),
            ),
            None => (None, None),
        };
        out.push(SidecarSummary { uuid: stem, path, missing_since });
    }
    Ok(out)
}

// ────────────────────────────────────────────────────────────────────────────
// File write with timestamp (for self-write suppression coordination)
// ────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn write_md_atomic(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    atomic_write(p, &content)?;
    log_line(&format!("md write path={}", path));
    Ok(())
}

/// Write a new file (used by Export Final). Atomic write, will overwrite if it exists.
#[tauri::command]
pub fn write_file_new(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            return Err(format!("Parent directory does not exist: {:?}", parent));
        }
    }
    atomic_write(p, &content)?;
    log_line(&format!("file write path={}", path));
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn read_curio_config() -> Result<Value, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse config: {}", e))
}

#[tauri::command]
pub fn write_curio_config(data: Value) -> Result<(), String> {
    let path = config_path()?;
    let serialized = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    atomic_write(&path, &serialized)?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Garbage collection (called once at startup)
// ────────────────────────────────────────────────────────────────────────────

pub fn run_gc() {
    let dir = match curio_dir() {
        Ok(d) => d,
        Err(e) => {
            log_line(&format!("gc skipped: {}", e));
            return;
        }
    };
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => {
            log_line(&format!("gc skipped: {}", e));
            return;
        }
    };

    let now = chrono::Utc::now();

    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let stem = match p.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if stem == "config" {
            continue;
        }

        let raw = match fs::read_to_string(&p) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut parsed: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let md_path_str = parsed.get("path").and_then(|v| v.as_str()).map(|s| s.to_string());
        let md_exists = md_path_str
            .as_deref()
            .map(|s| Path::new(s).exists())
            .unwrap_or(false);

        if md_exists {
            // Clear missing_since if set
            if !parsed.get("missing_since").map(|v| v.is_null()).unwrap_or(true) {
                parsed["missing_since"] = Value::Null;
                if let Ok(s) = serde_json::to_string_pretty(&parsed) {
                    let _ = atomic_write(&p, &s);
                }
            }
            continue;
        }

        // Path missing
        let missing_since = parsed
            .get("missing_since")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());

        match missing_since {
            None => {
                parsed["missing_since"] = Value::String(now.to_rfc3339());
                if let Ok(s) = serde_json::to_string_pretty(&parsed) {
                    let _ = atomic_write(&p, &s);
                }
                log_line(&format!("gc marked missing uuid={}", stem));
            }
            Some(ts) => {
                let age_days = (now.signed_duration_since(ts.with_timezone(&chrono::Utc))).num_days();
                if age_days >= GC_GRACE_DAYS {
                    let _ = fs::remove_file(&p);
                    log_line(&format!(
                        "gc deleted uuid={} missing_since={} age_days={}",
                        stem, ts, age_days
                    ));
                }
            }
        }
    }
}
