# Curio

A native macOS markdown viewer built with Tauri, Vue 3, and Rust.

Curio renders markdown files with syntax highlighting, Mermaid diagrams, and live reload — so your preview updates instantly as you edit in any text editor.

## Features

- **Live reload** — Watches open files for changes and re-renders automatically, preserving scroll position
- **Syntax highlighting** — 25+ languages via Prism.js (JavaScript, Python, Rust, Go, Swift, and more)
- **Mermaid diagrams** — Renders flowcharts, sequence diagrams, and other Mermaid blocks inline
- **In-document search** — Find text with match highlighting (Cmd+F)
- **Dark mode** — Follows macOS system appearance
- **Multi-window** — Open multiple files in separate windows
- **File associations** — Double-click `.md` files in Finder to open them in Curio
- **Copy buttons** — Hover over headings, code blocks, or diagrams to copy their content

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+O | Open file |
| Cmd+N | New window |
| Cmd+W | Close window |
| Cmd+F | Find in document |
| Cmd+R | Reload file |

## Installation

Download the latest `.dmg` from [Releases](https://github.com/mikefarmer/curio/releases), open it, and drag Curio to Applications.

> On first launch, macOS may show a Gatekeeper warning because the app is not code-signed. Right-click the app and select **Open** to bypass this.

## Development

Requires [Rust](https://rustup.rs/), [Node.js](https://nodejs.org/) 22+, and [pnpm](https://pnpm.io/).

```bash
# Install dependencies
pnpm install

# Run in development mode (hot reload)
pnpm tauri dev

# Build production app
pnpm tauri build
```

## License

MIT
