# Curio Annotations — Design Spec

**Status:** Draft v1
**Last updated:** 2026-05-13
**Format version:** 1

## 1. Goals & non-goals

### Goals
- Let the user comment on, suggest edits to, and check off items in markdown files viewed in Curio.
- Preserve user annotations across rewrites by *generic* LLM agents (agents that know nothing about Curio).
- Make annotations toggleable visually (Annotated / Original / Final views).
- Keep the `.md` file the source of truth; sidecar is cache + recovery state.

### Non-goals (v1)
- Multi-user collaboration (real-time or async).
- Cross-machine sync of orphan state and UI state (inline annotations sync via iCloud/git naturally; sidecar is per-machine).
- Plain text or non-markdown formats.
- Undo/redo as a first-class system (deferred — see §17).
- Direct edit mode with a full editor UI (deferred to v4 — see §22).

## 2. Core design principle

**Annotations live as readable markdown wrapped in HTML comment markers, inline in the `.md` file.** A generic LLM reading the raw file naturally sees and understands the feedback. The HTML comment markers exist only so Curio can find/render/toggle them. The sidecar in `~/.curio/` is a per-machine index for orphan recovery and UI state — fully reconstructable from the `.md` for any annotation whose markers are intact.

## 3. File format

### 3.1 Range comment

A comment anchored to a span of text within a single markdown block:

```markdown
The system uses <!--curio:c=a1b2-->Redis<!--/curio:c--> for session storage.

<!--curio:comment id=a1b2 author=mike ts=2026-05-13T14:22:00Z-->
> 💬 **Mike**: Why Redis over Memcached here? Need rationale.
<!--/curio:comment-->
```

- The anchored span is wrapped in `<!--curio:c=ID-->` / `<!--curio:/c-->`.
- The comment body follows as a real markdown blockquote so any LLM sees natural prose.
- The wrapping `<!--curio:comment ...-->` block carries metadata (id, author, timestamp).
- ID is a short stable token (8 chars from a UUID, sufficient for in-file uniqueness).

### 3.2 Suggested edit

An inline replacement proposal:

```markdown
The system uses <!--curio:e=e3f4-->~~Redis~~ → **PostgreSQL**<!--/curio:e--> for session storage.
```

- `~~old~~ → **new**` form is intentional — the arrow + bold + strikethrough makes intent unambiguous to any LLM ("user suggests replacing Redis with PostgreSQL").
- No separate metadata block needed for simple edits; the inline form contains everything.
- For edits with rationale, combine with a comment (§3.1) on the same span.

### 3.3 The file header

On first annotation of a file, Curio inserts a one-time header comment immediately after any frontmatter (or at line 1 if none):

```markdown
<!-- curio-sidecar: 7a3f0c12-4b8e-4d91-9c11-a2e8d3f5b6c7 -->
<!--
This file uses Curio annotation markers (curio.app).
- <!--curio:c=ID-->highlighted text<!--/curio:c--> marks a commented range; a blockquote with the comment follows.
- ~~old~~ → **new** inside <!--curio:e=ID--> marks a suggested edit.
- Please preserve these markers when rewriting this file.
-->
```

The first line is the sidecar pointer (§4). The second comment is human/LLM-readable documentation of the format.

### 3.4 Checkboxes

GFM checkboxes (`- [ ]` / `- [x]`) are written directly to the file when toggled. No annotation marker, no sidecar tracking. **Loss across generic agent rewrites is accepted.**

### 3.5 Edge cases & restrictions

| Case | v1 rule |
|---|---|
| Anchor inside a fenced code block | Forbidden. Show error toast: "Cannot annotate inside code blocks." |
| Anchor inside a table cell | Allowed, but range cannot span cells. |
| Anchor spanning multiple block-level elements | Forbidden. Range must stay within one paragraph / list item / table cell. |
| Nested annotations (annotating already-annotated text) | Forbidden in v1. |
| Empty range | Forbidden. |
| File without trailing newline | Curio adds one before writing the header. |

## 4. Sidecar

### 4.1 Location

`~/.curio/<UUID>.json`, where UUID is generated on first annotation and embedded in the `.md` header (§3.3).

### 4.2 Discovery & path tracking

- On opening an `.md`, Curio reads the `<!-- curio-sidecar: UUID -->` header.
- Loads `~/.curio/<UUID>.json`.
- If `stored.path ≠ current_path` AND `stored.path` no longer exists → it's a rename. Update `stored.path`, push old path to `path_history`.
- If `stored.path ≠ current_path` AND `stored.path` still exists → it's a copy. Fork: generate new UUID, copy sidecar contents to new file, rewrite the UUID comment in the just-opened `.md`. Show toast: "Detected copy of annotated file; forked sidecar."
- If no sidecar file exists at `~/.curio/<UUID>.json` → rebuild from inline markers in the `.md`. Reuse the existing UUID; do not generate a new one. Orphans, UI state, and history are lost.

### 4.3 Shape

```json
{
  "format_version": 1,
  "uuid": "7a3f0c12-4b8e-4d91-9c11-a2e8d3f5b6c7",
  "path": "/Users/mike/Documents/foo.md",
  "path_history": ["/Users/mike/Documents/old-name.md"],
  "missing_since": null,
  "last_opened": "2026-05-13T14:22:00Z",
  "file_hash_last_seen": "sha256:...",
  "annotations": {
    "a1b2": {
      "type": "comment",
      "anchor_text": "Redis",
      "context_before": "The system uses ",
      "context_after": " for session storage.",
      "body_md": "> 💬 **Mike**: Why Redis over Memcached here?",
      "author": "mike",
      "created_at": "2026-05-13T14:22:00Z",
      "updated_at": "2026-05-13T14:22:00Z"
    }
  },
  "orphans": [],
  "ui_state": {
    "collapsed_ids": [],
    "view_mode": "annotated"
  }
}
```

### 4.4 Garbage collection

On Curio startup:

1. Scan `~/.curio/*.json`.
2. For each, check `stored.path`.
3. If path resolves → mark `missing_since: null`, continue.
4. If path missing AND `missing_since == null` → set `missing_since = now()`.
5. If path missing AND `now() - missing_since > 30 days` → delete sidecar. Log to `~/.curio_debug.log`.

### 4.5 Writes

- Write to `<UUID>.json.tmp`, then atomic rename to `<UUID>.json`.
- Debounce writes during rapid annotation editing (500ms).
- A single in-process lock per UUID; cross-window writes coordinated via file mtime check before write (last-writer-wins for v1; multi-window §15).

## 5. View modes

Three modes, switchable in the toolbar:

| Mode | Renders |
|---|---|
| **Annotated** (default) | Original prose + comments (as blockquotes) + suggested edits visible with strikethrough/replacement. |
| **Original** | All `<!--curio:...-->` blocks stripped from the rendered output. Shows the file as it was before any annotation. |
| **Final** | All annotations stripped AND suggested edits applied (strikethrough text removed, replacement kept). Shows what the file would look like if every suggestion were accepted. |

All three are **read-only views** of the same on-disk file. None of them mutate the `.md`. The only way to permanently apply suggestions is the acceptance workflow (§7).

## 6. Edit modes

Per-session toggle in the toolbar:

- **Suggest mode** (default): edits create `<!--curio:edit-->` blocks. Original text preserved in the file.
- **Direct mode**: edits modify the file directly (no annotation). Deferred to v4 — see §22.

## 7. Acceptance workflow for suggested edits

Per-annotation actions in the side panel:

- **Accept**: rewrite the `.md` to replace `<!--curio:e=ID-->~~old~~ → **new**<!--/curio:e-->` with just `new`. Remove the annotation from the sidecar.
- **Reject**: rewrite to replace the same span with just `old`. Remove the annotation from the sidecar.
- **Bulk**: "Accept all my pending edits" — single batched write, single watcher-suppress window.

Range comments do not have accept/reject — they have **Resolve** (removes the comment markers and the blockquote body from the file) and **Delete** (same effect, different mental model; UI may collapse them to one action in v1).

## 8. Author identity

- First time Curio writes an annotation, prompt for display name. Default: `$USER`.
- Stored in `~/.curio/config.json`: `{ "author": "mike" }`.
- Editable later via Settings.
- Used in `author=` field of all subsequent annotations.

## 9. Orphan handling

After any file change (watcher fires, content differs from `file_hash_last_seen`):

1. Parse new content, extract all `<!--curio:c=ID-->` / `<!--curio:e=ID-->` markers.
2. For each annotation ID in `sidecar.annotations`:
   - Marker still present → fine. Update `file_hash_last_seen`.
   - Marker absent → move to `sidecar.orphans` with original `anchor_text`, `context_before`, `context_after`.
3. Surface orphans in a right-side panel with three actions per orphan:
   - **Re-anchor**: user selects new text → marker re-inserted at new location, annotation returns to active.
   - **Fuzzy match suggestion**: if Curio finds `anchor_text` (or a near-match) elsewhere in the new content, offer one-click re-anchor.
   - **Dismiss**: drop from `orphans`.
4. Nothing silently deleted.

## 10. In-flight conflict

If the file changes externally while the user is mid-comment (input field open, draft uncommitted):

1. Capture the in-progress draft text to clipboard.
2. Dismiss the input UI.
3. Show toast: "File changed externally — your draft was copied to clipboard."
4. Reload the file (existing live-reload flow).

User can paste and retry against the new content.

## 11. Self-write suppression

When Curio writes the file (annotation create/edit, checkbox toggle, accept/reject):

1. Record `self_write_at = now()`.
2. File watcher event handlers ignore events with `event.timestamp < self_write_at + 500ms`.
3. Logged with `[Annotate]` prefix.

Mirrors the existing pattern in `useFileWatcher.js`.

## 12. UI

### 12.1 Creating an annotation

- User selects text in the rendered view.
- Floating toolbar appears anchored to the selection: **[💬 Comment]** **[✏️ Suggest edit]**.
- Click → popover input opens anchored to selection.
- `Cmd+Enter` to commit, `Esc` to cancel.
- Keyboard shortcut: `Cmd+Shift+M` on a selection → same as clicking 💬.

### 12.2 Viewing annotations

- Annotated spans render with a colored underline + small marker dot. Single accent color drawn from the design system (`src/styles/variables.css`); no per-author coloring.
- Hover → preview popover with comment text.
- Click → expands the inline blockquote (if collapsed) and scrolls the right-side panel to that annotation.

### 12.3 Right-side panel

Collapsible panel listing:

- **Active annotations** (with ID, author, timestamp, body, jump-to-anchor action).
- **Orphans** (§9) — separate section with re-anchor / dismiss actions.
- Filter: All / Comments only / Edits only / Orphans only.

### 12.4 Toolbar additions

- View mode selector: [Annotated | Original | Final]
- Edit mode toggle: [Suggest | Direct] (Direct disabled in v1–v3)
- Annotation count badge.

## 13. Search interaction

- Default: search matches both prose and annotation body text (comments inside blockquotes are part of the rendered DOM).
- In **Original view**, annotations are not rendered → search does not find them. Acceptable (consistent with what's visible).
- Add `[Annotations]` toggle in `SearchBar.vue` for "search annotation bodies only" — useful for `Cmd+F` "find my comment about X".

## 14. Multi-window

- Each window opens its own `WebviewWindow` (existing pattern).
- All windows watching the same `.md` rely on the file watcher: any annotation write triggers reload in other windows.
- Sidecar writes coordinated via mtime check immediately before write: re-read sidecar, merge, write. Last-writer-wins on conflict (acceptable for v1; rare in solo use).

## 15. Format versioning

- Sidecar JSON includes `format_version: 1`.
- File header comment (§3.3) is the only inline version marker (implied by "Curio annotation format" prose; no explicit version number on file side in v1).
- On encountering `format_version > current`, Curio refuses to write and shows a banner: "This file uses a newer Curio format. Update Curio to edit." Reading still works in read-only mode.

## 16. Logging

All annotation operations log to `~/.curio_debug.log` with `[Annotate]` prefix:

- `[Annotate] create comment id=a1b2 path=/Users/.../foo.md`
- `[Annotate] orphan detected id=a1b2 anchor="Redis"`
- `[Annotate] self-write suppressed event at +123ms`
- `[Annotate] sidecar gc deleted UUID=7a3f... missing_since=2026-04-10`

## 17. Undo/redo

V1 has **no in-app undo** for annotation operations. Defensible because:

- Every annotation write is durable, visible in the file, and reversible by editing/deleting the annotation.
- Git is the authoritative history.

Future consideration (v3+): a small in-memory undo stack for "last N annotation actions in this session" bound to `Cmd+Z`.

## 18. Export

Two commands in the File menu:

- **Export Final…**: writes a new `.md` with all annotations stripped and suggestions applied. Prompts for destination path. Original unmodified.
- **Strip All Curio Markers (in place)…**: nuclear option. Removes the sidecar header, all `<!--curio:...-->` markers, all comment blockquotes. Keeps suggested edits in their *original* form (does not auto-accept). Requires confirmation dialog. Sidecar moves to `missing_since` state.

## 19. Settings (`~/.curio/config.json`)

```json
{
  "author": "mike",
  "default_view_mode": "annotated",
  "default_edit_mode": "suggest",
  "gitignore_prompt_shown": false
}
```

Editable via Settings panel (or by editing the file directly).

## 20. Git integration

On first annotation in a directory under git:

- Check for a `.gitignore` covering `.curio/` and the `<!-- curio-sidecar: -->` pattern.
- The header comment is inline in the `.md` and will commit with the file (intentional — collaborators see the format documentation).
- The sidecar lives in `~/.curio/`, never in the repo. No `.gitignore` change needed.
- One-time prompt: "Commit Curio annotations to git?" → if no, suggest adding a `.gitignore` entry for annotated files (not recommended; the inline form is the whole point). Probably skip this prompt entirely in v1.

## 21. IPC additions (Frontend → Backend)

New Tauri commands in `src-tauri/src/files.rs`:

```rust
invoke('read_sidecar', { uuid })           // -> SidecarJson | null
invoke('write_sidecar', { uuid, data })    // atomic write
invoke('list_sidecars')                    // -> [{ uuid, path, missing_since }]
invoke('delete_sidecar', { uuid })         // for GC
invoke('write_md_atomic', { path, content }) // for annotation writes with watcher suppression hint
```

Frontend composables:

- `composables/useAnnotations.js`: parse markers, manage sidecar state, expose CRUD.
- `composables/useAcceptance.js`: accept/reject suggested edits, batch operations.
- Extend `composables/useFileWatcher.js`: integrate self-write suppression timestamp.

## 22. Phased rollout

| Phase | Scope |
|---|---|
| **v1** | Range comments + checkbox writes + Annotated/Original toggle + sidecar (UUID-in-header model) + self-write suppression + right-side panel + author prompt + LLM header insertion |
| **v2** | Suggested edits + Final view + acceptance workflow (accept/reject/bulk) |
| **v3** | Orphan panel + fuzzy re-anchor + search-annotations toggle + Export Final + Strip All Curio Markers |
| **v4** | Direct edit mode (in-place editor) + undo/redo stack |

## 23. Resolved decisions

1. **LLM-instruction header version tag** — No explicit version tag in the inline header. Format evolution is signaled by the sidecar's `format_version` field only.
2. **Multi-window sidecar coordination** — Ship v1 with last-writer-wins + pre-write mtime check (§14). Revisit only if visible problems emerge.
3. **Checkbox preservation** — File-only. No belt-and-suspenders sidecar tracking. Loss across generic-agent rewrites is accepted.
4. **Annotation color** — Single accent color from the design system (`src/styles/variables.css`). No per-author coloring.
