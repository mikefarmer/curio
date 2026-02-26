/**
 * Composable for copy buttons on hover.
 *
 * - Headings: copy the heading + everything until the next heading of same or higher level
 * - Other block elements (paragraphs, lists, blockquotes, tables): copy just that element
 * - Code blocks: copy raw code text (handled separately)
 * - Mermaid diagrams: copy mermaid source (handled separately)
 *
 * Uses markdown-it's token stream to map DOM elements back to source line ranges.
 */
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: true })

const COPY_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 5.5V3.5C10.5 2.67 9.83 2 9 2H3.5C2.67 2 2 2.67 2 3.5V9C2 9.83 2.67 10.5 3.5 10.5H5.5" stroke="currentColor" stroke-width="1.3"/></svg>`

const CHECK_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

/**
 * Extract top-level block info from markdown-it's token stream.
 * Each block has: { type, level (heading level or 0), startLine, endLine }
 * The list corresponds 1:1 with the article's direct DOM children.
 */
function getBlockRanges(rawMarkdown) {
  const tokens = md.parse(rawMarkdown, {})
  const blocks = []
  let depth = 0

  for (const token of tokens) {
    if (depth === 0) {
      if (token.type === 'heading_open' && token.map) {
        blocks.push({
          type: 'heading',
          level: parseInt(token.tag[1]),
          startLine: token.map[0],
          endLine: token.map[1] - 1
        })
      } else if (token.type === 'hr' && token.map) {
        blocks.push({
          type: 'hr',
          level: 0,
          startLine: token.map[0],
          endLine: token.map[1] - 1
        })
      } else if (token.nesting === 0 && token.map) {
        // Self-closing block tokens (fence, html_block, code_block, etc.)
        blocks.push({
          type: 'block',
          level: 0,
          startLine: token.map[0],
          endLine: token.map[1] - 1
        })
      } else if (token.nesting === 1 && token.map && token.type !== 'heading_open') {
        // Opening token for a non-heading block (paragraph, list, blockquote, table, etc.)
        blocks.push({
          type: 'block',
          level: 0,
          startLine: token.map[0],
          endLine: token.map[1] - 1
        })
      }
    }

    if (token.nesting === 1) depth++
    else if (token.nesting === -1) depth--
  }

  return blocks
}

/**
 * Extract lines from rawMarkdown, trimming trailing blank lines.
 */
function extractText(lines, startLine, endLine) {
  const slice = lines.slice(startLine, endLine + 1)
  while (slice.length > 0 && slice[slice.length - 1].trim() === '') {
    slice.pop()
  }
  return slice.join('\n')
}

function createCopyButton(className) {
  const btn = document.createElement('button')
  btn.className = `copy-btn ${className}`
  btn.innerHTML = COPY_ICON
  btn.title = 'Copy to clipboard'
  btn.type = 'button'
  return btn
}

function showCopiedFeedback(btn) {
  btn.innerHTML = CHECK_ICON
  btn.classList.add('copy-btn-copied')
  setTimeout(() => {
    btn.innerHTML = COPY_ICON
    btn.classList.remove('copy-btn-copied')
  }, 1500)
}

function copyWithFeedback(btn, text) {
  writeText(text).then(() => {
    showCopiedFeedback(btn)
  }).catch(e => {
    console.error('Failed to copy:', e)
  })
}

/**
 * Add a copy button to each block element in the article.
 * - Headings: copy from that heading through all content until the next heading
 *   of equal or higher level (lower number).
 * - Other blocks: copy just that element's markdown.
 * - Skips code blocks (pre), mermaid containers, and HRs.
 */
function injectElementCopyButtons(articleEl, rawMarkdown) {
  if (!articleEl || !rawMarkdown) return

  const lines = rawMarkdown.split('\n')
  const blocks = getBlockRanges(rawMarkdown)
  const children = Array.from(articleEl.children)

  if (children.length === 0 || blocks.length === 0) return

  const count = Math.min(children.length, blocks.length)

  for (let i = 0; i < count; i++) {
    const child = children[i]
    const block = blocks[i]
    const tag = child.tagName.toLowerCase()

    // Skip elements that have their own copy buttons or nothing to copy
    if (child.classList.contains('mermaid-container')) continue
    if (tag === 'pre' && child.className.includes('language-')) continue
    if (tag === 'hr') continue

    // Compute markdown text to copy
    let markdownText
    if (block.type === 'heading') {
      // Hierarchical: copy from this heading to just before the next heading
      // of same or higher level (lower number = higher level)
      let endLine = lines.length - 1
      for (let j = i + 1; j < blocks.length; j++) {
        if (blocks[j].type === 'heading' && blocks[j].level <= block.level) {
          endLine = blocks[j].startLine - 1
          break
        }
      }
      markdownText = extractText(lines, block.startLine, endLine)
    } else {
      // Non-heading: just this element
      markdownText = extractText(lines, block.startLine, block.endLine)
    }

    if (!markdownText) continue

    // Wrap element in a .copy-item container
    const wrapper = document.createElement('div')
    wrapper.className = 'copy-item'
    wrapper.dataset.markdownSource = markdownText

    child.parentNode.insertBefore(wrapper, child)
    wrapper.appendChild(child)

    const btn = createCopyButton('copy-item-btn')
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      copyWithFeedback(btn, wrapper.dataset.markdownSource)
    })
    wrapper.appendChild(btn)
  }
}

/**
 * Inject copy buttons on mermaid containers.
 */
function injectMermaidCopyButtons() {
  const containers = document.querySelectorAll('.mermaid-container')

  for (const container of containers) {
    if (container.querySelector('.copy-btn')) continue

    const btn = createCopyButton('copy-mermaid-btn')
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      copyWithFeedback(btn, container.dataset.mermaidSource || '')
    })
    container.appendChild(btn)
  }
}

/**
 * Inject copy buttons on code blocks (pre elements).
 * Excludes mermaid containers.
 */
function injectCodeBlockCopyButtons(articleEl) {
  if (!articleEl) return

  const preElements = articleEl.querySelectorAll('pre[class*="language-"]')

  for (const pre of preElements) {
    if (pre.closest('.mermaid-container')) continue
    if (pre.parentElement.classList.contains('code-block-wrapper')) continue

    const wrapper = document.createElement('div')
    wrapper.className = 'code-block-wrapper'

    pre.parentNode.insertBefore(wrapper, pre)
    wrapper.appendChild(pre)

    const btn = createCopyButton('copy-code-btn')
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const codeEl = pre.querySelector('code')
      copyWithFeedback(btn, codeEl ? codeEl.textContent : pre.textContent)
    })
    wrapper.appendChild(btn)
  }
}

export function useSectionCopy() {
  function injectCopyButtons(articleEl, rawMarkdown) {
    if (!articleEl) return

    // Order matters: element wrapping first (modifies DOM structure),
    // then code blocks (wraps pre elements), then mermaid (adds to existing containers)
    injectElementCopyButtons(articleEl, rawMarkdown)
    injectCodeBlockCopyButtons(articleEl)
    injectMermaidCopyButtons()
  }

  return {
    injectCopyButtons
  }
}

export default useSectionCopy
