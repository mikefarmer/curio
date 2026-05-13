<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { save } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { open, ask } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import mermaid from 'mermaid'
import { useMarkdown } from './composables/useMarkdown'
import { useSearch } from './composables/useSearch'
import { useFileWatcher } from './composables/useFileWatcher'
import { useSectionCopy } from './composables/useSectionCopy'
import { useAnnotations, stripAnnotations } from './composables/useAnnotations'
import { useUndoStack } from './composables/useUndoStack'
import SearchBar from './components/SearchBar.vue'
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
  searchScope,
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
const panelOpen = ref(true)
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
let directWriteTimer = null         // debounce handle for direct-mode disk writes

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

  // Cmd+F - Search
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault()
    openSearch()
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

  // Cmd+Shift+D - Toggle Direct edit mode
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault()
    setEditMode(editMode.value === 'direct' ? 'suggest' : 'direct')
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

  // No file param - this is the main window, check for CLI arguments
  try {
    const cliFiles = await invoke('get_cli_files')

    if (cliFiles.length > 0) {
      // Load first file in this window
      await loadFile(cliFiles[0])

      // Open additional windows for remaining files
      for (let i = 1; i < cliFiles.length; i++) {
        await invoke('create_window', { filePath: cliFiles[i] })
      }
    }
  } catch (e) {
    console.error('Failed to get CLI files:', e)
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  // Load saved author name; if none, we'll prompt on first comment.
  initAuthor()
  checkStartupFile()
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
    rawContent.value = newContent
    setContent(newContent)
    refreshAnnotations(newContent)
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
    rawContent.value = newContent
    setContent(newContent)
    refreshAnnotations(newContent)
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
  rawContent.value = newContent
  setContent(newContent)
  refreshAnnotations(newContent)
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
    rawContent.value = newContent
    setContent(newContent)
    refreshAnnotations(newContent)
    await persistSidecar()
  } catch (e) {
    console.error('[Annotate] delete failed:', e)
  }
}

function onJumpTo(id) {
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
    // Leaving direct mode: flush any pending write synchronously so the
    // file and rawContent agree before the rendered view comes back.
    flushDirectWrite({ immediate: true })
    editMode.value = 'suggest'
  }
}

function onDirectInput(e) {
  directBuffer.value = e.target.value
  if (directWriteTimer) clearTimeout(directWriteTimer)
  directWriteTimer = setTimeout(() => flushDirectWrite(), 500)
}

async function flushDirectWrite({ immediate = false } = {}) {
  if (directWriteTimer) {
    clearTimeout(directWriteTimer)
    directWriteTimer = null
  }
  if (!filePath.value) return
  if (directBuffer.value === rawContent.value) return

  const newContent = directBuffer.value
  try {
    markSelfWrite()
    await invoke('write_md_atomic', { path: filePath.value, content: newContent })
    rawContent.value = newContent
    // Skip re-rendering HTML while user is actively typing — costly and
    // they're not looking at it. Sync renderedHtml only on mode switch
    // (immediate=true) so the suggest-mode view is fresh on return.
    if (immediate) setContent(newContent)
    refreshAnnotations(newContent)
    await persistSidecar()
  } catch (e) {
    console.error('[Annotate] direct write failed:', e)
    showStatusNotification(`Could not save: ${e.message || e}`)
  }
}

// If the file changes externally while we're in direct mode, reload the
// textarea buffer so the user sees the new content. Any unsaved <500ms
// typing burst is lost — acceptable per the existing in-flight policy.
watch(rawContent, (newVal) => {
  if (editMode.value === 'direct' && newVal !== directBuffer.value) {
    // Avoid clobbering an in-flight debounced write by checking pending state
    if (!directWriteTimer) directBuffer.value = newVal
  }
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
})
</script>

<template>
  <div class="app">
    <!-- Search bar -->
    <SearchBar
      v-model="searchQuery"
      v-model:scope="searchScope"
      :is-open="isSearchOpen"
      :match-display="matchDisplay"
      @close="closeSearch"
      @next="nextMatch"
      @prev="prevMatch"
    />

    <!-- Status notification -->
    <div v-if="showStatus" class="status-notification">
      {{ statusMessage }}
    </div>

    <!-- Watcher status indicator -->
    <div
      v-if="hasContent"
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

    <!-- View-mode + panel toggle toolbar (top-right) -->
    <div
      v-if="hasContent"
      class="curio-view-toolbar"
      :class="{ 'panel-open': panelOpen }"
    >
      <div class="view-mode-toggle" role="group" aria-label="View mode">
        <button
          :class="{ active: viewMode === 'annotated' }"
          @click="viewMode = 'annotated'"
          :disabled="editMode === 'direct'"
          title="Show annotations and comments"
        >Annotated</button>
        <button
          :class="{ active: viewMode === 'original' }"
          @click="viewMode = 'original'"
          :disabled="editMode === 'direct'"
          title="Show the document as if no annotations existed"
        >Original</button>
        <button
          :class="{ active: viewMode === 'final' }"
          @click="viewMode = 'final'"
          :disabled="editMode === 'direct'"
          title="Preview the document with all suggested edits applied"
        >Final</button>
      </div>
      <!-- Edit-mode toggle (spec §12.4): Suggest vs Direct -->
      <div class="edit-mode-toggle" role="group" aria-label="Edit mode">
        <button
          :class="{ active: editMode === 'suggest' }"
          @click="setEditMode('suggest')"
          title="Selections create annotations (default)"
        >Suggest</button>
        <button
          :class="{ active: editMode === 'direct' }"
          @click="setEditMode('direct')"
          title="Edit the raw markdown directly (⌘⇧D)"
        >Direct</button>
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
      />
    </div>

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
        v-if="hasContent && panelOpen"
        :open="panelOpen"
        :annotations="annotations"
        :orphans="orphans"
        :orphan-suggestions="orphanSuggestions"
        :reanchoring-id="reanchoringId"
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
.curio-view-toolbar {
  position: fixed;
  top: 12px;
  right: 16px;
  display: flex;
  gap: 8px;
  align-items: center;
  z-index: 100;
  transition: right 0.15s ease;
}

/* Annotation panel is 320px wide — shift the toolbar left of it when open
   so it sits over the content area instead of the panel header. */
.curio-view-toolbar.panel-open {
  right: calc(320px + 16px);
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

/* Curio annotation anchors */
.markdown-body :deep(.curio-anchor),
.curio-anchor {
  background: rgba(0, 122, 255, 0.08);
  border-bottom: 2px solid var(--accent, #007aff);
  border-radius: 2px;
  padding: 0 2px;
  cursor: pointer;
  transition: background 0.15s;
}

.markdown-body :deep(.curio-anchor:hover),
.curio-anchor:hover {
  background: rgba(0, 122, 255, 0.18);
}

.markdown-body :deep(.curio-anchor-flash),
.curio-anchor-flash {
  animation: curio-flash 1.2s ease-out;
}

@keyframes curio-flash {
  0% { background: rgba(255, 213, 0, 0.55); }
  100% { background: rgba(0, 122, 255, 0.08); }
}

@media (prefers-color-scheme: dark) {
  .markdown-body :deep(.curio-anchor),
  .curio-anchor {
    background: rgba(10, 132, 255, 0.15);
  }
  .markdown-body :deep(.curio-anchor:hover),
  .curio-anchor:hover {
    background: rgba(10, 132, 255, 0.28);
  }
}

/* Curio suggested-edit anchors — orange to distinguish from comments */
.markdown-body :deep(.curio-edit),
.curio-edit {
  background: rgba(255, 149, 0, 0.10);
  border-bottom: 2px solid rgb(255, 149, 0);
  border-radius: 2px;
  padding: 0 2px;
  cursor: pointer;
  transition: background 0.15s;
}

.markdown-body :deep(.curio-edit:hover),
.curio-edit:hover {
  background: rgba(255, 149, 0, 0.22);
}

.markdown-body :deep(.curio-anchor-flash),
.curio-anchor-flash {
  animation: curio-flash 1.2s ease-out;
}

@media (prefers-color-scheme: dark) {
  .markdown-body :deep(.curio-edit),
  .curio-edit {
    background: rgba(255, 159, 10, 0.15);
  }
  .markdown-body :deep(.curio-edit:hover),
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

/* Watcher status indicator */
.watcher-status {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 50%;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  z-index: 999;
  transition: all 0.2s ease;
}

.watcher-status:hover {
  transform: scale(1.1);
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
