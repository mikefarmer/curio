<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import mermaid from 'mermaid'
import { useMarkdown } from './composables/useMarkdown'
import { useSearch } from './composables/useSearch'
import { useFileWatcher } from './composables/useFileWatcher'
import { useSectionCopy } from './composables/useSectionCopy'
import SearchBar from './components/SearchBar.vue'

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
const { renderedHtml, setContent } = useMarkdown()

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
const { isWatching, watcherError, startWatching, stopWatching, getWatcherStatus } = useFileWatcher()

// Section copy composable
const { injectCopyButtons } = useSectionCopy()

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
  }
}, { flush: 'post' })

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
    const content = await invoke('read_file', { path })

    // Set state so article element is visible BEFORE setting content
    // This ensures the watcher can find .mermaid-container elements
    hasContent.value = true
    isLoading.value = false
    await nextTick()  // Wait for article to render
    rawContent.value = content  // Track for deduplication
    setContent(content)

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

  // Escape - Close search (handled in SearchBar too)
  if (e.key === 'Escape' && isSearchOpen.value) {
    closeSearch()
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
  checkStartupFile()
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="app">
    <!-- Search bar -->
    <SearchBar
      v-model="searchQuery"
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

      <!-- Rendered markdown content -->
      <article
        v-else
        ref="contentRef"
        class="markdown-body"
        v-html="renderedHtml"
      ></article>
    </main>
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

/* Main content */
.content {
  flex: 1;
  overflow-y: auto;
  padding: var(--content-padding);
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
