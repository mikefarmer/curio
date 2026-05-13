/**
 * Session-scoped undo/redo stack for annotation actions.
 *
 * Per spec §17/§22 (v4): we keep a small in-memory history of
 * "annotation-level" content snapshots — create / accept / reject /
 * resolve / delete / re-anchor / strip-all. Cmd+Z reverts the file to
 * the prior snapshot; Cmd+Shift+Z replays it.
 *
 * What this stack is NOT for:
 *  - Char-level edits in Direct mode → handled by the textarea's
 *    native browser undo. Bundling those in here would make Cmd+Z
 *    behave inconsistently with focus.
 *
 * Each entry is just the full markdown content from immediately before
 * the action, plus a short label for telemetry/logs. Full snapshots are
 * fine because:
 *   1. Annotation actions happen at human pace, not per keystroke.
 *   2. The file is the source of truth; cloning a few KB of markdown
 *      ~50 times costs nothing measurable.
 */
import { ref } from 'vue'

export function useUndoStack(limit = 50) {
  // Snapshots taken BEFORE each annotation mutation.
  const undoStack = ref([]) // [{ before: string, label: string }]
  // Snapshots taken when we pop from undo — needed to redo.
  const redoStack = ref([])

  /**
   * Record a snapshot before an annotation action. Clears redo (the
   * usual undo-stack invariant: a new action invalidates redo history).
   */
  function push(before, label = '') {
    undoStack.value.push({ before, label })
    if (undoStack.value.length > limit) undoStack.value.shift()
    redoStack.value = []
  }

  /**
   * Pop the top undo entry, recording `current` onto the redo stack so
   * the user can replay. Returns the entry, or null if nothing to undo.
   */
  function popUndo(current) {
    const entry = undoStack.value.pop()
    if (!entry) return null
    redoStack.value.push({ before: current, label: entry.label })
    return entry
  }

  /**
   * Pop the top redo entry, pushing `current` back onto the undo stack
   * so a subsequent Cmd+Z reverses the redo. Returns the entry, or null.
   */
  function popRedo(current) {
    const entry = redoStack.value.pop()
    if (!entry) return null
    undoStack.value.push({ before: current, label: entry.label })
    return entry
  }

  function clear() {
    undoStack.value = []
    redoStack.value = []
  }

  return {
    undoStack,
    redoStack,
    push,
    popUndo,
    popRedo,
    clear,
  }
}
