<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import mermaid from 'mermaid'
import { useMarkdown } from './composables/useMarkdown'
import { useSearch } from './composables/useSearch'
import { useFileWatcher } from './composables/useFileWatcher'
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
const { isWatching, startWatching, stopWatching } = useFileWatcher()

// State
const filename = ref('')
const filePath = ref('')
const isLoading = ref(false)
const error = ref('')
const hasContent = ref(false)
const contentRef = ref(null)

// Link content element to search
watch(contentRef, (el) => {
  contentElement.value = el
})

// Clear search highlights when content changes
// Use flush: 'post' to ensure DOM is updated before rendering Mermaid
watch(renderedHtml, () => {
  clearHighlights()
  if (renderedHtml.value) {
    renderMermaidDiagrams()
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
  // Handle different event types based on the fs plugin's event structure
  const eventType = event.type?.modify ? 'modified' :
                    event.type?.create ? 'created' :
                    event.type?.remove ? 'deleted' : null

  if (eventType === 'modified' || eventType === 'created') {
    try {
      // Save scroll position
      const scrollPos = contentRef.value?.scrollTop ?? 0

      // Reload content
      const content = await invoke('read_file', { path: filePath.value })
      setContent(content)

      // Restore scroll position after render
      await nextTick()
      if (contentRef.value) {
        contentRef.value.scrollTop = scrollPos
      }
    } catch (e) {
      console.error('Failed to reload file:', e)
    }
  } else if (eventType === 'deleted') {
    error.value = 'The file has been deleted or moved.'
    hasContent.value = false
    await stopWatching()
  }
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
    setContent(content)

    // Update window title
    const currentWindow = getCurrentWindow()
    await currentWindow.setTitle(filename.value)

    // Start watching the file for changes
    await startWatching(path, handleFileChange)
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
</style>
