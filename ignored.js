(() => {
  const M = IcmOncall; const UI = IcmOncallUI; const request = IcmOncallClient.request;
  const $ = id => document.getElementById(id);
  let db;
  const failure = error => { $('status').textContent = error.message; $('status').classList.add('ico-error'); };
  function render() {
    if (!db) return;
    const report = M.currentReport(db);
    $('report-context').textContent = `Track adds incidents to: ${report.name}. Change the selected report in the dashboard.`;
    const all = M.ignoredEntries(db);
    const query = $('search').value.toLowerCase().trim();
    const entries = all.filter(entry => !query || `${entry.id} ${entry.title}`.toLowerCase().includes(query));
    $('status').classList.remove('ico-error');
    $('status').textContent = `${entries.length} of ${all.length} ignored incidents`;
    $('empty').hidden = all.length !== 0;
    $('incidents').replaceChildren(...entries.map(entry => {
      const row = UI.node('tr'); const title = UI.node('td', 'incident-title');
      const link = UI.node('a', 'incident-id', `#${entry.id} ↗`); link.href = M.incidentUrl(entry.id); link.target = '_blank'; link.rel = 'noopener noreferrer';
      title.append(link, UI.node('div', '', entry.title || 'Title not recorded'));
      const date = UI.node('td', '', entry.ignoredAt ? new Date(entry.ignoredAt).toLocaleString('en-GB') : '—');
      const actions = UI.node('td', 'row-buttons'); const restore = UI.button('Restore'); const track = UI.button('Track', 'ico-primary');
      restore.setAttribute('aria-label', `Restore incident ${entry.id}`); track.setAttribute('aria-label', `Track incident ${entry.id}`);
      const act = async tracked => {
        restore.disabled = track.disabled = true;
        try {
          if (tracked) {
            const previous = report.entries[entry.id];
            const patch = { tracked: true }; const base = {};
            if (!previous?.title && entry.title) { patch.title = entry.title; base.title = previous?.title || ''; }
            db = await request('save', { reportId: report.id, incidentId: entry.id, patch, base, restoreIgnored: true, baseIgnored: true });
          } else db = await request('ignore', { reportId: report.id, incidentId: entry.id, ignored: false });
          render(); UI.toast(tracked ? `Restored and tracked in ${report.name}.` : 'Restored to query lists. Not added to the selected report.');
        } catch (error) { failure(error); restore.disabled = track.disabled = false; }
      };
      restore.addEventListener('click', () => act(false)); track.addEventListener('click', () => act(true));
      actions.append(restore, track); row.append(title, date, actions); return row;
    }));
  }
  $('search').addEventListener('input', render);
  $('dashboard').addEventListener('click', () => request('open').catch(failure));
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[M.STORAGE_KEY]?.newValue) { db = changes[M.STORAGE_KEY].newValue; render(); } });
  request('get').then(value => { db = value; render(); }).catch(failure);
})();
