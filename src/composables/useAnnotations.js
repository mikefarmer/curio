import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'

const FORMAT_VERSION = 1

// Regex for the sidecar pointer line in the .md
const SIDECAR_HEADER_RE = /<!--\s*curio-sidecar:\s*([0-9a-fA-F-]{36})\s*-->/

// Regex for an inline comment range
const COMMENT_RANGE_RE = /<!--curio:c=([0-9a-f]{8})-->([\s\S]*?)<!--\/curio:c-->/g

// Regex for a comment metadata block (the blockquote wrapper). The attribute
// portion is captured so we can find target=code / hash=… on code-block
// comments without changing the marker name.
const COMMENT_BLOCK_RE = /<!--curio:comment\s+id=([0-9a-f]{8})([^>]*)-->\s*([\s\S]*?)<!--\/curio:comment-->/g

// Regex for an inline suggested edit. Two on-disk shapes:
//   Replace: <!--curio:e=ID-->~~old~~ → **new**<!--/curio:e-->
//   Delete:  <!--curio:e=ID-->~~old~~ → _(removed)_<!--/curio:e-->
// Captures: 1=id, 2=old, 3=raw "new" portion (caller disambiguates).
const EDIT_RANGE_RE = /<!--curio:e=([0-9a-f]{8})-->~~([\s\S]*?)~~\s*→\s*([\s\S]*?)<!--\/curio:e-->/g

// Sentinel used in the "new" position for deletions
const DELETE_SENTINEL = '_(removed)_'
const DELETE_SENTINEL_RE = /^\s*_\(removed\)_\s*$/

/** True if a parsed "new" capture represents a deletion. */
function isDeleteNew(neuRaw) {
  return DELETE_SENTINEL_RE.test(neuRaw || '')
}

/** Extract the displayed/applied replacement from a raw `new` capture.
 *  For replace edits the on-disk form is **new**; strip the bold markers.
 *  For delete edits, returns empty string. */
function extractNewText(neuRaw) {
  if (isDeleteNew(neuRaw)) return ''
  const m = (neuRaw || '').match(/^\s*\*\*([\s\S]*)\*\*\s*$/)
  return m ? m[1] : (neuRaw || '').trim()
}

// LLM-readable doc block inserted alongside the sidecar header.
// Anchored on the "Please preserve…" line so it matches *both* the current
// format and any legacy block whose examples accidentally contained nested
// `-->` sequences (which broke the outer comment).
const LLM_DOC_RE = /<!--[\s\S]*?This file uses Curio annotation markers[\s\S]*?Please preserve these markers when rewriting this file\.[\s\S]*?-->/

function llmDocBlock() {
  return `<!--
This file uses Curio annotation markers (curio.app).
- Commented ranges are wrapped between HTML-comment markers named "curio:c=ID" with the highlighted text between them; a blockquote containing the comment body follows.
- Suggested edits are wrapped between HTML-comment markers named "curio:e=ID" around the form: ~~old~~ → **new**.
- Suggested removals use _(removed)_ in place of **new**.
- Please preserve these markers when rewriting this file.
-->`
}

function shortId() {
  // 8 hex chars derived from a random UUID
  return (crypto.randomUUID().replace(/-/g, '')).slice(0, 8)
}

function nowIso() {
  return new Date().toISOString()
}

/**
 * FNV-1a 32-bit hash → 8 hex chars. Stable, fast, sync. Used to identify
 * code-block content for comment anchoring. Not cryptographic.
 */
export function hashCode(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ────────────────────────────────────────────────────────────────────────────
// Sidecar load / save / build
// ────────────────────────────────────────────────────────────────────────────

function emptySidecar(uuid, path) {
  return {
    format_version: FORMAT_VERSION,
    uuid,
    path,
    path_history: [],
    missing_since: null,
    last_opened: nowIso(),
    file_hash_last_seen: null,
    annotations: {},
    orphans: [],
    ui_state: { collapsed_ids: [], view_mode: 'annotated' }
  }
}

async function sha256(text) {
  const buf = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return 'sha256:' + Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

// ────────────────────────────────────────────────────────────────────────────
// Header injection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the .md has a curio-sidecar header. Returns { content, uuid, changed }.
 * If a header already exists, reuses its UUID. Otherwise inserts a new one
 * (and the LLM doc block) after any YAML frontmatter (--- ... ---) or at the top.
 */
function ensureSidecarHeader(content, preferredUuid = null) {
  const match = content.match(SIDECAR_HEADER_RE)
  if (match) {
    // Header present — heal an out-of-date / broken LLM doc block in place.
    const currentBlock = llmDocBlock()
    const existing = content.match(LLM_DOC_RE)
    if (existing && existing[0] !== currentBlock) {
      return {
        content: content.replace(LLM_DOC_RE, currentBlock),
        uuid: match[1],
        changed: true
      }
    }
    // Header present, no LLM block found — inject one right after the header
    if (!existing) {
      const headerIdx = content.indexOf(match[0])
      const insertAt = headerIdx + match[0].length
      const after = content.slice(insertAt)
      // Avoid duplicating leading newlines
      const sep = after.startsWith('\n') ? '\n' : '\n\n'
      return {
        content: content.slice(0, insertAt) + sep + currentBlock + (after.startsWith('\n') ? '' : '\n') + after,
        uuid: match[1],
        changed: true
      }
    }
    return { content, uuid: match[1], changed: false }
  }

  // Reuse the sidecar's existing UUID when re-injecting a stripped header
  // (e.g. after "Strip All"), so we don't fork the sidecar.
  const uuid = preferredUuid || crypto.randomUUID()
  const header = `<!-- curio-sidecar: ${uuid} -->\n${llmDocBlock()}\n\n`

  // Insert after frontmatter if present
  if (content.startsWith('---\n')) {
    const fmEnd = content.indexOf('\n---\n', 4)
    if (fmEnd !== -1) {
      const insertAt = fmEnd + 5
      return {
        content: content.slice(0, insertAt) + header + content.slice(insertAt),
        uuid,
        changed: true
      }
    }
  }
  return { content: header + content, uuid, changed: true }
}

// ────────────────────────────────────────────────────────────────────────────
// Parsing markers from raw md
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returns a Map<id, { type, anchorText?, oldText?, newText?, blockBody? }> of
 * all annotations present in the content.
 */
export function parseAnnotations(content) {
  const out = new Map()

  // Comments
  COMMENT_RANGE_RE.lastIndex = 0
  let m
  while ((m = COMMENT_RANGE_RE.exec(content)) !== null) {
    out.set(m[1], { id: m[1], type: 'comment', anchorText: m[2], blockBody: null })
  }

  COMMENT_BLOCK_RE.lastIndex = 0
  while ((m = COMMENT_BLOCK_RE.exec(content)) !== null) {
    const id = m[1]
    const attrs = m[2] || ''
    const body = m[3].trim()
    const existing = out.get(id)
    if (existing) {
      existing.blockBody = body
    } else if (/\btarget=code\b/.test(attrs)) {
      // Code-block comment: no inline range marker, anchor by code hash
      const hashMatch = attrs.match(/\bhash=([0-9a-f]{8})\b/)
      out.set(id, {
        id,
        type: 'code-comment',
        codeHash: hashMatch ? hashMatch[1] : null,
        blockBody: body
      })
    }
  }

  // Suggested edits
  EDIT_RANGE_RE.lastIndex = 0
  while ((m = EDIT_RANGE_RE.exec(content)) !== null) {
    const isDelete = isDeleteNew(m[3])
    out.set(m[1], {
      id: m[1],
      type: 'edit',
      editKind: isDelete ? 'delete' : 'replace',
      oldText: m[2],
      newText: isDelete ? '' : extractNewText(m[3])
    })
  }

  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Creating a comment
// ────────────────────────────────────────────────────────────────────────────

/**
 * Given the current md content, an anchorText with context_before / context_after
 * (captured from the user's selection in the rendered DOM), find the unique
 * matching span and wrap it. Append a comment metadata block immediately after
 * the containing block (next blank line, or end of file).
 *
 * Returns { content, id } on success, throws on failure (no match / ambiguous).
 */
export function insertComment(content, { anchorText, contextBefore, contextAfter, author, body }) {
  const idx = findAnchorInSource(content, anchorText, contextBefore, contextAfter)

  if (insideCodeFence(content, idx)) throw new Error('Cannot annotate inside code blocks')
  if (insideInlineCode(content, idx)) throw new Error('Cannot annotate inside inline code spans')
  if (insideExistingCurioMarker(content, idx)) throw new Error('Cannot nest annotations')
  if (anchorText.includes('\n\n')) throw new Error('Selection cannot span multiple blocks')

  const id = shortId()
  const wrapped = `<!--curio:c=${id}-->${anchorText}<!--/curio:c-->`
  const withAnchor = content.slice(0, idx) + wrapped + content.slice(idx + anchorText.length)

  // Insert the comment metadata block at the end of the containing block.
  // Find the next blank line (\n\n) after our wrapper, or use end of file.
  const wrapperEnd = idx + wrapped.length
  let insertAt = withAnchor.indexOf('\n\n', wrapperEnd)
  if (insertAt === -1) {
    insertAt = withAnchor.length
  }

  const ts = nowIso()
  const safeAuthor = author || 'anonymous'
  const block = `\n\n<!--curio:comment id=${id} author=${safeAuthor} ts=${ts}-->\n> 💬 **${safeAuthor}**: ${body}\n<!--/curio:comment-->`

  const finalContent = withAnchor.slice(0, insertAt) + block + withAnchor.slice(insertAt)
  return { content: finalContent, id, ts }
}

/**
 * Insert a comment anchored to a fenced code block. The marker block is
 * placed immediately after the closing fence so any LLM reading the file
 * sees the code followed by the user's comment naturally.
 *
 * Matching: locate the first fenced code block in `content` whose contents
 * hash to `codeHash`. If no match, throw — caller should refresh the view.
 */
export function insertCodeComment(content, { codeText, codeHash, author, body }) {
  if (!body || !body.trim()) throw new Error('Empty comment body')
  if (!codeHash) throw new Error('No code block hash provided')

  // Walk fences looking for one matching the hash
  const fenceRe = /^(```|~~~)([^\n]*)\n([\s\S]*?)\n\1[ \t]*$/gm
  let match
  let target = null
  while ((match = fenceRe.exec(content)) !== null) {
    if (hashCode(match[3]) === codeHash) {
      target = match
      break
    }
  }
  if (!target) {
    throw new Error('Could not locate the code block in source — it may have changed')
  }

  const insertAt = target.index + target[0].length
  const id = shortId()
  const ts = nowIso()
  const safeAuthor = author || 'anonymous'
  const block = `\n\n<!--curio:comment id=${id} author=${safeAuthor} ts=${ts} target=code hash=${codeHash}-->\n> 💬 **${safeAuthor}**: ${body}\n<!--/curio:comment-->`
  const finalContent = content.slice(0, insertAt) + block + content.slice(insertAt)
  return { content: finalContent, id, ts, codeHash }
}

/**
 * Wrap a selection with a suggested-edit marker.
 *  Replace form: <!--curio:e=ID-->~~old~~ → **new**<!--/curio:e-->
 *  Delete form:  <!--curio:e=ID-->~~old~~ → _(removed)_<!--/curio:e-->
 * Pass newText='' (or whitespace) to produce the delete form.
 */
export function insertEdit(content, { anchorText, contextBefore, contextAfter, newText }) {
  const isDelete = !newText || !String(newText).trim()
  const idx = findAnchorInSource(content, anchorText, contextBefore, contextAfter)

  if (insideCodeFence(content, idx)) throw new Error('Cannot annotate inside code blocks')
  if (insideInlineCode(content, idx)) throw new Error('Cannot annotate inside inline code spans')
  if (insideExistingCurioMarker(content, idx)) throw new Error('Cannot nest annotations')
  if (anchorText.includes('\n\n')) throw new Error('Selection cannot span multiple blocks')

  const id = shortId()
  const replacement = isDelete ? DELETE_SENTINEL : `**${newText}**`
  const wrapped = `<!--curio:e=${id}-->~~${anchorText}~~ → ${replacement}<!--/curio:e-->`
  const finalContent = content.slice(0, idx) + wrapped + content.slice(idx + anchorText.length)
  return { content: finalContent, id, ts: nowIso(), editKind: isDelete ? 'delete' : 'replace' }
}

/**
 * After deleting a span in mid-prose, surrounding whitespace often becomes
 * doubled (e.g. "the  dog" or " word " → " "). Collapse the join cleanly.
 * Operates on a (start, end) deletion window in the larger string.
 */
function deletionFromString(before, after) {
  // If both sides are word characters and the deletion was a whole token,
  // there's usually a space on at least one side; collapse to a single space.
  const beforeEnd = before.slice(-1)
  const afterStart = after.slice(0, 1)
  if (/\s/.test(beforeEnd) && /\s/.test(afterStart)) {
    // Two whitespace chars surround — drop one
    return before + after.slice(1)
  }
  return before + after
}

/** Apply one edit marker per its `editKind` (replace or delete). */
function applyEdit(content, oldText, neuRaw, startIdx, endIdx) {
  if (isDeleteNew(neuRaw)) {
    return deletionFromString(content.slice(0, startIdx), content.slice(endIdx))
  }
  const replacement = extractNewText(neuRaw)
  return content.slice(0, startIdx) + replacement + content.slice(endIdx)
}

/** Accept a suggested edit by id. */
export function acceptEdit(content, id) {
  const safeId = id.replace(/[^0-9a-f]/g, '')
  if (!safeId) return content
  const re = new RegExp(
    `<!--curio:e=${safeId}-->~~([\\s\\S]*?)~~\\s*→\\s*([\\s\\S]*?)<!--/curio:e-->`
  )
  const m = re.exec(content)
  if (!m) return content
  return applyEdit(content, m[1], m[2], m.index, m.index + m[0].length)
}

/** Reject a suggested edit by id: keep the original text. */
export function rejectEdit(content, id) {
  const safeId = id.replace(/[^0-9a-f]/g, '')
  if (!safeId) return content
  const re = new RegExp(
    `<!--curio:e=${safeId}-->~~([\\s\\S]*?)~~\\s*→\\s*([\\s\\S]*?)<!--/curio:e-->`,
    'g'
  )
  return content.replace(re, (_, old) => old)
}

/** Apply every suggested edit: replacements take, deletions drop. */
export function applyAllEdits(content) {
  // Iterate left-to-right so indices stay valid after each substitution.
  let out = content
  // Reset regex state
  const re = new RegExp(EDIT_RANGE_RE.source, 'g')
  let cursor = 0
  let result = ''
  let m
  while ((m = re.exec(out)) !== null) {
    result += out.slice(cursor, m.index)
    if (isDeleteNew(m[3])) {
      // Whitespace-collapse on delete: peek prev char of `result` and next char after match
      const prevChar = result.slice(-1)
      const nextChar = out.slice(m.index + m[0].length, m.index + m[0].length + 1)
      if (/\s/.test(prevChar) && /\s/.test(nextChar)) {
        result = result.slice(0, -1)
      }
    } else {
      result += extractNewText(m[3])
    }
    cursor = m.index + m[0].length
  }
  result += out.slice(cursor)
  return result
}

/** Drop all suggested edits, keeping the original text. */
export function discardAllEdits(content) {
  return content.replace(EDIT_RANGE_RE, (_, _id, old) => old)
}

/**
 * Remove a comment (both its range markers and metadata block).
 * Inner anchor text is preserved.
 */
export function removeComment(content, id) {
  const safeId = id.replace(/[^0-9a-f]/g, '')
  if (!safeId) return content

  // Strip range markers (keep inner text)
  const rangeRe = new RegExp(`<!--curio:c=${safeId}-->([\\s\\S]*?)<!--/curio:c-->`, 'g')
  let out = content.replace(rangeRe, '$1')

  // Strip metadata block (entire block)
  const blockRe = new RegExp(
    `\\n*<!--curio:comment\\s+id=${safeId}\\b[^>]*-->[\\s\\S]*?<!--/curio:comment-->`,
    'g'
  )
  out = out.replace(blockRe, '')
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// View-mode stripping
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip curio annotations from content for non-annotated view modes.
 * mode='original' — keeps the original prose (rejects all pending edits visually).
 * mode='final'    — applies all pending edits (keeps replacements).
 */
export function stripAnnotations(content, mode = 'original') {
  let out = content

  // Strip sidecar header
  out = out.replace(SIDECAR_HEADER_RE, '')
  // Strip LLM doc block (best effort — only the one we generate)
  out = out.replace(LLM_DOC_RE, '')
  // Strip comment range markers (keep inner text)
  out = out.replace(COMMENT_RANGE_RE, '$2')
  // Strip comment metadata blocks entirely
  out = out.replace(COMMENT_BLOCK_RE, '')

  // Edits: original keeps old, final keeps new
  if (mode === 'final') {
    out = applyAllEdits(out)
  } else {
    out = discardAllEdits(out)
  }

  // Collapse the multiple blank lines left behind
  out = out.replace(/\n{3,}/g, '\n\n').trimStart()
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalize typographic differences between the rendered DOM and the source.
 * markdown-it's `typographer: true` rewrites smart quotes, ellipsis, dashes;
 * we strip these to neutral forms on both sides so they don't cause mismatches.
 */
function normalizeTypography(s) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')
}

/**
 * Project the source markdown into an approximation of its rendered text,
 * preserving a per-character mapping back to source byte offsets.
 *
 * Returns `{ stripped, map }` where `map[i]` is the source index that
 * produced `stripped[i]` (or for chars dropped from output: nothing).
 *
 * Handled patterns (best-effort, deliberately conservative — false negatives
 * are preferable to false positives):
 *   - HTML comments (incl. all curio markers)
 *   - Headings (leading `#+ `)
 *   - Blockquote prefix (`> `)
 *   - List markers (`-`, `*`, `+`, `1.`)
 *   - Bold `**...**`, strikethrough `~~...~~`, inline code `` `...` ``
 *   - Links `[text](url)` -> text
 * Italic single-* / _ is intentionally NOT handled (ambiguous and brittle).
 */
function projectSource(source) {
  const outChars = []
  const map = []
  let i = 0
  const n = source.length
  let atLineStart = true

  function takeInner(innerStartSrc, innerText) {
    for (let k = 0; k < innerText.length; k++) {
      outChars.push(innerText[k])
      map.push(innerStartSrc + k)
    }
  }

  while (i < n) {
    // HTML comments — drop entirely
    if (source[i] === '<' && source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4)
      if (end !== -1) {
        i = end + 3
        continue
      }
    }

    if (atLineStart) {
      // Leading whitespace (preserve for list-indent detection but generally drop indentation)
      // Heading marker: #+ followed by space
      const hm = /^(#{1,6})[ \t]+/.exec(source.slice(i))
      if (hm) { i += hm[0].length; atLineStart = false; continue }
      // Blockquote prefix
      const bq = /^>[ \t]?/.exec(source.slice(i))
      if (bq) { i += bq[0].length; continue }
      // List marker (-, *, +, or N.) — also tolerate leading whitespace
      const lm = /^[ \t]*([-*+][ \t]+|\d+\.[ \t]+)/.exec(source.slice(i))
      if (lm) { i += lm[0].length; continue }
    }

    // Bold **...**
    if (source.startsWith('**', i)) {
      const end = source.indexOf('**', i + 2)
      if (end !== -1 && end > i + 2) {
        takeInner(i + 2, source.slice(i + 2, end))
        i = end + 2
        continue
      }
    }

    // Strikethrough ~~...~~
    if (source.startsWith('~~', i)) {
      const end = source.indexOf('~~', i + 2)
      if (end !== -1 && end > i + 2) {
        takeInner(i + 2, source.slice(i + 2, end))
        i = end + 2
        continue
      }
    }

    // Inline code `...` (or ``...``)
    if (source[i] === '`') {
      let runLen = 1
      while (i + runLen < n && source[i + runLen] === '`') runLen++
      const closer = '`'.repeat(runLen)
      const end = source.indexOf(closer, i + runLen)
      if (end !== -1) {
        takeInner(i + runLen, source.slice(i + runLen, end))
        i = end + runLen
        continue
      }
    }

    // Link [text](url) — keep text only (not images)
    if (source[i] === '[' && (i === 0 || source[i - 1] !== '!')) {
      const closeBracket = source.indexOf(']', i + 1)
      if (closeBracket !== -1 && source[closeBracket + 1] === '(') {
        const closeParen = source.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          takeInner(i + 1, source.slice(i + 1, closeBracket))
          i = closeParen + 1
          continue
        }
      }
    }

    // Default: keep this character
    const ch = source[i]
    outChars.push(ch)
    map.push(i)
    atLineStart = (ch === '\n')
    i++
  }

  return { stripped: outChars.join(''), map }
}

/**
 * Locate the precise source byte offset of `anchorText`, using the captured
 * rendered-DOM context to disambiguate. Strategy:
 *   1. Project source -> stripped text + index map.
 *   2. Normalize typography on both stripped and captured needle.
 *   3. indexOf(needle) in stripped -> map back to source.
 *   4. If full-needle search fails, fall back to anchor-only with best-context-affinity scoring.
 */
function findAnchorInSource(content, anchorText, contextBefore, contextAfter) {
  if (!anchorText) throw new Error('Empty selection')

  const { stripped, map } = projectSource(content)
  const ns = normalizeTypography(stripped)
  const nAnchor = normalizeTypography(anchorText)
  const nBefore = normalizeTypography(contextBefore || '')
  const nAfter = normalizeTypography(contextAfter || '')

  // Full-needle match in projection
  const needle = nBefore + nAnchor + nAfter
  let idx = ns.indexOf(needle)
  if (idx !== -1) {
    const second = ns.indexOf(needle, idx + 1)
    if (second !== -1) {
      throw new Error('Selection is ambiguous (matches multiple locations); add more context')
    }
    return map[idx + nBefore.length]
  }

  // Fallback: enumerate all anchor occurrences in the projection
  const occurrences = []
  for (let from = 0; ;) {
    const j = ns.indexOf(nAnchor, from)
    if (j === -1) break
    occurrences.push(j)
    from = j + Math.max(1, nAnchor.length)
  }

  if (occurrences.length === 0) {
    throw new Error('Could not locate selection in source')
  }
  if (occurrences.length === 1) {
    return map[occurrences[0]]
  }

  // Multiple — score each by longest-common-affix with the captured context
  let best = -1
  let bestScore = -1
  let tied = false
  for (const j of occurrences) {
    const beforeSlice = ns.slice(Math.max(0, j - nBefore.length), j)
    const afterSlice = ns.slice(j + nAnchor.length, j + nAnchor.length + nAfter.length)

    // Longest common suffix of beforeSlice with nBefore
    let beforeLen = 0
    const maxBefore = Math.min(beforeSlice.length, nBefore.length)
    for (let k = 1; k <= maxBefore; k++) {
      if (beforeSlice.slice(-k) === nBefore.slice(-k)) beforeLen = k
      else break
    }
    // Longest common prefix of afterSlice with nAfter
    let afterLen = 0
    const maxAfter = Math.min(afterSlice.length, nAfter.length)
    for (let k = 1; k <= maxAfter; k++) {
      if (afterSlice.slice(0, k) === nAfter.slice(0, k)) afterLen = k
      else break
    }

    const s = beforeLen + afterLen
    if (s > bestScore) {
      bestScore = s
      best = j
      tied = false
    } else if (s === bestScore) {
      tied = true
    }
  }

  // Require a meaningful affinity advantage; if scores tie, refuse rather than guess.
  if (best !== -1 && bestScore >= 4 && !tied) {
    return map[best]
  }

  throw new Error('Selection is ambiguous (matches multiple locations); add more context')
}

/**
 * Find a candidate location for an orphaned anchor in current content.
 * Returns `{ idx, candidates }`. `candidates` is the total count of plausible
 * locations — caller decides whether to auto-attach (count === 1).
 *
 * Tries: exact projection match, then case-insensitive, then whitespace-collapsed.
 */
function findFuzzyAnchor(content, anchorText) {
  if (!anchorText) return { idx: null, candidates: 0 }
  const { stripped, map } = projectSource(content)
  const ns = normalizeTypography(stripped)
  const nAnchor = normalizeTypography(anchorText)

  const matchInProjection = (haystack, needle) => {
    const hits = []
    for (let from = 0; ;) {
      const j = haystack.indexOf(needle, from)
      if (j === -1) break
      hits.push(j)
      from = j + Math.max(1, needle.length)
    }
    return hits
  }

  // Pass 1: exact
  let hits = matchInProjection(ns, nAnchor)
  if (hits.length >= 1) return { idx: map[hits[0]], candidates: hits.length, anchorText, projectionStart: hits[0] }

  // Pass 2: case-insensitive
  const lcHaystack = ns.toLowerCase()
  const lcNeedle = nAnchor.toLowerCase()
  hits = matchInProjection(lcHaystack, lcNeedle)
  if (hits.length >= 1) {
    // The anchor text at the match site preserves case in projection
    return { idx: map[hits[0]], candidates: hits.length, anchorText: ns.slice(hits[0], hits[0] + nAnchor.length), projectionStart: hits[0] }
  }

  return { idx: null, candidates: 0 }
}

/** Returns true if `idx` falls inside an existing curio range marker. */
function insideExistingCurioMarker(content, idx) {
  // Walk forward from `idx` looking for a closing curio marker before a paragraph break;
  // if found and there's a matching opener before idx, we're inside.
  const closeRe = /<!--\/curio:[ce]-->/g
  closeRe.lastIndex = idx
  const close = closeRe.exec(content)
  if (!close) return false
  // Find any opener between content start and idx
  const before = content.slice(0, idx)
  const openRe = /<!--curio:[ce]=[0-9a-f]{8}-->/g
  let lastOpenIdx = -1
  let m
  while ((m = openRe.exec(before)) !== null) lastOpenIdx = m.index
  if (lastOpenIdx === -1) return false
  // Ensure no closer between lastOpenIdx and idx
  const between = content.slice(lastOpenIdx, idx)
  return !/<!--\/curio:[ce]-->/.test(between)
}

/** Returns true if `idx` falls inside a fenced code block (``` ... ```). */
function insideCodeFence(content, idx) {
  const before = content.slice(0, idx)
  // Count unmatched ``` fences before idx
  const fences = before.match(/^```/gm)
  return fences ? fences.length % 2 === 1 : false
}

/**
 * Returns true if `idx` falls inside an inline code span (`code`) within the
 * current paragraph. Walks backtick runs and pairs same-length runs as
 * open/close per CommonMark.
 */
function insideInlineCode(content, idx) {
  // Limit scan to current paragraph (between blank lines) to avoid false
  // matches from unrelated backticks elsewhere in the document.
  const blankBefore = content.lastIndexOf('\n\n', idx - 1)
  const paraStart = blankBefore === -1 ? 0 : blankBefore + 2
  const segment = content.slice(paraStart, idx)

  let i = 0
  let openLen = 0  // length of the currently-open backtick run, 0 if none
  while (i < segment.length) {
    if (segment[i] === '`') {
      let j = i
      while (j < segment.length && segment[j] === '`') j++
      const runLen = j - i
      if (openLen === 0) openLen = runLen
      else if (openLen === runLen) openLen = 0
      i = j
    } else {
      i++
    }
  }
  return openLen > 0
}

// ────────────────────────────────────────────────────────────────────────────
// Composable
// ────────────────────────────────────────────────────────────────────────────

export function useAnnotations() {
  const sidecar = ref(null)          // current sidecar object
  const annotations = ref([])        // active annotations (array, derived from sidecar)
  const orphans = ref([])            // orphaned annotations
  const author = ref('')             // resolved author name

  /**
   * Load the sidecar for an .md given its raw content + filesystem path.
   * Ensures the file has a curio-sidecar header (returns updated content + dirty flag).
   * Loads or rebuilds the sidecar in ~/.curio/.
   * Returns: { uuid, contentOut, contentChanged }
   */
  async function loadForFile(rawContent, filePath) {
    // Ensure header
    const { content: contentOut, uuid, changed: contentChanged } = ensureSidecarHeader(rawContent)

    // Try to load sidecar
    let data
    try {
      data = await invoke('read_sidecar', { uuid })
    } catch (e) {
      console.error('[Annotate] read_sidecar failed:', e)
      data = null
    }

    if (!data) {
      data = emptySidecar(uuid, filePath)
    }

    // Reconcile path on rename / copy detection
    if (data.path !== filePath) {
      // Both exist? -> copy: fork into new UUID. (Caller must rewrite header.)
      // (We don't have a sync stat from JS easily, so detect heuristically: leave path update to caller for now.)
      if (data.path) data.path_history = [...(data.path_history || []), data.path]
      data.path = filePath
    }
    data.missing_since = null
    data.last_opened = nowIso()
    data.file_hash_last_seen = await sha256(contentOut)

    sidecar.value = data
    refreshAnnotations(contentOut)

    // Persist (even if unchanged — keeps last_opened fresh)
    await persistSidecar()

    return { uuid, contentOut, contentChanged }
  }

  /** Re-derive active annotations + orphans by comparing sidecar to inline markers. */
  function refreshAnnotations(content) {
    if (!sidecar.value) {
      annotations.value = []
      orphans.value = []
      return
    }

    const inline = parseAnnotations(content)
    const active = []
    const orphaned = []
    const known = sidecar.value.annotations || {}

    // Anything inline that's not in sidecar -> add to sidecar (sidecar rebuild on first load)
    for (const [id, parsed] of inline) {
      if (!known[id]) {
        if (parsed.type === 'code-comment') {
          known[id] = {
            type: 'code-comment',
            code_hash: parsed.codeHash,
            body_md: parsed.blockBody || '',
            author: extractAuthor(parsed.blockBody) || author.value || 'anonymous',
            created_at: nowIso(),
            updated_at: nowIso()
          }
        } else if (parsed.type === 'edit') {
          known[id] = {
            type: 'edit',
            edit_kind: parsed.editKind,
            old_text: parsed.oldText,
            new_text: parsed.newText,
            author: author.value || 'anonymous',
            created_at: nowIso(),
            updated_at: nowIso()
          }
        } else {
          known[id] = {
            type: 'comment',
            anchor_text: parsed.anchorText,
            context_before: '',
            context_after: '',
            body_md: parsed.blockBody || '',
            author: extractAuthor(parsed.blockBody) || author.value || 'anonymous',
            created_at: nowIso(),
            updated_at: nowIso()
          }
        }
      } else if (parsed.type === 'edit') {
        // Refresh in case user edited the markers directly
        known[id].edit_kind = parsed.editKind
        known[id].old_text = parsed.oldText
        known[id].new_text = parsed.newText
      }

      if (parsed.type === 'edit') {
        active.push({
          id, ...known[id],
          editKind: parsed.editKind,
          oldText: parsed.oldText,
          newText: parsed.newText
        })
      } else if (parsed.type === 'code-comment') {
        active.push({
          id, ...known[id],
          codeHash: parsed.codeHash,
          body: parsed.blockBody
        })
      } else {
        active.push({
          id, ...known[id],
          anchorText: parsed.anchorText,
          body: parsed.blockBody
        })
      }
    }

    // Anything in sidecar but not inline -> orphan
    for (const [id, meta] of Object.entries(known)) {
      if (!inline.has(id)) {
        orphaned.push({ id, ...meta })
      }
    }

    sidecar.value.annotations = known
    annotations.value = active
    orphans.value = orphaned
  }

  function extractAuthor(blockBody) {
    if (!blockBody) return null
    // body starts with: > 💬 **NAME**: ...
    const m = blockBody.match(/\*\*([^*]+)\*\*/)
    return m ? m[1] : null
  }

  async function persistSidecar() {
    if (!sidecar.value) return
    try {
      await invoke('write_sidecar', {
        uuid: sidecar.value.uuid,
        data: sidecar.value
      })
    } catch (e) {
      console.error('[Annotate] write_sidecar failed:', e)
    }
  }

  /**
   * Re-inject the sidecar header + LLM doc block if either was stripped
   * (e.g. by "Strip All") since the file was loaded. Preserves the in-memory
   * sidecar's UUID so we don't fork. No-op when the header is already present.
   */
  function ensureHeaderForCurrentSidecar(content) {
    if (!sidecar.value) return content
    const { content: out } = ensureSidecarHeader(content, sidecar.value.uuid)
    return out
  }

  /**
   * Create a new comment on a selection. Returns the new md content (caller writes to disk).
   */
  function createComment({ content, anchorText, contextBefore, contextAfter, body }) {
    content = ensureHeaderForCurrentSidecar(content)
    const { content: newContent, id, ts } = insertComment(content, {
      anchorText, contextBefore, contextAfter,
      author: author.value || 'anonymous',
      body
    })
    if (!sidecar.value) throw new Error('Sidecar not loaded')
    sidecar.value.annotations[id] = {
      type: 'comment',
      anchor_text: anchorText,
      context_before: contextBefore || '',
      context_after: contextAfter || '',
      body_md: `> 💬 **${author.value || 'anonymous'}**: ${body}`,
      author: author.value || 'anonymous',
      created_at: ts,
      updated_at: ts
    }
    return { content: newContent, id }
  }

  function deleteAnnotation(content, id) {
    const newContent = removeComment(content, id)
    if (sidecar.value && sidecar.value.annotations) {
      delete sidecar.value.annotations[id]
    }
    return newContent
  }

  /**
   * Create a comment anchored to a fenced code block (identified by hash).
   */
  function createCodeComment({ content, codeText, codeHash, body }) {
    content = ensureHeaderForCurrentSidecar(content)
    const { content: newContent, id, ts } = insertCodeComment(content, {
      codeText, codeHash, body,
      author: author.value || 'anonymous'
    })
    if (!sidecar.value) throw new Error('Sidecar not loaded')
    sidecar.value.annotations[id] = {
      type: 'code-comment',
      code_hash: codeHash,
      body_md: `> 💬 **${author.value || 'anonymous'}**: ${body}`,
      author: author.value || 'anonymous',
      created_at: ts,
      updated_at: ts
    }
    return { content: newContent, id }
  }

  /**
   * Create a new suggested edit on a selection. Empty/whitespace newText
   * is recorded as a deletion suggestion (on-disk `_(removed)_` sentinel).
   * Returns { content, id, editKind } on success.
   */
  function createEdit({ content, anchorText, contextBefore, contextAfter, newText }) {
    content = ensureHeaderForCurrentSidecar(content)
    const { content: newContent, id, ts, editKind } = insertEdit(content, {
      anchorText, contextBefore, contextAfter, newText
    })
    if (!sidecar.value) throw new Error('Sidecar not loaded')
    sidecar.value.annotations[id] = {
      type: 'edit',
      edit_kind: editKind,
      old_text: anchorText,
      new_text: editKind === 'delete' ? '' : newText,
      author: author.value || 'anonymous',
      created_at: ts,
      updated_at: ts
    }
    return { content: newContent, id, editKind }
  }

  function acceptEditAnnotation(content, id) {
    const newContent = acceptEdit(content, id)
    if (sidecar.value && sidecar.value.annotations) {
      delete sidecar.value.annotations[id]
    }
    return newContent
  }

  function rejectEditAnnotation(content, id) {
    const newContent = rejectEdit(content, id)
    if (sidecar.value && sidecar.value.annotations) {
      delete sidecar.value.annotations[id]
    }
    return newContent
  }

  /** Accept every pending edit in the file. Returns new content. */
  function acceptAllEdits(content) {
    const newContent = applyAllEdits(content)
    if (sidecar.value && sidecar.value.annotations) {
      for (const [id, ann] of Object.entries(sidecar.value.annotations)) {
        if (ann.type === 'edit') delete sidecar.value.annotations[id]
      }
    }
    return newContent
  }

  /** Reject every pending edit in the file (keeps originals). Returns new content. */
  function rejectAllEdits(content) {
    const newContent = discardAllEdits(content)
    if (sidecar.value && sidecar.value.annotations) {
      for (const [id, ann] of Object.entries(sidecar.value.annotations)) {
        if (ann.type === 'edit') delete sidecar.value.annotations[id]
      }
    }
    return newContent
  }

  /** Drop an orphan record from the sidecar. Does not touch the .md file. */
  function dismissOrphan(id) {
    if (!sidecar.value || !sidecar.value.annotations) return
    delete sidecar.value.annotations[id]
    orphans.value = orphans.value.filter(o => o.id !== id)
  }

  /**
   * Suggest a new home for an orphan by fuzzy-searching the current content.
   * Returns { idx, candidates, anchorText } — idx is the source-byte offset
   * if exactly one likely match is found; null otherwise.
   */
  function suggestOrphanLocation(content, id) {
    const orphan = orphans.value.find(o => o.id === id)
    if (!orphan) return { idx: null, candidates: 0 }
    if (orphan.type === 'code-comment') {
      // Code-comments are matched by hash. Try to find a code block whose
      // hash matches; if none, search by code snippet substring.
      const targetHash = orphan.code_hash
      if (!targetHash) return { idx: null, candidates: 0 }
      const fenceRe = /^(```|~~~)[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm
      let m, count = 0, firstIdx = null
      while ((m = fenceRe.exec(content)) !== null) {
        if (hashCode(m[2]) === targetHash) {
          if (firstIdx === null) firstIdx = m.index
          count++
        }
      }
      return { idx: firstIdx, candidates: count }
    }
    return findFuzzyAnchor(content, orphan.anchor_text)
  }

  /**
   * Re-anchor an orphan to a new selection. Reuses the orphan's id and body.
   * Returns the new content (caller writes to disk).
   */
  function reanchorOrphan({ content, id, anchorText, contextBefore, contextAfter }) {
    const orphan = orphans.value.find(o => o.id === id)
    if (!orphan) throw new Error('Orphan not found')
    if (orphan.type === 'code-comment') {
      throw new Error('Code-comment re-anchor not supported via selection')
    }
    content = ensureHeaderForCurrentSidecar(content)
    const idx = findAnchorInSource(content, anchorText, contextBefore, contextAfter)
    if (insideCodeFence(content, idx)) throw new Error('Cannot annotate inside code blocks')
    if (insideInlineCode(content, idx)) throw new Error('Cannot annotate inside inline code spans')
    if (insideExistingCurioMarker(content, idx)) throw new Error('Cannot nest annotations')

    // Wrap the new anchor with the orphan's existing id
    const wrapped = `<!--curio:c=${id}-->${anchorText}<!--/curio:c-->`
    const withAnchor = content.slice(0, idx) + wrapped + content.slice(idx + anchorText.length)

    // Append a comment metadata block reusing the orphan's body
    const wrapperEnd = idx + wrapped.length
    let insertAt = withAnchor.indexOf('\n\n', wrapperEnd)
    if (insertAt === -1) insertAt = withAnchor.length
    const ts = orphan.updated_at || nowIso()
    const safeAuthor = orphan.author || 'anonymous'
    // If the orphan body already starts with the standard "> 💬 **NAME**: " prefix,
    // reuse it; otherwise format a fresh blockquote.
    const bodyLine = (orphan.body_md && orphan.body_md.trim().startsWith('>'))
      ? orphan.body_md.trim()
      : `> 💬 **${safeAuthor}**: ${orphan.body_md || ''}`
    const block = `\n\n<!--curio:comment id=${id} author=${safeAuthor} ts=${ts}-->\n${bodyLine}\n<!--/curio:comment-->`
    const finalContent = withAnchor.slice(0, insertAt) + block + withAnchor.slice(insertAt)

    // Promote the sidecar entry from orphan to active and refresh anchor_text
    if (sidecar.value && sidecar.value.annotations[id]) {
      sidecar.value.annotations[id].anchor_text = anchorText
      sidecar.value.annotations[id].updated_at = nowIso()
    }
    orphans.value = orphans.value.filter(o => o.id !== id)
    return finalContent
  }

  /**
   * Re-anchor an orphan to a specific source byte offset (no selection needed).
   * Used by the "Did you mean here?" one-click acceptance.
   */
  function reanchorOrphanAtIdx({ content, id, idx, anchorText }) {
    const orphan = orphans.value.find(o => o.id === id)
    if (!orphan) throw new Error('Orphan not found')
    if (insideCodeFence(content, idx)) throw new Error('Cannot annotate inside code blocks')
    if (insideInlineCode(content, idx)) throw new Error('Cannot annotate inside inline code spans')
    if (insideExistingCurioMarker(content, idx)) throw new Error('Cannot nest annotations')

    const wrapped = `<!--curio:c=${id}-->${anchorText}<!--/curio:c-->`
    const withAnchor = content.slice(0, idx) + wrapped + content.slice(idx + anchorText.length)
    const wrapperEnd = idx + wrapped.length
    let insertAt = withAnchor.indexOf('\n\n', wrapperEnd)
    if (insertAt === -1) insertAt = withAnchor.length
    const ts = orphan.updated_at || nowIso()
    const safeAuthor = orphan.author || 'anonymous'
    const bodyLine = (orphan.body_md && orphan.body_md.trim().startsWith('>'))
      ? orphan.body_md.trim()
      : `> 💬 **${safeAuthor}**: ${orphan.body_md || ''}`
    const block = `\n\n<!--curio:comment id=${id} author=${safeAuthor} ts=${ts}-->\n${bodyLine}\n<!--/curio:comment-->`
    const finalContent = withAnchor.slice(0, insertAt) + block + withAnchor.slice(insertAt)

    if (sidecar.value && sidecar.value.annotations[id]) {
      sidecar.value.annotations[id].anchor_text = anchorText
      sidecar.value.annotations[id].updated_at = nowIso()
    }
    orphans.value = orphans.value.filter(o => o.id !== id)
    // Header may have been stripped after load; re-inject at top so we don't
    // disturb the caller-supplied idx (header always inserts above content).
    return ensureHeaderForCurrentSidecar(finalContent)
  }

  /** Initialize author from config or prompt the caller. */
  async function initAuthor() {
    try {
      const cfg = await invoke('read_curio_config')
      if (cfg && cfg.author) {
        author.value = cfg.author
        return cfg.author
      }
    } catch (e) {
      console.error('[Annotate] read_curio_config failed:', e)
    }
    return null
  }

  async function setAuthor(name) {
    author.value = name
    try {
      const cfg = await invoke('read_curio_config')
      const merged = { ...(cfg || {}), author: name }
      await invoke('write_curio_config', { data: merged })
    } catch (e) {
      console.error('[Annotate] write_curio_config failed:', e)
    }
  }

  const hasAuthor = computed(() => !!author.value)

  return {
    // state
    sidecar,
    annotations,
    orphans,
    author,
    hasAuthor,
    // lifecycle
    loadForFile,
    refreshAnnotations,
    persistSidecar,
    // mutations
    createComment,
    createCodeComment,
    createEdit,
    acceptEdit: acceptEditAnnotation,
    rejectEdit: rejectEditAnnotation,
    acceptAllEdits,
    rejectAllEdits,
    deleteAnnotation,
    dismissOrphan,
    suggestOrphanLocation,
    reanchorOrphan,
    reanchorOrphanAtIdx,
    // author
    initAuthor,
    setAuthor,
    // utilities
    stripAnnotations
  }
}
