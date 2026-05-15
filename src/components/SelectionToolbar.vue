<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  // Element to listen for selections inside (the rendered markdown article)
  target: { type: Object, required: true }
})

const emit = defineEmits(['comment', 'suggest'])

const visible = ref(false)
const x = ref(0)
const y = ref(0)
let pendingSelection = null

// Approximate toolbar size; clamp so it stays on-screen.
const TOOLBAR_WIDTH = 240
const TOOLBAR_HEIGHT = 36
const VIEWPORT_MARGIN = 8

const clampedStyle = computed(() => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const halfW = TOOLBAR_WIDTH / 2
  const minLeft = VIEWPORT_MARGIN + halfW
  const maxLeft = vw - VIEWPORT_MARGIN - halfW
  const clampedX = Math.min(maxLeft, Math.max(minLeft, x.value))

  // Vertically: default places toolbar above (translate -100%). Flip below if too close to top.
  let top = y.value
  let translateY = '-100%'
  if (top - TOOLBAR_HEIGHT < VIEWPORT_MARGIN) {
    // Flip to below the selection
    top = y.value + TOOLBAR_HEIGHT + 8
    translateY = '0'
  }
  if (top > vh - VIEWPORT_MARGIN) top = vh - VIEWPORT_MARGIN
  return {
    left: `${clampedX}px`,
    top: `${top}px`,
    transform: `translate(-50%, ${translateY})`
  }
})

function clearAndHide() {
  visible.value = false
  pendingSelection = null
}

function onSelectionChange() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    visible.value = false
    return
  }
  const range = sel.getRangeAt(0)
  const container = props.target?.value || props.target
  if (!container) {
    visible.value = false
    return
  }
  // Only respond to selections inside the target
  if (!container.contains(range.commonAncestorContainer)) {
    visible.value = false
    return
  }
  const text = sel.toString().trim()
  if (!text) {
    visible.value = false
    return
  }
  // Refuse to offer annotation where it can't succeed
  if (!canAnnotateRange(range, container)) {
    visible.value = false
    return
  }

  const rect = range.getBoundingClientRect()
  // Anchor toolbar above the selection, centered horizontally
  x.value = rect.left + rect.width / 2
  y.value = rect.top - 8
  pendingSelection = {
    text,
    // Surrounding text context for source-anchor matching
    contextBefore: getContextBefore(range, container, 60),
    contextAfter: getContextAfter(range, container, 60)
  }
  visible.value = true
}

/**
 * Returns true only when the selection can become an annotation:
 *  - Not inside fenced or inline code (<pre> or <code>)
 *  - Not inside an existing curio anchor/edit span
 *  - Not crossing block-level boundaries
 */
function canAnnotateRange(range, container) {
  const startNode = nodeOf(range.startContainer)
  const endNode = nodeOf(range.endContainer)
  if (!startNode || !endNode) return false

  // Code (fenced or inline)
  if (startNode.closest('pre, code')) return false
  if (endNode.closest('pre, code')) return false

  // Inside an existing curio annotation (nesting forbidden)
  if (startNode.closest('.curio-anchor, .curio-edit')) return false
  if (endNode.closest('.curio-anchor, .curio-edit')) return false

  // Cross-block: each direct child of .markdown-body is a block. If start and
  // end live under different direct children, the selection spans blocks.
  const startBlock = blockAncestor(startNode, container)
  const endBlock = blockAncestor(endNode, container)
  if (!startBlock || !endBlock || startBlock !== endBlock) return false

  return true
}

function nodeOf(n) {
  return n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement
}

function blockAncestor(node, container) {
  // Walk up until parent === container; return the child of container.
  let cur = node
  while (cur && cur.parentElement !== container) {
    cur = cur.parentElement
  }
  return cur
}

function getContextBefore(range, container, chars) {
  try {
    const r = range.cloneRange()
    r.setStart(container, 0)
    return r.toString().slice(-chars)
  } catch {
    return ''
  }
}

function getContextAfter(range, container, chars) {
  try {
    const r = range.cloneRange()
    // Move end to end of container
    r.setEnd(container, container.childNodes.length)
    // Now r covers from selection start to container end; we want from selection end forward
    const r2 = range.cloneRange()
    r2.collapse(false)
    r2.setEnd(container, container.childNodes.length)
    return r2.toString().slice(0, chars)
  } catch {
    return ''
  }
}

function handleComment() {
  if (!pendingSelection) return
  emit('comment', pendingSelection)
  visible.value = false
}

function handleSuggest() {
  if (!pendingSelection) return
  emit('suggest', pendingSelection)
  visible.value = false
}

// Expose for external triggers (e.g. Cmd+Shift+M / Cmd+Shift+E)
function triggerCommentFromCurrentSelection() {
  onSelectionChange()
  if (visible.value) handleComment()
}
function triggerSuggestFromCurrentSelection() {
  onSelectionChange()
  if (visible.value) handleSuggest()
}

defineExpose({
  triggerCommentFromCurrentSelection,
  triggerSuggestFromCurrentSelection,
  clearAndHide
})

onMounted(() => {
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('mousedown', (e) => {
    // Hide if click is outside the toolbar itself
    if (!e.target.closest('.curio-selection-toolbar')) {
      // selectionchange will re-fire and hide if collapsed
    }
  })
})

onUnmounted(() => {
  document.removeEventListener('selectionchange', onSelectionChange)
})
</script>

<template>
  <div
    v-if="visible"
    class="curio-selection-toolbar"
    :style="clampedStyle"
    @mousedown.prevent
  >
    <button type="button" @click="handleComment" title="Comment on selection (⌘⇧M)">
      💬 Comment
    </button>
    <button type="button" @click="handleSuggest" title="Suggest an edit (⌘⇧E)">
      ✏️ Suggest edit
    </button>
  </div>
</template>

<style scoped>
.curio-selection-toolbar {
  position: fixed;
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1100;
  animation: curio-toolbar-fade 0.12s ease-out;
}

button {
  background: transparent;
  border: none;
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
}

button:hover {
  background: var(--border);
}

@keyframes curio-toolbar-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
