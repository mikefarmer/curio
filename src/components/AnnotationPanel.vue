<script setup>
import { ref, computed, watch, nextTick } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: true },
  annotations: { type: Array, default: () => [] },
  orphans: { type: Array, default: () => [] },
  // Map<orphanId, { idx, candidates, anchorText }> with fuzzy suggestions for each orphan
  orphanSuggestions: { type: Object, default: () => ({}) },
  // True while waiting for the user to select text for an orphan re-anchor
  reanchoringId: { type: String, default: null },
  // Currently focused annotation id (set when user clicks a highlight in the doc)
  activeId: { type: String, default: null }
})

// Refs keyed by annotation id so we can scroll the active card into view
const cardRefs = ref({})
function setCardRef(id, el) {
  if (el) cardRefs.value[id] = el
  else delete cardRefs.value[id]
}

watch(() => props.activeId, async (id) => {
  if (!id) return
  await nextTick()
  const el = cardRefs.value[id]
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}, { immediate: true })

const emit = defineEmits([
  'close', 'jumpTo', 'delete', 'dismissOrphan',
  'acceptEdit', 'rejectEdit', 'acceptAllEdits', 'rejectAllEdits',
  'acceptSuggestion', 'startReanchor', 'cancelReanchor'
])

const filter = ref('all') // all | comments | edits | orphans

const commentCount = computed(() => props.annotations.filter(a => a.type === 'comment' || a.type === 'code-comment').length)
const editCount = computed(() => props.annotations.filter(a => a.type === 'edit').length)

const filteredAnnotations = computed(() => {
  if (filter.value === 'orphans') return []
  if (filter.value === 'comments') return props.annotations.filter(a => a.type !== 'edit')
  if (filter.value === 'edits') return props.annotations.filter(a => a.type === 'edit')
  return props.annotations
})

const showOrphans = computed(() => filter.value === 'all' || filter.value === 'orphans')

function formatTs(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return ts
  }
}

function previewBody(body) {
  if (!body) return ''
  // Strip the "> 💬 **NAME**: " prefix for compact display
  return body.replace(/^>\s*💬\s*\*\*[^*]+\*\*:\s*/, '').replace(/^>\s*/, '')
}
</script>

<template>
  <aside v-if="open" class="curio-annotation-panel">
    <header>
      <h3>Annotations</h3>
      <button class="close" @click="emit('close')" title="Close panel">✕</button>
    </header>

    <div class="filters">
      <button :class="{ active: filter === 'all' }" @click="filter = 'all'">
        All ({{ annotations.length + orphans.length }})
      </button>
      <button :class="{ active: filter === 'comments' }" @click="filter = 'comments'">
        Comments ({{ commentCount }})
      </button>
      <button :class="{ active: filter === 'edits' }" @click="filter = 'edits'">
        Edits ({{ editCount }})
      </button>
      <button :class="{ active: filter === 'orphans' }" @click="filter = 'orphans'">
        Orphans ({{ orphans.length }})
      </button>
    </div>

    <div v-if="editCount > 0" class="bulk-bar">
      <span>{{ editCount }} pending edit{{ editCount === 1 ? '' : 's' }}</span>
      <div>
        <button class="bulk-accept" @click="emit('acceptAllEdits')" title="Accept every pending edit">
          Accept all
        </button>
        <button class="bulk-reject" @click="emit('rejectAllEdits')" title="Reject every pending edit">
          Reject all
        </button>
      </div>
    </div>

    <div class="list">
      <div
        v-for="ann in filteredAnnotations"
        :key="ann.id"
        :ref="el => setCardRef(ann.id, el)"
        class="annotation"
        :class="{ 'is-edit': ann.type === 'edit', 'is-active': activeId === ann.id }"
        @click="emit('jumpTo', ann.id)"
      >
        <div class="meta">
          <strong>{{ ann.author }}</strong>
          <span class="ts">{{ formatTs(ann.created_at || ann.updated_at) }}</span>
          <span v-if="ann.type === 'edit'" class="edit-badge">edit</span>
        </div>

        <!-- Suggested edit body -->
        <template v-if="ann.type === 'edit'">
          <div class="edit-preview">
            <div class="old"><s>{{ ann.oldText || ann.old_text }}</s></div>
            <div class="arrow">{{ (ann.editKind || ann.edit_kind) === 'delete' ? '✕' : '→' }}</div>
            <div v-if="(ann.editKind || ann.edit_kind) === 'delete'" class="removed">(remove)</div>
            <div v-else class="new"><strong>{{ ann.newText || ann.new_text }}</strong></div>
          </div>
          <div class="actions">
            <button class="reject" @click.stop="emit('rejectEdit', ann.id)" title="Discard this suggestion">
              Reject
            </button>
            <button class="accept" @click.stop="emit('acceptEdit', ann.id)" :title="(ann.editKind || ann.edit_kind) === 'delete' ? 'Apply: remove this text from the file' : 'Apply this suggestion to the file'">
              Accept
            </button>
          </div>
        </template>

        <!-- Code-block comment body -->
        <template v-else-if="ann.type === 'code-comment'">
          <div class="code-anchor" :title="'Code block ' + (ann.codeHash || ann.code_hash || '')">
            <span class="code-badge">code</span>
            <code>{{ (ann.codeHash || ann.code_hash || '').slice(0, 6) }}</code>
          </div>
          <div class="body">{{ previewBody(ann.body || ann.body_md) }}</div>
          <div class="actions">
            <button @click.stop="emit('delete', ann.id)" title="Delete annotation">Delete</button>
          </div>
        </template>

        <!-- Inline text-range comment body -->
        <template v-else>
          <div class="anchor" :title="ann.anchorText || ann.anchor_text">
            "{{ (ann.anchorText || ann.anchor_text || '').slice(0, 50) }}{{ (ann.anchorText || ann.anchor_text || '').length > 50 ? '…' : '' }}"
          </div>
          <div class="body">{{ previewBody(ann.body || ann.body_md) }}</div>
          <div class="actions">
            <button @click.stop="emit('delete', ann.id)" title="Delete annotation">Delete</button>
          </div>
        </template>
      </div>

      <template v-if="showOrphans && orphans.length">
        <div class="orphan-divider" v-if="filter === 'all'">Orphans</div>
        <div
          v-for="o in orphans"
          :key="'o-' + o.id"
          class="annotation orphan"
          :class="{ 'is-reanchoring': reanchoringId === o.id }"
        >
          <div class="meta">
            <strong>{{ o.author }}</strong>
            <span class="ts">{{ formatTs(o.created_at) }}</span>
            <span class="orphan-badge">orphan</span>
          </div>
          <div class="anchor" :title="o.anchor_text">"{{ (o.anchor_text || '').slice(0, 50) }}…"</div>
          <div class="body">{{ previewBody(o.body_md) }}</div>

          <!-- Fuzzy "Did you mean here?" suggestion -->
          <div
            v-if="orphanSuggestions[o.id] && orphanSuggestions[o.id].candidates === 1 && reanchoringId !== o.id"
            class="suggestion"
          >
            <span class="suggestion-label">Found a likely match in the document.</span>
            <button class="suggestion-accept" @click.stop="emit('acceptSuggestion', o.id)">
              Re-anchor here →
            </button>
          </div>
          <div
            v-else-if="orphanSuggestions[o.id] && orphanSuggestions[o.id].candidates > 1 && reanchoringId !== o.id"
            class="suggestion ambiguous"
          >
            <span class="suggestion-label">
              {{ orphanSuggestions[o.id].candidates }} possible matches — pick manually.
            </span>
          </div>

          <!-- Re-anchor mode indicator -->
          <div v-if="reanchoringId === o.id" class="reanchor-mode">
            <span>Select text in the document to re-anchor here…</span>
            <button class="cancel-reanchor" @click.stop="emit('cancelReanchor')">Cancel</button>
          </div>

          <div class="actions" v-if="reanchoringId !== o.id">
            <button @click.stop="emit('startReanchor', o.id)">Re-anchor</button>
            <button @click.stop="emit('dismissOrphan', o.id)">Dismiss</button>
          </div>
        </div>
      </template>

      <div v-if="filteredAnnotations.length === 0 && (!showOrphans || orphans.length === 0)" class="empty">
        No annotations yet.<br>
        <small>Select text in the document and click 💬 to add a comment.</small>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.curio-annotation-panel {
  width: 320px;
  border-left: 1px solid var(--border);
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  height: 100%;
  font-size: 13px;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
}

.filters {
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.filters button {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 12px;
  padding: 3px 10px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}

.filters button.active {
  background: var(--bg-primary);
  border-color: var(--border);
  color: var(--text-primary);
}

.bulk-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary);
}

.bulk-bar > div {
  display: flex;
  gap: 4px;
}

.bulk-bar button {
  font: inherit;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
}

.bulk-bar button.bulk-accept:hover {
  background: rgba(52, 199, 89, 0.12);
  border-color: rgb(52, 199, 89);
}

.bulk-bar button.bulk-reject:hover {
  background: rgba(255, 59, 48, 0.12);
  border-color: rgb(255, 59, 48);
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.annotation {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-left: 3px solid rgb(0, 122, 255);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.annotation:hover {
  border-color: var(--accent, #007aff);
  border-left-color: rgb(0, 122, 255);
}

.annotation.is-edit {
  border-left: 3px solid rgb(255, 149, 0);
}

.annotation.is-edit:hover {
  border-left-color: rgb(255, 149, 0);
}

.annotation.is-active {
  border-color: rgb(0, 122, 255);
  box-shadow: 0 0 0 2px rgba(0, 122, 255, 0.25);
  background: rgba(0, 122, 255, 0.06);
}

.annotation.is-active.is-edit {
  border-color: rgb(255, 149, 0);
  box-shadow: 0 0 0 2px rgba(255, 149, 0, 0.25);
  background: rgba(255, 149, 0, 0.06);
}

.edit-badge {
  background: rgba(255, 149, 0, 0.18);
  color: rgb(180, 90, 0);
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.edit-preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.4;
  margin: 4px 0 6px;
}

.edit-preview .old {
  color: var(--text-secondary);
  word-break: break-word;
}

.edit-preview .arrow {
  color: rgb(255, 149, 0);
  font-weight: 600;
  text-align: center;
}

.edit-preview .new {
  color: var(--text-primary);
  word-break: break-word;
}

.edit-preview .removed {
  color: var(--text-secondary);
  font-style: italic;
  font-size: 12px;
}

.actions button.accept {
  color: rgb(20, 130, 60);
}

.actions button.accept:hover {
  background: rgba(52, 199, 89, 0.15);
}

.actions button.reject {
  color: rgb(180, 60, 50);
}

.actions button.reject:hover {
  background: rgba(255, 59, 48, 0.12);
}

.annotation.orphan {
  border-style: dashed;
  cursor: default;
  opacity: 0.85;
}

.annotation.is-reanchoring {
  border-color: rgb(0, 122, 255);
  background: rgba(0, 122, 255, 0.04);
  opacity: 1;
}

.suggestion {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 6px 0;
  padding: 6px 8px;
  background: rgba(52, 199, 89, 0.10);
  border-radius: 4px;
  font-size: 11px;
}

.suggestion.ambiguous {
  background: rgba(255, 149, 0, 0.10);
}

.suggestion-label {
  color: var(--text-secondary);
}

.suggestion-accept {
  background: rgb(52, 199, 89);
  color: white;
  border: none;
  font: inherit;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.suggestion-accept:hover { opacity: 0.9; }

.reanchor-mode {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 6px 0;
  padding: 8px;
  background: rgba(0, 122, 255, 0.10);
  border-radius: 4px;
  font-size: 11px;
  color: rgb(0, 80, 200);
}

.cancel-reanchor {
  background: transparent;
  border: 1px solid var(--border);
  font: inherit;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-secondary);
}

.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.meta strong {
  color: var(--text-primary);
  font-weight: 600;
}

.orphan-badge {
  background: rgba(255, 149, 0, 0.15);
  color: rgb(180, 90, 0);
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 10px;
}

.anchor {
  font-style: italic;
  color: var(--text-secondary);
  font-size: 12px;
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-anchor {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.code-badge {
  background: rgba(120, 120, 128, 0.2);
  color: var(--text-secondary);
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
}

.code-anchor code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  padding: 1px 5px;
  border-radius: 3px;
}

.body {
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}

.actions button {
  background: transparent;
  border: none;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.actions button:hover {
  background: var(--border);
  color: var(--text-primary);
}

.orphan-divider {
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 12px 4px 4px;
  font-weight: 600;
}

.empty {
  text-align: center;
  color: var(--text-secondary);
  padding: 24px 16px;
  line-height: 1.5;
}

.empty small {
  font-size: 11px;
  opacity: 0.8;
}
</style>
