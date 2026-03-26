/**
 * sidebar.js — Sidebar initialisation helper
 * (actual rendering is in browser.js; this module wires up search)
 */

export function initSidebar({ navigate, refreshSidebar }) {
  const searchInput = document.getElementById('sidebar-search');

  searchInput?.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase().trim();
    const activePanel = document.querySelector('.sidebar-panel.active');
    if (!activePanel) return;

    const items = activePanel.querySelectorAll('.sidebar-item');
    items.forEach(item => {
      const title = item.querySelector('.sidebar-item-title')?.textContent.toLowerCase() || '';
      const url = item.dataset.url?.toLowerCase() || '';
      
      if (title.includes(query) || url.includes(query)) {
        item.style.display = 'flex';
      } else {
        item.style.display = 'none';
      }
    });

    // Handle empty state for filtered results
    const visibleItems = Array.from(items).filter(i => i.style.display !== 'none');
    let noResultsMsg = activePanel.querySelector('.no-results-msg');
    
    if (visibleItems.length === 0 && query !== '') {
      if (!noResultsMsg) {
        noResultsMsg = document.createElement('p');
        noResultsMsg.className = 'no-results-msg';
        noResultsMsg.style.cssText = 'color:var(--text-muted);font-size:11px;padding:20px;text-align:center';
        noResultsMsg.textContent = 'No matches found';
        activePanel.appendChild(noResultsMsg);
      }
    } else if (noResultsMsg) {
      noResultsMsg.remove();
    }
  });

  // Re-apply filter after sidebar refresh
  const observer = new MutationObserver(() => {
    if (searchInput && searchInput.value) {
      searchInput.dispatchEvent(new Event('input'));
    }
  });
  
  const panels = document.querySelectorAll('.sidebar-panel');
  panels.forEach(p => observer.observe(p, { childList: true }));
}

