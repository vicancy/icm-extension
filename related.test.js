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

test('linking appends source Notes once while preserving source annotations and unknown counts', async () => {
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
  assert.equal(report.entries['900'].notes, 'Manual analysis\nOriginal child notes');
  assert.equal(report.entries['900'].rootCause, 'Confirmed cause');
  assert.equal(report.entries['900'].resolution, 'Recovered');
  assert.equal(report.entries['900'].occurrences, '');
  assert.equal(report.entries['900'].customersImpacted, '');
  const read = await runtime.agentRequest({ method: 'read_incident', params: { reportId, incidentId: '900' } });
  assert.deepEqual(Array.from(read.relatedIncidentIds), ['123', '456']);
  await assert.rejects(runtime.agentRequest({ method: 'save_incident', params: { reportId, incidentId: '123', fields: { resolution: 'Done' } } }), /linked to #900/);
  await runtime.agentRequest({ method: 'save_incident', params: { reportId, incidentId: '123', fields: { tracked: false, resolution: 'Done' } } });
  assert.equal(M.currentReport(await runtime.request('get')).entries['123'].summaryIncidentId, '900');
});

test('bulk linking appends only nonempty Notes in input order without duplicate IDs or extra labels', async () => {
  const { runtime, reportId } = await setup();
  for (const [id, notes] of [['123', 'First line\nSecond line'], ['456', ''], ['789', 'Evidence: https://example.com/logs?x=1&y=2']]) {
    await runtime.request('save', { reportId, incidentId: id, patch: { notes, rootCause: 'Source cause', resolution: 'Source resolution' } });
  }
  await link(runtime, reportId, '900', ['789', '456', '123', '789']);
  let report = M.currentReport(await runtime.request('get'));
  const expected = 'Manual analysis\nEvidence: https://example.com/logs?x=1&y=2\nFirst line\nSecond line';
  assert.equal(report.entries['900'].notes, expected);
  assert.equal(report.entries['123'].notes, 'First line\nSecond line');
  const dom = new JSDOM(M.exportReport(report).html); const cells = [...dom.window.document.querySelectorAll('td')];
  assert.equal(cells.length, 11); assert.equal(cells[7].textContent, 'Confirmed cause');
  assert.match(cells[10].innerHTML, /Manual analysis<br>Evidence:/);
  assert.match(cells[10].innerHTML, /First line<br>Second line/);
  assert.doesNotMatch(cells[10].textContent, /Source cause|Source resolution/);
  assert.equal(cells[10].querySelector('a').href, 'https://example.com/logs?x=1&y=2'); dom.window.close();
  await runtime.request('save', { reportId, incidentId: '123', patch: { notes: 'Later source edit' }, base: { notes: 'First line\nSecond line' } });
  await link(runtime, reportId, '900', ['123']);
  await link(runtime, reportId, '', ['123']);
  report = M.currentReport(await runtime.request('get'));
  assert.equal(report.entries['900'].notes, expected); // No live sync or deletion on unlink.
  assert.equal(report.entries['123'].notes, 'Later source edit');
  await runtime.request('save', { reportId, incidentId: '800', patch: { tracked: true } });
  await link(runtime, reportId, '800', ['123']);
  assert.equal(M.currentReport(await runtime.request('get')).entries['800'].notes, 'Later source edit');
});

test('linking a summary merges its related ICMs and Notes once while retaining annotations and Ignore state', async () => {
  const { runtime, reportId } = await setup();
  await runtime.request('save', { reportId, incidentId: '800', patch: { tracked: true, notes: 'Source analysis', rootCause: 'Source cause', resolution: 'Source resolution' } });
  await runtime.request('save', { reportId, incidentId: '123', patch: { notes: 'Child analysis', rootCause: 'Child cause' } });
  await link(runtime, reportId, '800', ['123', '456']);
  await link(runtime, reportId, '900', ['789']);
  await runtime.request('ignore', { reportId, incidentId: '456', ignored: true });
  await runtime.request('save', { reportId, incidentId: '123', patch: { notes: 'Later child analysis' }, base: { notes: 'Child analysis' } });
  const before = await runtime.request('get'); const sources = M.currentReport(before).entries;
  const payload = { reportId, targetId: '900', incidents: [{ id: '800' }], ...M.triageBase(before, reportId, [{ id: '800' }]) };
  const writes = runtime.writes.length;
  await runtime.request('link-incidents', payload);
  assert.equal(runtime.writes.length, writes + 1);
  await runtime.request('link-incidents', payload); // Retry the original request after a lost response.
  const db = await runtime.request('get'); const report = M.currentReport(db);
  assert.deepEqual(M.relatedEntries(report, '900').map(entry => entry.id), ['123', '456', '789', '800']);
  assert.equal(M.relatedEntries(report, '800').length, 0);
  assert.deepEqual(M.trackedEntries(report).map(entry => entry.id), ['900']);
  assert.equal(report.entries['900'].notes, 'Manual analysis\nSource analysis\nChild analysis');
  assert.equal(report.entries['900'].rootCause, 'Confirmed cause');
  assert.equal(report.entries['900'].resolution, 'Recovered');
  assert.equal(report.entries['900'].occurrences, ''); assert.equal(report.entries['900'].customersImpacted, '');
  for (const id of ['800', '123', '456']) {
    assert.deepEqual(report.entries[id], { ...sources[id], summaryIncidentId: '900', tracked: false, updatedAt: report.entries[id].updatedAt });
  }
  assert.deepEqual(db.ignoredIncidents, before.ignoredIncidents);
  assert.doesNotThrow(() => M.validateBackup(db));
  const dom = new JSDOM(M.exportReport(M.reportForDisplay(db)).html);
  assert.deepEqual([...dom.window.document.querySelectorAll('td')[8].querySelectorAll('a')].map(a => a.textContent), ['Main credential incident', '123', '789', '800']);
  dom.window.close();
});

test('bulk summary merges deduplicate overlapping selections regardless of parent/child order', async t => {
  for (const ids of [['800', '123', '700', '456', '789', '800'], ['123', '800', '456', '700', '789', '800']]) {
    await t.test(ids.join(', '), async () => {
      const { runtime, reportId } = await setup();
      for (const [id, notes] of [['800', 'First summary'], ['700', 'Second summary'], ['123', 'First child'], ['456', 'Second child'], ['789', 'Standalone']]) {
        await runtime.request('save', { reportId, incidentId: id, patch: { tracked: true, notes } });
      }
      await link(runtime, reportId, '800', ['123']); await link(runtime, reportId, '700', ['456']);
      await link(runtime, reportId, '900', ids);
      await link(runtime, reportId, '900', ids);
      const report = M.currentReport(await runtime.request('get'));
      assert.deepEqual(M.relatedEntries(report, '900').map(entry => entry.id), ['123', '456', '700', '789', '800']);
      assert.equal(report.entries['900'].notes, 'Manual analysis\nFirst summary\nFirst child\nSecond summary\nSecond child\nStandalone');
      assert.deepEqual(M.trackedEntries(report).map(entry => entry.id), ['900']);
    });
  }
});

test('summary merges leave the entire group unchanged on storage failure or oversized Notes', async () => {
  const { runtime, reportId } = await setup();
  await runtime.request('save', { reportId, incidentId: '800', patch: { tracked: true, notes: 'Source analysis' } });
  await link(runtime, reportId, '800', ['123', '456']);
  let before = await runtime.request('get');
  runtime.failWrites(); await assert.rejects(link(runtime, reportId, '900', ['800']), /quota/);
  runtime.failWrites(false);
  assert.deepEqual(await runtime.request('get'), before);
  await runtime.request('save', { reportId, incidentId: '800', patch: { notes: 'x'.repeat(20000) }, base: { notes: 'Source analysis' } });
  before = await runtime.request('get');
  await assert.rejects(link(runtime, reportId, '900', ['800', '789']), /Notes is too long/);
  assert.deepEqual(await runtime.request('get'), before);
  await runtime.request('save', { reportId, incidentId: '800', patch: { notes: 'Source analysis' }, base: { notes: 'x'.repeat(20000) } });
  await link(runtime, reportId, '900', ['800']);
  const report = M.currentReport(await runtime.request('get'));
  assert.deepEqual(M.relatedEntries(report, '900').map(entry => entry.id), ['123', '456', '800']);
  assert.equal(report.entries['900'].notes, 'Manual analysis\nSource analysis');
});

test('summary merges use current membership and Notes, preserve other reports and reject stale moves', async () => {
  const { runtime, reportId } = await setup();
  await runtime.request('save', { reportId, incidentId: '800', patch: { tracked: true, notes: 'Source analysis' } });
  await runtime.request('save', { reportId, incidentId: '700', patch: { tracked: true } });
  await link(runtime, reportId, '800', ['123', '456']);
  const db = await runtime.request('get');
  const payload = { reportId, targetId: '900', incidents: [{ id: '800' }], ...M.triageBase(db, reportId, [{ id: '800' }]) };
  const other = await runtime.request('create-report', { fields: { name: 'Other report' } });
  await link(runtime, reportId, '700', ['123']); // A child moved away while the picker was open.
  await link(runtime, reportId, '800', ['789']); // A new child joined the summary.
  await runtime.request('save', { reportId, incidentId: '800', patch: { notes: 'Latest source analysis' }, base: { notes: 'Source analysis' } });
  await runtime.request('save', { reportId, incidentId: '900', patch: { notes: 'Latest target analysis' }, base: { notes: 'Manual analysis' } });
  await runtime.request('ignore', { reportId, incidentId: '456', ignored: true });
  await runtime.request('link-incidents', payload);
  let merged = await runtime.request('get'); const report = M.currentReport(merged, reportId);
  assert.deepEqual(M.relatedEntries(report, '900').map(entry => entry.id), ['456', '789', '800']);
  assert.equal(report.entries['123'].summaryIncidentId, '700');
  assert.equal(report.entries['900'].notes, 'Latest target analysis\nLatest source analysis');
  assert.equal(M.isIgnored(merged, '456'), true);
  assert.deepEqual(M.currentReport(merged, other.activeReportId), structuredClone(M.currentReport(other)));
  await link(runtime, reportId, '700', ['900']); // A second merge stays flat.
  await runtime.request('save', { reportId, incidentId: '600', patch: { tracked: true } });
  merged = await runtime.request('get');
  assert.deepEqual(M.relatedEntries(M.currentReport(merged, reportId), '700').map(entry => entry.id), ['123', '456', '789', '800', '900']);
  await assert.rejects(runtime.request('link-incidents', { ...payload, targetId: '600' }), /another window/);
  assert.deepEqual(await runtime.request('get'), merged);
});

test('note append preserves concurrent manual edits and rejects stale note replacement', async () => {
  const { runtime, reportId } = await setup();
  await runtime.request('save', { reportId, incidentId: '123', patch: { notes: 'A' } });
  await runtime.request('save', { reportId, incidentId: '456', patch: { notes: 'B' } });
  // Both link requests can read the same old target; the append uses the latest
  // target when each queued operation executes, preserving the manual addition.
  await Promise.all([
    runtime.request('save', { reportId, incidentId: '900', patch: { notes: 'Manual analysis\nManual addition' }, base: { notes: 'Manual analysis' } }),
    link(runtime, reportId, '900', ['123']), link(runtime, reportId, '900', ['456']),
  ]);
  const report = M.currentReport(await runtime.request('get'));
  assert.equal(report.entries['900'].notes, 'Manual analysis\nManual addition\nA\nB');
  await assert.rejects(runtime.request('save', { reportId, incidentId: '900', patch: { notes: 'Old draft' }, base: { notes: 'Manual analysis' } }), /Notes changed/);
  assert.equal(M.currentReport(await runtime.request('get')).entries['900'].notes, report.entries['900'].notes);
});

test('link and Notes append commit atomically on failed storage, retry, and combined length limit', async () => {
  const { runtime, reportId } = await setup();
  await runtime.request('save', { reportId, incidentId: '123', patch: { notes: 'Keep source', tracked: true } });
  runtime.failWrites(); await assert.rejects(link(runtime, reportId, '900', ['123']), /quota/);
  runtime.failWrites(false);
  let report = M.currentReport(await runtime.request('get'));
  assert.equal(report.entries['900'].notes, 'Manual analysis');
  assert.equal(report.entries['123'].tracked, true); assert.equal(report.entries['123'].summaryIncidentId, undefined);
  await link(runtime, reportId, '900', ['123']);
  await link(runtime, reportId, '900', ['123'], { baseTargets: { 123: '' }, baseTracked: { 123: true } });
  report = M.currentReport(await runtime.request('get'));
  assert.equal(report.entries['900'].notes, 'Manual analysis\nKeep source');
  await runtime.request('save', { reportId, incidentId: '456', patch: { notes: 'x'.repeat(20000), tracked: true } });
  await assert.rejects(link(runtime, reportId, '900', ['789', '456']), /Notes is too long/);
  report = M.currentReport(await runtime.request('get'));
  assert.equal(report.entries['900'].notes, 'Manual analysis\nKeep source');
  assert.equal(report.entries['456'].tracked, true); assert.equal(report.entries['456'].notes.length, 20000);
  assert.equal(report.entries['789'], undefined);
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

test('linked selections without a native checkbox stay visible as a fallback, and untracking or ignoring the summary returns children', async t => {
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

test('dashboard Link to and Related ICMs both merge an existing summary with its children', async t => {
  for (const action of ['Link to', 'Related ICMs']) {
    await t.test(action, async t => {
      const { runtime, reportId } = await setup();
      await runtime.request('save', { reportId, incidentId: '800', patch: { tracked: true, notes: 'Source analysis' } });
      await link(runtime, reportId, '800', ['123', '456']);
      const page = loadPage(runtime, { dashboard: true }); t.after(page.close);
      const $ = selector => page.document.querySelector(selector);
      await waitFor(() => $('[aria-label="Link incident 800 to another tracked incident"]'));
      if (action === 'Link to') {
        $('[aria-label="Link incident 800 to another tracked incident"]').click();
        assert.match($('.ico-overlay').textContent, /Existing related ICMs move with their summary/);
        $('.ico-summary-choice[data-incident-id="900"]').click();
        await waitFor(() => !$('.ico-overlay'));
      } else {
        $('[aria-label="Related ICMs for incident 900"]').click();
        const input = $('[name="relatedIncidents"]'); input.value = '800';
        input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
        $('.ico-editor-form').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
        await waitFor(() => $('.ico-related-list').children.length === 3);
        assert.equal(input.value, '');
      }
      assert.equal(page.document.querySelectorAll('#incidents tr').length, 1);
      assert.equal($('[aria-label="Related ICMs for incident 900"]').textContent, 'Related ICMs (3)');
      const report = M.currentReport(await runtime.request('get'));
      assert.deepEqual(M.relatedEntries(report, '900').map(entry => entry.id), ['123', '456', '800']);
      assert.equal(report.entries['900'].notes, 'Manual analysis\nSource analysis');
    });
  }
});

test('bulk ID input rejects non-ICM URLs and ignores duplicates', () => {
  assert.deepEqual(M.parseIncidentIds(`123, #123; ${M.incidentUrl('456')}\n789`), ['123', '456', '789']);
  for (const value of ['', '123 bad-id', 'https://example.com/imp/v5/incidents/details/123', 'javascript:alert(1)']) assert.throws(() => M.parseIncidentIds(value));
});
