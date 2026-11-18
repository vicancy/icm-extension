const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('./model');
const { createRuntime, loadPage, waitFor } = require('./test/runtime');

const click = element => element.dispatchEvent(new element.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
const set = (doc, name, value) => { const input = doc.querySelector(`[name="${name}"]`); input.value = value; input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); };
const submit = doc => doc.querySelector('.ico-editor-form').dispatchEvent(new doc.defaultView.Event('submit', { bubbles: true, cancelable: true }));

test('list controls track an incident and save its private notes without modifying native headers', async t => {
  const runtime = createRuntime(); const page = loadPage(runtime); t.after(page.close);
  const d = page.document;
  await waitFor(() => d.querySelector('.ico-row-actions'));
  assert.equal(d.querySelector('[role="columnheader"]').textContent, 'Title');
  assert.equal(d.querySelectorAll('.ico-row-actions').length, 1);
  click(d.querySelector('[data-action="track"]'));
  await waitFor(() => d.querySelector('[data-action="track"]').textContent === 'Tracked');
  click(d.querySelector('[data-action="notes"]'));
  set(d, 'rootCause', 'Regional capacity exhausted'); set(d, 'resolution', 'Requested more capacity'); set(d, 'notes', 'Waiting for the owning team');
  submit(d);
  await waitFor(() => !d.querySelector('.ico-editor'));
  const entry = M.currentReport(await runtime.request('get')).entries['123'];
  assert.equal(entry.title, 'A sample incident'); assert.equal(entry.severity, '3'); assert.equal(entry.status, 'Active');
  assert.equal(entry.rootCause, 'Regional capacity exhausted'); assert.equal(entry.notes, 'Waiting for the owning team');
  assert.ok(d.querySelector('.ico-has-notes'));
  assert.ok(runtime.messages.every(message => message.type.startsWith('oncall:')));
});

test('recycled rows and removed controls bind to the current incident ID', async t => {
  const runtime = createRuntime(); const page = loadPage(runtime); t.after(page.close); const d = page.document;
  await waitFor(() => d.querySelector('.ico-row-actions'));
  const link = d.querySelector('[data-automation-key="Title"] a');
  link.href = 'https://portal.microsofticm.com/imp/v5/incidents/details/456'; link.textContent = 'The next incident';
  await waitFor(() => d.querySelector('[data-action="track"]').getAttribute('aria-label') === 'Track incident 456');
  click(d.querySelector('[data-action="track"]'));
  await waitFor(() => d.querySelector('[data-action="track"]').textContent === 'Tracked');
  const report = M.currentReport(await runtime.request('get'));
  assert.equal(report.entries['123'], undefined); assert.equal(report.entries['456'].title, 'The next incident');
  d.querySelector('.ico-row-actions').remove();
  await waitFor(() => d.querySelector('.ico-row-actions'));
  assert.equal(d.querySelectorAll('.ico-row-actions').length, 1);
  assert.equal(d.querySelector('[data-action="track"]').textContent, 'Tracked');
});

test('the toolbar stays inline through query/detail navigation and native control remounts', async t => {
  const page = loadPage(createRuntime()); t.after(page.close); const d = page.document;
  const style = d.createElement('style'); style.textContent = fs.readFileSync(path.join(__dirname, 'content.css'), 'utf8'); d.head.append(style);
  await waitFor(() => d.querySelector('.ico-toolbar'));
  const toolbar = d.querySelector('.ico-toolbar');
  assert.equal(toolbar.hidden, true);
  assert.equal(page.window.getComputedStyle(toolbar).display, 'none');
  assert.equal(page.window.getComputedStyle(toolbar).position, 'static');
  const nativeControls = d.createElement('section');
  const markup = '<div class="ms-Stack"><div role="menubar" aria-label="Bulk actions"></div></div>';
  nativeControls.innerHTML = markup; d.body.prepend(nativeControls);
  await waitFor(() => nativeControls.querySelector('.ico-toolbar-inline'));
  assert.equal(toolbar.hidden, false);
  assert.equal(page.window.getComputedStyle(toolbar).position, 'static');
  assert.equal(nativeControls.firstElementChild.nextElementSibling, nativeControls.querySelector('.ms-Stack'));
  nativeControls.replaceChildren();
  await waitFor(() => toolbar.hidden);
  assert.equal(page.window.getComputedStyle(toolbar).display, 'none');
  nativeControls.innerHTML = markup;
  await waitFor(() => nativeControls.querySelector('.ico-toolbar-inline'));
  assert.equal(nativeControls.querySelector('.ico-toolbar'), toolbar);
  assert.equal(toolbar.hidden, false);
  assert.equal(d.querySelectorAll('.ico-toolbar').length, 1);
  page.dom.reconfigure({ url: M.incidentUrl('123') });
  await waitFor(() => d.querySelector('.ico-detail-actions'));
  const detailActions = d.querySelector('.ico-detail-actions');
  assert.equal(toolbar.parentElement, detailActions);
  assert.equal(d.querySelector('.ico-toolbar-inline'), null);
  assert.equal(toolbar.hidden, true);
  assert.equal(page.window.getComputedStyle(toolbar).position, 'static');
  const incident = d.createElement('main'); incident.id = 'incident-details-container';
  const actionsMarkup = '<section><div aria-label="action-bar"></div></section>';
  incident.innerHTML = actionsMarkup; d.body.append(incident);
  await waitFor(() => !toolbar.hidden);
  assert.equal(detailActions.nextElementSibling, incident.querySelector('[aria-label="action-bar"]'));
  assert.equal(toolbar.parentElement, detailActions);
  assert.equal(toolbar.querySelector('.ico-list-filters').hidden, true);
  assert.equal(toolbar.querySelector('.ico-bulk-actions').hidden, true);
  incident.replaceChildren();
  await waitFor(() => toolbar.hidden);
  incident.innerHTML = actionsMarkup;
  await waitFor(() => !toolbar.hidden && incident.contains(toolbar));
  assert.equal(d.querySelectorAll('.ico-toolbar').length, 1);
  assert.equal(d.querySelectorAll('.ico-detail-actions').length, 1);
  nativeControls.remove();
  page.dom.reconfigure({ url: 'https://portal.microsofticm.com/imp/v5/incidents/queries/my-teams' });
  d.body.append(d.createElement('section'));
  await waitFor(() => toolbar.hidden && toolbar.classList.contains('ico-toolbar-inline'));
  assert.equal(page.window.getComputedStyle(toolbar).display, 'none');
  d.body.prepend(nativeControls);
  await waitFor(() => !toolbar.hidden && nativeControls.querySelector('.ico-toolbar') && !d.querySelector('.ico-detail-actions'));
  assert.equal(nativeControls.querySelector('.ico-toolbar'), toolbar);
  assert.equal(d.querySelector('.ico-toolbar-detail'), null);
  assert.equal(d.querySelector('.ico-detail-actions'), null);
});

test('a failed save leaves the draft visible and retry succeeds', async t => {
  const runtime = createRuntime(); const page = loadPage(runtime); t.after(page.close); const d = page.document;
  await waitFor(() => d.querySelector('.ico-row-actions'));
  click(d.querySelector('[data-action="notes"]')); set(d, 'notes', 'Do not lose this draft');
  runtime.failWrites(); submit(d);
  assert.equal(d.querySelector('[name="notes"]').disabled, true);
  await waitFor(() => d.querySelector('.ico-form-status')?.textContent.includes('quota'));
  assert.equal(d.querySelector('[name="notes"]').disabled, false);
  assert.equal(d.querySelector('[name="notes"]').value, 'Do not lose this draft');
  runtime.failWrites(false); submit(d); await waitFor(() => !d.querySelector('.ico-editor'));
  const entry = M.currentReport(await runtime.request('get')).entries['123'];
  assert.equal(entry.notes, 'Do not lose this draft'); assert.equal(entry.tracked, false);
});

test('concurrent notes edits report a conflict without replacing the unsaved draft', async t => {
  const runtime = createRuntime(); const page = loadPage(runtime); t.after(page.close); const d = page.document;
  await waitFor(() => d.querySelector('.ico-row-actions'));
  click(d.querySelector('[data-action="notes"]')); set(d, 'notes', 'My unsaved draft');
  const db = await runtime.request('get');
  await runtime.request('save', { reportId: db.activeReportId, incidentId: '123', patch: { notes: 'Saved in another tab' } });
  assert.equal(d.querySelector('[name="notes"]').value, 'My unsaved draft'); submit(d);
  await waitFor(() => d.querySelector('.ico-form-status')?.textContent.includes('another window'));
  assert.equal(M.currentReport(await runtime.request('get')).entries['123'].notes, 'Saved in another tab');
});

test('switching reports while an editor is open does not move its notes into the new report', async t => {
  const runtime = createRuntime(); const page = loadPage(runtime); t.after(page.close); const d = page.document;
  await waitFor(() => d.querySelector('.ico-row-actions'));
  const first = await runtime.request('get');
  click(d.querySelector('[data-action="notes"]')); set(d, 'notes', 'For the first report');
  await runtime.request('create-report', { fields: { name: 'Next report' } }); submit(d);
  await waitFor(() => !d.querySelector('.ico-editor'));
  const db = await runtime.request('get');
  assert.equal(M.currentReport(db, first.activeReportId).entries['123'].notes, 'For the first report');
  assert.equal(M.currentReport(db).entries['123'], undefined);
});

test('embedded incident pages share notes with the list and follow detail route changes', async t => {
  const runtime = createRuntime(); const parent = loadPage(runtime); const frame = loadPage(runtime, { embedded: true, url: 'https://portal.microsofticm.com/imp/v5/incidents/details/123/summary', html: '<title>Incident 123 : A sample incident - IcM</title><h1>A sample incident</h1>' });
  t.after(parent.close); t.after(frame.close);
  await waitFor(() => frame.document.querySelector('.ico-detail-actions'));
  assert.equal(frame.document.querySelector('.ico-toolbar'), null);
  click(frame.document.querySelector('[data-action="track"]'));
  await waitFor(() => parent.document.querySelector('[data-action="track"]')?.textContent === 'Tracked');
  click(frame.document.querySelector('[data-action="notes"]')); set(frame.document, 'rootCause', 'Dependency timeout'); submit(frame.document);
  await waitFor(() => !frame.document.querySelector('.ico-editor'));
  assert.ok(parent.document.querySelector('.ico-has-notes'));
  frame.window.history.pushState({}, '', '/imp/v5/incidents/details/456/summary');
  await waitFor(() => frame.document.querySelector('[data-action="track"]').getAttribute('aria-label') === 'Track incident 456');
  click(frame.document.querySelector('[data-action="track"]'));
  await waitFor(() => frame.document.querySelector('[data-action="track"]').textContent === 'Tracked');
  const report = M.currentReport(await runtime.request('get'));
  assert.equal(report.entries['123'].rootCause, 'Dependency timeout'); assert.equal(report.entries['456'].rootCause, '');
  assert.equal(report.entries['456'].title, '');
});

test('native status changes update the snapshot without overwriting annotations', async t => {
  const runtime = createRuntime(); const page = loadPage(runtime); t.after(page.close); const d = page.document;
  await waitFor(() => d.querySelector('.ico-row-actions'));
  click(d.querySelector('[data-action="track"]')); await waitFor(() => d.querySelector('[data-action="track"]').textContent === 'Tracked');
  const reportId = (await runtime.request('get')).activeReportId;
  await runtime.request('save', { reportId, incidentId: '123', patch: { resolution: 'Restarted worker' } });
  d.querySelector('[data-automation-key="State"]').textContent = 'Mitigated';
  await waitFor(() => runtime.data[M.STORAGE_KEY].reports[0].entries['123'].status === 'Mitigated');
  assert.equal(runtime.data[M.STORAGE_KEY].reports[0].entries['123'].resolution, 'Restarted worker');
});

test('Created Time backfills legacy records and follows recycled rows without converting timezones', async t => {
  const runtime = createRuntime(); const reportId = (await runtime.request('get')).activeReportId;
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true, notes: 'Keep my analysis' } });
  delete runtime.data[M.STORAGE_KEY].reports[0].entries['123'].day;
  const page = loadPage(runtime, { html: `<title>Incident Queries - IcM</title>
    <div class="ms-DetailsRow" role="row">
      <div data-automation-key="ModifiedDate">2026-11-20 12:00 GMT+8</div>
      <div data-automation-key="CreatedDate"><time datetime="2026-11-15T16:30:00Z">2026-11-16 00:30 GMT+8</time></div>
      <div data-automation-key="Title"><a href="/imp/v5/incidents/details/123">A sample incident</a></div>
    </div>` });
  t.after(page.close); const d = page.document;
  await waitFor(() => runtime.data[M.STORAGE_KEY].reports[0].entries['123'].day === '2026-11-16');
  assert.equal(runtime.data[M.STORAGE_KEY].reports[0].entries['123'].notes, 'Keep my analysis');
  click(d.querySelector('[data-action="notes"]'));
  assert.equal(d.querySelector('[name="day"]').readOnly, true);
  assert.equal(d.querySelector('[name="day"]').value, '2026-11-16');
  submit(d); await waitFor(() => !d.querySelector('.ico-editor'));
  const link = d.querySelector('[data-automation-key="Title"] a');
  link.href = '/imp/v5/incidents/details/456'; link.textContent = 'Next incident';
  d.querySelector('[data-automation-key="CreatedDate"] time').textContent = '2026-11-17 01:00 GMT+8';
  await waitFor(() => d.querySelector('[data-action="track"]').getAttribute('aria-label') === 'Track incident 456');
  click(d.querySelector('[data-action="track"]'));
  await waitFor(() => runtime.data[M.STORAGE_KEY].reports[0].entries['456']?.day === '2026-11-17');
  assert.equal(runtime.data[M.STORAGE_KEY].reports[0].entries['123'].day, '2026-11-16');
});

test('detail Day uses Incident created, never source, impact, comments or stale route metadata', async t => {
  const runtime = createRuntime();
  const page = loadPage(runtime, { url: 'https://portal.microsofticm.com/imp/v5/incidents/details/123/summary', html: `
    <title>Incident 123 : A sample incident - IcM</title>
    <div><h3>Impact start</h3><h3><time>2026-11-13 22:00 GMT+8</time></h3></div>
    <div><h3>Source created</h3><h3><time>2026-11-15 23:59 GMT+8</time></h3></div>
    <p>Created at 2026-11-14 08:00 GMT+8</p>` });
  t.after(page.close); const d = page.document;
  await waitFor(() => d.querySelector('.ico-detail-actions'));
  click(d.querySelector('[data-action="track"]'));
  await waitFor(() => d.querySelector('[data-action="track"]').textContent === 'Tracked');
  assert.equal(runtime.data[M.STORAGE_KEY].reports[0].entries['123'].day, '');
  const dateCard = d.createElement('div');
  dateCard.innerHTML = '<h3>Incident created</h3><h3><time datetime="2026-11-15T16:01:00Z">2026-11-16 00:01 GMT+8</time></h3>';
  d.body.append(dateCard);
  await waitFor(() => runtime.data[M.STORAGE_KEY].reports[0].entries['123'].day === '2026-11-16');
  page.window.history.pushState({}, '', '/imp/v5/incidents/details/456/summary');
  await waitFor(() => d.querySelector('[data-action="track"]').getAttribute('aria-label') === 'Track incident 456');
  click(d.querySelector('[data-action="track"]'));
  await waitFor(() => runtime.data[M.STORAGE_KEY].reports[0].entries['456']);
  assert.equal(runtime.data[M.STORAGE_KEY].reports[0].entries['456'].day, '');
});

test('a date already visible in the list is captured when an incident is tracked from elsewhere', async t => {
  const runtime = createRuntime(); const reportId = (await runtime.request('get')).activeReportId;
  const page = loadPage(runtime, { html: `<title>Incident Queries - IcM</title>
    <div class="ms-DetailsRow" role="row">
      <div data-automation-key="CreatedDate">2026-11-16 00:30 GMT+8</div>
      <div data-automation-key="State">Active</div>
      <div data-automation-key="Title"><a href="/imp/v5/incidents/details/123">A sample incident</a></div>
    </div>` });
  t.after(page.close);
  await waitFor(() => page.document.querySelector('.ico-row-actions'));
  await runtime.agentRequest({ method: 'save_incident', params: { reportId, incidentId: '123',
    fields: { title: 'Updated title', status: 'Mitigated', notes: 'Keep my analysis' } } });
  await waitFor(() => runtime.data[M.STORAGE_KEY].reports[0].entries['123'].day === '2026-11-16');
  const entry = M.currentReport(await runtime.request('get')).entries['123'];
  assert.equal(entry.title, 'Updated title'); assert.equal(entry.status, 'Mitigated');
  assert.equal(entry.notes, 'Keep my analysis');
  assert.equal(runtime.messages.filter(message => message.type === 'oncall:observe').length, 1);
  assert.deepEqual(runtime.messages.find(message => message.type === 'oncall:observe').snapshots, [{ id: '123', day: '2026-11-16' }]);
});

test('a stale tab cannot repeatedly overwrite metadata observed in another tab', async t => {
  const runtime = createRuntime(); const older = loadPage(runtime); const newer = loadPage(runtime);
  t.after(older.close); t.after(newer.close);
  await waitFor(() => older.document.querySelector('.ico-row-actions') && newer.document.querySelector('.ico-row-actions'));
  click(older.document.querySelector('[data-action="track"]'));
  await waitFor(() => newer.document.querySelector('[data-action="track"]').textContent === 'Tracked');
  newer.document.querySelector('[data-automation-key="State"]').textContent = 'Mitigated';
  await waitFor(() => runtime.data[M.STORAGE_KEY].reports[0].entries['123'].status === 'Mitigated');
  older.document.body.append(older.document.createElement('p'));
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(runtime.data[M.STORAGE_KEY].reports[0].entries['123'].status, 'Mitigated');
  assert.equal(runtime.messages.filter(message => message.type === 'oncall:observe').length, 1);
  older.document.querySelector('[data-automation-key="State"]').textContent = 'Resolved';
  await waitFor(() => runtime.data[M.STORAGE_KEY].reports[0].entries['123'].status === 'Resolved');
});

test('failed metadata writes recover on the next page update after reading the latest saved fields', async t => {
  const runtime = createRuntime(); const reportId = (await runtime.request('get')).activeReportId;
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true, title: 'A sample incident', severity: '3', status: 'Active', notes: 'Keep my analysis' } });
  const page = loadPage(runtime); t.after(page.close);
  await waitFor(() => page.document.querySelector('.ico-row-actions'));
  runtime.failWrites();
  page.document.querySelector('[data-automation-key="State"]').textContent = 'Mitigated';
  await waitFor(() => page.document.querySelector('.ico-toast.ico-error'));
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(runtime.messages.filter(message => message.type === 'oncall:observe').length, 1, 'failed writes must not spin in a retry loop');
  const beforeRetry = runtime.messages.length;
  runtime.failWrites(false);
  page.document.body.append(page.document.createElement('p'));
  await waitFor(() => runtime.data[M.STORAGE_KEY].reports[0].entries['123'].status === 'Mitigated');
  assert.deepEqual(runtime.messages.slice(beforeRetry).map(message => message.type), ['oncall:get', 'oncall:observe']);
  assert.equal(runtime.data[M.STORAGE_KEY].reports[0].entries['123'].notes, 'Keep my analysis');
});

test('metadata recovery keeps newer cross-tab fields while retrying unrelated missing metadata', async t => {
  const runtime = createRuntime(); const reportId = (await runtime.request('get')).activeReportId;
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true, title: 'A sample incident', severity: '3', status: 'Active' } });
  const page = loadPage(runtime); t.after(page.close);
  await waitFor(() => page.document.querySelector('.ico-row-actions'));
  runtime.failWrites();
  page.document.querySelector('[data-automation-key="State"]').textContent = 'Mitigated';
  const date = page.document.createElement('div'); date.dataset.automationKey = 'CreatedDate'; date.textContent = '2026-11-16 00:30 GMT+8';
  page.document.querySelector('.ms-DetailsRow').append(date);
  await waitFor(() => page.document.querySelector('.ico-toast.ico-error'));
  runtime.failWrites(false);
  await runtime.request('save', { reportId, incidentId: '123', patch: { status: 'Resolved', notes: 'Newer manual analysis' } });
  await waitFor(() => runtime.data[M.STORAGE_KEY].reports[0].entries['123'].day === '2026-11-16');
  const entry = runtime.data[M.STORAGE_KEY].reports[0].entries['123'];
  assert.equal(entry.status, 'Resolved'); assert.equal(entry.notes, 'Newer manual analysis');
  const attempts = runtime.messages.filter(message => message.type === 'oncall:observe');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1].snapshots, [{ id: '123', day: '2026-11-16' }]);
});

test('an unacknowledged metadata save is read back without replaying a committed update', async t => {
  const runtime = createRuntime(); const reportId = (await runtime.request('get')).activeReportId;
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true, title: 'A sample incident', severity: '3', status: 'Active' } });
  const send = runtime.chrome.runtime.sendMessage;
  let loseAcknowledgement = true;
  runtime.chrome.runtime.sendMessage = async message => {
    const response = await send(message);
    if (message.type === 'oncall:observe' && loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Acknowledgement lost'); }
    return response;
  };
  const page = loadPage(runtime); t.after(page.close);
  await waitFor(() => page.document.querySelector('.ico-row-actions'));
  const beforeChange = runtime.messages.length;
  page.document.querySelector('[data-automation-key="State"]').textContent = 'Mitigated';
  await waitFor(() => page.document.querySelector('.ico-toast.ico-error'));
  page.document.body.append(page.document.createElement('p'));
  await waitFor(() => runtime.messages.slice(beforeChange).some(message => message.type === 'oncall:get'));
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(runtime.data[M.STORAGE_KEY].reports[0].entries['123'].status, 'Mitigated');
  assert.equal(runtime.messages.filter(message => message.type === 'oncall:observe').length, 1);
});

test('dashboard search renders locally and keeps unavailable backup controls hidden', async t => {
  const runtime = createRuntime(); const reportId = (await runtime.request('get')).activeReportId;
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true, title: 'Sample incident' } });
  const page = loadPage(runtime, { dashboard: true }); t.after(page.close);
  await waitFor(() => page.document.querySelectorAll('#incidents tr').length === 1 && page.document.querySelector('#auto-backup-status').dataset.state === 'not-installed');
  const beforeSearch = runtime.messages.length;
  const search = page.document.querySelector('#search');
  for (const query of ['S', 'Sa', 'Sample']) {
    search.value = query; search.dispatchEvent(new page.window.Event('input'));
    assert.equal(page.document.querySelectorAll('#incidents tr').length, 1);
    assert.equal(page.document.querySelector('#backup-now').disabled, true);
    assert.equal(page.document.querySelector('#backup-now').hidden, true);
    assert.equal(page.document.querySelector('#auto-backup-info').hidden, true);
  }
  assert.equal(runtime.messages.length, beforeSearch, 'search must not request bridge or workspace data');
});

test('OneNote copy includes all tracked rows even when the dashboard is filtered', async t => {
  const runtime = createRuntime(); const reportId = (await runtime.request('get')).activeReportId;
  for (const [id, day] of [['123', '2026-11-14'], ['456', '2026-11-16']]) await runtime.request('save', { reportId, incidentId: id, patch: { tracked: true, day, title: `Sample ${id}`, notes: 'First line\nSecond line' } });
  const page = loadPage(runtime, { dashboard: true }); t.after(page.close); const d = page.document;
  const copied = {};
  d.execCommand = command => {
    assert.equal(command, 'copy');
    const event = new page.window.Event('copy', { cancelable: true });
    event.clipboardData = { setData(type, value) { copied[type] = value; } };
    d.dispatchEvent(event); return true;
  };
  await waitFor(() => d.querySelectorAll('#incidents tr').length === 2);
  d.querySelector('#search').value = '123'; d.querySelector('#search').dispatchEvent(new page.window.Event('input'));
  assert.equal(d.querySelectorAll('#incidents tr').length, 1);
  click(d.querySelector('#copy'));
  await waitFor(() => copied['text/html']);
  const exported = new page.window.DOMParser().parseFromString(copied['text/html'], 'text/html');
  assert.equal(exported.querySelectorAll('tbody tr').length, 2);
  assert.equal(exported.querySelectorAll('th').length, 11);
  assert.deepEqual([...exported.querySelectorAll('tbody tr')].map(row => row.firstElementChild.textContent).sort(), ['2026-11-14', '2026-11-16']);
  assert.match(copied['text/html'], /details\/456\/summary/);
  assert.match(copied['text/html'], /First line<br>Second line/);
  assert.match(copied['text/plain'], /Sample 123/);
});

test('dashboard tracks incidents, edits notes, filters incomplete work and removes rows without deleting notes', async t => {
  const runtime = createRuntime(); const page = loadPage(runtime, { dashboard: true }); t.after(page.close); const d = page.document;
  await waitFor(() => d.querySelector('#reports').options.length);
  d.querySelector('#add-id').value = '123'; d.querySelector('#add-form').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => d.querySelector('#incidents tr'));
  click(d.querySelector('[aria-label="Edit notes for incident 123"]'));
  set(d, 'rootCause', 'Capacity'); set(d, 'resolution', 'Increased allocation'); set(d, 'notes', 'Verified recovery'); submit(d);
  await waitFor(() => !d.querySelector('.ico-editor'));
  assert.equal(d.querySelector('#filter option[value="incomplete"]').textContent, 'Needs summary (0)');
  d.querySelector('#filter').value = 'incomplete'; d.querySelector('#filter').dispatchEvent(new page.window.Event('change'));
  assert.equal(d.querySelectorAll('#incidents tr').length, 0);
  d.querySelector('#filter').value = 'all'; d.querySelector('#filter').dispatchEvent(new page.window.Event('change'));
  click(d.querySelector('[aria-label="Untrack incident 123"]'));
  await waitFor(() => !d.querySelector('#incidents tr'));
  assert.equal(M.currentReport(await runtime.request('get')).entries['123'].notes, 'Verified recovery');
});
