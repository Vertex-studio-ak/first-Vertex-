/**
 * browser.js — Core browser logic for Brauser
 * Handles: tabs, navigation, IPC calls to Rust backend,
 *          history, bookmarks, window controls, loading bar
 */

// Try to get Tauri API from window or CDN
let tauriApi = window.__TAURI__ || {};
const invoke = tauriApi.core?.invoke || (await import('https://cdn.jsdelivr.net/npm/@tauri-apps/api@2/core.js')).invoke;
const { LogicalSize, LogicalPosition } = tauriApi.dpi || (await import('https://cdn.jsdelivr.net/npm/@tauri-apps/api@2/dpi.js'));
const { getCurrentWindow } = tauriApi.window || (await import('https://cdn.jsdelivr.net/npm/@tauri-apps/api@2/window.js'));
const { Webview } = tauriApi.webview || (await import('https://cdn.jsdelivr.net/npm/@tauri-apps/api@2/webview.js'));
const { listen } = tauriApi.event || (await import('https://cdn.jsdelivr.net/npm/@tauri-apps/api@2/event.js'));
import { initOmnibox } from './omnibox.js';
import { initSidebar } from './sidebar.js';
import { initExtras, renderBookmarksBar } from './extras.js';

let appWindow;
try {
  appWindow = getCurrentWindow();
} catch (e) {
  console.error("Vertex: Failed to get current window", e);
}

// ── State ────────────────────────────────────────────────────────
let tabs = [];
let activeTabId = null;
let settings = {};
let activePlugins = [];

// ── Injected Script for Password Management ──────────────────────
const INJECT_SCRIPT = `
(function() {
  function findLoginFields() {
    const passwords = document.querySelectorAll('input[type="password"]');
    if (passwords.length === 0) return null;
    
    // Find associated username (usually text/email input before password)
    const pw = passwords[0];
    const form = pw.form;
    let user = null;
    
    if (form) {
      user = form.querySelector('input[type="text"], input[type="email"], input:not([type])');
    } else {
      // Look globally near the password field
      const inputs = Array.from(document.querySelectorAll('input'));
      const idx = inputs.indexOf(pw);
      if (idx > 0) user = inputs[idx-1];
    }
    
    return { user, pw, form };
  }

  // Intercept form submission
  window.addEventListener('submit', (e) => {
    const fields = findLoginFields();
    if (fields && fields.user && fields.pw) {
      const u = fields.user.value;
      const p = fields.pw.value;
      if (u && p) {
        // Send to host via document.title (captured by onTitleUpdate)
        const payload = JSON.stringify({ u, p, url: location.href, title: document.title });
        document.title = 'VERTEX_SAVE_PW:' + payload;
      }
    }
    }
  }, true);

  // ── Download Interception ──
  window.addEventListener('click', (e) => {
    let el = e.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (el && el.href) {
      const url = el.href;
      const exts = ['.zip', '.rar', '.7z', '.exe', '.msi', '.pdf', '.dmg', '.pkg', '.mp3', '.mp4', '.mkv', '.iso'];
      const isDownload = exts.some(ext => url.toLowerCase().split('?')[0].endsWith(ext)) || el.hasAttribute('download');
      
      if (isDownload) {
        e.preventDefault();
        // Direct invoke for better reliability
        __TAURI_INTERNALS__.invoke('start_download', { url, suggestedFilename: el.getAttribute('download') || null })
          .catch(err => console.error("Download failed:", err));
      }
    }
  }, true);

  
  // ── Ad Blocking & YouTube Ad Skipping ────────────────────────
  function applyAdBlock() {
    const adSelectors = [
      '.video-ads', '.ytp-ad-module', '.ytp-ad-image-overlay', '.ytp-ad-text-overlay',
      '#player-ads', '#masthead-ad', '.ytd-promoted-sparkles-web-renderer',
      'div[id^="dfp-ad-"]', 'ins.adsbygoogle', '.google-ad', '.ad-box', '.ad-unit',
      'ytd-ad-slot-renderer', 'ytd-companion-slot-renderer', 'ytd-merch-shelf-renderer',
      '.ytp-ad-player-overlay', '.ytp-ad-player-overlay-layout',
      '.ytd-in-feed-ad-layout-renderer', '#ad-iframe', '.ad-container', '.ad-placement'
    ];
    
    // Inject CSS for instant hiding
    const style = document.createElement('style');
    style.id = 'vertex-adblock-styles';
    style.innerHTML = adSelectors.join(', ') + ' { display: none !important; opacity: 0 !important; pointer-events: none !important; }';
    document.head ? document.head.appendChild(style) : document.documentElement.appendChild(style);
    
    function hideAds() {

      adSelectors.forEach(s => {
        document.querySelectorAll(s).forEach(el => {
          el.remove(); // Use remove instead of display:none for better results
        });
      });
      
      // YouTube Skip Ad Button (Multi-language)
      const skipBtn = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button');
      if (skipBtn) {
        skipBtn.click();
      }
      
      // Auto-skip unskippable ads by speeding up
      const video = document.querySelector('video');
      const isAd = document.querySelector('.ad-showing, .ytp-ad-player-overlay');
      if (video && isAd) {
        if (!video.dataset.hasAdSpeed) {
          video.muted = true;
          video.playbackRate = 16;
          video.dataset.hasAdSpeed = 'true';
        }
      } else if (video && video.dataset.hasAdSpeed) {
        video.playbackRate = 1;
        delete video.dataset.hasAdSpeed;
      }
    }

    // Use MutationObserver for instant reaction
    const observer = new MutationObserver(hideAds);
    observer.observe(document.body, { childList: true, subtree: true });
    
    hideAds();
    setInterval(hideAds, 1000); // Fallback for some dynamic changes


    // Monkey-patch fetch and XHR for network-level blocking
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0].url;
      try {
        const block = await __TAURI_INTERNALS__.invoke('check_adblock', { url, sourceUrl: location.href, resourceType: 'fetch' });
        if (block) {
          console.warn('Vertex: Blocked fetch to', url);
          return new Response('', { status: 403, statusText: 'Blocked by Vertex' });
        }
      } catch(e) {}
      return originalFetch(...args);
    };

    const originalXHR = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function(method, url) {
      this._url = url;
      return originalXHR.apply(this, arguments);
    };
    const originalSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.send = async function() {
      try {
        const block = await __TAURI_INTERNALS__.invoke('check_adblock', { url: this._url, sourceUrl: location.href, resourceType: 'xmlhttprequest' });
        if (block) {
          console.warn('Vertex: Blocked XHR to', this._url);
          this.abort();
          return;
        }
      } catch(e) {}
      return originalSend.apply(this, arguments);
    };
  }

  applyAdBlock();

  // Potential Autofill logic here...
})();
`;

async function loadPlugins() {
  try {
    const all = await invoke('get_plugins');
    activePlugins = all.filter(p => p.enabled);
  } catch (e) {
    console.warn("Vertex: Failed to load plugins", e);
  }
}

function getPluginsScript() {
  return activePlugins.map(p => `
    try { 
      /* Extension: ${p.name.replace(/\*/g, '')} */
      ${p.script}
    } catch(e) { console.error("Vertex Extension Error (${p.name}):", e); }
  `).join('\n');
}

// ── DOM refs ─────────────────────────────────────────────────────
const tabbar        = document.getElementById('tabbar');
const newTabBtn     = document.getElementById('new-tab-btn');
const webviewWrap   = document.getElementById('webview-container');
const loadingBar    = document.getElementById('loading-bar');
const statusUrl     = document.getElementById('status-url');
const badgeSecure   = document.getElementById('badge-secure');
const badgeAdblock  = document.getElementById('badge-adblock');
const btnBack       = document.getElementById('btn-back');
const btnForward    = document.getElementById('btn-forward');
const btnReload     = document.getElementById('btn-reload');
const btnHome       = document.getElementById('btn-home');
const btnBookmark   = document.getElementById('btn-bookmark');
const btnSidebar    = document.getElementById('btn-sidebar');
const btnSettings   = document.getElementById('btn-settings');
const sidebar       = document.getElementById('sidebar');

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  settings = await invoke('get_settings').catch(() => ({
    theme: 'dark', adblock_enabled: true,
    search_engine: 'https://duckduckgo.com/?q=',
    home_page: 'vertex://newtab'
  }));

  applySettings(settings);
  await loadPlugins();

  // Try to open initial URL from command line or restore last session
  try {
    const [initialUrl, session, isDefault] = await Promise.all([
      invoke('get_initial_url').catch(() => null),
      invoke('load_session').catch(() => null),
      invoke('check_is_default_browser').catch(() => false)
    ]);

    // Onboarding check
    if (!settings.onboarding_completed) {
      if (!isDefault) {
        showOnboarding();
      } else {
        settings.onboarding_completed = true;
        invoke('save_settings', { settings }).catch(() => {});
      }
    }

    if (initialUrl) {
      createTab(initialUrl, 'Loading...', true);
      if (session && session.tabs.length > 0) {
        session.tabs.forEach((t) => {
          if (t.url !== initialUrl) createTab(t.url, t.title, false);
        });
      }
    } else if (session && session.tabs.length > 0) {
      session.tabs.forEach((t, i) => {
        createTab(t.url, t.title, i === session.active_index);
      });
    } else {
      createTab('vertex://newtab', 'New Tab', true);
    }
  } catch (err) {
    console.error("Vertex: Session/InitialURL error:", err);
    createTab('vertex://newtab', 'New Tab', true);
  }


  // Settings channel
  const settingsChannel = new BroadcastChannel('vertex_internal');
  settingsChannel.onmessage = async (e) => {
    if (e.data.type === 'get_settings') {
      settingsChannel.postMessage({ type: 'settings_data', settings });
    } else if (e.data.type === 'save_settings') {
      Object.assign(settings, e.data.settings);
      await invoke('save_settings', { settings });
      applySettings(settings);
      
      // Notify all other windows/tabs that settings have changed
      settingsChannel.postMessage({ type: 'settings_data', settings });
      
      const bmBar = document.getElementById('bookmarks-bar');
      if (settings.show_bookmarks_bar !== false) {
        if (bmBar) bmBar.classList.remove('hidden');
        renderBookmarksBar(navigate);
      } else {
        if (bmBar) {
          bmBar.innerHTML = '';
          bmBar.classList.add('hidden');
        }
      }
    } else if (e.data.type === 'register_default_browser') {
      try {
        await invoke('register_as_default_browser');
        toast('Registry updated. Please select Vertex in the Windows settings.');
      } catch(err) {
        toast('Error: ' + err);
      }
    } else if (e.data.type === 'plugins_updated') {
      await loadPlugins();
      const tab = getActiveTab();
      if (tab) {
        if (activePlugins.length > 0) {
          invoke('webview_eval', { id: tab.id, script: getPluginsScript() }).catch(() => {});
        }
      }
    }
  };

  // Listen for deep links / single-instance URLs
  listen('open-url', (event) => {
    console.log('Vertex: Opening external URL:', event.payload);
    createTab(event.payload, 'Loading...', true);
    // Bring window to focus
    appWindow.setFocus();
  });

  try { initOmnibox({ navigate, getActiveTab, settings }); } catch(e) { console.error("Omnibox init failed", e); }
  try { initSidebar({ navigate, refreshSidebar }); } catch(e) { console.error("Sidebar init failed", e); }
  try { initExtras({ navigate, getActiveTab, settings, toast }); } catch(e) { console.error("Extras init failed", e); }
  
  if (settings.show_bookmarks_bar !== false) {
    renderBookmarksBar(navigate);
  }

  // bindWindowControls(); // Now handled by index.html for maximum reliability
  bindToolbar();
  bindSidebar();
  bindPasswordPrompt();
  bindDownloadControls();


  // Save session on window close
  window.addEventListener('beforeunload', saveSession);
}

// ── Settings & Theme ─────────────────────────────────────────────
function applySettings(s) {
  // Theme mode
  document.body.classList.toggle('theme-light', s.theme === 'light');
  
  // Custom Accents
  if (s.accent_start) {
    document.documentElement.style.setProperty('--grad-start', s.accent_start);
    document.documentElement.style.setProperty('--accent', s.accent_start);
  }
  if (s.accent_end) {
    document.documentElement.style.setProperty('--grad-end', s.accent_end);
  }
  
  // Glass Blur
  if (s.glass_blur !== undefined) {
    // We target the backdrop-filter via a root variable if main.css supports it
    // For now, we'll try to set a global glass-blur variable
    document.documentElement.style.setProperty('--glass-blur-val', `${s.glass_blur}px`);
  }

  // UI elements
  badgeAdblock.style.display = s.adblock_enabled ? '' : 'none';
}

function createTab(url = 'vertex://newtab', title = 'New Tab', activate = true) {
  const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  
  // Prepare script with current settings
  const finalScript = `
    (function() {
      const ENABLE_ADBLOCK = ${settings.adblock_enabled !== false};
      ${INJECT_SCRIPT.replace('(function() {', '').replace('})();', '')}
      if (ENABLE_ADBLOCK) applyAdBlock();
    })();
  `;

  // Create placeholder slot to measure bounds
  const slot = document.createElement('div');
  slot.className = 'webview-slot';
  slot.id = `slot-${id}`;
  if (activate) { slot.classList.add('active'); }
  webviewWrap.appendChild(slot);

  const rect = slot.getBoundingClientRect();
  const startW = Math.max(rect.width, 100);
  const startH = Math.max(rect.height, 100);

  // Native webview
  const wvUrl = resolveUrl(url);
  const wv = new Webview(appWindow, id, {
    url: wvUrl,
    x: rect.left,
    y: rect.top,
    width: startW,
    height: startH,
    focus: activate,
    visible: activate // Create hidden if not active to avoid flash
  });

  const tab = { id, url, title, favicon: null, wv, slot, loading: true };
  tabs.push(tab);

  // Webview events
  wv.once('tauri://created', () => {
    syncTabBounds(tab);
    if (!activate) wv.hide().catch(()=>null);
  });
  wv.once('tauri://error', (e) => {
    console.error("Webview creation error:", e);
  });

  // Listen for title and favicon changes
  wv.listen('tauri://title-change', (e) => {
    onTitleUpdate(id, e.payload || '');
  });
  wv.listen('tauri://favicon-change', (e) => {
    onFaviconUpdate(id, e.payload || {});
  });

  // We don't have perfect native load events for arbitrary domains without Rust plugins,
  // but we can simulate onLoadStart 
  onLoadStart(id);
  // Inject password manager & adblock script
  invoke('webview_eval', { id, script: finalScript }).catch(() => {});

  setTimeout(() => {
    onLoadEnd(id);
    onNavigate(id, { url: wvUrl });
  }, 1000);

  renderTabs();
  if (activate) activateTab(id);
  queueSessionSave();
  return tab;
}

function syncTabBounds(tab) {
  if (!tab || !tab.slot) return;
  const rect = tab.slot.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    try {
      if (typeof LogicalSize !== "undefined") {
         tab.wv.setSize(new LogicalSize(rect.width, rect.height)).catch(()=>null);
         tab.wv.setPosition(new LogicalPosition(rect.left, rect.top)).catch(()=>null);
      } else {
         tab.wv.setSize({ type: 'Logical', width: rect.width, height: rect.height }).catch(()=>null);
         tab.wv.setPosition({ type: 'Logical', x: rect.left, y: rect.top }).catch(()=>null);
      }
    } catch(err) {
      console.warn("Bounds sync error:", err);
    }
  }
}

// Ensure resize observer keeps bounds in check
const resizeObserver = new ResizeObserver(() => {
  const activeTab = getActiveTab();
  if (activeTab) syncTabBounds(activeTab);
});
resizeObserver.observe(webviewWrap);

function activateTab(id) {
  activeTabId = id;
  tabs.forEach(t => {
    const isActive = (t.id === id);
    t.slot.classList.toggle('active', isActive);
    if (!isActive) {
      t.wv.hide().catch(()=>null);
    }
  });

  // Then show the active one
  const activeTab = tabs.find(t => t.id === id);
  if (activeTab) {
    activeTab.wv.show().then(() => {
      syncTabBounds(activeTab);
      activeTab.wv.setFocus();
    }).catch(()=>null);
  }

  renderTabs();
  updateToolbarForTab(getActiveTab());
  queueSessionSave();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  tab.slot.remove();
  tab.wv.hide().catch(()=>null); // Hide immediately before closing
  tab.wv.close().catch(()=>null);
  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    createTab('vertex://newtab', 'New Tab', true);
  } else if (activeTabId === id) {
    activateTab(tabs[Math.max(0, idx - 1)].id);
  }
  renderTabs();
  queueSessionSave();
}

function getActiveTab() {
  return tabs.find(t => t.id === activeTabId);
}

function renderTabs() {
  // Remove all tab elements (keep the + button)
  tabbar.querySelectorAll('.tab').forEach(el => el.remove());

  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    el.dataset.id = tab.id;

    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.src = tab.favicon || `https://www.google.com/s2/favicons?sz=64&domain=${getDomain(tab.url)}`;
    favicon.onerror = () => { favicon.style.display = 'none'; };

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url;

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.innerHTML = `<svg viewBox="0 0 10 10" width="10" height="10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
      <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
    </svg>`;
    close.addEventListener('click', e => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    el.appendChild(favicon);
    el.appendChild(title);
    el.appendChild(close);
    el.addEventListener('click', () => activateTab(tab.id));

    tabbar.insertBefore(el, newTabBtn);
  });
}

// ── Navigation ────────────────────────────────────────────────────
function navigate(input) {
  const tab = getActiveTab();
  if (!tab || !tab.wv) return;
  const url = resolveUrl(input);
  
  invoke('webview_navigate', { id: tab.id, url }).catch(console.warn);
  
  onLoadStart(tab.id);
  
  tab.url = url;
  updateOmniboxValue(url);
  onNavigate(tab.id, { url });
  
  // Re-inject on navigation immediately and after a delay to catch late-loading forms
  const runInject = () => {
    invoke('webview_eval', { id: tab.id, script: INJECT_SCRIPT }).catch(() => {});
    if (activePlugins.length > 0) {
      invoke('webview_eval', { id: tab.id, script: getPluginsScript() }).catch(() => {});
    }
  };
  runInject();
  setTimeout(runInject, 500); 
  setTimeout(runInject, 2000);
}

function resolveUrl(input) {
  if (!input || input === 'vertex://newtab') return window.location.origin + '/newtab.html';
  if (input === 'vertex://settings')         return window.location.origin + '/settings.html';
  if (input === 'vertex://passwords')        return window.location.origin + '/passwords.html';
  if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('file://') || input.startsWith(window.location.origin)) return input;
  // If it looks like a hostname
  if (/^[\w-]+\.[a-z]{2,}/.test(input)) return `https://${input}`;
  // Otherwise, search
  return `${settings.search_engine || 'https://duckduckgo.com/?q='}${encodeURIComponent(input)}`;
}

// ── URL Syncing ─────────────────────────────────────────────────────
setInterval(async () => {
  const tab = getActiveTab();
  if (!tab || !tab.wv) return;
  try {
    const url = await invoke('webview_get_url', { id: tab.id });
    if (url && url !== tab.url && url !== 'about:blank') {
      tab.url = url;
      updateToolbarForTab(tab);
    }
  } catch(e) {}
}, 500);

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ── WebView event handlers ────────────────────────────────────────
function onLoadStart(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  tab.loading = true;
  if (id === activeTabId) startLoadingBar();
}

function onLoadEnd(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  tab.loading = false;
  if (id === activeTabId) stopLoadingBar();
}

async function onNavigate(id, e) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  const url = e.url;
  tab.url = url;
  if (id === activeTabId) {
    updateToolbarForTab(tab);
    // Record history
    invoke('add_history', { title: tab.title || url, url }).catch(() => {});
  }
  
  // ── Autofill Logic ──
  try {
    const locked = await invoke('vault_is_locked');
    if (!locked) {
      const entries = await invoke('vault_get_entries');
      const domain = getDomain(url);
      const match = entries.find(e => getDomain(e.url) === domain);
      if (match) {
        const fillScript = `
          (function() {
            function fill() {
              const passwords = document.querySelectorAll('input[type="password"]');
              if (passwords.length > 0) {
                const pw = passwords[0];
                const form = pw.form;
                let user = form ? form.querySelector('input[type="text"], input[type="email"], input:not([type])') : null;
                if (!user) {
                  const inputs = Array.from(document.querySelectorAll('input'));
                  const idx = inputs.indexOf(pw);
                  if (idx > 0) user = inputs[idx-1];
                }
                if (user) {
                   user.value = ${JSON.stringify(match.username)};
                   user.dispatchEvent(new Event('input', { bubbles: true }));
                   user.dispatchEvent(new Event('change', { bubbles: true }));
                }
                pw.value = ${JSON.stringify(match.password)};
                pw.dispatchEvent(new Event('input', { bubbles: true }));
                pw.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
              return false;
            }
            if (!fill()) {
              const obs = new MutationObserver((muts) => { if(fill()) obs.disconnect(); });
              obs.observe(document.body, { childList: true, subtree: true });
              setTimeout(() => obs.disconnect(), 5000);
            }
          })();
        `;
        // Try multiple times to ensure the page is ready
        setTimeout(() => invoke('webview_eval', { id, script: fillScript }).catch(() => {}), 500);
        setTimeout(() => invoke('webview_eval', { id, script: fillScript }).catch(() => {}), 2000);
      }
    }
  } catch(err) {}

  queueSessionSave();
}

function onTitleUpdate(id, title) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  
  // ── IPC via Title (Password Save Signal) ──
  if (title.startsWith("VERTEX_SAVE_PW:")) {
    try {
      const data = JSON.parse(title.substring(15));
      pendingPwData = data;
      document.getElementById('pw-prompt-site').textContent = getDomain(data.url);
      document.getElementById('pw-prompt-user').textContent = data.u;
      document.getElementById('pw-save-prompt').classList.add('active');
    } catch(e) {}
    return; // Don't update UI title with signal
  }

  if (title.startsWith("VERTEX_DOWNLOAD:")) {
    // Keep as fallback just in case, though the direct invoke above is preferred
    const url = title.substring(16);
    invoke('start_download', { url }).catch(err => toast("Download failed: " + err));
    return;
  }

  tab.title = title;
  renderTabs();
  if (id === activeTabId) {
    document.title = `${title} — Vertex`;
  }
}

function onFaviconUpdate(id, payload) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  // Handle both {favicons:[]} and direct array payload
  const favicons = payload.favicons || (Array.isArray(payload) ? payload : []);
  if (!favicons.length) return;
  
  tab.favicon = favicons[0];
  renderTabs();
}

// ── Toolbar ───────────────────────────────────────────────────────
function updateToolbarForTab(tab) {
  if (!tab) return;
  const url = tab.url;
  updateOmniboxValue(url === 'newtab.html' ? '' : url);
  // Security badge
  const isSecure = url.startsWith('https://');
  badgeSecure.style.display = isSecure ? '' : 'none';
  // Status bar
  statusUrl.textContent = url === 'newtab.html' ? '' : url;
}

function updateOmniboxValue(val) {
  const omnibox = document.getElementById('omnibox');
  if (omnibox && document.activeElement !== omnibox) {
    omnibox.value = val === 'newtab.html' ? '' : val;
  }
}

function bindToolbar() {
  btnBack.addEventListener('click',    () => { const t = getActiveTab(); if (t) invoke('webview_go_back', { id: t.id }).catch(()=>null); });
  btnForward.addEventListener('click', () => { const t = getActiveTab(); if (t) invoke('webview_go_forward', { id: t.id }).catch(()=>null); });
  btnReload.addEventListener('click',  () => { const t = getActiveTab(); if (t) invoke('webview_reload', { id: t.id }).catch(()=>null); });
  btnHome.addEventListener('click',    () => navigate(settings.home_page || 'vertex://newtab'));
  newTabBtn.addEventListener('click',  () => { createTab('vertex://newtab', 'New Tab', true); });
  btnSettings.addEventListener('click', () => { createTab('vertex://settings', 'Settings', true); });
  document.getElementById('btn-passwords').addEventListener('click', () => { createTab('vertex://passwords', 'Passwords', true); });

  btnBookmark.addEventListener('click', async () => {
    const tab = getActiveTab();
    if (!tab || tab.url === 'newtab.html') return;
    const bm = await invoke('add_bookmark', { title: tab.title || tab.url, url: tab.url });
    btnBookmark.classList.add('active');
    toast(`Bookmarked "${bm.title}"`);
    refreshSidebar();
  });
}

// ── Sidebar ───────────────────────────────────────────────────────
function bindSidebar() {
  btnSidebar.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('open');
    btnSidebar.classList.toggle('active', isOpen);
    if (isOpen) refreshSidebar();
  });

  // Panel tab switching
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`panel-${tab.dataset.panel}`).classList.add('active');
      refreshSidebar();
    });
  });
}

async function refreshSidebar() {
  await Promise.all([
    renderBookmarks(),
    renderHistory(),
  ]);
  if (settings.show_bookmarks_bar !== false) {
    renderBookmarksBar(navigate);
  }
}

async function renderBookmarks() {
  const panel = document.getElementById('panel-bookmarks');
  const bookmarks = await invoke('get_bookmarks').catch(() => []);
  panel.innerHTML = bookmarks.length === 0
    ? `<p style="color:var(--text-muted);font-size:12px;padding:16px;text-align:center">No bookmarks yet</p>`
    : bookmarks.map(b => `
      <div class="sidebar-item" data-url="${b.url}">
        <img class="sidebar-item-icon" src="https://www.google.com/s2/favicons?sz=32&domain=${getDomain(b.url)}"
             width="14" height="14" style="border-radius:2px" onerror="this.style.display='none'">
        <div class="sidebar-item-body">
          <div class="sidebar-item-title">${escHtml(b.title)}</div>
          <div class="sidebar-item-sub">${escHtml(getDomain(b.url))}</div>
        </div>
        <span class="sidebar-item-action" data-remove="${b.id}" title="Remove">
          <svg viewBox="0 0 12 12" width="12" height="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
          </svg>
        </span>
      </div>`).join('');

  panel.querySelectorAll('.sidebar-item[data-url]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-remove]')) return;
      navigate(el.dataset.url);
    });
  });
  panel.querySelectorAll('[data-remove]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation();
      await invoke('remove_bookmark', { id: el.dataset.remove });
      renderBookmarks();
    });
  });
}

async function renderHistory() {
  const panel = document.getElementById('panel-history');
  const history = await invoke('get_history').catch(() => []);
  panel.innerHTML = history.length === 0
    ? `<p style="color:var(--text-muted);font-size:12px;padding:16px;text-align:center">No history yet</p>`
    : `<div style="display:flex;justify-content:flex-end;padding:4px 8px">
         <button id="clear-history-btn" style="font-size:11px;color:var(--text-muted);background:none;border:none;cursor:pointer">Clear all</button>
       </div>` +
      history.slice(0, 50).map(h => `
      <div class="sidebar-item" data-url="${h.url}">
        <img src="https://www.google.com/s2/favicons?sz=32&domain=${getDomain(h.url)}"
             width="14" height="14" style="border-radius:2px;flex-shrink:0" onerror="this.style.display='none'">
        <div class="sidebar-item-body">
          <div class="sidebar-item-title">${escHtml(h.title)}</div>
          <div class="sidebar-item-sub">${formatDate(h.visited_at)}</div>
        </div>
      </div>`).join('');

  panel.querySelector('#clear-history-btn')?.addEventListener('click', async () => {
    await invoke('clear_history');
    renderHistory();
  });
  panel.querySelectorAll('.sidebar-item[data-url]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.url));
  });
}

// ── Session ───────────────────────────────────────────────────────
let sessionTimer = null;
function queueSessionSave() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSession, 1500);
}

async function saveSession() {
  const sessionTabs = tabs.map(t => ({ url: t.url, title: t.title }));
  const activeIdx = tabs.findIndex(t => t.id === activeTabId);
  await invoke('save_session', {
    tabs: sessionTabs,
    activeIndex: Math.max(0, activeIdx)
  }).catch(() => {});
}

// ── Loading bar ───────────────────────────────────────────────────
let loadTimer = null;
function startLoadingBar() {
  loadingBar.classList.add('loading');
  loadingBar.style.width = '10%';
  loadTimer = setInterval(() => {
    const cur = parseFloat(loadingBar.style.width) || 0;
    if (cur < 80) loadingBar.style.width = (cur + Math.random() * 8) + '%';
  }, 300);
}
function stopLoadingBar() {
  clearInterval(loadTimer);
  loadingBar.style.width = '100%';
  setTimeout(() => {
    loadingBar.classList.remove('loading');
    loadingBar.style.width = '0%';
  }, 400);
}

// ── Password Save Flow ───────────────────────────────────────────
let pendingPwData = null;

async function bindPasswordPrompt() {
  const prompt = document.getElementById('pw-save-prompt');
  const btnSave = document.getElementById('btn-pw-save');
  const btnIgnore = document.getElementById('btn-pw-ignore');
  const btnClose = document.getElementById('btn-pw-close');

  // Logic moved to onTitleUpdate for cleaner IPC flow
  
  btnSave.addEventListener('click', async () => {
    if (!pendingPwData) return;
    const { u, p, url, title } = pendingPwData;
    
    // Check if vault is setup
    const setup = await invoke('vault_is_setup');
    if (!setup) {
      toast("Please setup Password Manager first (vault icon)");
      prompt.classList.remove('active');
      return;
    }

    // Check if locked
    const locked = await invoke('vault_is_locked');
    if (locked) {
      toast("Unlock your vault to save this password");
      prompt.classList.remove('active');
      // maybe open passwords page?
      return;
    }

    await invoke('vault_add_entry', {
      title: title || getDomain(url),
      url, username: u, password: p
    }).catch(err => toast("Error: " + err));

    toast("Password saved to vault");
    prompt.classList.remove('active');
    pendingPwData = null;
  });

  btnIgnore.addEventListener('click', () => {
    prompt.classList.remove('active');
    pendingPwData = null;
  });
  btnClose.addEventListener('click', () => {
    prompt.classList.remove('active');
    pendingPwData = null;
  });
}

// ── Download Controls ─────────────────────────────────────────────
function bindDownloadControls() {
  const btn = document.getElementById('btn-downloads');
  const ring = document.querySelector('.progress-ring');
  const circle = document.querySelector('.progress-ring-circle');
  const badge = document.getElementById('downloads-badge');
  const radius = 12;
  const circumference = 2 * Math.PI * radius;
  
  if (circle) {
    circle.style.strokeDasharray = `${circumference} ${circumference}`;
    circle.style.strokeDashoffset = circumference;
  }

  btn?.addEventListener('click', () => {
    invoke('open_downloads_window');
  });

  listen('download-update', (event) => {
    const item = event.payload;
    updateDownloadUI(item);
  });

  let activeDownloads = new Set();

  function updateDownloadUI(item) {
    if (item.status === 'Started' || item.status === 'Progress') {
      activeDownloads.add(item.id);
    } else {
      activeDownloads.delete(item.id);
    }

    const count = activeDownloads.size;
    if (count > 0) {
      badge.textContent = count;
      badge.classList.add('active');
      ring.classList.add('active');
      
      // For now, ring shows progress of the *latest* active download
      const progress = item.total_bytes ? (item.downloaded_bytes / item.total_bytes) : 0;
      const offset = circumference - (progress * circumference);
      if (circle) circle.style.strokeDashoffset = offset;
      
      if (item.status === 'Started') toast(`Download started: ${item.name}`);
    } else {
      badge.classList.remove('active');
      ring.classList.remove('active');
      if (circle) circle.style.strokeDashoffset = circumference;
      
      if (item.status === 'Finished') toast(`Download finished: ${item.name}`);
    }
  }
}

// ── Window controls ───────────────────────────────────────────────

function bindWindowControls() {
  if (!appWindow) return;

  const btnClose = document.getElementById('btn-close');
  const btnMin = document.getElementById('btn-minimize');
  const btnMax = document.getElementById('btn-maximize');

  if (btnClose) {
    btnClose.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("Vertex: Close button clicked");
      try {
        // Run saveSession with a timeout so it doesn't block window closing indefinitely
        await Promise.race([
          saveSession(),
          new Promise(r => setTimeout(r, 500))
        ]);
      } catch (e) {}
      await appWindow.close();
    });
  }

  if (btnMin) {
    btnMin.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      appWindow.minimize();
    });
  }

  if (btnMax) {
    btnMax.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const maximized = await appWindow.isMaximized();
      if (maximized) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
    });
  }

  // Also ensure window can be closed via system menu/Alt+F4
  try {
    appWindow.onCloseRequested(async () => {
      try { await saveSession(); } catch(e) {}
    });
  } catch(e) {}
}

// ── Utilities ─────────────────────────────────────────────────────
function toast(msg, duration = 2500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  const container = document.getElementById('toast-container');
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

function escHtml(str = '') {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  } catch { return iso; }
}

// ─── Onboarding ─────────────────────────────────────────────────────
function showOnboarding() {
  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) {
    overlay.classList.add('active');
    // Also disable titlebar controls visibility if needed, but for now just show overlay
  }
}

function hideOnboarding() {
  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) overlay.classList.remove('active');
  settings.onboarding_completed = true;
  invoke('save_settings', { settings }).catch(() => {});
}

document.getElementById('ob-set-default')?.addEventListener('click', async () => {
  try {
    await invoke('register_as_default_browser');
    toast('Opening Windows Settings...');
    // Don't hide yet, wait for user to change it
  } catch(e) { toast('Error: ' + e); }
});

document.getElementById('ob-pin')?.addEventListener('click', async () => {
  try {
    await invoke('pin_to_taskbar');
    toast('Attempting to Pin to Taskbar...');
  } catch(e) { toast('Note: Pinning may require manual confirmation.'); }
});

document.getElementById('ob-skip')?.addEventListener('click', () => {
  hideOnboarding();
});

// Expose helpers for other modules
export { navigate, getActiveTab, settings, toast };

// ── Boot ──────────────────────────────────────────────────────────
init();
