(() => {
  const M = IcmSignalRMonitor;
  const $ = id => document.getElementById(id);
  let storageKey, changeVersion = 0;
  function error(message) {
    $('monitor-status').textContent = message;
    $('monitor-status').dataset.error = 'true';
    $('monitor-status').hidden = false;
  }
  function show(query) {
    try {
      const text = M.searchQuery(query);
      const currentUrl = M.searchUrl(text);
      $('monitor-query').value = text;
      $('open-monitor').href = currentUrl;
      $('monitor-status').textContent = '';
      $('monitor-status').dataset.error = 'false';
      $('monitor-status').hidden = true;
      $('monitor-frame').hidden = false;
      $('monitor-frame').src = currentUrl;
    } catch (reason) { error(reason.message); }
  }
  function apply(value) {
    if (value?.error) {
      $('monitor-query').value = '';
      $('monitor-frame').removeAttribute('src');
      $('monitor-frame').hidden = true;
      $('open-monitor').href = M.ORIGIN;
      error(value.error); return;
    }
    if (value?.query) show(value.query);
  }
  $('monitor-search').addEventListener('submit', event => { event.preventDefault(); show($('monitor-query').value); });
  $('monitor-frame').addEventListener('error', () => error('The embedded page could not open. Use Open in new tab.'));
  // A cross-origin iframe load event also fires for blocked pages; do not claim search success from it.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && storageKey && changes[storageKey]) { changeVersion++; apply(changes[storageKey].newValue); }
  });
  (async () => {
    if (new URL(location.href).searchParams.has('invalid')) { error('Select one resource name or resource ID (up to 2,048 characters).'); return; }
    const currentWindow = await chrome.windows.getCurrent();
    storageKey = M.storageKey(currentWindow.id);
    const version = changeVersion;
    const saved = await chrome.storage.session.get(storageKey);
    if (version === changeVersion) apply(saved[storageKey]);
  })().catch(() => error('Could not read the selected resource. Enter its name above to search.'));
})();
