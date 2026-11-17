(() => {
  const M = IcmOncall; const UI = IcmOncallUI; const request = IcmOncallClient.request;
  const $ = id => document.getElementById(id);
  let db, editor, copyReportId, backupPath = '';
  const initialControls = [...document.querySelectorAll('button, input, select')];
  initialControls.forEach(control => { control.disabled = true; });
  const current = () => M.reportForDisplay(db);
  const failure = error => { $('status').textContent = error.message; $('status').classList.add('ico-error'); };
  const filename = ext => `${current().name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'oncall-report'}.${ext}`;
  const excerpt = value => value.length > 220 ? value.slice(0, 217) + '…' : value;
  async function change(type, args = {}) { db = await request(type, args); render(); return db; }
  function editEntry(entry, anchor) {
    if (editor?.panel.isConnected) return;
    const report = current();
    editor = UI.openEditor({ report, entry, returnFocus: anchor, onSave: (patch, base) => change('save', { reportId: report.id, incidentId: entry.id, patch, base }) });
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
      status.textContent = count ? `${count} incident${count === 1 ? '' : 's'} · ${rows} row${rows === 1 ? '' : 's'} to copy · Newest included: #${entries[0].id}`
        : $('copy-after').value.trim() ? 'No newly tracked incidents after this ICM.' : 'Track an incident to copy a table.';
    } catch (error) {
      status.textContent = error.message; status.classList.add('ico-error'); $('copy-after').setAttribute('aria-invalid', 'true');
    }
    for (const id of ['copy', 'copy-without-headers']) $(id).disabled = count === 0;
  }
  function render() {
    if (!db) return;
    initialControls.forEach(control => { control.disabled = false; });
    const report = current();
    if (copyReportId !== report.id) { $('copy-after').value = ''; copyReportId = report.id; }
    $('reports').replaceChildren(...db.reports.map(item => { const option = UI.node('option', '', item.name); option.value = item.id; return option; }));
    $('reports').value = report.id;
    $('ignored').textContent = `Ignored (${M.ignoredEntries(db).length})`;
    $('period').textContent = [report.startDate, report.endDate].filter(Boolean).join(' → ') || 'Set your on-call period';
    const entries = M.trackedEntries(report).map(entry => ({ ...entry,
      ...Object.fromEntries(M.FIELDS.map(([key]) => [key, M.knownText(entry[key])])),
    }));
    $('tracked-count').textContent = entries.length; $('group-count').textContent = M.groups(report).length;
    $('root-count').textContent = entries.filter(entry => !entry.rootCause).length;
    $('resolution-count').textContent = entries.filter(entry => !entry.resolution).length;
    const query = $('search').value.toLowerCase().trim();
    const visible = entries.filter(entry => ($('filter').value === 'all' || !entry.rootCause || !entry.resolution)
      && (!query || [entry.id, ...M.FIELDS.map(([key]) => entry[key]), ...M.relatedEntries(report, entry.id).flatMap(item => [item.id, item.title])].join(' ').toLowerCase().includes(query)));
    const rows = visible.map(entry => {
      const row = UI.node('tr'); const titleCell = UI.node('td', 'incident-title');
      const id = UI.node('a', 'incident-id', `#${entry.id} ↗`); id.href = M.incidentUrl(entry.id); id.target = '_blank'; id.rel = 'noopener noreferrer';
      titleCell.append(id, UI.node('div', '', entry.title || 'Title not recorded'));
      const related = M.relatedEntries(report, entry.id);
      if (related.length) {
        const links = UI.node('div', 'related-incident-links'); links.append(UI.node('span', '', 'Related: '));
        for (const item of related.slice(0, 5)) {
          const link = UI.node('a', '', `#${item.id}`); link.href = M.incidentUrl(item.id); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = item.title || `Incident ${item.id}`; links.append(link, document.createTextNode(' '));
        }
        if (related.length > 5) links.append(UI.node('span', '', `+${related.length - 5}`));
        titleCell.append(links);
      }
      const state = UI.node('td'); state.append(UI.node('span', 'severity', entry.severity ? `Sev ${entry.severity}` : 'Severity —'), UI.node('div', 'state-label', entry.status || 'Status not recorded'));
      row.append(titleCell, state);
      for (const key of ['rootCause', 'resolution', 'notes', 'summaryGroup']) {
        const cell = UI.node('td', entry[key] ? 'summary-text' : 'missing', entry[key] ? excerpt(entry[key]) : key === 'summaryGroup' ? '—' : 'Not recorded'); cell.title = entry[key]; row.append(cell);
      }
      const actions = UI.node('td', 'row-buttons'); const edit = UI.button('Edit notes'); edit.setAttribute('aria-label', `Edit notes for incident ${entry.id}`);
      edit.addEventListener('click', () => editEntry(report.entries[entry.id], edit));
      const relatedButton = UI.button(`Related ICMs (${related.length})`, 'ico-subtle'); relatedButton.setAttribute('aria-label', `Related ICMs for incident ${entry.id}`);
      relatedButton.addEventListener('click', () => {
        if (editor?.panel.isConnected) return;
        editor = UI.openRelatedIncidents({ db, reportId: report.id, incidentId: entry.id, returnFocus: relatedButton,
          onChange: payload => change('link-incidents', payload) });
      });
      const untrack = UI.button('Untrack', 'ico-subtle'); untrack.setAttribute('aria-label', `Untrack incident ${entry.id}`);
      untrack.addEventListener('click', async () => {
        untrack.disabled = true;
        try { await change('save', { reportId: report.id, incidentId: entry.id, patch: { tracked: false } }); UI.toast('Removed from this report. Your notes are kept.'); }
        catch (error) { failure(error); untrack.disabled = false; }
      });
      const ignore = UI.button('Ignore', 'ico-subtle'); ignore.setAttribute('aria-label', `Ignore incident ${entry.id}`);
      ignore.addEventListener('click', async () => {
        ignore.disabled = true;
        try { await change('ignore', { reportId: report.id, incidentId: entry.id, ignored: true, title: entry.title }); UI.toast('Ignored across reports. Your notes are kept.'); }
        catch (error) { failure(error); ignore.disabled = false; }
      });
      actions.append(edit, relatedButton, untrack, ignore); row.append(actions); return row;
    });
    $('incidents').replaceChildren(...rows); $('empty').hidden = entries.length !== 0;
    $('status').classList.remove('ico-error');
    $('status').textContent = entries.length ? `${visible.length} of ${entries.length} tracked incidents · ${M.groups(report).length} rows in the exported summary` : '';
    for (const id of ['html', 'csv']) $(id).disabled = entries.length === 0;
    renderCopyRange();
    checkAgent();
  }
  $('reports').addEventListener('change', () => change('select-report', { reportId: $('reports').value }).catch(failure));
  $('ignored').addEventListener('click', () => request('open-ignored').catch(failure));
  async function checkAgent() {
    try {
      const result = await request('bridge-status');
      const labels = { connected: 'Agent: connected', connecting: 'Agent: connecting…', disconnected: 'Agent: offline', 'not-installed': 'Agent: not installed' };
      $('agent-status').textContent = labels[result.state] || 'Agent: offline';
      renderBackup(result);
    } catch { $('agent-status').textContent = 'Agent: unavailable'; renderBackup({ state: 'disconnected' }); }
  }
  function renderBackup(result) {
    const backup = result.backup || { state: result.state === 'not-installed' ? 'not-installed' : 'offline' };
    const labels = { saved: 'Automatic backup: up to date', saving: 'Automatic backup: saving…', pending: 'Automatic backup: pending…', ready: 'Automatic backup: pending…',
      offline: 'Automatic backup: service offline', error: 'Automatic backup: needs attention', conflict: 'Automatic backup: recovery available', 'not-installed': 'Automatic backup: not installed' };
    const lastSaved = backup.lastSavedAt ? `Last successful backup: ${new Date(backup.lastSavedAt).toLocaleString()}. ` : '';
    const details = {
      saved: 'One latest copy outside Edge. All reports, notes and Ignore decisions are included.',
      saving: 'Writing the latest saved workspace to disk.', pending: 'Your saved changes are waiting to be backed up.', ready: 'Your saved changes are waiting to be backed up.',
      offline: 'Recent changes may only be in Edge. Backup resumes when the local service reconnects.',
      error: backup.error || 'Could not update the backup file. The service will retry automatically.',
      conflict: 'An existing backup was protected from being overwritten. Restore saved backup adds its reports and keeps your current notes.',
      'not-installed': backup.error || 'Run node bridge/install.cjs and node bridge/cli.cjs status from the extension folder, then reload the extension.',
    };
    $('auto-backup-status').textContent = labels[backup.state] || labels.offline;
    $('auto-backup-status').closest('.backup-panel').dataset.state = backup.state;
    $('auto-backup-detail').textContent = lastSaved + (details[backup.state] || details.offline);
    if (backup.path) backupPath = backup.path;
    $('auto-backup-path').textContent = backupPath || 'Waiting for the backup service…';
    $('copy-backup-path').disabled = !backupPath;
    $('backup-now').disabled = result.state !== 'connected' || ['not-installed', 'conflict', 'saving'].includes(backup.state);
    $('restore-backup').hidden = backup.state !== 'conflict';
    $('restore-backup').disabled = result.state !== 'connected';
  }
  $('agent-status').addEventListener('click', checkAgent);
  $('copy-backup-path').addEventListener('click', async () => {
    if (!backupPath) return;
    try { await navigator.clipboard.writeText(backupPath); UI.toast('Backup file path copied.'); }
    catch { failure(new Error('Could not copy the path. Select the Backup file path and copy it manually.')); }
  });
  $('backup-now').addEventListener('click', async () => {
    try { renderBackup(await request('backup-now')); } catch (error) { failure(error); }
  });
  $('restore-backup').addEventListener('click', async () => {
    $('restore-backup').disabled = true;
    try { await change('restore-backup'); UI.toast('Backup restored as separate reports. Your current notes are kept.'); }
    catch (error) { failure(error); checkAgent(); }
  });
  checkAgent();
  setInterval(checkAgent, 3000);
  $('new-report').addEventListener('click', () => UI.editReport(null, fields => change('create-report', { fields }), $('new-report')));
  $('settings').addEventListener('click', () => { const report = current(); UI.editReport(report, fields => change('edit-report', { reportId: report.id, fields }), $('settings')); });
  $('search').addEventListener('input', render); $('filter').addEventListener('change', render);
  $('add-form').addEventListener('submit', async event => {
    event.preventDefault(); const id = M.incidentId($('add-id').value);
    if (!id) { failure(new Error('Enter a numeric incident ID or a portal.microsofticm.com incident URL.')); return; }
    const ignored = M.isIgnored(db, id);
    const patch = { tracked: true };
    if (ignored && !M.currentReport(db).entries[id]?.title && db.ignoredIncidents[id].title) patch.title = db.ignoredIncidents[id].title;
    try { await change('save', { reportId: current().id, incidentId: id, patch, restoreIgnored: ignored, baseIgnored: ignored }); $('add-id').value = ''; } catch (error) { failure(error); }
  });
  $('copy-after').addEventListener('input', renderCopyRange);
  for (const [id, includeHeaders] of [['copy', true], ['copy-without-headers', false]]) $(id).addEventListener('click', async () => {
    try {
      const output = await UI.copyReport(current(), { includeHeaders, afterIncident: $('copy-after').value });
      $('copy-range-status').classList.remove('ico-error');
      $('copy-range-status').textContent = `Copied ${output.count} row${output.count === 1 ? '' : 's'}${includeHeaders ? '' : ' without headers'}. For the next batch, copy after #${output.newestIncidentId}.`;
      UI.toast(includeHeaders ? 'Table copied. Paste it into OneNote.' : 'Data rows copied. Paste them into your existing table.');
    } catch (error) { $('copy-range-status').textContent = error.message; $('copy-range-status').classList.add('ico-error'); }
  });
  $('html').addEventListener('click', () => UI.download(filename('html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>${M.escapeHtml(current().name)}</title><body>${M.exportReport(current()).html}</body></html>`, 'text/html;charset=utf-8'));
  $('csv').addEventListener('click', () => UI.download(filename('csv'), M.exportReport(current()).csv, 'text/csv;charset=utf-8'));
  $('backup').addEventListener('click', () => UI.download('oncall-workspace-backup.json', JSON.stringify(db, null, 2), 'application/json'));
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0]; if (!file) return;
    try {
      if (file.size > M.MAX_BACKUP_BYTES) throw new Error('Choose a backup smaller than 32 MB.');
      await change('import', { data: JSON.parse(await file.text()) }); UI.toast('Backup imported as separate reports. Existing reports are unchanged.');
    } catch (error) { failure(error); }
    $('import-file').value = '';
  });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[M.STORAGE_KEY]?.newValue) { db = changes[M.STORAGE_KEY].newValue; render(); } });
  request('get').then(value => { db = value; render(); }).catch(failure);
})();
