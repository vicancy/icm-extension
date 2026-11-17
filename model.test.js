const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const M = require('./model');
const { createRuntime } = require('./test/runtime');

test('only incident IDs and trusted ICM URLs are accepted', () => {
  assert.equal(M.incidentId('123'), '123');
  assert.equal(M.incidentId('https://portal.microsofticm.com/imp/v5/incidents/details/123/summary'), '123');
  for (const value of ['123abc', 'https://example.com/imp/v5/incidents/details/123', 'javascript:alert(1)', '/imp/v5/incidents/queries/my-teams']) assert.equal(M.incidentId(value), null);
  assert.throws(() => M.emptyEntry('__proto__'));
  assert.throws(() => M.emptyEntry(123));
});

test('report export groups related incidents, preserves links and escapes user input', () => {
  const entry = id => ({ ...M.emptyEntry(id), tracked: true, day: '2026-11-16', title: '<img src=x onerror=alert(1)>', summaryGroup: 'Quota issue', rootCause: 'Capacity unavailable', resolution: 'Moved to available capacity', customersImpacted: '2', occurrences: '1', relatedLinks: 'https://example.com/bug?x=1&y=2\njavascript:alert(1)' });
  const first = entry('123'); const second = { ...entry('456'), notes: 'Waiting for team\nFollow up tomorrow' };
  const report = { name: '<script>bad</script>', startDate: '2026-11-16', endDate: '2026-11-22', entries: { 123: first, 456: second, 789: { ...entry('789'), tracked: false } } };
  const output = M.exportReport(report);
  assert.equal(output.count, 1);
  assert.match(output.html, /details\/123\/summary/);
  assert.match(output.html, /details\/456\/summary/);
  assert.doesNotMatch(output.html, /details\/789/);
  assert.doesNotMatch(output.html, /<img|<script|href="javascript:/);
  assert.match(output.html, /Waiting for team<br>Follow up tomorrow/);
  const expectedHeaders = ['Day', 'RP/Runtime', 'Reported by customer', 'Severity', 'Status', '# of customers impacted', '# of occurrence', 'Root cause', 'Bug and/or ICM to external team', 'Error msg', 'Notes'];
  const exported = new JSDOM(output.html);
  assert.deepEqual([...exported.window.document.querySelectorAll('th')].map(cell => cell.textContent), expectedHeaders);
  const cells = [...exported.window.document.querySelectorAll('tbody tr:first-child td')];
  assert.equal(cells.length, expectedHeaders.length);
  assert.equal(cells[0].textContent, '2026-11-16');
  assert.match(cells.at(-1).textContent, /Resolution: Moved to available capacity/);
  assert.match(cells.at(-1).textContent, /Waiting for team/);
  exported.window.close();
  assert.equal(output.csv.replace(/^\uFEFF/, '').split('\r\n')[0], expectedHeaders.map(header => `"${header}"`).join(','));
  assert.ok(output.plain.includes(expectedHeaders.join('\t')));
  assert.match(output.html, /https:\/\/example.com\/bug\?x=1&amp;y=2/);
  // Counts are recorded values, not an unsafe sum of potentially overlapping customers.
  assert.equal((output.html.match(/>2<\/td>/g) || []).length, 1);
});

test('updates reject stale edits on the same field but merge unrelated fields', () => {
  const original = { ...M.emptyEntry('123'), notes: 'New note', status: 'Mitigated' };
  assert.throws(() => M.patchEntry(original, { notes: 'My draft' }, { notes: 'Old note' }), /another window/);
  assert.equal(M.patchEntry(original, { rootCause: 'Capacity' }, { rootCause: '' }).notes, 'New note');
  assert.throws(() => M.patchEntry(original, { rootCause: 'a'.repeat(20001) }), /too long/);
  const legacy = { ...original }; delete legacy.day;
  const withDay = M.patchEntry(legacy, { day: '2026-11-16' }, { day: '' });
  assert.equal(withDay.day, '2026-11-16');
  assert.equal(withDay.notes, original.notes);
  assert.throws(() => M.patchEntry(legacy, { day: 'Mon' }), /ICM creation date/);
});

test('creation dates keep the displayed calendar day and reject impossible dates', () => {
  assert.equal(M.createdDay('2026-11-16 00:30 GMT+8'), '2026-11-16');
  assert.equal(M.createdDay('2026-11-16T00:30:00+08:00'), '2026-11-16');
  for (const value of ['Mon', '2026-02-30', '2026-13-01', '11/16/2026', undefined]) assert.equal(M.createdDay(value), '');
});

test('handoff separates incident links, analysis, evidence and errors, and leaves placeholders blank', () => {
  const entry = { ...M.emptyEntry('123'), tracked: true, title: 'Credential renewal failed', summaryGroup: 'MSI cleanup',
    reportedByCustomer: 'Unknown', customersImpacted: ' Not Established ', occurrences: 'unknown',
    rootCause: 'Cross-tenant move prevented renewal.', resolution: 'Not established',
    notes: 'Analysis is incomplete; impact is unknown.\nCorrelation ID: abc',
    errorMessage: 'CrossTenantCredentialRequestForbidden', relatedLinks: 'Evidence: https://example.com/logs?x=1&y=2' };
  const output = M.exportReport({ name: 'Report', entries: { 123: entry } });
  const document = new JSDOM(output.html); const cells = [...document.window.document.querySelectorAll('td')];
  for (const index of [0, 2, 5, 6]) assert.equal(cells[index].textContent, '');
  assert.equal(cells[7].textContent, entry.rootCause);
  assert.equal(cells[8].textContent, entry.title);
  assert.equal(cells[8].querySelectorAll('a').length, 1);
  assert.equal(cells[8].querySelector('a').href, M.incidentUrl('123'));
  assert.equal(cells[9].textContent, entry.errorMessage);
  assert.match(cells[10].textContent, /impact is unknown/); // Preserve genuine analysis, not just placeholder fields.
  assert.equal(cells[10].querySelector('a').href, 'https://example.com/logs?x=1&y=2');
  assert.doesNotMatch(cells[10].textContent, /Resolution:|MSI cleanup/);
  assert.doesNotMatch(output.csv, /Not Established|Not established|Unknown/);
  assert.doesNotMatch(output.plain, /Not Established|Not established|Unknown/);
  document.window.close();
  const clean = M.patchEntry(entry, { reportedByCustomer: 'Unknown', customersImpacted: 'not established', rootCause: 'Unknown' });
  assert.equal(clean.reportedByCustomer, ''); assert.equal(clean.customersImpacted, ''); assert.equal(clean.rootCause, '');
});

test('concurrent updates are serialized and unrelated old Tag data is preserved', async () => {
  const runtime = createRuntime({ 'icm-incident-tags:incident:123': { tagId: 'legacy' } });
  const db = await runtime.request('get');
  const reportId = db.activeReportId;
  await Promise.all([
    runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true, rootCause: 'A capacity limit' } }),
    runtime.request('save', { reportId, incidentId: '123', patch: { notes: 'Escalated to the owning team' } }),
    runtime.request('save', { reportId, incidentId: '456', patch: { tracked: true } })
  ]);
  const report = M.currentReport(await runtime.request('get'));
  assert.equal(report.entries['123'].rootCause, 'A capacity limit');
  assert.equal(report.entries['123'].notes, 'Escalated to the owning team');
  assert.equal(M.trackedEntries(report).length, 2);
  assert.deepEqual(runtime.data['icm-incident-tags:incident:123'], { tagId: 'legacy' });
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: false } });
  assert.equal(M.currentReport(await runtime.request('get')).entries['123'].notes, 'Escalated to the owning team');
});

test('failed writes do not corrupt saved records or block later saves', async () => {
  const runtime = createRuntime(); const db = await runtime.request('get');
  const args = { reportId: db.activeReportId, incidentId: '123', patch: { tracked: true, notes: 'Keep this' } };
  runtime.failWrites(); await assert.rejects(runtime.request('save', args), /quota/);
  assert.equal(M.currentReport(await runtime.request('get')).entries['123'], undefined);
  runtime.failWrites(false); await runtime.request('save', args);
  assert.equal(M.currentReport(await runtime.request('get')).entries['123'].notes, 'Keep this');
});

test('observed metadata updates tracked incidents without changing private notes', async () => {
  const runtime = createRuntime(); const db = await runtime.request('get'); const reportId = db.activeReportId;
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true, notes: 'Wait', rootCause: 'Unknown', status: 'Active' } });
  await runtime.request('observe', { reportId, snapshots: [{ id: '123', status: 'Mitigated', notes: 'Do not overwrite' }, { id: '456', title: 'Untracked' }] });
  const report = M.currentReport(await runtime.request('get'));
  assert.equal(report.entries['123'].status, 'Mitigated'); assert.equal(report.entries['123'].notes, 'Wait');
  assert.equal(report.entries['456'], undefined);
});

test('queued observations preserve concurrently saved fields and still merge unrelated metadata', async () => {
  const runtime = createRuntime(); const reportId = (await runtime.request('get')).activeReportId;
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true, status: 'Active', notes: 'Private analysis' } });
  await Promise.all([
    runtime.request('save', { reportId, incidentId: '123', patch: { status: 'Resolved' }, base: { status: 'Active' } }),
    runtime.request('observe', { reportId, snapshots: [{ id: '123', status: 'Mitigated', day: '2026-11-16' }], base: { 123: { status: 'Active', day: '' } } }),
  ]);
  const entry = M.currentReport(await runtime.request('get')).entries['123'];
  assert.equal(entry.status, 'Resolved'); assert.equal(entry.day, '2026-11-16'); assert.equal(entry.notes, 'Private analysis');
});

test('reports keep separate records and imports never overwrite existing reports', async () => {
  const runtime = createRuntime(); const first = await runtime.request('get');
  await runtime.request('save', { reportId: first.activeReportId, incidentId: '123', patch: { tracked: true, notes: 'First rotation' } });
  const backup = await runtime.request('get');
  const second = await runtime.request('create-report', { fields: { name: 'Next rotation', startDate: '2026-11-23', endDate: '2026-11-29' } });
  assert.equal(Object.keys(M.currentReport(second).entries).length, 0);
  await runtime.request('import', { data: backup });
  const restored = await runtime.request('get');
  assert.equal(restored.reports.length, 3);
  assert.equal(restored.reports[0].entries['123'].notes, 'First rotation');
  assert.equal(restored.reports[2].entries['123'].notes, 'First rotation');
  assert.notEqual(restored.reports[0].id, restored.reports[2].id);
  assert.equal(restored.activeReportId, second.activeReportId);
  await assert.rejects(runtime.request('create-report', { fields: { name: 'Invalid', startDate: '2026-12-01', endDate: '2026-11-01' } }), /end date/);
});

test('CSV exports neutralize formulas and invalid report dates have a useful error', () => {
  const entry = { ...M.emptyEntry('123'), tracked: true, notes: ' \t=HYPERLINK("https://example.com")' };
  const csv = M.exportReport({ name: 'Report', entries: { 123: entry } }).csv;
  assert.ok(csv.includes('"\' \t=HYPERLINK(""https://example.com"")"'));
  for (const date of ['2026-13-01', '2026-02-30', 'not-a-date']) {
    assert.throws(() => M.reportFields({ name: 'Report', startDate: date }), /valid report dates/);
  }
});
