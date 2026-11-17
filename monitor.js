((root) => {
  const ORIGIN = 'https://srprodmonitor.azurewebsites.net';
  const MENU_ID = 'icm-search-signalr-monitor';
  function searchQuery(value) {
    const query = typeof value === 'string' ? value.trim() : '';
    if (!query || query.length > 2048 || /[\r\n\x00-\x1f\x7f]/.test(query)) throw new Error('Select one resource name or resource ID (up to 2,048 characters).');
    return query;
  }
  function searchUrl(value) {
    const url = new URL('/', ORIGIN);
    url.searchParams.set('q', searchQuery(value));
    return url.href;
  }
  const storageKey = windowId => `icm-monitor-search-${windowId}`;
  function install(chrome) {
    if (!chrome.contextMenus) return;
    function registerMenu() {
      const options = { title: 'Search in SignalR Monitor', contexts: ['selection'] };
      chrome.contextMenus.update(MENU_ID, options, () => {
        if (chrome.runtime.lastError) chrome.contextMenus.create({ id: MENU_ID, ...options }, () => { void chrome.runtime.lastError; });
      });
    }
    async function openSearch(info, tab) {
      if (info.menuItemId !== MENU_ID) return;
      let payload;
      try { payload = { query: searchQuery(info.selectionText), requestId: crypto.randomUUID() }; }
      catch (error) { payload = { error: error.message, requestId: crypto.randomUUID() }; }
      const fallback = () => chrome.tabs.create({ url: payload.query ? searchUrl(payload.query) : chrome.runtime.getURL('monitor-panel.html?invalid=1') });
      if (!chrome.sidePanel?.open || !chrome.storage.session || !Number.isInteger(tab?.windowId)) return fallback();
      try {
        // Start open() in the context-menu gesture, before awaiting any storage operation.
        await Promise.all([
          chrome.storage.session.set({ [storageKey(tab.windowId)]: payload }),
          chrome.sidePanel.open({ windowId: tab.windowId }),
        ]);
      } catch { await fallback(); }
    }
    chrome.contextMenus.onClicked.addListener((info, tab) => openSearch(info, tab).catch(() => {}));
    chrome.runtime.onInstalled?.addListener(registerMenu);
    registerMenu();
  }
  const api = { ORIGIN, MENU_ID, searchQuery, searchUrl, storageKey, install };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IcmSignalRMonitor = api;
})(globalThis);
