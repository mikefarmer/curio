<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const emit = defineEmits(['exportFinal', 'stripAll', 'copyPath'])

const open = ref(false)
const menuRef = ref(null)

function toggle() {
  open.value = !open.value
}

function close() {
  open.value = false
}

function handleClickOutside(e) {
  if (!menuRef.value) return
  if (!menuRef.value.contains(e.target)) close()
}

function onExport() {
  close()
  emit('exportFinal')
}

function onStrip() {
  close()
  emit('stripAll')
}

function onCopyPath() {
  close()
  emit('copyPath')
}

onMounted(() => document.addEventListener('mousedown', handleClickOutside))
onUnmounted(() => document.removeEventListener('mousedown', handleClickOutside))
</script>

<template>
  <div ref="menuRef" class="view-menu">
    <button class="view-menu-trigger" @click="toggle" title="More actions">⋯</button>
    <div v-if="open" class="view-menu-dropdown" @mousedown.stop>
      <button @click="onExport">
        <span class="label">Export Final…</span>
        <span class="hint">Strip annotations, apply edits</span>
      </button>
      <button @click="onCopyPath">
        <span class="label">Copy File Path</span>
        <span class="hint">Copy the full path to the clipboard</span>
      </button>
      <button @click="onStrip" class="destructive">
        <span class="label">Strip All Curio Markers…</span>
        <span class="hint">Remove every annotation in place</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.view-menu {
  position: relative;
}

.view-menu-trigger {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font: inherit;
  font-size: 16px;
  line-height: 1;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.view-menu-trigger:hover {
  color: var(--text-primary);
}

.view-menu-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 4px;
  min-width: 240px;
  z-index: 1200;
}

.view-menu-dropdown button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}

.view-menu-dropdown button:hover {
  background: var(--bg-primary);
}

.view-menu-dropdown button.destructive .label {
  color: rgb(255, 59, 48);
}

.label {
  font-weight: 500;
}

.hint {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
}
</style>
