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
