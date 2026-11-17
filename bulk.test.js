const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./model');
const { createRuntime, loadPage, waitFor } = require('./test/runtime');

const listHtml = ids => `<div role="grid">${ids.map(id => `<div class="ms-DetailsRow" role="row" aria-selected="false"><div role="gridcell" data-selection-toggle="true"><div role="checkbox" aria-checked="false" data-selection-toggle="true" aria-label="Select ${id}"></div></div><div role="gridcell" data-automation-key="Title"><a href="${M.incidentUrl(id)}">Incident ${id}</a></div><div data-automation-key="State">Active</div></div>`).join('')}</div>`;
async function fixture(t, ids = ['123', '456', '789']) {
  const runtime = createRuntime(); const { activeReportId: reportId } = await runtime.request('get');
  const page = loadPage(runtime, { html: listHtml(ids) }); t.after(page.close);
  const $ = selector => page.document.querySelector(selector);
  await waitFor(() => $('[data-action="link-selected"]'));
  for (const checkbox of page.document.querySelectorAll('[role="checkbox"][data-selection-toggle]')) checkbox.addEventListener('click', () => {
    const selected = checkbox.getAttribute('aria-checked') !== 'true';
    checkbox.setAttribute('aria-checked', String(selected));
    checkbox.closest('[role="row"]').setAttribute('aria-selected', String(selected));
  });
  const select = async selected => {
    for (const row of page.document.querySelectorAll('.ms-DetailsRow')) {
      if ((row.getAttribute('aria-selected') === 'true') !== selected.includes(M.incidentId(row.querySelector('a').href))) row.querySelector('[role="checkbox"][data-selection-toggle]').click();
    }
    await waitFor(() => $('.ico-selected-count').textContent === `${new Set(selected).size} selected`);
  };
  return { runtime, reportId, page, $, select, api: page.window.IcmQuickMitigate };
}
function ignorePayload(db, ids) {
  const report = M.currentReport(db);
  return { reportId: report.id, incidents: ids.map(id => ({ id })), ignored: true,
    baseIgnored: Object.fromEntries(ids.map(id => [id, M.isIgnored(db, id)])),
    baseTracked: Object.fromEntries(ids.map(id => [id, !!report.entries[id]?.tracked])),
    baseTargets: Object.fromEntries(ids.map(id => [id, report.entries[id]?.summaryIncidentId || ''])),
  };
}

test('native multi-selection links to one summary, including a selected main, and ignores only selected IDs', async t => {
  const { runtime, reportId, page, $, select } = await fixture(t);
  assert.equal($('.ico-bulk-actions').hidden, true);
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true, notes: 'Main analysis' } });
  await runtime.request('save', { reportId, incidentId: '456', patch: { tracked: true, notes: 'Child analysis' } });
  await runtime.request('list-preferences', { patch: { showTracked: true } });
  await select(['123', '456']);
  $('[data-action="link-selected"]').click();
  runtime.failWrites();
  $('.ico-summary-choice[data-incident-id="123"]').click();
  await waitFor(() => $('.ico-form-status')?.textContent.includes('quota'));
  assert.equal($('.ico-selected-count').textContent, '2 selected');
  assert.equal(page.document.querySelectorAll('.ico-row-hidden').length, 0);
  runtime.failWrites(false);
  // A later selection is not part of the batch and must remain selected.
  await select(['123', '456', '789']);
  $('.ico-summary-choice[data-incident-id="123"]').click();
  await waitFor(() => !$('.ico-overlay'));
  let report = M.currentReport(await runtime.request('get'));
  assert.equal(report.entries['123'].tracked, true);
  assert.equal(report.entries['456'].summaryIncidentId, '123');
  assert.equal(report.entries['456'].notes, 'Child analysis');
  assert.equal(report.entries['789'], undefined);
  assert.equal($('.ico-bulk-status').textContent, '1 linked.');
  assert.equal($('.ico-selected-count').textContent, '1 selected');
  assert.equal(page.document.querySelectorAll('.ms-DetailsRow[aria-selected="true"]').length, 1);
  assert.equal(page.document.querySelectorAll('[role="checkbox"][aria-checked="true"]').length, 1);
  await runtime.request('list-preferences', { patch: { showTracked: false } });
  assert.equal(page.document.querySelectorAll('.ico-row-hidden').length, 2);
  await runtime.request('list-preferences', { patch: { showTracked: true } });
  await select(['456', '789']);
  runtime.failWrites();
  $('[data-action="ignore-selected"]').click();
  await waitFor(() => $('.ico-bulk-status').textContent.includes('quota'));
  assert.equal($('.ico-selected-count').textContent, '2 selected');
  assert.equal(page.document.querySelectorAll('.ico-row-hidden').length, 0);
  runtime.failWrites(false);
  $('[data-action="ignore-selected"]').click();
  await waitFor(() => $('.ico-bulk-status').textContent === '2 ignored.');
  const db = await runtime.request('get'); report = M.currentReport(db);
  assert.deepEqual(M.ignoredEntries(db).map(item => item.id).sort(), ['456', '789']);
  assert.equal(report.entries['123'].notes, 'Main analysis\nChild analysis');
  assert.equal(report.entries['456'].notes, 'Child analysis');
  assert.equal(report.entries['456'].summaryIncidentId, '123');
  await runtime.request('list-preferences', { patch: { showTracked: false } });
  assert.equal(page.document.querySelectorAll('.ico-row-hidden').length, 3);
  assert.equal(page.document.querySelectorAll('.ms-DetailsRow[aria-selected="true"], [role="checkbox"][aria-checked="true"]').length, 0);
  assert.equal($('.ico-bulk-actions').hidden, true);
});

test('bulk Link freezes IDs and report when opened, even if selection and active report change', async t => {
  const { runtime, reportId, $, select } = await fixture(t);
  await runtime.request('save', { reportId, incidentId: '900', patch: { tracked: true } });
  await select(['123', '456']); $('[data-action="link-selected"]').click();
  await select(['789']);
  const next = await runtime.request('create-report', { fields: { name: 'Next report' } });
  $('.ico-summary-choice[data-incident-id="900"]').click(); await waitFor(() => !$('.ico-overlay'));
  const db = await runtime.request('get');
  assert.deepEqual(M.relatedEntries(M.currentReport(db, reportId), '900').map(item => item.id), ['123', '456']);
  assert.equal(Object.keys(M.currentReport(db, next.activeReportId).entries).length, 0);
  assert.equal($('.ico-selected-count').textContent, '1 selected');
});

test('bulk Ignore is atomic on invalid IDs, concurrent triage changes and storage failure', async () => {
  const runtime = createRuntime(); let db = await runtime.request('get');
  await runtime.request('save', { reportId: db.activeReportId, incidentId: '456', patch: { tracked: true, notes: 'Preserve me' } });
  db = await runtime.request('get');
  const payload = ignorePayload(db, ['123', '456']);
  await assert.rejects(runtime.request('ignore-incidents', { ...payload, incidents: [{ id: '123' }, { id: 'bad' }] }), /incident ID/i);
  assert.equal(M.isIgnored(await runtime.request('get'), '123'), false);
  await runtime.request('save', { reportId: db.activeReportId, incidentId: '456', patch: { tracked: false } });
  await assert.rejects(runtime.request('ignore-incidents', payload), /another window/);
  assert.equal(M.isIgnored(await runtime.request('get'), '123'), false);
  const refreshed = ignorePayload(await runtime.request('get'), ['123', '456']);
  runtime.failWrites(); await assert.rejects(runtime.request('ignore-incidents', refreshed), /quota/);
  assert.equal(M.isIgnored(await runtime.request('get'), '123'), false);
  runtime.failWrites(false);
  const writes = runtime.writes.length;
  await runtime.request('ignore-incidents', refreshed);
  assert.equal(runtime.writes.length, writes + 1);
  assert.equal(M.currentReport(await runtime.request('get')).entries['456'].notes, 'Preserve me');
});

test('checkbox selection, recycled rows and legacy selected rows update the bulk controls without leaking to detail pages', async t => {
  const { page, $, api } = await fixture(t, ['123']);
  const checkbox = page.document.createElement('input'); checkbox.type = 'checkbox'; $('.ms-DetailsRow').prepend(checkbox); checkbox.checked = true;
  checkbox.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await waitFor(() => !$('.ico-bulk-actions').hidden);
  let calls = 0; api.startBatch = () => { calls++; };
  $('[data-action="mitigate-selected"]').click();
  assert.equal(calls, 0); // Programmatic page events cannot authorize official writes.
  $('[data-automation-key="State"]').textContent = 'Resolved';
  await waitFor(() => $('[data-action="mitigate-selected"]').disabled);
  $('a').href = 'https://example.com';
  await waitFor(() => $('.ico-bulk-actions').hidden);
  $('a').href = M.incidentUrl('456');
  await waitFor(() => !$('.ico-bulk-actions').hidden);
  page.dom.reconfigure({ url: M.incidentUrl('456') });
  await waitFor(() => $('.ico-bulk-actions').hidden);

  const legacy = loadPage(createRuntime(), { url: 'https://portal.microsofticm.com/imp/v5/incidents/search', html: `<div class="searchresults-k-grid"><div class="k-grid-content"><table><tr role="row" class="k-state-selected"><td><a href="${M.incidentUrl('789')}">Legacy incident</a></td></tr></table></div></div>` });
  t.after(legacy.close);
  await waitFor(() => legacy.document.querySelector('.ico-selected-count')?.textContent === '1 selected');
  assert.equal(legacy.document.querySelector('.ico-bulk-actions').hidden, false);
});

test('batch mitigation freezes selection, deduplicates, skips completed incidents and waits for each confirmed result', async t => {
  const { api } = await fixture(t);
  const incidents = [{ id: '123', status: 'Active' }, { id: '456', status: 'Resolved' }, { id: '789', status: 'Active' }, { id: '123' }];
  const calls = [], saved = []; let release;
  const pending = api.startBatch(incidents, {
    startIncident: async (id, options) => {
      calls.push(id); assert.equal(options.stopOnError, true);
      if (id === '123') await new Promise(resolve => { release = resolve; });
      return { status: 'Mitigated' };
    },
    onResult: async id => { saved.push(id); },
  });
  assert.equal(api.busy(), true);
  assert.deepEqual(calls, ['123']);
  assert.throws(() => api.start('999'), /current Quick Mitigate/);
  await assert.rejects(api.startBatch([{ id: '999' }]), /current Quick Mitigate/);
  incidents[2].id = '999'; incidents.push({ id: '800' });
  release(); const result = await pending;
  assert.deepEqual(calls, ['123', '789']); assert.deepEqual(saved, calls);
  assert.deepEqual(Array.from(result.completed), calls);
  assert.deepEqual(Array.from(result.skipped), ['456']);
  assert.equal(result.stoppedAt, ''); assert.equal(api.busy(), false);
});

test('batch mitigation stops on failure, cancellation, unconfirmed status or navigation, without retries or later submissions', async t => {
  const { api } = await fixture(t);
  for (const failed of [null, { error: 'Validation failed' }, { status: 'Active' }, new Error('Unconfirmed')]) {
    const calls = [];
    const result = await api.startBatch(['123', '456', '789'].map(id => ({ id })), { startIncident: async id => {
      calls.push(id);
      if (id === '123') return { status: 'Mitigated' };
      if (failed instanceof Error) throw failed;
      return failed;
    } });
    assert.deepEqual(calls, ['123', '456']); assert.equal(result.stoppedAt, '456');
    assert.deepEqual(Array.from(result.completed), ['123']); assert.ok(result.error);
  }
  let samePage = true; const calls = [];
  const stopped = await api.startBatch([{ id: '123' }, { id: '456' }], {
    shouldContinue: () => samePage,
    startIncident: async id => { calls.push(id); samePage = false; return { status: 'Mitigated' }; },
  });
  assert.deepEqual(calls, ['123']); assert.equal(stopped.stoppedAt, '456');
  const localFailure = await api.startBatch([{ id: '123' }, { id: '456' }], {
    startIncident: async () => ({ status: 'Mitigated' }), onResult: async () => { throw new Error('Storage quota'); },
  });
  assert.deepEqual(Array.from(localFailure.completed), ['123']); assert.equal(localFailure.stoppedAt, '123');
  assert.match(localFailure.error, /ICM confirmed Mitigated.*Storage quota/);
});
