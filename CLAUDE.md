# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Curio is a desktop markdown viewer application built with:
- **Frontend**: Vue 3 (Composition API with `<script setup>`)
- **Backend**: Rust via Tauri 2
- **Build Tool**: Vite 6
- **Package Manager**: pnpm

## Common Commands

```bash
# Development (starts Vite dev server + Tauri app with hot reload)
pnpm tauri dev

# Build production app
pnpm tauri build

# Frontend only (for debugging Vue/CSS without Tauri)
pnpm dev

# Install dependencies
pnpm install
```

## Architecture

### Frontend (`src/`)

The Vue frontend uses a composables-based architecture:

- **`App.vue`**: Root component handling file loading, window management, and keyboard shortcuts
- **`components/SearchBar.vue`**: In-document search with match highlighting
- **`composables/`**: Reusable composition functions
  - `useMarkdown.js`: Markdown parsing (markdown-it), code highlighting (Prism.js), Mermaid diagrams
  - `useSearch.js`: DOM tree-walking text search with debouncing
  - `useFileWatcher.js`: Tauri file system watcher for live reload
- **`styles/`**: Design system with CSS variables, dark mode support

### Backend (`src-tauri/`)

Rust backend providing native capabilities:

- **`lib.rs`**: Core app logic - window management, CLI argument handling, macOS file associations
- **`files.rs`**: File operations exposed to frontend

### IPC Commands (Frontend → Backend)

```javascript
invoke('read_file', { path })     // Read file contents
invoke('get_filename', { path })  // Extract filename from path
invoke('create_window', { filePath })  // Open new window
invoke('get_cli_files')           // Get files passed via CLI
invoke('write_log', { message })  // Write debug log to ~/.curio_debug.log
```

### Tauri Plugins Used

- `tauri-plugin-fs`: File system operations with watch capability
- `tauri-plugin-dialog`: Native file picker dialogs
- `tauri-plugin-opener`: External link handling

## Key Patterns

- **Composables** return reactive refs and functions; state is managed via Vue's `ref()` and `computed()`
- **Debouncing** is used for search (150ms) and file watching (500ms)
- **Multi-window**: Each file opens in its own window with a unique WebviewWindow label
- **File associations**: macOS registers `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdown` extensions

## Design System

CSS variables are defined in `src/styles/variables.css`:
- Light/dark mode via `prefers-color-scheme`
- System fonts: SF Pro Display, SF Pro Text, SF Mono
- Content max-width: 720px

## File Watching in Production

Curio uses a dual-layer file watching strategy for live reload:

1. **Native watcher** (`watchImmediate`) - Instant detection of file changes
2. **Polling fallback** (5s interval) - Catches events the watcher may miss

### Critical Production Requirements

**The `fs:allow-stat` permission in `src-tauri/capabilities/default.json` is REQUIRED for production builds.**

Without this permission, file watching fails silently because:
- The native watcher uses `stat()` to track file modification times
- The polling fallback also depends on `stat()` for change detection
- In dev mode, Tauri auto-grants permissions (it works)
- In production DMG builds, only explicitly declared permissions work

### Event Coalescing

File system events are coalesced over 100ms to prevent redundant reloads:
- Multiple rapid edits trigger only one reload
- Delete followed by create is treated as a modification
- Scroll position is preserved across reloads

### User Feedback

- **Status indicator** (bottom-right corner) shows watcher health:
  - Green dot = actively watching
  - Red dot = auto-reload failed (click to manually reload)
- **Manual reload** available via Cmd+R keyboard shortcut
- **Notifications** appear when auto-reload is unavailable

### Troubleshooting File Watching

If file watching fails in production builds:

1. **Check console logs** - DevTools can be enabled via `tauri.conf.json` → `app.security.devtools: true`
2. **Check file logs** - Debug logs written to `~/.curio_debug.log`
3. **Look for permission errors** - Specifically stat() or watch() permission denied
4. **Verify status indicator** - Should show green dot when working
5. **Test manual reload** - Press Cmd+R to verify file reading works
6. **Check polling** - Should see events logged every 5 seconds

### Debug Logging

All file watcher operations are logged with `[FileWatcher]` prefix:
- Initialization logs include platform, file path, permissions test
- Event processing shows raw events and coalesced actions
- Polling shows mtime changes and detected modifications
- Errors include full stack traces

Logs appear in both:
- Browser DevTools console (if DevTools enabled)
- File at `~/.curio_debug.log` (always available)
