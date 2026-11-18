(() => {
  const M = IcmOncall; const UI = IcmOncallUI; const request = IcmOncallClient.request;
  const $ = id => document.getElementById(id);
  let db, editor, copyReportId, backupPath = '';
  let bridgeStatus = { state: 'disconnected' }, checkingAgent = false;
  let sortKey = '', sortDirection = 'ascending';
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const sortButtons = [...document.querySelectorAll('.column-sort')];
  const detailFields = M.FIELDS.filter(([key]) => !sortButtons.some(button => button.dataset.sort === key));
  const initialControls = [...document.querySelectorAll('button, input, select')];
  initialControls.forEach(control => { control.disabled = true; });
  const current = () => M.reportForDisplay(db);
  const failure = error => { $('status').textContent = error.message; $('status').classList.add('ico-error'); };
  const filename = ext => `${current().name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'oncall-report'}.${ext}`;
  function excerpt(value, terms = []) {
    if (value.length <= 220) return value;
    const lower = value.toLowerCase();
    const matches = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
    const start = matches.length ? Math.max(0, Math.min(...matches) - 60) : 0;
    return (start ? '…' : '') + value.slice(start, start + 217) + (start + 217 < value.length ? '…' : '');
  }
  function createHighlighter(terms) {
    const pattern = terms.length ? new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|'), 'gi') : null;
    return (element, value) => {
      if (!pattern) { element.textContent = value; return element; }
      let offset = 0;
      for (const match of value.matchAll(pattern)) {
        element.append(document.createTextNode(value.slice(offset, match.index)), UI.node('mark', '', match[0]));
        offset = match.index + match[0].length;
      }
      element.append(document.createTextNode(value.slice(offset)));
      return element;
    };
  }
  function compareEntries(a, b) {
    const left = a[sortKey].trim(), right = b[sortKey].trim();
    if (!left || !right) return left ? -1 : right ? 1 : 0;
    return collator.compare(left, right) * (sortDirection === 'ascending' ? 1 : -1);
  }
  function editEntry(entry, anchor) {
    if (editor?.panel.isConnected) return;
    const report = current();
    editor = UI.openEditor({ report, entry, returnFocus: anchor, onSave: (patch, base) => request('save', { reportId: report.id, incidentId: entry.id, patch, base }) });
  }
  function renderCopyRange() {
    if (!db) return;
    const status = $('copy-range-status');
    status.classList.remove('ico-error'); $('copy-after').removeAttribute('aria-invalid');
    let count = 0;
    try {
      const report = current(); const entries = M.exportEntries(report, $('copy-after').value);
      count = entries.length;
      const rows = M.groups(report, entries).length;
      status.textContent = count ? `${count === rows ? '' : `${count} incidents · `}${rows} row${rows === 1 ? '' : 's'} to copy`
        : $('copy-after').value.trim() ? 'No newly tracked incidents after this ICM.' : 'Track an incident to copy a table.';
    } catch (error) {
      status.textContent = error.message; status.classList.add('ico-error'); $('copy-after').setAttribute('aria-invalid', 'true');
    }
    $('copy').disabled = count === 0;
    $('copy').title = `Copy for OneNote ${$('include-headers').checked ? 'with' : 'without'} headers · ${status.textContent}`;
    $('copy-after').title = `Copy incidents tracked after this ICM. Leave blank for all.\n${status.textContent}`;
  }
  function render() {
    if (!db) return;
    initialControls.forEach(control => { control.disabled = false; });
    const report = current();
    const related = M.relatedIndex(report);
    if (copyReportId !== report.id) { $('copy-after').value = ''; copyReportId = report.id; }
    $('reports').replaceChildren(...db.reports.map(item => { const option = UI.node('option', '', item.name); option.value = item.id; return option; }));
    $('reports').value = report.id;
    $('ignored').textContent = `Ignored (${M.ignoredEntries(db).length})`;
    $('reports').title = [report.name, [report.startDate, report.endDate].filter(Boolean).join(' → ')].filter(Boolean).join(' · ');
    const entries = M.trackedEntries(report).map(entry => ({ ...entry,
      ...Object.fromEntries(M.FIELDS.map(([key]) => [key, key === 'day' ? M.createdDay(entry.day) : M.knownText(entry[key])])),
    }));
    const incomplete = entries.filter(entry => !entry.rootCause || !entry.resolution).length;
    $('filter').querySelector('[value="all"]').textContent = `All tracked (${entries.length})`;
    $('filter').querySelector('[value="incomplete"]').textContent = `Needs summary (${incomplete})`;
    const query = $('search').value.toLowerCase().trim();
    const terms = [...new Set(query.split(/\s+/).filter(Boolean).map(term => M.incidentId(term.replace(/^#/, '')) || term))];
    const highlight = createHighlighter(terms);
    const visible = entries.filter(entry => {
      if ($('filter').value !== 'all' && entry.rootCause && entry.resolution) return false;
      const text = [`#${entry.id}`, ...M.FIELDS.map(([key]) => entry[key]), entry.severity && `Sev ${entry.severity}`, ...(related.get(entry.id) || []).flatMap(item => [`#${item.id}`, item.title])].join(' ').toLowerCase();
      return terms.every(term => text.includes(term));
    });
    if (sortKey) visible.sort(compareEntries);
    for (const button of sortButtons) {
      const active = button.dataset.sort === sortKey;
      button.closest('th').setAttribute('aria-sort', active ? sortDirection : 'none');
      button.querySelector('.sort-indicator').textContent = active ? sortDirection === 'ascending' ? '↑' : '↓' : '↕';
      button.setAttribute('aria-label', `Sort by ${button.querySelector('.sort-label').textContent}, ${active && sortDirection === 'ascending' ? 'descending' : 'ascending'}`);
    }
    $('clear-search').disabled = !$('search').value;
    $('reset-sort').disabled = !sortKey;
    const rows = visible.map(entry => {
      const row = UI.node('tr'); row.dataset.incidentId = entry.id;
      const dateCell = UI.node('td', 'incident-created');
      if (entry.day) { const time = highlight(UI.node('time'), entry.day); time.dateTime = entry.day; dateCell.append(time); }
      const severityCell = UI.node('td', 'incident-severity');
      if (entry.severity) severityCell.append(highlight(UI.node('span', 'severity'), `Sev ${entry.severity}`));
      const idCell = UI.node('td', 'incident-number');
      const id = highlight(UI.node('a', 'incident-id'), `#${entry.id}`); id.href = M.incidentUrl(entry.id); id.target = '_blank'; id.rel = 'noopener noreferrer'; idCell.append(id);
      const titleCell = UI.node('td', 'incident-title');
      titleCell.append(highlight(UI.node('div', entry.title ? '' : 'missing'), entry.title || 'Title not recorded'));
      const relatedIncidents = related.get(entry.id) || [];
      if (relatedIncidents.length) {
        const links = UI.node('div', 'related-incident-links'); links.append(UI.node('span', '', 'Related: '));
        const matchingRelated = relatedIncidents.filter(item => terms.some(term => `#${item.id} ${item.title}`.toLowerCase().includes(term)));
        const shownRelated = matchingRelated.length ? matchingRelated : relatedIncidents.slice(0, 5);
        for (const item of shownRelated) {
          const link = highlight(UI.node('a'), `#${item.id}`); link.href = M.incidentUrl(item.id); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = item.title || `Incident ${item.id}`; links.append(link, document.createTextNode(' '));
          if (terms.some(term => item.title?.toLowerCase().includes(term))) titleCell.append(highlight(UI.node('div', 'search-detail'), `Related #${item.id}: ${excerpt(item.title, terms)}`));
        }
        if (relatedIncidents.length > shownRelated.length) links.append(UI.node('span', '', `+${relatedIncidents.length - shownRelated.length}`));
        titleCell.append(links);
      }
      for (const [key, label] of detailFields) {
        if (terms.some(term => entry[key].toLowerCase().includes(term))) titleCell.append(highlight(UI.node('div', 'search-detail'), `${label}: ${excerpt(entry[key], terms)}`));
      }
      const state = highlight(UI.node('td', 'state-label'), entry.status);
      row.append(dateCell, severityCell, idCell, titleCell, state);
      for (const key of ['rootCause', 'resolution', 'notes', 'summaryGroup']) {
        const cell = highlight(UI.node('td', entry[key] ? 'summary-text' : 'missing'), entry[key] ? excerpt(entry[key], terms) : key === 'summaryGroup' ? '—' : 'Not recorded'); cell.title = entry[key]; row.append(cell);
      }
      const actions = UI.node('td', 'row-buttons'); const edit = UI.button('Edit notes'); edit.setAttribute('aria-label', `Edit notes for incident ${entry.id}`);
      edit.addEventListener('click', () => editEntry(report.entries[entry.id], edit));
      const relatedButton = UI.button(`Related ICMs (${relatedIncidents.length})`, 'ico-subtle'); relatedButton.setAttribute('aria-label', `Related ICMs for incident ${entry.id}`);
      relatedButton.addEventListener('click', () => {
        if (editor?.panel.isConnected) return;
        editor = UI.openRelatedIncidents({ db, reportId: report.id, incidentId: entry.id, returnFocus: relatedButton,
          onChange: payload => request('link-incidents', payload) });
      });
      const linkTo = UI.button('Link to…', 'ico-subtle'); linkTo.setAttribute('aria-label', `Link incident ${entry.id} to another tracked incident`);
      linkTo.addEventListener('click', () => {
        if (editor?.panel.isConnected) return;
        editor = UI.openLinkPicker({ db, reportId: report.id, incident: { id: entry.id }, returnFocus: linkTo,
          onChange: payload => request('link-incidents', payload) });
      });
      const untrack = UI.button('Untrack', 'ico-subtle'); untrack.setAttribute('aria-label', `Untrack incident ${entry.id}`);
      untrack.addEventListener('click', async () => {
        untrack.disabled = true;
        try { await request('save', { reportId: report.id, incidentId: entry.id, patch: { tracked: false } }); UI.toast('Removed from this report. Your notes are kept.'); }
        catch (error) { failure(error); untrack.disabled = false; }
      });
      const ignore = UI.button('Ignore', 'ico-subtle'); ignore.setAttribute('aria-label', `Ignore incident ${entry.id}`);
      ignore.addEventListener('click', async () => {
        ignore.disabled = true;
        try { await request('ignore', { reportId: report.id, incidentId: entry.id, ignored: true, title: entry.title }); UI.toast('Ignored across reports. Your notes are kept.'); }
        catch (error) { failure(error); ignore.disabled = false; }
      });
      actions.append(edit, relatedButton, linkTo, untrack, ignore); row.append(actions); return row;
    });
    $('incidents').replaceChildren(...rows); $('empty').hidden = entries.length !== 0;
    $('no-results').hidden = !entries.length || visible.length !== 0;
    $('status').classList.remove('ico-error');
    const order = sortKey ? `Sorted by ${sortButtons.find(button => button.dataset.sort === sortKey).querySelector('.sort-label').textContent} ${sortDirection === 'ascending' ? '↑' : '↓'}` : 'Newest tracked first';
    $('status').textContent = entries.length ? `${visible.length} of ${entries.length} incidents · ${order}` : '';
    for (const id of ['html', 'csv']) $(id).disabled = entries.length === 0;
    renderCopyRange();
    renderBackup(bridgeStatus);
  }
  $('reports').addEventListener('change', () => request('select-report', { reportId: $('reports').value }).catch(failure));
  $('ignored').addEventListener('click', () => request('open-ignored').catch(failure));
  async function checkAgent() {
    if (checkingAgent) return;
    checkingAgent = true;
    try {
      const result = await request('bridge-status');
      bridgeStatus = result;
      renderBackup(result);
    } catch { bridgeStatus = { state: 'disconnected' }; renderBackup(bridgeStatus); }
    finally { checkingAgent = false; }
  }
  function renderBackup(result) {
    const backup = result.backup || { state: result.state === 'not-installed' ? 'not-installed' : 'offline' };
    const labels = { saved: 'Backup saved', saving: 'Backing up…', pending: 'Backup pending', ready: 'Backup pending',
      offline: 'Backup offline', error: 'Backup needs attention', conflict: 'Backup recovery available' };
    const lastSaved = backup.lastSavedAt ? `Last saved: ${new Date(backup.lastSavedAt).toLocaleString()}` : '';
    $('auto-backup-info').hidden = backup.state === 'not-installed';
    $('auto-backup-status').textContent = labels[backup.state] || labels.offline;
    $('auto-backup-status').dataset.state = backup.state;
    $('auto-backup-detail').textContent = [backup.error, lastSaved].filter(Boolean).join('\n');
    $('auto-backup-detail').hidden = !$('auto-backup-detail').textContent;
    const attention = ['offline', 'error', 'conflict'].includes(backup.state);
    $('more').dataset.attention = String(attention);
    $('more').title = attention ? $('auto-backup-status').textContent : 'More actions';
    if (backup.path) backupPath = backup.path;
    $('copy-backup-path').title = backupPath;
    $('copy-backup-path').hidden = $('copy-backup-path').disabled = !backupPath;
    $('backup-now').hidden = $('backup-now').disabled = result.state !== 'connected' || ['not-installed', 'conflict', 'saving'].includes(backup.state);
    $('restore-backup').hidden = $('restore-backup').disabled = backup.state !== 'conflict' || result.state !== 'connected';
  }
  $('more').addEventListener('click', checkAgent);
  $('dashboard-menu').addEventListener('click', event => {
    if (['settings', 'new-report', 'html', 'csv', 'backup', 'import'].includes(event.target.closest('button')?.id)) $('dashboard-menu').hidePopover?.();
  }, true);
  $('copy-backup-path').addEventListener('click', async () => {
    if (!backupPath) return;
    try { await navigator.clipboard.writeText(backupPath); UI.toast('Backup file path copied.'); }
    catch { failure(new Error(`Could not copy the backup path: ${backupPath}`)); }
  });
  $('backup-now').addEventListener('click', async () => {
    try { bridgeStatus = await request('backup-now'); renderBackup(bridgeStatus); } catch (error) { failure(error); }
  });
  $('restore-backup').addEventListener('click', async () => {
    $('restore-backup').disabled = true;
    try { await request('restore-backup'); UI.toast('Backup restored as separate reports. Your current notes are kept.'); }
    catch (error) { failure(error); }
    finally { checkAgent(); }
  });
  checkAgent();
  setInterval(checkAgent, 3000);
  $('new-report').addEventListener('click', () => UI.editReport(null, fields => request('create-report', { fields }), $('more')));
  $('settings').addEventListener('click', () => { const report = current(); UI.editReport(report, fields => request('edit-report', { reportId: report.id, fields }), $('more')); });
  $('search').addEventListener('input', render); $('filter').addEventListener('change', render);
  $('clear-search').addEventListener('click', () => { $('search').value = ''; render(); $('search').focus(); });
  $('search').addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('search').value) { event.preventDefault(); $('clear-search').click(); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.defaultPrevented
      && !editor?.panel.isConnected && !event.target.closest('input, textarea, select, [contenteditable], [role="dialog"]')) {
      event.preventDefault(); $('search').focus(); $('search').select();
    }
  });
  for (const button of sortButtons) button.addEventListener('click', () => {
    sortDirection = sortKey === button.dataset.sort && sortDirection === 'ascending' ? 'descending' : 'ascending';
    sortKey = button.dataset.sort; render();
  });
  $('reset-sort').addEventListener('click', () => { sortKey = ''; sortDirection = 'ascending'; render(); });
  $('add-form').addEventListener('submit', async event => {
    event.preventDefault(); const id = M.incidentId($('add-id').value);
    if (!id) { failure(new Error('Enter a numeric incident ID or a portal.microsofticm.com incident URL.')); return; }
    const ignored = M.isIgnored(db, id);
    const patch = { tracked: true };
    if (ignored && !M.currentReport(db).entries[id]?.title && db.ignoredIncidents[id].title) patch.title = db.ignoredIncidents[id].title;
    try { await request('save', { reportId: current().id, incidentId: id, patch, restoreIgnored: ignored, baseIgnored: ignored }); $('add-id').value = ''; } catch (error) { failure(error); }
  });
  $('copy-after').addEventListener('input', renderCopyRange);
  $('include-headers').addEventListener('change', renderCopyRange);
  $('copy').addEventListener('click', async () => {
    const includeHeaders = $('include-headers').checked;
    try {
      const output = await UI.copyReport(current(), { includeHeaders, afterIncident: $('copy-after').value });
      $('copy-range-status').classList.remove('ico-error');
      $('copy-range-status').textContent = `Copied ${output.count} row${output.count === 1 ? '' : 's'}${includeHeaders ? '' : ' without headers'}. Next: #${output.newestIncidentId}.`;
      UI.toast(includeHeaders ? 'Table copied. Paste it into OneNote.' : 'Data rows copied. Paste them into your existing table.');
    } catch (error) { $('copy-range-status').textContent = error.message; $('copy-range-status').classList.add('ico-error'); UI.toast(error.message, true); }
  });
  $('html').addEventListener('click', () => UI.download(filename('html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>${M.escapeHtml(current().name)}</title><body>${M.exportReport(current()).html}</body></html>`, 'text/html;charset=utf-8'));
  $('csv').addEventListener('click', () => UI.download(filename('csv'), M.exportReport(current()).csv, 'text/csv;charset=utf-8'));
  $('backup').addEventListener('click', () => UI.download('oncall-workspace-backup.json', JSON.stringify(db, null, 2), 'application/json'));
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0]; if (!file) return;
    try {
      if (file.size > M.MAX_BACKUP_BYTES) throw new Error('Choose a backup smaller than 32 MB.');
      await request('import', { data: JSON.parse(await file.text()) }); UI.toast('Backup imported as separate reports. Existing reports are unchanged.');
    } catch (error) { failure(error); }
    $('import-file').value = '';
  });
  // Storage events render both local and cross-tab saves exactly once. Request
  // responses still return the saved report to editors without rendering it again.
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[M.STORAGE_KEY]?.newValue) { db = changes[M.STORAGE_KEY].newValue; render(); } });
  request('get').then(value => { if (!db) { db = value; render(); } }).catch(failure);
})();
