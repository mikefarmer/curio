import { ref, onUnmounted } from 'vue'
import { watch as watchFile } from '@tauri-apps/plugin-fs'

export function useFileWatcher() {
  const isWatching = ref(false)
  let unwatchFn = null
  let debounceTimer = null

  async function startWatching(filePath, callback) {
    // Stop any existing watcher first
    await stopWatching()

    try {
      unwatchFn = await watchFile(
        filePath,
        (event) => {
          // Debounce the callback to avoid multiple rapid triggers
          if (debounceTimer) {
            clearTimeout(debounceTimer)
          }
          debounceTimer = setTimeout(() => {
            callback(event)
          }, 500)
        },
        { recursive: false }
      )
      isWatching.value = true
    } catch (e) {
      console.error('Failed to start file watcher:', e)
      isWatching.value = false
    }
  }

  async function stopWatching() {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    if (unwatchFn) {
      try {
        await unwatchFn()
      } catch (e) {
        console.error('Failed to stop file watcher:', e)
      }
      unwatchFn = null
    }
    isWatching.value = false
  }

  // Cleanup on component unmount
  onUnmounted(() => {
    stopWatching()
  })

  return {
    isWatching,
    startWatching,
    stopWatching
  }
}
