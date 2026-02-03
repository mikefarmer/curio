import { ref, computed, watch } from 'vue'

/**
 * Composable for in-document search functionality
 */
export function useSearch() {
  const searchQuery = ref('')
  const isSearchOpen = ref(false)
  const currentMatchIndex = ref(0)
  const matches = ref([])
  const contentElement = ref(null)

  // Highlight class name
  const HIGHLIGHT_CLASS = 'search-highlight'
  const ACTIVE_CLASS = 'search-highlight-active'

  /**
   * Open the search bar
   */
  function openSearch() {
    isSearchOpen.value = true
  }

  /**
   * Close the search bar and clear highlights
   */
  function closeSearch() {
    isSearchOpen.value = false
    searchQuery.value = ''
    clearHighlights()
  }

  /**
   * Clear all search highlights from the document
   */
  function clearHighlights() {
    if (!contentElement.value) return

    const highlights = contentElement.value.querySelectorAll(`.${HIGHLIGHT_CLASS}`)
    highlights.forEach(el => {
      const parent = el.parentNode
      parent.replaceChild(document.createTextNode(el.textContent), el)
      parent.normalize() // Merge adjacent text nodes
    })

    matches.value = []
    currentMatchIndex.value = 0
  }

  /**
   * Perform search and highlight matches
   */
  function performSearch() {
    clearHighlights()

    if (!searchQuery.value || !contentElement.value) {
      return
    }

    const query = searchQuery.value.toLowerCase()
    const walker = document.createTreeWalker(
      contentElement.value,
      NodeFilter.SHOW_TEXT,
      null,
      false
    )

    const textNodes = []
    let node
    while (node = walker.nextNode()) {
      // Skip nodes inside pre/code blocks for better UX
      const parent = node.parentElement
      if (parent && (parent.tagName === 'PRE' || parent.tagName === 'CODE' || parent.closest('pre'))) {
        continue
      }
      if (node.textContent.toLowerCase().includes(query)) {
        textNodes.push(node)
      }
    }

    const newMatches = []

    textNodes.forEach(textNode => {
      const text = textNode.textContent
      const lowerText = text.toLowerCase()
      const parent = textNode.parentNode

      let lastIndex = 0
      let index
      const fragments = []

      while ((index = lowerText.indexOf(query, lastIndex)) !== -1) {
        // Text before match
        if (index > lastIndex) {
          fragments.push(document.createTextNode(text.slice(lastIndex, index)))
        }

        // The match itself
        const mark = document.createElement('mark')
        mark.className = HIGHLIGHT_CLASS
        mark.textContent = text.slice(index, index + query.length)
        fragments.push(mark)
        newMatches.push(mark)

        lastIndex = index + query.length
      }

      // Remaining text after last match
      if (lastIndex < text.length) {
        fragments.push(document.createTextNode(text.slice(lastIndex)))
      }

      // Replace the text node with fragments
      if (fragments.length > 0) {
        fragments.forEach(fragment => {
          parent.insertBefore(fragment, textNode)
        })
        parent.removeChild(textNode)
      }
    })

    matches.value = newMatches
    currentMatchIndex.value = 0

    // Highlight and scroll to first match
    if (newMatches.length > 0) {
      updateActiveMatch()
    }
  }

  /**
   * Update which match is currently active
   */
  function updateActiveMatch() {
    // Remove active class from all
    matches.value.forEach(el => el.classList.remove(ACTIVE_CLASS))

    // Add active class to current
    if (matches.value.length > 0 && matches.value[currentMatchIndex.value]) {
      const activeMatch = matches.value[currentMatchIndex.value]
      activeMatch.classList.add(ACTIVE_CLASS)

      // Scroll into view
      activeMatch.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      })
    }
  }

  /**
   * Go to next match
   */
  function nextMatch() {
    if (matches.value.length === 0) return

    currentMatchIndex.value = (currentMatchIndex.value + 1) % matches.value.length
    updateActiveMatch()
  }

  /**
   * Go to previous match
   */
  function prevMatch() {
    if (matches.value.length === 0) return

    currentMatchIndex.value = (currentMatchIndex.value - 1 + matches.value.length) % matches.value.length
    updateActiveMatch()
  }

  // Watch for query changes and debounce search
  let searchTimeout
  watch(searchQuery, () => {
    clearTimeout(searchTimeout)
    searchTimeout = setTimeout(() => {
      performSearch()
    }, 150)
  })

  // Computed for match count display
  const matchCount = computed(() => matches.value.length)
  const matchDisplay = computed(() => {
    if (!searchQuery.value) return ''
    if (matches.value.length === 0) return 'No matches'
    return `${currentMatchIndex.value + 1} of ${matches.value.length}`
  })

  return {
    searchQuery,
    isSearchOpen,
    currentMatchIndex,
    matchCount,
    matchDisplay,
    contentElement,
    openSearch,
    closeSearch,
    nextMatch,
    prevMatch,
    clearHighlights
  }
}

export default useSearch
