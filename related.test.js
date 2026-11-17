const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const M = require('./model');
const { createRuntime, loadPage, waitFor } = require('./test/runtime');

async function setup() {
  const runtime = createRuntime(); const { activeReportId: reportId } = await runtime.request('get');
  await runtime.request('save', { reportId, incidentId: '900', patch: { tracked: true, title: 'Main credential incident', rootCause: 'Confirmed cause', notes: 'Manual analysis', resolution: 'Recovered' } });
  return { runtime, reportId };
}
async function link(runtime, reportId, targetId, ids, overrides = {}) {
  const db = await runtime.request('get'); const report = M.currentReport(db, reportId);
  return runtime.request('link-incidents', { reportId, targetId, incidents: ids.map(id => ({ id })),
    baseTargets: Object.fromEntries(ids.map(id => [id, report.entries[id]?.summaryIncidentId || ''])),
    baseIgnored: Object.fromEntries(ids.map(id => [id, M.isIgnored(db, id)])),
    baseTracked: Object.fromEntries(ids.map(id => [id, !!report.entries[id]?.tracked])), ...overrides });
}

test('one tracked summary owns multiple related ICMs without changing private notes or inferred counts', async () => {
  const { runtime, reportId } = await setup();
  await runtime.request('save', { reportId, incidentId: '123', patch: { notes: 'Original child notes', rootCause: 'Tentative child cause', tracked: true } });
  await link(runtime, reportId, '900', ['123', '456']);
  await link(runtime, reportId, '900', ['123']);
  const report = M.currentReport(await runtime.request('get'));
  assert.equal(M.trackedEntries(report).length, 1);
  assert.deepEqual(M.relatedEntries(report, '900').map(entry => entry.id), ['123', '456']);
  assert.equal(report.entries['123'].tracked, false);
  assert.equal(report.entries['123'].notes, 'Original child notes');
  assert.equal(report.entries['123'].rootCause, 'Tentative child cause');
  assert.equal(report.entries['900'].notes, 'Manual analysis');
  assert.equal(report.entries['900'].occurrences, '');
  assert.equal(report.entries['900'].customersImpacted, '');
  const read = await runtime.agentRequest({ method: 'read_incident', params: { reportId, incidentId: '900' } });
  assert.deepEqual(Array.from(read.relatedIncidentIds), ['123', '456']);
  await assert.rejects(runtime.agentRequest({ method: 'save_incident', params: { reportId, incidentId: '123', fields: { resolution: 'Done' } } }), /linked to #900/);
  await runtime.agentRequest({ method: 'save_incident', params: { reportId, incidentId: '123', fields: { tracked: false, resolution: 'Done' } } });
  assert.equal(M.currentReport(await runtime.request('get')).entries['123'].summaryIncidentId, '900');
});

test('export puts numeric related links below the primary title in the Bug column and preserves Notes', async () => {
  const { runtime, reportId } = await setup(); await link(runtime, reportId, '900', ['789', '123', '456']);
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: false, title: 'Child title should not be exported', notes: 'Separate child analysis' } });
  await runtime.request('ignore', { reportId, incidentId: '456', ignored: true });
  const output = M.exportReport(M.reportForDisplay(await runtime.request('get')));
  const dom = new JSDOM(output.html); const cells = [...dom.window.document.querySelectorAll('td')];
  assert.equal(output.count, 1); assert.equal(cells.length, 11);
  assert.deepEqual([...cells[8].querySelectorAll('a')].map(a => [a.textContent, a.href]), [
    ['Main credential incident', M.incidentUrl('900')], ['123', M.incidentUrl('123')], ['789', M.incidentUrl('789')],
  ]);
  assert.equal(cells[8].querySelectorAll('br').length, 2);
  assert.match(cells[10].textContent, /Resolution: Recovered/);
  assert.match(cells[10].textContent, /Manual analysis/);
  assert.equal(cells[10].querySelector('a'), null);
  assert.doesNotMatch(output.html, /Related ICMs|Child title|Separate child analysis/);
  assert.doesNotMatch(output.html, /details\/456/);
  assert.equal(cells[5].textContent, ''); assert.equal(cells[6].textContent, '');
  assert.ok(output.csv.includes(`Main credential incident\n${M.incidentUrl('900')}\n[123](${M.incidentUrl('123')})\n[789](${M.incidentUrl('789')})`));
  const plainCells = output.plain.split('\n').at(-1).split('\t');
  assert.ok(plainCells[8].includes(`[123](${M.incidentUrl('123')})`));
  assert.equal(plainCells[10], 'Resolution: Recovered / Manual analysis');
  dom.window.close();
});

test('grouped exports keep each related number under its own primary and leave manual evidence in Notes', () => {
  const entry = (id, fields) => ({ ...M.emptyEntry(id), ...fields });
  const report = { name: 'Grouped report', entries: {
    900: entry('900', { tracked: true, title: 'First <main>', summaryGroup: 'Same issue', notes: 'Manual analysis', relatedLinks: 'https://example.com/evidence' }),
    901: entry('901', { tracked: true, title: 'Second main', summaryGroup: 'Same issue', notes: 'Manual analysis', relatedLinks: 'https://example.com/evidence' }),
    123: entry('123', { summaryIncidentId: '900' }),
    456: entry('456', { summaryIncidentId: '901' }),
  } };
  const output = M.exportReport(report);
  const dom = new JSDOM(output.html); const cells = [...dom.window.document.querySelectorAll('td')];
  assert.equal(output.count, 1);
  assert.deepEqual([...cells[8].children].map(block => [...block.querySelectorAll('a')].map(a => [a.textContent, a.href])), [
    [['First <main>', M.incidentUrl('900')], ['123', M.incidentUrl('123')]],
    [['Second main', M.incidentUrl('901')], ['456', M.incidentUrl('456')]],
  ]);
  assert.equal(cells[8].querySelector('main'), null);
  assert.equal(cells[10].textContent, 'Manual analysisEvidence links:https://example.com/evidence');
  assert.equal(cells[10].querySelector('a').href, 'https://example.com/evidence');
  dom.window.close();
});

test('related links reject cycles, stale moves, inactive targets and partial batch updates', async () => {
  const { runtime, reportId } = await setup();
  await runtime.request('save', { reportId, incidentId: '800', patch: { tracked: true } });
  await link(runtime, reportId, '900', ['123']);
  await assert.rejects(link(runtime, reportId, '900', ['456', '900']), /itself/);
  assert.equal(M.currentReport(await runtime.request('get')).entries['456'], undefined);
  await assert.rejects(link(runtime, reportId, '123', ['900']), /no longer tracked/);
  await assert.rejects(link(runtime, reportId, '800', ['900']), /related ICMs/);
  await assert.rejects(link(runtime, reportId, '800', ['123'], { baseTargets: { '123': '' } }), /another window/);
  await assert.rejects(link(runtime, reportId, '', ['123'], { baseTargets: { '123': '800' } }), /another window/);
  await runtime.request('save', { reportId, incidentId: '456', patch: { tracked: true } });
  await assert.rejects(link(runtime, reportId, '900', ['456'], { baseTracked: { '456': false } }), /Tracking changed/);
  assert.equal(M.currentReport(await runtime.request('get')).entries['456'].tracked, true);
  await runtime.request('save', { reportId, incidentId: '800', patch: { tracked: false } });
  await assert.rejects(link(runtime, reportId, '800', ['456']), /no longer tracked/);
  assert.equal(M.currentReport(await runtime.request('get')).entries['123'].summaryIncidentId, '900');
});

test('concurrent additions merge and a failed disk save does not lose or partially attach records', async () => {
  const { runtime, reportId } = await setup();
  await Promise.all([link(runtime, reportId, '900', ['123']), link(runtime, reportId, '900', ['456'])]);
  assert.equal(M.relatedEntries(M.currentReport(await runtime.request('get')), '900').length, 2);
  runtime.failWrites(); await assert.rejects(link(runtime, reportId, '900', ['777', '888']), /quota/);
  runtime.failWrites(false);
  const report = M.currentReport(await runtime.request('get'));
  assert.equal(report.entries['777'], undefined); assert.equal(report.entries['888'], undefined);
  assert.equal(M.relatedEntries(report, '900').length, 2);
});

test('links stay in their chosen report and unlink permits separate tracking without losing child notes', async () => {
  const { runtime, reportId } = await setup();
  await runtime.request('save', { reportId, incidentId: '123', patch: { notes: 'Keep child notes' } });
  const next = await runtime.request('create-report', { fields: { name: 'Next rotation' } });
  await link(runtime, reportId, '900', ['123']);
  const db = await runtime.request('get');
  assert.equal(M.currentReport(db).id, next.activeReportId); assert.equal(Object.keys(M.currentReport(db).entries).length, 0);
  assert.equal(M.currentReport(db, reportId).entries['123'].summaryIncidentId, '900');
  await link(runtime, reportId, '', ['123']);
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true } });
  const report = M.currentReport(await runtime.request('get'), reportId);
  assert.equal(report.entries['123'].notes, 'Keep child notes'); assert.equal(M.relatedEntries(report, '900').length, 0);
  assert.equal(M.trackedEntries(report).length, 2);
});

test('backup imports preserve related links and validate invalid relationship graphs', async () => {
  const { runtime, reportId } = await setup(); await link(runtime, reportId, '900', ['123', '456']);
  const backup = await runtime.request('get');
  const restored = createRuntime(); await restored.request('import', { data: backup });
  const report = (await restored.request('get')).reports[1];
  assert.equal(report.entries['123'].summaryIncidentId, '900');
  assert.equal(M.exportReport(report).count, 1);
  assert.deepEqual(M.relatedEntries(report, '900').map(entry => entry.id), ['123', '456']);
  for (const target of ['123', '789', false]) {
    const invalid = structuredClone(backup); invalid.reports[0].entries['123'].summaryIncidentId = target;
    assert.throws(() => M.validateBackup(invalid), /incident|related/);
  }
});

test('query Link picker attaches the visible incident, filters it, and can unlink it again', async t => {
  const { runtime } = await setup(); const page = loadPage(runtime); t.after(page.close);
  const $ = selector => page.document.querySelector(selector);
  await waitFor(() => $('[data-action="link"]'));
  $('[data-action="link"]').click();
  $('.ico-summary-choice[data-incident-id="900"]').click();
  await waitFor(() => $('.ms-DetailsRow').classList.contains('ico-row-hidden'));
  assert.equal($('.ico-overlay'), null);
  $('[name="showTracked"]').checked = true; $('[name="showTracked"]').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await waitFor(() => !$('.ms-DetailsRow').classList.contains('ico-row-hidden'));
  assert.equal($('[data-action="link"]').textContent, 'Linked #900');
  assert.equal($('[data-action="track"]').disabled, true);
  $('[data-action="link"]').click(); $('.ico-related-item button').click();
  await waitFor(() => $('[data-action="link"]').textContent === 'Link');
  assert.equal($('[data-action="track"]').disabled, false);
});

test('linked native-selected rows stay visible, and untracking or ignoring the summary returns children to the list', async t => {
  const { runtime, reportId } = await setup(); const page = loadPage(runtime); t.after(page.close);
  const row = () => page.document.querySelector('.ms-DetailsRow');
  await waitFor(() => page.document.querySelector('[data-action="link"]'));
  row().setAttribute('aria-selected', 'true');
  await link(runtime, reportId, '900', ['123']);
  assert.equal(row().classList.contains('ico-row-hidden'), false);
  row().setAttribute('aria-selected', 'false'); await waitFor(() => row().classList.contains('ico-row-hidden'));
  await runtime.request('save', { reportId, incidentId: '900', patch: { tracked: false } });
  await waitFor(() => !row().classList.contains('ico-row-hidden'));
  await runtime.request('save', { reportId, incidentId: '900', patch: { tracked: true } });
  await waitFor(() => row().classList.contains('ico-row-hidden'));
  await runtime.request('ignore', { reportId, incidentId: '900', ignored: true });
  await waitFor(() => !row().classList.contains('ico-row-hidden'));
});

test('dashboard accepts multiple IDs or URLs, keeps failed drafts, and removes links without discard prompts', async t => {
  const { runtime, reportId } = await setup(); const page = loadPage(runtime, { dashboard: true }); t.after(page.close);
  const $ = selector => page.document.querySelector(selector);
  await waitFor(() => $('[aria-label="Related ICMs for incident 900"]'));
  $('[aria-label="Related ICMs for incident 900"]').click();
  const input = $('[name="relatedIncidents"]');
  input.value = `123, #123; ${M.incidentUrl('456')}`; input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  runtime.failWrites(); $('.ico-editor-form').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => $('.ico-form-status').textContent.includes('quota'));
  assert.ok(input.value.includes('123'));
  runtime.failWrites(false); $('.ico-editor-form').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => $('.ico-related-list').children.length === 2);
  assert.equal(input.value, '');
  assert.equal(page.document.querySelectorAll('#incidents tr').length, 1);
  assert.equal(page.document.querySelectorAll('.related-incident-links a').length, 2);
  $('[aria-label="Unlink incident 123"]').click();
  await waitFor(() => $('.ico-related-list').children.length === 1);
  let confirms = 0; page.window.confirm = () => { confirms++; return true; };
  $('[aria-label="Close editor"]').click();
  assert.equal(confirms, 0);
  assert.deepEqual(M.relatedEntries(M.currentReport(await runtime.request('get'), reportId), '900').map(entry => entry.id), ['456']);
  $('#search').value = '456'; $('#search').dispatchEvent(new page.window.Event('input', { bubbles: true }));
  assert.equal(page.document.querySelectorAll('#incidents tr').length, 1);
  assert.match($('#incidents').textContent, /#900/);
});

test('bulk ID input rejects non-ICM URLs and ignores duplicates', () => {
  assert.deepEqual(M.parseIncidentIds(`123, #123; ${M.incidentUrl('456')}\n789`), ['123', '456', '789']);
  for (const value of ['', '123 bad-id', 'https://example.com/imp/v5/incidents/details/123', 'javascript:alert(1)']) assert.throws(() => M.parseIncidentIds(value));
});
