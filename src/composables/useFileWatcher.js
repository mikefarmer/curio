import { ref, onUnmounted } from 'vue'
import { watchImmediate, stat } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'

export function useFileWatcher() {
  const isWatching = ref(false)
  const watcherError = ref(null)

  // Dual logging: console + file
  async function log(message, isError = false) {
    const logMessage = `[FileWatcher] ${message}`
    if (isError) {
      console.error(logMessage)
    } else {
      console.log(logMessage)
    }
    try {
      await invoke('write_log', { message: logMessage })
    } catch (e) {
      // Silently ignore logging failures
    }
  }

  // Internal state
  let unwatchFn = null
  let pollingTimer = null
  let eventQueue = []
  let processTimer = null
  let fileIdentity = { mtime: null }
  let userCallback = null
  let currentFilePath = null

  const COALESCE_MS = 100
  const POLL_MS = 5000

  // Categorize raw fs event into a simple type
  function categorizeEvent(event) {
    if (event.type?.remove) return 'deleted'
    if (event.type?.create) return 'created'
    if (event.type?.modify) return 'modified'
    // Unknown event type - log and treat as modified to be safe
    log(`Unknown event type: ${JSON.stringify(event.type)}`)
    return 'modified'
  }

  // Coalesce multiple events into a single action
  function coalesceEvents(events) {
    // Priority: deleted > created > modified
    // If file was deleted at any point and not recreated, it's deleted
    // If file was created (or deleted then created), treat as modified
    let hasDelete = false
    let hasCreateAfterDelete = false

    for (const evt of events) {
      if (evt === 'deleted') {
        hasDelete = true
        hasCreateAfterDelete = false
      } else if (evt === 'created' && hasDelete) {
        hasCreateAfterDelete = true
      }
    }

    if (hasDelete && !hasCreateAfterDelete) {
      return 'deleted'
    }
    // Any create or modify means content changed
    return 'modified'
  }

  // Process queued events
  async function processEventQueue() {
    if (eventQueue.length === 0) return

    const events = eventQueue.map(categorizeEvent)
    eventQueue = []

    const action = coalesceEvents(events)
    log(`Coalesced to action: ${action}`)

    // Update stored mtime after processing
    if (action !== 'deleted' && currentFilePath) {
      try {
        const info = await stat(currentFilePath)
        fileIdentity.mtime = info.mtime?.getTime() ?? null
      } catch {
        // File may have been deleted
      }
    }

    if (userCallback) {
      userCallback({ type: action })
    }
  }

  // Enqueue an event for coalescing
  function enqueueEvent(event) {
    log(`Raw event: ${JSON.stringify(event.type)}`)
    eventQueue.push(event)

    // Reset coalesce timer
    if (processTimer) {
      clearTimeout(processTimer)
    }
    processTimer = setTimeout(processEventQueue, COALESCE_MS)
  }

  // Polling fallback - catches events the watcher may have missed
  async function pollForChanges() {
    if (!currentFilePath) return

    try {
      const info = await stat(currentFilePath)
      const newMtime = info.mtime?.getTime() ?? null

      if (fileIdentity.mtime !== null && newMtime !== null && newMtime !== fileIdentity.mtime) {
        log(`Poll detected change - mtime: ${fileIdentity.mtime} -> ${newMtime}`)
        fileIdentity.mtime = newMtime
        if (userCallback) {
          userCallback({ type: 'modified' })
        }
      }
    } catch (e) {
      // File doesn't exist - may have been deleted
      if (fileIdentity.mtime !== null) {
        log('Poll detected deletion')
        fileIdentity.mtime = null
        if (userCallback) {
          userCallback({ type: 'deleted' })
        }
      }
    }
  }

  function startPolling() {
    stopPolling()
    pollingTimer = setInterval(pollForChanges, POLL_MS)
    log(`Polling started (interval: ${POLL_MS}ms)`)
  }

  function stopPolling() {
    if (pollingTimer) {
      clearInterval(pollingTimer)
      pollingTimer = null
    }
  }

  async function startWatching(filePath, callback) {
    // Stop any existing watcher first
    await stopWatching()

    currentFilePath = filePath
    userCallback = callback

    // Log system information for diagnostics
    log(`=== Starting file watcher ===`)
    log(`Platform: ${navigator.platform}`)
    log(`User Agent: ${navigator.userAgent}`)
    log(`File path: ${filePath}`)

    try {
      // Test stat() permission first
      log('Testing stat() permission...')
      const info = await stat(filePath)
      fileIdentity.mtime = info.mtime?.getTime() ?? null
      log(`✓ stat() succeeded - Initial mtime: ${fileIdentity.mtime}`)
      log(`File size: ${info.size} bytes, isFile: ${info.isFile}, isDirectory: ${info.isDirectory}`)

      // Start native watcher with immediate events (no internal debouncing)
      log('Starting watchImmediate...')
      unwatchFn = await watchImmediate(
        filePath,
        enqueueEvent,
        { recursive: false }
      )
      log('✓ watchImmediate started successfully')

      // Start polling fallback
      startPolling()

      isWatching.value = true
      watcherError.value = null
      log(`✓ File watching fully initialized`)
      log(`=== Watcher ready ===`)
    } catch (e) {
      const errorMsg = `Failed to start: ${e.message || e}`
      const errorDetails = e.stack || JSON.stringify(e)
      log(`✗ ${errorMsg}`, true)
      log(`Error details: ${errorDetails}`, true)
      watcherError.value = errorMsg
      isWatching.value = false
    }
  }

  async function stopWatching() {
    // Clear coalesce timer
    if (processTimer) {
      clearTimeout(processTimer)
      processTimer = null
    }

    // Stop polling
    stopPolling()

    // Stop native watcher
    if (unwatchFn) {
      try {
        await unwatchFn()
      } catch (e) {
        log(`Failed to stop: ${e.message || e}`, true)
      }
      unwatchFn = null
    }

    // Reset state
    eventQueue = []
    fileIdentity = { mtime: null }
    userCallback = null
    currentFilePath = null
    isWatching.value = false
  }

  // Cleanup on component unmount
  onUnmounted(() => {
    stopWatching()
  })

  // Get watcher status for debugging/UI feedback
  function getWatcherStatus() {
    return {
      isWatching: isWatching.value,
      error: watcherError.value,
      filePath: currentFilePath
    }
  }

  return {
    isWatching,
    watcherError,
    startWatching,
    stopWatching,
    getWatcherStatus
  }
}
