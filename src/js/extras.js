/**
 * extras.js — Extended frontend functionality
 * Bookmarks bar rendering, context menu, keyboard shortcuts
 */

import { invoke } from 'https://cdn.jsdelivr.net/npm/@tauri-apps/api@2/core.js';

export function initExtras({ navigate, getActiveTab, settings, toast }) {
  // ── Bookmarks bar ───────────────────────────────────────────────
  const bmBar = document.getElementById('bookmarks-bar');
  if (bmBar) {
    if (settings.show_bookmarks_bar === false) {
      bmBar.classList.add('hidden');
    }
  }

  // ── Keyboard shortcuts overlay ──────────────────────────────────
  const kbdOverlay = document.getElementById('kbd-overlay');
  
  window.addEventListener('keydown', e => {
    // Show shortcut overlay on Ctrl+? or Cmd+?
    if ((e.ctrlKey || e.metaKey) && e.key === '?') {
      e.preventDefault();
      kbdOverlay?.classList.toggle('open');
      return;
    }

    // Escape closes overlays
    if (e.key === 'Escape') {
      kbdOverlay?.classList.remove('open');
      closeContextMenu();
      return;
    }

    // Ctrl+T: New Tab (in a real browser this would trigger createTab, we simulate by clicking the + button)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
      e.preventDefault();
      document.getElementById('new-tab-btn')?.click();
      return;
    }

    // Ctrl+W: Close Tab
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      const tab = getActiveTab();
      if (tab) {
        // Tab closing requires access to `closeTab` from browser.js. 
        // For now we just select the close button of the active tab.
        document.querySelector('.tab.active .tab-close')?.click();
      }
      return;
    }

    // Ctrl+R: Reload
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'r')) {
      e.preventDefault();
      document.getElementById('btn-reload')?.click();
      return;
    }
  });

  if (kbdOverlay) {
    kbdOverlay.addEventListener('click', e => {
      if (e.target === kbdOverlay) kbdOverlay.classList.remove('open');
    });
  }

  // ── Context Menu ────────────────────────────────────────────────
  const ctx = document.getElementById('context-menu');
  
  window.addEventListener('contextmenu', e => {
    // Only intercept context menu in the app chrome, let WebView handle its own
    if (e.target.closest('#webview-container') || !ctx) return;
    
    e.preventDefault();
    
    // Position menu
    let x = e.clientX;
    let y = e.clientY;
    
    ctx.style.display = 'block';
    
    // Adjust if off-screen
    const rect = ctx.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x -= rect.width;
    if (y + rect.height > window.innerHeight) y -= rect.height;
    
    ctx.style.left = x + 'px';
    ctx.style.top = y + 'px';
    ctx.classList.add('open');
  });

  window.addEventListener('click', () => closeContextMenu());

  function closeContextMenu() {
    if (ctx) {
      ctx.classList.remove('open');
      setTimeout(() => { if (!ctx.classList.contains('open')) ctx.style.display = 'none'; }, 150);
    }
  }

  // Wire up context menu actions
  document.getElementById('ctx-new-tab')?.addEventListener('click', () => {
    document.getElementById('new-tab-btn')?.click();
  });
  document.getElementById('ctx-reload')?.addEventListener('click', () => {
    document.getElementById('btn-reload')?.click();
  });
  document.getElementById('ctx-settings')?.addEventListener('click', () => {
    document.getElementById('btn-settings')?.click();
  });
}

/**
 * Render the horizontal bookmarks bar
 */
export async function renderBookmarksBar(navigate) {
  const bmBar = document.getElementById('bookmarks-bar');
  if (!bmBar) return;
  
  const bookmarks = await invoke('get_bookmarks').catch(() => []);
  
  bmBar.innerHTML = bookmarks.length === 0 
    ? `<span style="font-size:11px;color:var(--text-muted);padding-left:10px">No bookmarks yet. Add one with the star icon.</span>`
    : bookmarks.map(b => `
      <div class="bm-chip" data-url="${b.url}" title="${b.title}\\n${b.url}">
        <img src="https://www.google.com/s2/favicons?sz=32&domain=${getDomain(b.url)}" onerror="this.style.display='none'">
        <span>${escHtml(b.title)}</span>
      </div>
    `).join('');

  bmBar.querySelectorAll('.bm-chip').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.url));
  });
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}
function escHtml(str = '') {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
