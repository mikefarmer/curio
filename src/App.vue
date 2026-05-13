<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { save } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { open, ask } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import mermaid from 'mermaid'
import { useMarkdown } from './composables/useMarkdown'
import { useSearch } from './composables/useSearch'
import { useFileWatcher } from './composables/useFileWatcher'
import { useSectionCopy } from './composables/useSectionCopy'
import { useAnnotations, stripAnnotations } from './composables/useAnnotations'
import { useUndoStack } from './composables/useUndoStack'
import SelectionToolbar from './components/SelectionToolbar.vue'
import CommentInput from './components/CommentInput.vue'
import SuggestEditInput from './components/SuggestEditInput.vue'
import AnnotationPanel from './components/AnnotationPanel.vue'
import AuthorPrompt from './components/AuthorPrompt.vue'
import ViewMenu from './components/ViewMenu.vue'

// Initialize Mermaid with theme detection
function initMermaid() {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'loose',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  })
}

initMermaid()

// Re-initialize mermaid when theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  initMermaid()
  renderMermaidDiagrams()
})

// Markdown composable
const { renderedHtml, setContent, viewMode } = useMarkdown()

// Search composable
const {
  searchQuery,
  isSearchOpen,
  matchDisplay,
  contentElement,
  openSearch,
  closeSearch,
  nextMatch,
  prevMatch,
  clearHighlights
} = useSearch()

// File watcher composable
const { isWatching, watcherError, startWatching, stopWatching, getWatcherStatus, markSelfWrite } = useFileWatcher()

// Section copy composable
const { injectCopyButtons } = useSectionCopy()

// Annotations composable
const {
  annotations,
  orphans,
  author,
  hasAuthor,
  loadForFile: loadAnnotationsForFile,
  refreshAnnotations,
  persistSidecar,
  createComment: createCommentInState,
  createCodeComment: createCodeCommentInState,
  createEdit: createEditInState,
  acceptEdit: acceptEditInState,
  rejectEdit: rejectEditInState,
  acceptAllEdits: acceptAllEditsInState,
  rejectAllEdits: rejectAllEditsInState,
  deleteAnnotation,
  dismissOrphan,
  suggestOrphanLocation,
  reanchorOrphan: reanchorOrphanInState,
  reanchorOrphanAtIdx: reanchorOrphanAtIdxInState,
  initAuthor,
  setAuthor
} = useAnnotations()

// State
const filename = ref('')
const filePath = ref('')
const isLoading = ref(false)
const error = ref('')
const hasContent = ref(false)
const contentRef = ref(null)
const rawContent = ref('')  // Track last loaded content for deduplication
const statusMessage = ref('')  // Notification message for user
const showStatus = ref(false)  // Show status notification

// Annotation UI state
const panelOpen = ref(false)
const activeAnnotationId = ref(null)  // Currently highlighted comment (sidebar focus)
const topSearchInputRef = ref(null)   // Persistent find input in the top toolbar
const selectionToolbarRef = ref(null)
const commentInputOpen = ref(false)
const commentInputAnchorX = ref(0)
const commentInputAnchorY = ref(0)
const suggestInputOpen = ref(false)
const suggestInputAnchorX = ref(0)
const suggestInputAnchorY = ref(0)
const pendingSelection = ref(null)  // { text, contextBefore, contextAfter }
const pendingIntent = ref(null)     // 'comment' | 'suggest' | 'code-comment'
const pendingCodeBlock = ref(null)  // { hash, text } when commenting on code
const authorPromptOpen = ref(false)
const reanchoringId = ref(null)     // orphan id currently in re-anchor mode

// Edit-mode toggle (spec §6, §22 v4):
//   'suggest' — edits create <!--curio:e--> annotations (default).
//   'direct'  — raw markdown textarea, writes go straight to the file.
const editMode = ref('suggest')
const directBuffer = ref('')       // textarea content while in direct mode
const directTextareaRef = ref(null)

// Annotation-level undo stack (v4). Direct-mode char edits use the
// textarea's native browser undo — see useUndoStack.js for rationale.
const { undoStack, redoStack, push: pushUndo, popUndo, popRedo, clear: clearUndo } = useUndoStack()

// Link content element to search
watch(contentRef, (el) => {
  contentElement.value = el
})

// Clear search highlights when content changes
// Use flush: 'post' to ensure DOM is updated before rendering Mermaid
watch(renderedHtml, async () => {
  clearHighlights()
  if (renderedHtml.value) {
    await renderMermaidDiagrams()
    injectCopyButtons(contentRef.value, rawContent.value)
    injectCodeCommentButtons(contentRef.value)
  }
}, { flush: 'post' })

// Inject a "💬" comment button into each code-block wrapper (alongside the
// existing copy button). Clicking it triggers a comment-on-code-block flow.
function injectCodeCommentButtons(articleEl) {
  if (!articleEl) return
  const wrappers = articleEl.querySelectorAll('.code-block-wrapper[data-code-hash]')
  for (const wrapper of wrappers) {
    if (wrapper.querySelector('.curio-code-comment-btn')) continue
    const btn = document.createElement('button')
    btn.className = 'copy-btn curio-code-comment-btn'
    btn.type = 'button'
    btn.innerHTML = '💬'
    btn.title = 'Comment on this code block'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      const codeEl = wrapper.querySelector('code') || wrapper.querySelector('pre')
      const codeText = codeEl ? codeEl.textContent : ''
      onCodeBlockCommentRequested({
        hash: wrapper.dataset.codeHash,
        text: codeText,
        rect: btn.getBoundingClientRect()
      })
    })
    wrapper.appendChild(btn)
  }
}

// Render Mermaid diagrams after content updates
async function renderMermaidDiagrams() {
  await nextTick()

  const containers = document.querySelectorAll('.mermaid-container')

  for (const container of containers) {
    const preElement = container.querySelector('pre.mermaid')
    if (!preElement) continue

    const code = preElement.textContent
    if (!code) continue

    try {
      // Preserve mermaid source before replacing with SVG
      container.dataset.mermaidSource = code
      const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`
      const { svg } = await mermaid.render(id, code)
      container.innerHTML = svg
    } catch (e) {
      console.error('Mermaid rendering error:', e)
      container.innerHTML = `<div class="mermaid-error">Failed to render diagram: ${e.message}</div>`
    }
  }
}

// Open file dialog
async function openFile() {
  try {
    isLoading.value = true
    error.value = ''

    const selected = await open({
      multiple: false,
      filters: [{
        name: 'Markdown',
        extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdown']
      }]
    })

    if (selected) {
      await loadFile(selected)
    }
  } catch (e) {
    error.value = `Failed to open file: ${e}`
    console.error(e)
  } finally {
    isLoading.value = false
  }
}

// Run an in-place content mutation while preserving the scroll position of
// the main content area. Use for annotation create/delete/accept/reject so
// the view doesn't jump after a write.
async function withPreservedScroll(fn) {
  const scroller = document.querySelector('main.content')
  const top = scroller ? scroller.scrollTop : 0
  await fn()
  await nextTick()
  if (scroller) scroller.scrollTop = top
}

// Handle file changes from watcher
async function handleFileChange(event) {
  // Event type is now a simple string from our coalesced watcher
  const eventType = event.type

  if (eventType === 'deleted') {
    error.value = 'The file has been deleted or moved.'
    hasContent.value = false
    await stopWatching()
    return
  }

  // Handle modified (includes 'created' from delete+recreate)
  try {
    // Capture relative scroll position (0-1 ratio)
    const container = contentRef.value
    const scrollRatio = container && container.scrollHeight > container.clientHeight
      ? container.scrollTop / (container.scrollHeight - container.clientHeight)
      : 0

    // Reload content
    const content = await invoke('read_file', { path: filePath.value })

    // Skip re-render if content unchanged (handles "touch" events)
    if (content === rawContent.value) {
      console.log('[App] Content unchanged, skipping re-render')
      return
    }

    rawContent.value = content
    setContent(content)
    // Re-derive annotations and orphans against the new content
    refreshAnnotations(content)
    await persistSidecar()

    // Restore relative scroll position after render
    await nextTick()
    if (container && container.scrollHeight > container.clientHeight) {
      container.scrollTop = scrollRatio * (container.scrollHeight - container.clientHeight)
    }
  } catch (e) {
    console.error('Failed to reload file:', e)
  }
}

// Manual reload - useful when auto-reload fails
async function reloadCurrentFile() {
  if (!filePath.value) return

  try {
    const content = await invoke('read_file', { path: filePath.value })
    rawContent.value = content
    setContent(content)
    showStatusNotification('File reloaded manually')
  } catch (e) {
    error.value = `Failed to reload file: ${e}`
    console.error(e)
  }
}

// Show temporary status notification
function showStatusNotification(message) {
  statusMessage.value = message
  showStatus.value = true
  setTimeout(() => {
    showStatus.value = false
  }, 3000)
}

// Load file content
async function loadFile(path) {
  try {
    isLoading.value = true
    error.value = ''
    filePath.value = path

    filename.value = await invoke('get_filename', { path })
    let content = await invoke('read_file', { path })

    // Load annotations: this may inject a curio-sidecar header if missing.
    // We do NOT write the file just to add the header — only when an actual
    // annotation is created. Until then the in-memory `content` carries the
    // header but disk is untouched.
    try {
      const result = await loadAnnotationsForFile(content, path)
      content = result.contentOut
      if (result.contentChanged) {
        try {
          markSelfWrite()
          await invoke('write_md_atomic', { path, content })
        } catch (e) {
          console.error('[Annotate] header heal write failed:', e)
        }
      }
    } catch (e) {
      console.error('[Annotate] loadForFile failed:', e)
    }

    // Set state so article element is visible BEFORE setting content
    // This ensures the watcher can find .mermaid-container elements
    hasContent.value = true
    isLoading.value = false
    await nextTick()  // Wait for article to render
    rawContent.value = content  // Track for deduplication
    setContent(content)

    // New file → fresh undo history. Stack is session-scoped per spec.
    clearUndo()

    // Update window title
    const currentWindow = getCurrentWindow()
    await currentWindow.setTitle(filename.value)

    // Start watching the file for changes
    await startWatching(path, handleFileChange)

    // Check if watcher failed and notify user
    if (watcherError.value) {
      showStatusNotification('Auto-reload unavailable. Press ⌘R to refresh manually.')
    }
  } catch (e) {
    error.value = `Failed to read file: ${e}`
    console.error(e)
    isLoading.value = false
  }
}

// Create a new window
async function createNewWindow() {
  try {
    await invoke('create_window')
  } catch (e) {
    console.error('Failed to create window:', e)
  }
}

// Close current window
async function closeCurrentWindow() {
  try {
    // Stop watching before closing
    await stopWatching()
    const currentWindow = getCurrentWindow()
    await currentWindow.close()
  } catch (e) {
    console.error('Failed to close window:', e)
  }
}

// Keyboard shortcuts
function handleKeydown(e) {
  // Cmd+O - Open file
  if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
    e.preventDefault()
    openFile()
  }

  // Cmd+N - New window
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault()
    createNewWindow()
  }

  // Cmd+W - Close window
  if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
    e.preventDefault()
    closeCurrentWindow()
  }

  // Cmd+F - Focus the persistent find input in the top toolbar
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault()
    openSearch()
    nextTick(() => {
      topSearchInputRef.value?.focus()
      topSearchInputRef.value?.select()
    })
  }

  // Cmd+R - Manual reload
  if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
    e.preventDefault()
    reloadCurrentFile()
  }

  // Cmd+Shift+M - Comment on current selection
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault()
    selectionToolbarRef.value?.triggerCommentFromCurrentSelection()
  }

  // Cmd+Shift+E - Suggest edit on current selection
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'e' || e.key === 'E')) {
    e.preventDefault()
    selectionToolbarRef.value?.triggerSuggestFromCurrentSelection()
  }

  // Cmd+Shift+A - Toggle annotations panel
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault()
    panelOpen.value = !panelOpen.value
  }

  // Cmd+Shift+D - Enter Direct edit mode (Save/Cancel buttons exit it)
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault()
    if (editMode.value !== 'direct') setEditMode('direct')
  }

  // Inside direct edit: Esc = cancel, ⌘S = save
  if (editMode.value === 'direct') {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelDirectEdit()
      return
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      saveDirectEdit()
      return
    }
  }

  // Cmd+Z / Cmd+Shift+Z — annotation-level undo/redo. Only fires when
  // focus is NOT in a textarea/input/contenteditable (those get their
  // native browser undo). Spec §17 / §22 v4.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    if (isEditableFocused()) return
    e.preventDefault()
    doUndo()
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    if (isEditableFocused()) return
    e.preventDefault()
    doRedo()
  }

  // Escape - Close search (handled in SearchBar too) or cancel re-anchor mode
  if (e.key === 'Escape') {
    if (reanchoringId.value) {
      onCancelReanchor()
      return
    }
    if (isSearchOpen.value) closeSearch()
  }
}

// Keydown handler for the toolbar's find input. Enter / Shift+Enter cycle
// matches; Esc clears the query and blurs.
function onTopSearchKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeSearch()
    e.target.blur()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (e.shiftKey) prevMatch()
    else nextMatch()
  }
}

// Check for file to load on startup
async function checkStartupFile() {
  // First, check URL query parameter (for windows opened with a specific file)
  const urlParams = new URLSearchParams(window.location.search)
  const fileParam = urlParams.get('file')

  if (fileParam) {
    // This window was opened with a specific file
    await loadFile(decodeURIComponent(fileParam))
    return
  }

  // No file param — this is the main window. Collect both CLI args and any
  // macOS file-association opens that arrived before the listener registered.
  let startupFiles = []
  try {
    const cliFiles = await invoke('get_cli_files')
    startupFiles = startupFiles.concat(cliFiles)
  } catch (e) {
    console.error('Failed to get CLI files:', e)
  }
  try {
    const pending = await invoke('take_pending_opens')
    startupFiles = startupFiles.concat(pending)
  } catch (e) {
    console.error('Failed to get pending opens:', e)
  }

  if (startupFiles.length > 0) {
    await loadFile(startupFiles[0])
    for (let i = 1; i < startupFiles.length; i++) {
      await invoke('create_window', { filePath: startupFiles[i] })
    }
  }
}

// Receive macOS file-association opens that arrive while the app is running.
// If this window is empty, claim the file ourselves so the welcome screen
// doesn't linger; otherwise spawn a new window so the open document is
// preserved. Without this guard every window would race to claim the file.
let openFileUnlisten = null
async function registerOpenFileListener() {
  openFileUnlisten = await listen('open-file', async (event) => {
    const path = event.payload
    if (!path) return
    // Dedup: if we just loaded this file (via the startup drain or a previous
    // event), do nothing. Otherwise an event queued during mount would spawn
    // a duplicate window.
    if (filePath.value === path) return
    if (!hasContent.value && !filePath.value) {
      // Drain the buffer too so a later mount doesn't replay this file.
      try { await invoke('take_pending_opens') } catch (e) { /* ignore */ }
      await loadFile(path)
    } else {
      try { await invoke('create_window', { filePath: path }) }
      catch (e) { console.error('Failed to open file in new window:', e) }
    }
  })
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  // Load saved author name; if none, we'll prompt on first comment.
  initAuthor()
  // Register the listener before draining pending opens so a file delivered
  // between the two awaits can't slip through unnoticed (it will land in
  // PendingOpens and the listener will also fire — both paths are idempotent
  // because loadFile is guarded by hasContent above).
  await registerOpenFileListener()
  await checkStartupFile()
})

// ────────────────────────────────────────────────────────────────────────────
// Annotation handlers
// ────────────────────────────────────────────────────────────────────────────

function onSelectionComment(selection) {
  // If we're in re-anchor mode, the next "comment" gesture re-attaches the orphan
  if (reanchoringId.value) {
    completeReanchor(selection)
    return
  }
  startIntent('comment', selection)
}

function onSelectionSuggest(selection) {
  // Re-anchor mode also accepts the suggest gesture (treat both as "use this selection")
  if (reanchoringId.value) {
    completeReanchor(selection)
    return
  }
  startIntent('suggest', selection)
}

async function completeReanchor(selection) {
  const id = reanchoringId.value
  if (!id) return
  try {
    const before = rawContent.value
    const newContent = reanchorOrphanInState({
      content: rawContent.value,
      id,
      anchorText: selection.text,
      contextBefore: selection.contextBefore,
      contextAfter: selection.contextAfter
    })
    pushUndo(before, 're-anchor')
    markSelfWrite()
    await invoke('write_md_atomic', { path: filePath.value, content: newContent })
    rawContent.value = newContent
    setContent(newContent)
    refreshAnnotations(newContent)
    await persistSidecar()
    showStatusNotification('Comment re-anchored.')
  } catch (e) {
    console.error('[Annotate] re-anchor failed:', e)
    showStatusNotification(`Could not re-anchor: ${e.message || e}`)
  } finally {
    reanchoringId.value = null
    window.getSelection()?.removeAllRanges()
  }
}

function onCodeBlockCommentRequested({ hash, text, rect }) {
  pendingSelection.value = null
  pendingCodeBlock.value = { hash, text }
  pendingIntent.value = 'code-comment'

  if (!hasAuthor.value) {
    authorPromptOpen.value = true
    return
  }
  openCodeCommentInput(rect)
}

function openCodeCommentInput(rect) {
  if (rect) {
    commentInputAnchorX.value = rect.left + rect.width / 2
    commentInputAnchorY.value = rect.bottom
  }
  commentInputOpen.value = true
}

function startIntent(intent, selection) {
  pendingSelection.value = selection
  pendingIntent.value = intent

  if (!hasAuthor.value) {
    authorPromptOpen.value = true
    return
  }
  openIntentInput()
}

function openIntentInput() {
  if (pendingIntent.value === 'code-comment') {
    openCodeCommentInput(null)
    return
  }
  // Anchor near the current selection rect
  const sel = window.getSelection()
  let x = 0, y = 0
  if (sel && sel.rangeCount > 0) {
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    x = rect.left + rect.width / 2
    y = rect.bottom
  }
  if (pendingIntent.value === 'suggest') {
    suggestInputAnchorX.value = x
    suggestInputAnchorY.value = y
    suggestInputOpen.value = true
  } else {
    commentInputAnchorX.value = x
    commentInputAnchorY.value = y
    commentInputOpen.value = true
  }
}

async function onAuthorSubmit(name) {
  await setAuthor(name)
  authorPromptOpen.value = false
  if (pendingIntent.value) {
    openIntentInput()
  }
}

function onAuthorCancel() {
  authorPromptOpen.value = false
  pendingIntent.value = null
  pendingSelection.value = null
  pendingCodeBlock.value = null
}

async function onCommentSubmit(body) {
  if (!filePath.value) {
    commentInputOpen.value = false
    return
  }
  try {
    let newContent
    if (pendingIntent.value === 'code-comment' && pendingCodeBlock.value) {
      const result = createCodeCommentInState({
        content: rawContent.value,
        codeHash: pendingCodeBlock.value.hash,
        codeText: pendingCodeBlock.value.text,
        body
      })
      newContent = result.content
    } else if (pendingSelection.value) {
      const result = createCommentInState({
        content: rawContent.value,
        anchorText: pendingSelection.value.text,
        contextBefore: pendingSelection.value.contextBefore,
        contextAfter: pendingSelection.value.contextAfter,
        body
      })
      newContent = result.content
    } else {
      commentInputOpen.value = false
      return
    }

    pushUndo(rawContent.value, pendingIntent.value === 'code-comment' ? 'code comment' : 'comment')
    markSelfWrite()
    await invoke('write_md_atomic', { path: filePath.value, content: newContent })
    await withPreservedScroll(() => {
      rawContent.value = newContent
      setContent(newContent)
      refreshAnnotations(newContent)
    })
    await persistSidecar()
  } catch (e) {
    console.error('[Annotate] create comment failed:', e)
    showStatusNotification(`Could not add comment: ${e.message || e}`)
  } finally {
    commentInputOpen.value = false
    pendingSelection.value = null
    pendingCodeBlock.value = null
    pendingIntent.value = null
    window.getSelection()?.removeAllRanges()
  }
}

function onCommentCancel() {
  commentInputOpen.value = false
  pendingSelection.value = null
  pendingCodeBlock.value = null
  pendingIntent.value = null
}

async function onSuggestSubmit(newText) {
  if (!pendingSelection.value || !filePath.value) {
    suggestInputOpen.value = false
    return
  }
  try {
    const { content: newContent } = createEditInState({
      content: rawContent.value,
      anchorText: pendingSelection.value.text,
      contextBefore: pendingSelection.value.contextBefore,
      contextAfter: pendingSelection.value.contextAfter,
      newText
    })
    pushUndo(rawContent.value, 'suggest edit')
    markSelfWrite()
    await invoke('write_md_atomic', { path: filePath.value, content: newContent })
    await withPreservedScroll(() => {
      rawContent.value = newContent
      setContent(newContent)
      refreshAnnotations(newContent)
    })
    await persistSidecar()
  } catch (e) {
    console.error('[Annotate] create edit failed:', e)
    showStatusNotification(`Could not add edit: ${e.message || e}`)
  } finally {
    suggestInputOpen.value = false
    pendingSelection.value = null
    pendingIntent.value = null
    window.getSelection()?.removeAllRanges()
  }
}

function onSuggestCancel() {
  suggestInputOpen.value = false
  pendingSelection.value = null
  pendingIntent.value = null
}

async function applyContentChange(newContent, undoLabel = null) {
  if (undoLabel !== null) pushUndo(rawContent.value, undoLabel)
  markSelfWrite()
  await invoke('write_md_atomic', { path: filePath.value, content: newContent })
  await withPreservedScroll(() => {
    rawContent.value = newContent
    setContent(newContent)
    refreshAnnotations(newContent)
  })
  await persistSidecar()
}

async function onAcceptEdit(id) {
  if (!filePath.value) return
  try {
    const newContent = acceptEditInState(rawContent.value, id)
    await applyContentChange(newContent, 'accept edit')
  } catch (e) {
    console.error('[Annotate] accept edit failed:', e)
    showStatusNotification(`Could not accept edit: ${e.message || e}`)
  }
}

async function onRejectEdit(id) {
  if (!filePath.value) return
  try {
    const newContent = rejectEditInState(rawContent.value, id)
    await applyContentChange(newContent, 'reject edit')
  } catch (e) {
    console.error('[Annotate] reject edit failed:', e)
    showStatusNotification(`Could not reject edit: ${e.message || e}`)
  }
}

async function onAcceptAllEdits() {
  if (!filePath.value) return
  try {
    const newContent = acceptAllEditsInState(rawContent.value)
    await applyContentChange(newContent, 'accept all edits')
  } catch (e) {
    console.error('[Annotate] accept-all failed:', e)
  }
}

async function onRejectAllEdits() {
  if (!filePath.value) return
  try {
    const newContent = rejectAllEditsInState(rawContent.value)
    await applyContentChange(newContent, 'reject all edits')
  } catch (e) {
    console.error('[Annotate] reject-all failed:', e)
  }
}

async function onDeleteAnnotation(id) {
  if (!filePath.value) return
  try {
    const newContent = deleteAnnotation(rawContent.value, id)
    pushUndo(rawContent.value, 'delete annotation')
    markSelfWrite()
    await invoke('write_md_atomic', { path: filePath.value, content: newContent })
    await withPreservedScroll(() => {
      rawContent.value = newContent
      setContent(newContent)
      refreshAnnotations(newContent)
    })
    await persistSidecar()
  } catch (e) {
    console.error('[Annotate] delete failed:', e)
  }
}

function onJumpTo(id) {
  activeAnnotationId.value = id
  // First try inline-anchor types
  let el = document.querySelector(
    `.curio-anchor[data-curio-id="${id}"], .curio-edit[data-curio-id="${id}"]`
  )
  // Code-comment: jump to the code block by hash
  if (!el) {
    const ann = annotations.value.find(a => a.id === id)
    const hash = ann && (ann.codeHash || ann.code_hash)
    if (hash) {
      el = document.querySelector(`.code-block-wrapper[data-code-hash="${hash}"]`)
    }
  }
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('curio-anchor-flash')
    setTimeout(() => el.classList.remove('curio-anchor-flash'), 1200)
  }
}

async function onDismissOrphan(id) {
  dismissOrphan(id)
  await persistSidecar()
}

// Fuzzy suggestions for each orphan, recomputed when content or orphans change
const orphanSuggestions = computed(() => {
  const result = {}
  if (!rawContent.value) return result
  for (const o of orphans.value) {
    try {
      result[o.id] = suggestOrphanLocation(rawContent.value, o.id)
    } catch (e) {
      result[o.id] = { idx: null, candidates: 0 }
    }
  }
  return result
})

async function onAcceptSuggestion(id) {
  const suggestion = orphanSuggestions.value[id]
  if (!suggestion || suggestion.idx === null) return
  const orphan = orphans.value.find(o => o.id === id)
  if (!orphan) return
  try {
    const newContent = reanchorOrphanAtIdxInState({
      content: rawContent.value,
      id,
      idx: suggestion.idx,
      anchorText: suggestion.anchorText || orphan.anchor_text
    })
    pushUndo(rawContent.value, 're-anchor (suggestion)')
    markSelfWrite()
    await invoke('write_md_atomic', { path: filePath.value, content: newContent })
    rawContent.value = newContent
    setContent(newContent)
    refreshAnnotations(newContent)
    await persistSidecar()
  } catch (e) {
    console.error('[Annotate] accept-suggestion failed:', e)
    showStatusNotification(`Could not re-anchor: ${e.message || e}`)
  }
}

function onStartReanchor(id) {
  reanchoringId.value = id
  showStatusNotification('Select text in the document to re-anchor this comment.')
}

function onCancelReanchor() {
  reanchoringId.value = null
}

// ────────────────────────────────────────────────────────────────────────────
// Overflow menu: Export Final / Strip All
// ────────────────────────────────────────────────────────────────────────────

async function onExportFinal() {
  if (!filePath.value) return
  // Suggest a default filename: original.md → original.final.md
  const defaultPath = filePath.value.replace(/(\.[^./\\]+)?$/, '.final$1')
  let target
  try {
    target = await save({
      defaultPath,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdown'] }]
    })
  } catch (e) {
    console.error('[Annotate] save dialog failed:', e)
    return
  }
  if (!target) return  // user cancelled

  try {
    const finalContent = stripAnnotations(rawContent.value, 'final')
    // Different file — no need to suppress watcher
    await invoke('write_file_new', { path: target, content: finalContent })
    showStatusNotification('Exported Final view to ' + target.split('/').pop())
  } catch (e) {
    console.error('[Annotate] export final failed:', e)
    showStatusNotification(`Could not export: ${e.message || e}`)
  }
}

async function onCopyPath() {
  if (!filePath.value) return
  try {
    await writeText(filePath.value)
    showStatusNotification('File path copied to clipboard')
  } catch (e) {
    console.error('[Menu] copy path failed:', e)
    showStatusNotification(`Could not copy path: ${e.message || e}`)
  }
}

async function onStripAll() {
  if (!filePath.value) return
  const confirmed = await ask(
    'Remove every Curio annotation marker, comment, and suggested edit from this file? Edits will revert to their original (rejected) form. This cannot be undone via Curio.',
    { title: 'Strip all Curio markers?', kind: 'warning' }
  )
  if (!confirmed) return

  try {
    // mode='original' keeps original text for edits (so they revert, not apply)
    const stripped = stripAnnotations(rawContent.value, 'original')
    pushUndo(rawContent.value, 'strip all')
    markSelfWrite()
    await invoke('write_md_atomic', { path: filePath.value, content: stripped })
    rawContent.value = stripped
    setContent(stripped)
    refreshAnnotations(stripped)
    await persistSidecar()
    showStatusNotification('All Curio markers removed.')
  } catch (e) {
    console.error('[Annotate] strip all failed:', e)
    showStatusNotification(`Could not strip: ${e.message || e}`)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Direct edit mode (v4, spec §6/§22)
// ────────────────────────────────────────────────────────────────────────────
// Raw markdown textarea. Native textarea undo handles char-level history;
// we don't push to our annotation undo stack on direct keystrokes — see
// useUndoStack.js for the rationale. Writes are debounced 500ms so each
// burst of typing produces a single atomic disk write + watcher-suppress.

function setEditMode(mode) {
  if (mode === editMode.value) return
  if (mode === 'direct') {
    directBuffer.value = rawContent.value
    editMode.value = 'direct'
    nextTick(() => directTextareaRef.value?.focus())
  } else {
    // Direct → suggest exits without writing. Callers wanting to persist
    // the buffer must call saveDirectEdit() first; otherwise the in-progress
    // edits are discarded (Cancel semantics).
    editMode.value = 'suggest'
    directBuffer.value = ''
    // The article remounts with the existing renderedHtml — fresh DOM nodes
    // for `<pre class="mermaid">` haven't been processed yet. The renderedHtml
    // watcher only fires on value changes, so trigger post-processing here.
    nextTick(() => {
      renderMermaidDiagrams()
      injectCopyButtons(contentRef.value, rawContent.value)
      injectCodeCommentButtons(contentRef.value)
    })
  }
}

function onDirectInput(e) {
  // Buffer-only: nothing is persisted until the user clicks Save.
  directBuffer.value = e.target.value
}

/** Commit the direct-edit buffer to disk and return to suggest mode. */
async function saveDirectEdit() {
  if (!filePath.value) { setEditMode('suggest'); return }
  if (directBuffer.value === rawContent.value) { setEditMode('suggest'); return }

  const newContent = directBuffer.value
  try {
    pushUndo(rawContent.value, 'direct edit')
    markSelfWrite()
    await invoke('write_md_atomic', { path: filePath.value, content: newContent })
    rawContent.value = newContent
    setContent(newContent)
    refreshAnnotations(newContent)
    await persistSidecar()
    setEditMode('suggest')
  } catch (e) {
    console.error('[Annotate] direct write failed:', e)
    showStatusNotification(`Could not save: ${e.message || e}`)
  }
}

/** Discard direct-edit buffer changes and return to suggest mode. */
function cancelDirectEdit() {
  setEditMode('suggest')
}

// If the file changes externally while we're in direct mode, refresh the
// textarea — but only when the buffer has no unsaved edits (i.e. it still
// matches the pre-change rawContent). Otherwise we'd clobber the user's work.
let lastSyncedRaw = ''
watch(rawContent, (newVal) => {
  if (editMode.value === 'direct') {
    if (directBuffer.value === lastSyncedRaw) {
      directBuffer.value = newVal
    } else {
      showStatusNotification('File changed on disk — your unsaved edits are preserved.')
    }
  }
  lastSyncedRaw = newVal
})

// ────────────────────────────────────────────────────────────────────────────
// Undo / redo (v4, spec §17/§22)
// ────────────────────────────────────────────────────────────────────────────

function isEditableFocused() {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable
}

async function doUndo() {
  const entry = popUndo(rawContent.value)
  if (!entry) return
  await applyUndoSnapshot(entry.before, `undo: ${entry.label}`)
}

async function doRedo() {
  const entry = popRedo(rawContent.value)
  if (!entry) return
  await applyUndoSnapshot(entry.before, `redo: ${entry.label}`)
}

async function applyUndoSnapshot(content, label) {
  try {
    markSelfWrite()
    await invoke('write_md_atomic', { path: filePath.value, content })
    rawContent.value = content
    setContent(content)
    refreshAnnotations(content)
    await persistSidecar()
    if (editMode.value === 'direct') directBuffer.value = content
    showStatusNotification(label)
  } catch (e) {
    console.error('[Annotate]', label, 'failed:', e)
    showStatusNotification(`Could not ${label}: ${e.message || e}`)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Checkbox writes
// ────────────────────────────────────────────────────────────────────────────

async function onContentClick(e) {
  const target = e.target

  // Click on a commented highlight → open panel and activate that comment
  if (target instanceof Element) {
    const anchor = target.closest('.curio-anchor[data-curio-id]')
    if (anchor) {
      const id = anchor.getAttribute('data-curio-id')
      if (id) {
        activeAnnotationId.value = id
        if (!panelOpen.value) panelOpen.value = true
        return
      }
    }
  }

  if (!(target instanceof HTMLInputElement)) return
  if (target.type !== 'checkbox') return
  if (!target.classList.contains('task-checkbox')) return

  const idx = Number(target.dataset.taskIndex)
  if (Number.isNaN(idx)) return

  // Find the Nth task list item in rawContent and toggle it
  const lines = rawContent.value.split('\n')
  // Regex captures the checkbox state in source order. Skip lines inside code fences.
  let inFence = false
  let count = 0
  let lineIndex = -1
  let currentChecked = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = line.match(/^(\s*[-*+]\s+)\[( |x|X)\](\s+)(.*)$/)
    if (m) {
      if (count === idx) {
        lineIndex = i
        currentChecked = m[2].toLowerCase() === 'x'
        break
      }
      count++
    }
  }

  if (lineIndex === -1) return

  // Toggle the line
  const newState = currentChecked ? ' ' : 'x'
  const newLine = lines[lineIndex].replace(/^(\s*[-*+]\s+)\[( |x|X)\]/, `$1[${newState}]`)
  const newLines = [...lines]
  newLines[lineIndex] = newLine
  const newContent = newLines.join('\n')

  // Optimistically set the checkbox visually
  target.checked = !currentChecked

  try {
    pushUndo(rawContent.value, 'toggle checkbox')
    markSelfWrite()
    await invoke('write_md_atomic', { path: filePath.value, content: newContent })
    rawContent.value = newContent
    setContent(newContent)
  } catch (err) {
    // Revert visual state on error
    target.checked = currentChecked
    console.error('[Annotate] checkbox write failed:', err)
    showStatusNotification(`Could not save checkbox: ${err.message || err}`)
  }
}

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  if (openFileUnlisten) { openFileUnlisten(); openFileUnlisten = null }
})
</script>

<template>
  <div class="app">
    <!-- Status notification -->
    <div v-if="showStatus" class="status-notification">
      {{ statusMessage }}
    </div>

    <!-- Unified top toolbar: persistent across all modes. In normal modes it
         hosts find, view-mode, edit toggle, panel toggle, menu, and the
         watcher indicator. In Edit mode it morphs to Cancel / Save. -->
    <header v-if="hasContent" class="top-toolbar" :class="{ 'is-editing': editMode === 'direct' }">
      <template v-if="editMode === 'direct'">
        <span class="top-toolbar-title">Editing raw markdown</span>
        <div class="top-toolbar-group">
          <button class="tb-btn" @click="cancelDirectEdit" title="Discard changes (Esc)">
            Cancel
          </button>
          <button class="tb-btn tb-primary" @click="saveDirectEdit" title="Save and return (⌘S)">
            Save
          </button>
        </div>
      </template>

      <template v-else>
        <!-- Watcher status — leading indicator. Click to reload on error. -->
        <div
          class="watcher-status"
          :class="{
            'status-watching': isWatching && !watcherError,
            'status-error': watcherError
          }"
          :title="watcherError ? 'Auto-reload failed. Press ⌘R to reload manually.' : 'Auto-reload active'"
          @click="watcherError ? reloadCurrentFile() : null"
        >
          <div class="status-dot"></div>
        </div>

        <!-- Find -->
        <div class="tb-search">
          <svg class="tb-search-icon" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
          </svg>
          <input
            ref="topSearchInputRef"
            type="text"
            class="tb-search-input"
            placeholder="Find…"
            :value="searchQuery"
            @input="searchQuery = $event.target.value"
            @keydown="onTopSearchKeydown"
          />
          <span v-if="searchQuery && matchDisplay" class="tb-search-count">{{ matchDisplay }}</span>
          <button v-if="searchQuery" class="tb-search-btn" @click="prevMatch" title="Previous (Shift+Enter)">▲</button>
          <button v-if="searchQuery" class="tb-search-btn" @click="nextMatch" title="Next (Enter)">▼</button>
          <button v-if="searchQuery" class="tb-search-btn" @click="closeSearch" title="Clear (Esc)">✕</button>
        </div>

        <!-- View mode -->
        <div class="view-mode-toggle" role="group" aria-label="View mode">
          <button :class="{ active: viewMode === 'annotated' }" @click="viewMode = 'annotated'" title="Show annotations and comments">Annotated</button>
          <button :class="{ active: viewMode === 'original' }" @click="viewMode = 'original'" title="Show the document as if no annotations existed">Original</button>
          <button :class="{ active: viewMode === 'final' }" @click="viewMode = 'final'" title="Preview the document with all suggested edits applied">Final</button>
        </div>

        <!-- Suggest / Edit toggle -->
        <div class="edit-mode-toggle" role="group" aria-label="Edit mode">
          <button :class="{ active: editMode === 'suggest' }" @click="setEditMode('suggest')" title="Selections create annotations (default)">Suggest</button>
          <button :class="{ active: editMode === 'direct' }" @click="setEditMode('direct')" title="Edit the raw markdown directly (⌘⇧D)">Edit</button>
        </div>

        <button
          class="panel-toggle"
          :class="{ active: panelOpen }"
          @click="panelOpen = !panelOpen"
          title="Toggle annotations panel (⌘⇧A)"
        >
          💬 {{ annotations.length + orphans.length }}
        </button>

        <ViewMenu
          @export-final="onExportFinal"
          @strip-all="onStripAll"
          @copy-path="onCopyPath"
        />
      </template>
    </header>

    <!-- Layout: content + optional side panel -->
    <div class="layout">
      <!-- Main content area -->
      <main class="content">
        <!-- Empty state -->
        <div v-if="!hasContent && !isLoading && !error" class="empty-state">
          <div class="empty-icon">📄</div>
          <h2>Welcome to Curio</h2>
          <p>Open a markdown file to get started</p>
          <button @click="openFile" class="open-button">
            Open File
          </button>
          <p class="shortcut-hint">or press <kbd>⌘</kbd> + <kbd>O</kbd></p>
        </div>

        <!-- Loading state -->
        <div v-else-if="isLoading" class="loading-state">
          <p>Loading...</p>
        </div>

        <!-- Error state -->
        <div v-else-if="error" class="error-state">
          <p>{{ error }}</p>
          <button @click="openFile" class="open-button">Try Again</button>
        </div>

        <!-- Direct edit mode: raw markdown textarea (spec §6, v4) -->
        <textarea
          v-else-if="editMode === 'direct'"
          ref="directTextareaRef"
          class="direct-editor"
          :value="directBuffer"
          @input="onDirectInput"
          spellcheck="false"
          aria-label="Raw markdown editor"
        ></textarea>

        <!-- Rendered markdown content -->
        <article
          v-else
          ref="contentRef"
          class="markdown-body"
          v-html="renderedHtml"
          @click="onContentClick"
        ></article>
      </main>

      <!-- Annotation panel -->
      <AnnotationPanel
        v-if="hasContent && panelOpen && editMode !== 'direct'"
        :open="panelOpen"
        :annotations="annotations"
        :orphans="orphans"
        :orphan-suggestions="orphanSuggestions"
        :reanchoring-id="reanchoringId"
        :active-id="activeAnnotationId"
        @close="panelOpen = false"
        @jump-to="onJumpTo"
        @delete="onDeleteAnnotation"
        @dismiss-orphan="onDismissOrphan"
        @accept-suggestion="onAcceptSuggestion"
        @start-reanchor="onStartReanchor"
        @cancel-reanchor="onCancelReanchor"
        @accept-edit="onAcceptEdit"
        @reject-edit="onRejectEdit"
        @accept-all-edits="onAcceptAllEdits"
        @reject-all-edits="onRejectAllEdits"
      />
    </div>

    <!-- Floating selection toolbar (hidden in Direct mode) -->
    <SelectionToolbar
      v-if="hasContent && editMode === 'suggest' && viewMode === 'annotated'"
      ref="selectionToolbarRef"
      :target="contentRef"
      @comment="onSelectionComment"
      @suggest="onSelectionSuggest"
    />

    <!-- Comment input popover -->
    <CommentInput
      :open="commentInputOpen"
      :anchor-x="commentInputAnchorX"
      :anchor-y="commentInputAnchorY"
      :selection-text="pendingIntent === 'code-comment' ? (pendingCodeBlock?.text || '') : (pendingSelection?.text || '')"
      @submit="onCommentSubmit"
      @cancel="onCommentCancel"
    />

    <!-- Suggest edit input popover -->
    <SuggestEditInput
      :open="suggestInputOpen"
      :anchor-x="suggestInputAnchorX"
      :anchor-y="suggestInputAnchorY"
      :original-text="pendingSelection?.text || ''"
      @submit="onSuggestSubmit"
      @cancel="onSuggestCancel"
    />

    <!-- Author identity prompt -->
    <AuthorPrompt
      :open="authorPromptOpen"
      :initial="author"
      @submit="onAuthorSubmit"
      @cancel="onAuthorCancel"
    />
  </div>
</template>

<style>
@import './styles/variables.css';
@import './styles/markdown.css';
@import './styles/prism-theme.css';

.app {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.layout {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* Main content */
.content {
  flex: 1;
  overflow-y: auto;
  padding: var(--content-padding);
}

/* View-mode + panel toggle toolbar */
/* Unified top toolbar — persistent across all modes. Holds find, view-mode,
   edit toggle, panel toggle, menu, and watcher status. In Edit mode the
   content swaps to a Cancel/Save bar. */
.top-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px 8px 84px; /* left padding clears macOS traffic lights */
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}

.top-toolbar > * {
  -webkit-app-region: no-drag;
}

.top-toolbar.is-editing {
  justify-content: space-between;
}

.top-toolbar-title {
  font-size: 12px;
  color: var(--text-secondary);
  -webkit-app-region: drag;
}

.top-toolbar-group {
  display: flex;
  gap: 8px;
}

.tb-btn {
  font: inherit;
  font-size: 12px;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
}

.tb-btn:hover {
  background: var(--border);
}

.tb-btn.tb-primary {
  background: var(--accent, #007aff);
  border-color: var(--accent, #007aff);
  color: white;
}

.tb-btn.tb-primary:hover {
  opacity: 0.9;
  background: var(--accent, #007aff);
}

/* Find input inside the toolbar */
.tb-search {
  display: flex;
  align-items: center;
  flex: 1;
  max-width: 360px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 6px 0 8px;
  height: 28px;
}

.tb-search-icon {
  width: 13px;
  height: 13px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.tb-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 4px 6px;
  font-size: 12.5px;
  color: var(--text-primary);
  outline: none;
  font-family: var(--font-text);
}

.tb-search-input::placeholder {
  color: var(--text-secondary);
}

.tb-search-count {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  padding: 0 4px;
}

.tb-search-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 5px;
  border-radius: 4px;
  cursor: pointer;
  line-height: 1;
}

.tb-search-btn:hover {
  background: var(--border);
  color: var(--text-primary);
}

.view-mode-toggle {
  display: flex;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px;
}

.view-mode-toggle button {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.view-mode-toggle button.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.view-mode-toggle button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Edit-mode toggle (Suggest / Direct) — same shape as view-mode toggle */
.edit-mode-toggle {
  display: flex;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px;
}

.edit-mode-toggle button {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.edit-mode-toggle button.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

/* Direct mode editor — full-height monospace textarea */
.direct-editor {
  display: block;
  width: 100%;
  height: 100%;
  max-width: 900px;
  margin: 0 auto;
  padding: 16px 20px;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 13.5px;
  line-height: 1.6;
  resize: none;
  outline: none;
  box-sizing: border-box;
  white-space: pre;
  overflow: auto;
  tab-size: 2;
}

.direct-editor:focus {
  border-color: var(--accent, #007aff);
  box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.15);
}

.panel-toggle {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.panel-toggle.active {
  color: var(--text-primary);
}

.curio-anchor {
  background: rgba(0, 122, 255, 0.14);
  border-bottom: 2px solid rgb(0, 122, 255);
  border-radius: 2px;
  padding: 0 2px;
  cursor: pointer;
  transition: background 0.15s;
}

.curio-anchor:hover {
  background: rgba(0, 122, 255, 0.28);
}

.curio-anchor-flash {
  animation: curio-flash 1.2s ease-out;
}

@keyframes curio-flash {
  0% { background: rgba(0, 122, 255, 0.55); }
  100% { background: rgba(0, 122, 255, 0.14); }
}

@media (prefers-color-scheme: dark) {
  .curio-anchor {
    background: rgba(10, 132, 255, 0.22);
    border-bottom-color: rgb(10, 132, 255);
  }
  .curio-anchor:hover {
    background: rgba(10, 132, 255, 0.40);
  }
}

/* Curio suggested-edit anchors — orange to distinguish from comments */
.curio-edit {
  background: rgba(255, 149, 0, 0.10);
  border-bottom: 2px solid rgb(255, 149, 0);
  border-radius: 2px;
  padding: 0 2px;
  cursor: pointer;
  transition: background 0.15s;
}

.curio-edit:hover {
  background: rgba(255, 149, 0, 0.22);
}

@media (prefers-color-scheme: dark) {
  .curio-edit {
    background: rgba(255, 159, 10, 0.15);
  }
  .curio-edit:hover {
    background: rgba(255, 159, 10, 0.30);
  }
}

/* Empty state */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--text-secondary);
}

.empty-icon {
  font-size: 64px;
  margin-bottom: 16px;
  opacity: 0.6;
}

.empty-state h2 {
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.empty-state p {
  font-size: 16px;
  margin-bottom: 24px;
}

.open-button {
  background: var(--accent);
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.2s;
}

.open-button:hover {
  opacity: 0.9;
}

.open-button:active {
  opacity: 0.8;
}

.shortcut-hint {
  margin-top: 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

kbd {
  display: inline-block;
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  margin: 0 2px;
}

/* Loading state */
.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
}

/* Error state */
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--text-secondary);
}

.error-state p {
  margin-bottom: 16px;
  color: #ff3b30;
}

/* Search highlight styles */
.search-highlight {
  background: rgba(255, 213, 0, 0.4);
  border-radius: 2px;
  padding: 1px 0;
}

.search-highlight-active {
  background: rgba(255, 149, 0, 0.6);
  box-shadow: 0 0 0 2px rgba(255, 149, 0, 0.3);
}

@media (prefers-color-scheme: dark) {
  .search-highlight {
    background: rgba(255, 213, 0, 0.3);
  }

  .search-highlight-active {
    background: rgba(255, 149, 0, 0.5);
    box-shadow: 0 0 0 2px rgba(255, 149, 0, 0.25);
  }
}

/* Status notification */
.status-notification {
  position: fixed;
  bottom: 60px;
  right: 20px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  font-size: 14px;
  z-index: 1000;
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from {
    transform: translateY(10px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

/* Watcher status indicator — sits inline at the end of the top toolbar */
.watcher-status {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.watcher-status.status-error {
  cursor: pointer;
  border-color: #ff3b30;
}

.watcher-status.status-error:hover {
  background: rgba(255, 59, 48, 0.1);
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #8e8e93;
  transition: background 0.2s ease;
}

.watcher-status.status-watching .status-dot {
  background: #34c759;
  animation: pulse 2s ease-in-out infinite;
}

.watcher-status.status-error .status-dot {
  background: #ff3b30;
  animation: none;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

@media (prefers-color-scheme: dark) {
  .status-notification {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .watcher-status {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
}

/* ============================================
   Copy Buttons
   ============================================ */

.copy-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
  z-index: 10;
}

.copy-btn:hover {
  background: var(--border);
  color: var(--text-primary);
}

.copy-btn:active {
  transform: scale(0.95);
}

.copy-btn-copied {
  color: #34c759;
}

.copy-btn-copied:hover {
  color: #34c759;
}

/* Per-element copy buttons */
.copy-item {
  position: relative;
}

.copy-item:hover > .copy-item-btn {
  opacity: 1;
}

.copy-item-btn {
  top: 0;
  right: -44px;
}

/* Code block copy buttons */
.code-block-wrapper {
  position: relative;
}

.code-block-wrapper > pre[class*="language-"] {
  margin-top: 0;
  margin-bottom: 0;
}

.code-block-wrapper {
  margin: 1.25em 0;
}

.code-block-wrapper:hover > .copy-code-btn {
  opacity: 1;
}

.copy-code-btn {
  top: 8px;
  right: 8px;
  background: rgba(0, 0, 0, 0.3);
  border-color: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.7);
}

.curio-code-comment-btn {
  top: 8px;
  right: 48px;
  background: rgba(0, 0, 0, 0.3);
  border-color: rgba(255, 255, 255, 0.1);
  font-size: 14px;
  line-height: 1;
}

.code-block-wrapper:hover > .curio-code-comment-btn {
  opacity: 1;
}

.curio-code-comment-btn:hover {
  background: rgba(0, 0, 0, 0.5);
}

.copy-code-btn:hover {
  background: rgba(0, 0, 0, 0.5);
  color: rgba(255, 255, 255, 0.9);
}

/* Mermaid copy buttons */
.mermaid-container:hover > .copy-mermaid-btn {
  opacity: 1;
}

.copy-mermaid-btn {
  top: 8px;
  right: 8px;
}

/* Adjust button position for narrow viewports */
@media (max-width: 900px) {
  .copy-item-btn {
    right: 0;
    top: -4px;
  }
}
</style>
