import { ref, computed } from 'vue'
import MarkdownIt from 'markdown-it'
import Prism from 'prismjs'

// Import Prism language components (order matters for dependencies!)
// Core languages first
import 'prismjs/components/prism-markup' // HTML/XML - required by many others
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-clike' // Required by many C-style languages
import 'prismjs/components/prism-javascript'

// Languages that depend on the above
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-csharp'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-kotlin'
import 'prismjs/components/prism-swift'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-rust'

// Standalone languages
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-ruby'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-toml'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-diff'

// Language aliases
const languageAliases = {
  'js': 'javascript',
  'ts': 'typescript',
  'py': 'python',
  'rb': 'ruby',
  'rs': 'rust',
  'sh': 'bash',
  'shell': 'bash',
  'zsh': 'bash',
  'yml': 'yaml',
  'html': 'markup',
  'xml': 'markup',
  'svg': 'markup',
  'vue': 'markup',
  'md': 'markdown',
  'c++': 'cpp',
  'cs': 'csharp',
  'dotnet': 'csharp',
}

// Resolve language alias
function resolveLanguage(lang) {
  if (!lang) return null
  const normalized = lang.toLowerCase().trim()
  return languageAliases[normalized] || normalized
}

// Escape HTML helper
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Create markdown-it instance
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
})

// Custom fence renderer for code blocks with Prism
md.renderer.rules.fence = function(tokens, idx) {
  const token = tokens[idx]
  const code = token.content
  const lang = resolveLanguage(token.info)

  // Mermaid blocks - special handling
  if (lang === 'mermaid') {
    return `<div class="mermaid-container"><pre class="mermaid">${escapeHtml(code)}</pre></div>\n`
  }

  // Try to highlight with Prism
  if (lang && Prism.languages[lang]) {
    try {
      const highlighted = Prism.highlight(code, Prism.languages[lang], lang)
      return `<pre class="language-${lang}"><code class="language-${lang}">${highlighted}</code></pre>\n`
    } catch (e) {
      console.error('Prism highlighting error:', e)
    }
  }

  // Fallback: no highlighting
  const langClass = lang ? `language-${lang}` : 'language-none'
  return `<pre class="${langClass}"><code class="${langClass}">${escapeHtml(code)}</code></pre>\n`
}

// Strikethrough support: ~~text~~
md.use((md) => {
  const strikethrough = (state, silent) => {
    const start = state.pos
    const marker = state.src.charCodeAt(start)

    if (silent) return false
    if (marker !== 0x7E) return false
    if (state.src.charCodeAt(start + 1) !== 0x7E) return false

    const scanned = state.scanDelims(state.pos, true)
    let len = scanned.length

    if (len < 2) return false
    if (len % 2) {
      const token = state.push('text', '', 0)
      token.content = '~'
      len--
    }

    for (let i = 0; i < len; i += 2) {
      const token = state.push('text', '', 0)
      token.content = '~~'
      state.delimiters.push({
        marker: marker,
        length: 0,
        token: state.tokens.length - 1,
        end: -1,
        open: scanned.can_open,
        close: scanned.can_close
      })
    }

    state.pos += scanned.length
    return true
  }

  const postProcess = (state, delimiters) => {
    const loneMarkers = []
    const max = delimiters.length

    for (let i = 0; i < max; i++) {
      const startDelim = delimiters[i]
      if (startDelim.marker !== 0x7E) continue
      if (startDelim.end === -1) continue

      const endDelim = delimiters[startDelim.end]
      const token_o = state.tokens[startDelim.token]
      token_o.type = 's_open'
      token_o.tag = 's'
      token_o.nesting = 1
      token_o.markup = '~~'
      token_o.content = ''

      const token_c = state.tokens[endDelim.token]
      token_c.type = 's_close'
      token_c.tag = 's'
      token_c.nesting = -1
      token_c.markup = '~~'
      token_c.content = ''

      if (state.tokens[endDelim.token - 1].type === 'text' &&
          state.tokens[endDelim.token - 1].content === '~') {
        loneMarkers.push(endDelim.token - 1)
      }
    }

    while (loneMarkers.length) {
      const i = loneMarkers.pop()
      let j = i + 1
      while (j < state.tokens.length && state.tokens[j].type === 's_close') {
        j++
      }
      j--
      if (i !== j) {
        const token = state.tokens[j]
        state.tokens[j] = state.tokens[i]
        state.tokens[i] = token
      }
    }
  }

  md.inline.ruler.before('emphasis', 'strikethrough', strikethrough)
  md.inline.ruler2.before('emphasis', 'strikethrough', (state) => {
    postProcess(state, state.delimiters)
    for (const token of state.tokens_meta || []) {
      if (token && token.delimiters) {
        postProcess(state, token.delimiters)
      }
    }
    return true
  })
})

// External links: add target="_blank"
const defaultLinkRender = md.renderer.rules.link_open || function(tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options)
}

md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
  const href = tokens[idx].attrGet('href')
  if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
    tokens[idx].attrPush(['target', '_blank'])
    tokens[idx].attrPush(['rel', 'noopener noreferrer'])
  }
  return defaultLinkRender(tokens, idx, options, env, self)
}

/**
 * Post-process HTML to convert task list items
 */
function processTaskLists(html) {
  // Match list items that start with [ ] or [x]
  return html.replace(
    /<li>(\s*)\[ \]/g,
    '<li class="task-list-item"><input type="checkbox" class="task-checkbox" disabled> '
  ).replace(
    /<li>(\s*)\[x\]/gi,
    '<li class="task-list-item"><input type="checkbox" class="task-checkbox" disabled checked> '
  )
}

/**
 * Composable for markdown parsing with Prism highlighting
 */
export function useMarkdown() {
  const rawContent = ref('')

  const renderedHtml = computed(() => {
    if (!rawContent.value) return ''
    const html = md.render(rawContent.value)
    return processTaskLists(html)
  })

  function setContent(content) {
    rawContent.value = content
  }

  function render(content) {
    const html = md.render(content)
    return processTaskLists(html)
  }

  return {
    rawContent,
    renderedHtml,
    setContent,
    render
  }
}

export default useMarkdown
