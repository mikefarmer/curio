<script setup>
import { ref, watch, nextTick } from 'vue'

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  matchDisplay: {
    type: String,
    default: ''
  },
  isOpen: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:modelValue', 'close', 'next', 'prev'])

const inputRef = ref(null)

// Focus input when search opens
watch(() => props.isOpen, async (isOpen) => {
  if (isOpen) {
    await nextTick()
    inputRef.value?.focus()
    inputRef.value?.select()
  }
})

function handleKeydown(e) {
  if (e.key === 'Escape') {
    emit('close')
  } else if (e.key === 'Enter') {
    if (e.shiftKey) {
      emit('prev')
    } else {
      emit('next')
    }
    e.preventDefault()
  }
}

function updateValue(e) {
  emit('update:modelValue', e.target.value)
}
</script>

<template>
  <div v-if="isOpen" class="search-bar">
    <div class="search-input-wrapper">
      <svg class="search-icon" viewBox="0 0 16 16" fill="currentColor">
        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
      </svg>
      <input
        ref="inputRef"
        type="text"
        class="search-input"
        placeholder="Search in document..."
        :value="modelValue"
        @input="updateValue"
        @keydown="handleKeydown"
      />
      <span v-if="matchDisplay" class="match-count">{{ matchDisplay }}</span>
    </div>
    <div class="search-actions">
      <button
        class="search-btn"
        title="Previous match (Shift+Enter)"
        @click="$emit('prev')"
      >
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M7.646 4.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1-.708.708L8 5.707l-5.646 5.647a.5.5 0 0 1-.708-.708l6-6z"/>
        </svg>
      </button>
      <button
        class="search-btn"
        title="Next match (Enter)"
        @click="$emit('next')"
      >
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/>
        </svg>
      </button>
      <button
        class="search-btn search-close"
        title="Close (Esc)"
        @click="$emit('close')"
      >
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

.search-input-wrapper {
  display: flex;
  align-items: center;
  flex: 1;
  max-width: 400px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 10px;
}

.search-icon {
  width: 14px;
  height: 14px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  border: none;
  background: transparent;
  padding: 8px;
  font-size: 13px;
  color: var(--text-primary);
  outline: none;
  font-family: var(--font-text);
}

.search-input::placeholder {
  color: var(--text-secondary);
}

.match-count {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  padding-right: 4px;
}

.search-actions {
  display: flex;
  gap: 4px;
}

.search-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.15s ease;
}

.search-btn:hover {
  background: var(--bg-primary);
  color: var(--text-primary);
}

.search-btn svg {
  width: 14px;
  height: 14px;
}

.search-close:hover {
  color: #ff3b30;
}
</style>
