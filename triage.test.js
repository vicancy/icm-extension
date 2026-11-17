const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('./model');
const { createRuntime, loadPage, waitFor, root } = require('./test/runtime');

const click = element => element.click();
const row = page => page.document.querySelector('.ms-DetailsRow');
const button = (page, action) => page.document.querySelector(`[data-action="${action}"]`);
const hidden = page => row(page).classList.contains('ico-row-hidden');
function open(t, runtime, options) { const page = loadPage(runtime, options); t.after(page.close); return page; }
function change(page, element, value) { element.checked = value; element.dispatchEvent(new page.window.Event('change', { bubbles: true })); }

test('tracking hides query rows, shared visibility preferences reveal them, and untracking restores pending work', async t => {
  const runtime = createRuntime(); const a = open(t, runtime); const b = open(t, runtime);
  await waitFor(() => button(a, 'track') && button(b, 'track'));
  click(button(a, 'track')); await waitFor(() => hidden(a) && hidden(b));
  assert.equal(M.trackedEntries(M.reportForDisplay(await runtime.request('get'))).length, 1);
  change(a, a.document.querySelector('[name="showTracked"]'), true);
  await waitFor(() => !hidden(a) && !hidden(b));
  assert.equal(b.document.querySelector('[name="showTracked"]').checked, true);
  const reload = open(t, runtime); await waitFor(() => button(reload, 'track'));
  assert.equal(hidden(reload), false);
  change(a, a.document.querySelector('[name="showTracked"]'), false);
  await waitFor(() => hidden(a));
  const db = await runtime.request('get');
  await runtime.request('save', { reportId: db.activeReportId, incidentId: '123', patch: { tracked: false } });
  assert.equal(hidden(a), false); assert.equal(hidden(b), false);
  assert.equal(a.document.querySelector('[role="columnheader"]').textContent, 'Title');
});

test('hidden Fluent rows collapse their minimum-height cells and recover when selection, filters or recycled rows change', async t => {
  const runtime = createRuntime();
  const cellHtml = id => `<div class="ms-List-cell" data-case="${id}"><div><div class="ms-DetailsRow" role="row"><div role="gridcell" data-automation-key="Title"><a href="${M.incidentUrl(id)}">Incident ${id}</a></div></div></div></div>`;
  const page = open(t, runtime, { html: `<style>.ms-List-cell { min-height:24px; }${fs.readFileSync(path.join(root, 'content.css'), 'utf8')}</style><div class="ms-List"><div class="ms-List-surface"><div class="ms-List-page">${cellHtml('123')}${cellHtml('456')}</div><div class="ms-List-page" style="height:240px"></div></div></div>` });
  const cells = [...page.document.querySelectorAll('.ms-List-cell')];
  const display = element => page.window.getComputedStyle(element).display;
  await waitFor(() => button(page, 'track'));
  assert.equal(page.window.getComputedStyle(cells[0]).minHeight, '24px');
  click(cells[0].querySelector('[data-action="track"]'));
  await waitFor(() => hidden(page));
  assert.equal(display(cells[0]), 'none');
  assert.equal(display(cells[1]), 'block');
  click(cells[1].querySelector('[data-action="ignore"]'));
  await waitFor(() => cells[1].querySelector('.ico-row-hidden'));
  assert.equal(display(cells[1]), 'none');
  // Keep native list pages/placeholders intact; only the row's own cell collapses.
  for (const nativePage of page.document.querySelectorAll('.ms-List-page')) assert.equal(display(nativePage), 'block');
  assert.equal(page.document.querySelector('.ms-List-page[style]').style.height, '240px');
  row(page).setAttribute('aria-selected', 'true'); await waitFor(() => !hidden(page));
  assert.equal(display(cells[0]), 'block');
  row(page).setAttribute('aria-selected', 'false'); await waitFor(() => hidden(page));
  assert.equal(display(cells[0]), 'none');
  change(page, page.document.querySelector('[name="showTracked"]'), true);
  await waitFor(() => !hidden(page)); assert.equal(display(cells[0]), 'block');
  change(page, page.document.querySelector('[name="showIgnored"]'), true);
  await waitFor(() => !cells[1].querySelector('.ico-row-hidden')); assert.equal(display(cells[1]), 'block');
  change(page, page.document.querySelector('[name="showIgnored"]'), false);
  await waitFor(() => cells[1].querySelector('.ico-row-hidden'));
  cells[1].querySelector('a').href = M.incidentUrl('789');
  await waitFor(() => !cells[1].querySelector('.ico-row-hidden'));
  assert.equal(display(cells[1]), 'block');
  // Reusing a wrapper for a new native row must not inherit a stale hidden state.
  cells[0].innerHTML = cells[1].innerHTML;
  assert.equal(display(cells[0]), 'block');
});

test('ignore stays across reports, preserves notes and is excluded from summaries without deleting historical records', async () => {
  const runtime = createRuntime(); const db = await runtime.request('get'); const first = db.activeReportId;
  await runtime.request('save', { reportId: first, incidentId: '123', patch: { tracked: true, title: 'Buildout', notes: 'Keep my investigation', rootCause: 'Known cause' } });
  const next = await runtime.request('create-report', { fields: { name: 'Next rotation' } }); const second = next.activeReportId;
  await runtime.request('save', { reportId: second, incidentId: '123', patch: { tracked: true, notes: 'This rotation' } });
  const ignored = await runtime.request('ignore', { reportId: second, incidentId: '123', ignored: true, title: 'Buildout' });
  assert.equal(M.isIgnored(ignored, '123'), true);
  for (const id of [first, second]) assert.equal(M.exportReport(M.reportForDisplay(ignored, id)).count, 0);
  assert.equal(M.currentReport(ignored, first).entries['123'].notes, 'Keep my investigation');
  assert.equal(M.currentReport(ignored, first).entries['123'].tracked, true);
  assert.equal(M.currentReport(ignored, second).entries['123'].tracked, false);
  const third = await runtime.request('create-report', { fields: { name: 'Another rotation' } });
  assert.equal(M.isIgnored(third, '123'), true);
  const restored = await runtime.request('ignore', { reportId: third.activeReportId, incidentId: '123', ignored: false });
  assert.equal(M.isIgnored(restored, '123'), false); assert.equal(M.trackedEntries(M.reportForDisplay(restored)).length, 0);
  assert.equal(M.currentReport(restored, first).entries['123'].notes, 'Keep my investigation');
});

test('Ignored list searches, restores pending incidents, and explicitly tracks them into the selected report', async t => {
  const runtime = createRuntime(); const list = open(t, runtime); const dashboard = open(t, runtime, { dashboard: true });
  const manager = open(t, runtime, { ignored: true });
  await waitFor(() => button(list, 'ignore'));
  click(button(list, 'ignore')); await waitFor(() => hidden(list) && manager.document.querySelector('#incidents tr'));
  assert.equal(dashboard.document.querySelectorAll('#incidents tr').length, 0);
  assert.equal(dashboard.document.querySelector('#ignored').textContent, 'Ignored (1)');
  click(button(list, 'open-ignored')); await waitFor(() => runtime.tabs.length);
  assert.match(runtime.tabs[0].url, /ignored\.html$/);
  const search = manager.document.querySelector('#search'); search.value = 'missing'; search.dispatchEvent(new manager.window.Event('input'));
  assert.equal(manager.document.querySelectorAll('#incidents tr').length, 0);
  search.value = '123'; search.dispatchEvent(new manager.window.Event('input'));
  click(manager.document.querySelector('[aria-label="Restore incident 123"]'));
  await waitFor(() => !hidden(list) && !manager.document.querySelector('#incidents tr'));
  assert.equal(button(list, 'track').textContent, 'Track');
  click(button(list, 'ignore')); await waitFor(() => manager.document.querySelector('#incidents tr'));
  const next = await runtime.request('create-report', { fields: { name: 'New rotation' } });
  click(manager.document.querySelector('[aria-label="Track incident 123"]'));
  await waitFor(() => !manager.document.querySelector('#incidents tr') && dashboard.document.querySelector('#incidents tr'));
  const result = await runtime.request('get');
  assert.equal(M.currentReport(result, next.activeReportId).entries['123'].tracked, true);
  assert.equal(M.currentReport(result).entries['123'].title, 'A sample incident');
  assert.equal(M.isIgnored(result, '123'), false); assert.equal(hidden(list), true);
});

test('native selected rows stay visible, including native select-all, until deselected', async t => {
  const runtime = createRuntime(); const page = open(t, runtime);
  await waitFor(() => button(page, 'track'));
  click(button(page, 'track')); await waitFor(() => hidden(page));
  row(page).setAttribute('aria-selected', 'true'); await waitFor(() => !hidden(page));
  assert.match(page.document.querySelector('.ico-hidden-count').textContent, /1 selected kept visible/);
  row(page).setAttribute('aria-selected', 'false'); await waitFor(() => hidden(page));
  const checkbox = page.document.createElement('input'); checkbox.type = 'checkbox'; row(page).prepend(checkbox);
  change(page, checkbox, true); await waitFor(() => !hidden(page));
  change(page, checkbox, false); await waitFor(() => hidden(page));
});

test('recycled and invalid rows lose obsolete hiding and bind Ignore to the new incident', async t => {
  const runtime = createRuntime(); const page = open(t, runtime);
  await waitFor(() => button(page, 'ignore'));
  click(button(page, 'ignore')); await waitFor(() => hidden(page));
  const link = page.document.querySelector('[data-automation-key="Title"] a');
  link.href = M.incidentUrl('456'); link.textContent = 'Another incident';
  await waitFor(() => !hidden(page) && button(page, 'ignore').getAttribute('aria-label') === 'Ignore incident 456');
  click(button(page, 'ignore')); await waitFor(() => hidden(page));
  assert.equal(M.ignoredEntries(await runtime.request('get')).length, 2);
  link.href = 'https://example.com';
  await waitFor(() => !hidden(page) && !button(page, 'ignore'));
});

test('legacy Search rows support filtering and detail pages are never hidden by it', async t => {
  const runtime = createRuntime(); const db = await runtime.request('get');
  await runtime.request('ignore', { reportId: db.activeReportId, incidentId: '123', ignored: true, title: 'Noise' });
  const search = open(t, runtime, { url: 'https://portal.microsofticm.com/imp/v5/incidents/search', html: '<div class="searchresults-k-grid"><div class="k-grid-content"><table><tr role="row"><td><a href="https://portal.microsofticm.com/imp/v5/incidents/details/123">Noise</a></td></tr></table></div></div>' });
  await waitFor(() => search.document.querySelector('tr.ico-row-hidden'));
  change(search, search.document.querySelector('[name="showIgnored"]'), true);
  await waitFor(() => !search.document.querySelector('tr.ico-row-hidden'));
  const detail = open(t, runtime, { url: M.incidentUrl('123'), html: '<title>Incident 123: Noise - IcM</title>' });
  await waitFor(() => detail.document.querySelector('.ico-detail-actions'));
  assert.equal(detail.document.querySelector('[data-action="ignore"]').textContent, 'Restore');
  assert.equal(detail.document.querySelector('.ico-list-filters').hidden, true);
});

test('failed Ignore writes do not hide incidents or lose annotations', async t => {
  const runtime = createRuntime(); const page = open(t, runtime);
  await waitFor(() => button(page, 'ignore')); const db = await runtime.request('get');
  await runtime.request('save', { reportId: db.activeReportId, incidentId: '123', patch: { notes: 'Keep this', tracked: false } });
  runtime.failWrites(); click(button(page, 'ignore'));
  await waitFor(() => page.document.querySelector('.ico-toast.ico-error'));
  assert.equal(hidden(page), false); assert.equal(M.isIgnored(await runtime.request('get'), '123'), false);
  runtime.failWrites(false); click(button(page, 'ignore')); await waitFor(() => hidden(page));
  assert.equal(M.currentReport(await runtime.request('get')).entries['123'].notes, 'Keep this');
});

test('agent saves and stale editors cannot silently undo Ignore', async () => {
  const runtime = createRuntime(); const db = await runtime.request('get'); const reportId = db.activeReportId;
  await runtime.request('ignore', { reportId, incidentId: '123', ignored: true, title: 'Buildout' });
  const read = await runtime.agentRequest({ method: 'read_incident', params: { reportId, incidentId: '123' } });
  assert.equal(read.ignored, true);
  await assert.rejects(runtime.agentRequest({ method: 'save_incident', params: { reportId, incidentId: '123', fields: { notes: 'Do not retrack' } } }), /ignored/);
  await assert.rejects(runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true }, baseIgnored: false, restoreIgnored: true }), /another window/);
  await runtime.agentRequest({ method: 'save_incident', params: { reportId, incidentId: '123', fields: { tracked: false, notes: 'Saved without retracking' } } });
  assert.equal(M.isIgnored(await runtime.request('get'), '123'), true);
});

test('backups preserve Ignore and restoring an older backup never reverses existing decisions', async () => {
  const source = createRuntime(); const db = await source.request('get');
  const backup = await source.request('ignore', { reportId: db.activeReportId, incidentId: '123', ignored: true, title: 'Noise' });
  const restored = createRuntime(); await restored.request('import', { data: backup });
  assert.equal(M.isIgnored(await restored.request('get'), '123'), true);
  await source.request('ignore', { reportId: db.activeReportId, incidentId: '123', ignored: false });
  await source.request('import', { data: backup }); assert.equal(M.isIgnored(await source.request('get'), '123'), false);
  const existing = createRuntime(); const current = await existing.request('get');
  await existing.request('save', { reportId: current.activeReportId, incidentId: '123', patch: { tracked: true, notes: 'Current decision' } });
  await existing.request('import', { data: backup });
  const result = await existing.request('get');
  assert.equal(M.isIgnored(result, '123'), false); assert.equal(M.currentReport(result).entries['123'].tracked, true);
  assert.throws(() => M.validateBackup({ ...backup, ignoredIncidents: { bad: { ignored: true, title: '' } } }), /incident ID/);
});
