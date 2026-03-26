/**
 * omnibox.js — Address bar with autocomplete from history
 */

import { invoke } from 'https://cdn.jsdelivr.net/npm/@tauri-apps/api@2/core.js';

export function initOmnibox({ navigate, getActiveTab, settings }) {
  const omnibox     = document.getElementById('omnibox');
  const autocomplete = document.getElementById('autocomplete');
  let acItems = [], focusedIdx = -1;

  // ── Focus: select all text ──────────────────────────────────────
  omnibox.addEventListener('focus', () => {
    omnibox.select();
    const tab = getActiveTab();
    if (tab && tab.url !== 'newtab.html') omnibox.value = tab.url;
  });

  // ── Input: search history for autocomplete ──────────────────────
  omnibox.addEventListener('input', async () => {
    const val = omnibox.value.trim();
    focusedIdx = -1;
    if (!val) { closeAutoComplete(); return; }

    const results = await invoke('search_history', { query: val }).catch(() => []);
    acItems = [
      // If it looks like a URL add direct navigate suggestion first
      ...(isUrl(val) ? [{ type: 'url', title: val, url: prepUrl(val) }] : [
        { type: 'search', title: `Search: ${val}`, url: (settings.search_engine || 'https://duckduckgo.com/?q=') + encodeURIComponent(val) }
      ]),
      ...results.slice(0, 8).map(h => ({ type: 'history', title: h.title, url: h.url }))
    ];
    renderAutoComplete(val);
  });

  // ── Keyboard navigation ─────────────────────────────────────────
  omnibox.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIdx = Math.min(focusedIdx + 1, acItems.length - 1);
      highlightAc();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIdx = Math.max(focusedIdx - 1, -1);
      highlightAc();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const val = omnibox.value.trim();
      if (focusedIdx >= 0 && acItems[focusedIdx]) {
        commit(acItems[focusedIdx].url);
      } else if (val) {
        commit(val);
      }
    } else if (e.key === 'Escape') {
      closeAutoComplete();
      omnibox.blur();
    }
  });

  // ── Blur: close dropdown ────────────────────────────────────────
  omnibox.addEventListener('blur', () => {
    setTimeout(closeAutoComplete, 150);
  });

  // ── Helpers ─────────────────────────────────────────────────────
  function commit(val) {
    navigate(val);
    closeAutoComplete();
    omnibox.blur();
  }

  function isUrl(str) {
    return str.startsWith('http') || /^[\w-]+\.[a-z]{2,}/.test(str);
  }
  function prepUrl(str) {
    return str.startsWith('http') ? str : `https://${str}`;
  }

  function renderAutoComplete(query) {
    if (!acItems.length) { closeAutoComplete(); return; }
    autocomplete.innerHTML = acItems.map((item, i) => {
      const icon = item.type === 'search'
        ? `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14" y2="14"/></svg>`
        : item.type === 'url'
        ? `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2a10 10 0 0 1 0 12M8 2a10 10 0 0 0 0 12"/></svg>`
        : `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="5" r="2.5"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>`;

      return `<div class="ac-item${i === focusedIdx ? ' focused' : ''}" data-idx="${i}">
        <span class="ac-icon">${icon}</span>
        <span class="ac-title">${escHtml(item.title)}</span>
        <span class="ac-url">${escHtml(getDomain(item.url))}</span>
      </div>`;
    }).join('');

    autocomplete.querySelectorAll('.ac-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        commit(acItems[parseInt(el.dataset.idx)].url);
      });
    });
    autocomplete.classList.add('open');
  }

  function highlightAc() {
    autocomplete.querySelectorAll('.ac-item').forEach((el, i) => {
      el.classList.toggle('focused', i === focusedIdx);
    });
  }

  function closeAutoComplete() {
    autocomplete.classList.remove('open');
    autocomplete.innerHTML = '';
    acItems = [];
    focusedIdx = -1;
  }

  function getDomain(url) {
    try { return new URL(url).hostname; } catch { return url.slice(0, 30); }
  }
  function escHtml(str = '') {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
}
