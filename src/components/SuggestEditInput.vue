<script setup>
import { ref, watch, computed, nextTick } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  anchorX: { type: Number, default: 0 },
  anchorY: { type: Number, default: 0 },
  originalText: { type: String, default: '' }
})

const emit = defineEmits(['submit', 'cancel'])

const replacement = ref('')
const textareaRef = ref(null)

const POPOVER_WIDTH = 360
const VIEWPORT_MARGIN = 8

const clampedStyle = computed(() => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const halfW = POPOVER_WIDTH / 2
  const minLeft = VIEWPORT_MARGIN + halfW
  const maxLeft = vw - VIEWPORT_MARGIN - halfW
  const left = Math.min(maxLeft, Math.max(minLeft, props.anchorX))

  const estHeight = 240
  let top = props.anchorY
  let translateY = '8px'
  if (props.anchorY + estHeight + VIEWPORT_MARGIN > vh) {
    translateY = `calc(-100% - 8px)`
  }
  if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN
  return {
    left: `${left}px`,
    top: `${top}px`,
    transform: `translate(-50%, ${translateY})`
  }
})

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    // Default the replacement to the original so users can edit in place
    replacement.value = props.originalText
    await nextTick()
    textareaRef.value?.focus()
    textareaRef.value?.select()
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

const isRemoval = computed(() => !replacement.value.trim())
const isNoop = computed(() => replacement.value === props.originalText)

function submit() {
  if (isNoop.value) {
    emit('cancel')
    return
  }
  // Empty replacement -> deletion suggestion. Pass '' through.
  emit('submit', isRemoval.value ? '' : replacement.value.trim())
}
</script>

<template>
  <div
    v-if="open"
    class="curio-suggest-input"
    :style="clampedStyle"
    @mousedown.stop
  >
    <div class="row">
      <span class="label">Original</span>
      <div class="original">
        <s>{{ originalText }}</s>
      </div>
    </div>
    <div class="row">
      <span class="label">Replace with</span>
      <textarea
        ref="textareaRef"
        v-model="replacement"
        placeholder="New text… (or clear to suggest removal)  ⌘↩ to save, Esc to cancel"
        rows="3"
        @keydown="onKeydown"
      ></textarea>
      <p v-if="isRemoval" class="hint">Empty — this will suggest <strong>removing</strong> the selected text.</p>
    </div>
    <div class="actions">
      <button type="button" class="cancel" @click="emit('cancel')">Cancel</button>
      <button
        type="button"
        class="submit"
        :class="{ 'is-removal': isRemoval }"
        :disabled="isNoop"
        @click="submit"
      >{{ isRemoval ? 'Suggest removal' : 'Suggest edit' }}</button>
    </div>
  </div>
</template>

<style scoped>
.curio-suggest-input {
  position: fixed;
  width: 360px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 12px;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.original {
  border-left: 3px solid var(--accent, #007aff);
  padding: 6px 8px;
  background: var(--bg-primary);
  border-radius: 4px;
  font-size: 13px;
  color: var(--text-secondary);
  max-height: 80px;
  overflow-y: auto;
  white-space: pre-wrap;
}

.original s {
  color: var(--text-secondary);
}

textarea {
  width: 100%;
  resize: vertical;
  min-height: 70px;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: inherit;
  font-size: 13px;
  box-sizing: border-box;
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

button.submit.is-removal {
  background: rgb(255, 59, 48);
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-secondary);
  font-style: italic;
}

.hint strong {
  color: rgb(255, 59, 48);
  font-style: normal;
  font-weight: 600;
}

button.submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

button:hover:not(:disabled) {
  opacity: 0.9;
}
</style>
