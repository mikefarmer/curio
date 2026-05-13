<script setup>
import { ref, watch, computed, nextTick } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  anchorX: { type: Number, default: 0 },
  anchorY: { type: Number, default: 0 },
  selectionText: { type: String, default: '' }
})

const emit = defineEmits(['submit', 'cancel'])

const body = ref('')
const textareaRef = ref(null)

// Popover dimensions match the CSS below (320px wide + 10px padding both sides)
const POPOVER_WIDTH = 320
const VIEWPORT_MARGIN = 8

// Clamp position to keep the popover fully on-screen.
// The popover's `transform: translate(-50%, 8px)` means we center horizontally
// on `left`. Compute a left that, after the -50% shift, lies within viewport.
const clampedStyle = computed(() => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const halfW = POPOVER_WIDTH / 2
  // Bounds for the `left` (which is the popover's horizontal center):
  const minLeft = VIEWPORT_MARGIN + halfW
  const maxLeft = vw - VIEWPORT_MARGIN - halfW
  const left = Math.min(maxLeft, Math.max(minLeft, props.anchorX))

  // Vertically: prefer placement below (default), but flip above if too close to bottom.
  // Rough estimated height ~200px including padding.
  const estHeight = 200
  let top = props.anchorY
  let translateY = '8px'
  if (props.anchorY + estHeight + VIEWPORT_MARGIN > vh) {
    // Flip above
    translateY = `calc(-100% - 8px)`
  }
  // Also clamp top so it doesn't go negative
  if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN
  return {
    left: `${left}px`,
    top: `${top}px`,
    transform: `translate(-50%, ${translateY})`
  }
})

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    body.value = ''
    await nextTick()
    textareaRef.value?.focus()
  }
})

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    submit()
  }
}

function submit() {
  const text = body.value.trim()
  if (!text) return
  emit('submit', text)
}
</script>

<template>
  <div
    v-if="open"
    class="curio-comment-input"
    :style="clampedStyle"
    @mousedown.stop
  >
    <div class="selection-preview" :title="selectionText">
      "<span>{{ selectionText.length > 60 ? selectionText.slice(0, 60) + '…' : selectionText }}</span>"
    </div>
    <textarea
      ref="textareaRef"
      v-model="body"
      placeholder="Add a comment…  (⌘↩ to save, Esc to cancel)"
      rows="3"
      @keydown="onKeydown"
    ></textarea>
    <div class="actions">
      <button type="button" class="cancel" @click="emit('cancel')">Cancel</button>
      <button type="button" class="submit" :disabled="!body.trim()" @click="submit">Comment</button>
    </div>
  </div>
</template>

<style scoped>
.curio-comment-input {
  position: fixed;
  width: 320px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 10px;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.selection-preview {
  font-size: 12px;
  color: var(--text-secondary);
  font-style: italic;
  border-left: 3px solid var(--accent, #007aff);
  padding-left: 8px;
  line-height: 1.4;
}

textarea {
  width: 100%;
  resize: vertical;
  min-height: 60px;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: inherit;
  font-size: 13px;
}

textarea:focus {
  outline: 2px solid var(--accent, #007aff);
  outline-offset: -1px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

button {
  font: inherit;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
}

button.submit {
  background: var(--accent, #007aff);
  color: white;
  border-color: transparent;
}

button.submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

button:hover:not(:disabled) {
  opacity: 0.9;
}
</style>
