<script setup>
import { ref, watch, nextTick } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  initial: { type: String, default: '' }
})

const emit = defineEmits(['submit', 'cancel'])

const name = ref('')
const inputRef = ref(null)

watch(() => props.open, async (open) => {
  if (open) {
    name.value = props.initial || ''
    await nextTick()
    inputRef.value?.focus()
    inputRef.value?.select()
  }
})

function submit() {
  const v = name.value.trim()
  if (!v) return
  emit('submit', v)
}

function onKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault()
    submit()
  } else if (e.key === 'Escape') {
    emit('cancel')
  }
}
</script>

<template>
  <div v-if="open" class="curio-author-modal-backdrop" @mousedown.self="emit('cancel')">
    <div class="curio-author-modal">
      <h3>What name should appear on your annotations?</h3>
      <p>This is shown in the comment blockquotes Curio writes into the file.</p>
      <input
        ref="inputRef"
        v-model="name"
        type="text"
        placeholder="e.g. Mike"
        @keydown="onKey"
      />
      <div class="actions">
        <button class="cancel" @click="emit('cancel')">Cancel</button>
        <button class="submit" :disabled="!name.trim()" @click="submit">Save</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.curio-author-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.curio-author-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px 22px;
  width: 360px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
}

h3 {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
}

p {
  margin: 0 0 14px;
  color: var(--text-secondary);
  font-size: 12px;
}

input {
  width: 100%;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font: inherit;
  font-size: 14px;
  box-sizing: border-box;
}

input:focus {
  outline: 2px solid var(--accent, #007aff);
  outline-offset: -1px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 14px;
}

button {
  font: inherit;
  font-size: 13px;
  padding: 6px 14px;
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
</style>
