const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./model');
const { createRuntime, loadPage, waitFor } = require('./test/runtime');

async function dashboard(t, entries) {
  const runtime = createRuntime(); const db = await runtime.request('get');
  const report = M.currentReport(db);
  report.entries = Object.fromEntries(entries.map((entry, index) => [entry.id, { ...M.emptyEntry(entry.id), tracked: true, trackedAt: index + 1, ...entry }]));
  await runtime.chrome.storage.local.set({ [M.STORAGE_KEY]: db });
  const page = loadPage(runtime, { dashboard: true }); t.after(page.close);
  await waitFor(() => !page.document.getElementById('search').disabled);
  const $ = selector => page.document.querySelector(selector);
  const ids = () => [...page.document.querySelectorAll('#incidents tr')].map(row => row.dataset.incidentId);
  const input = value => { $('#search').value = value; $('#search').dispatchEvent(new page.window.Event('input')); };
  const sort = key => $(`[data-sort="${key}"]`).click();
  return { runtime, reportId: report.id, page, $, ids, input, sort };
}

test('dashboard sorts columns naturally, keeps unknown values last and restores tracking order without saving', async t => {
  const { runtime, $, ids, sort } = await dashboard(t, [
    { id: '90071992547409933', day: '2026-11-18', severity: '10', title: 'worker 10' },
    { id: '90071992547409932', day: '2026-11-09', severity: '2', title: 'Worker 2' },
    { id: '9', day: 'Unknown', severity: 'Unknown', title: '' }
  ]);
  const writes = runtime.writes.length;
  assert.deepEqual(ids(), ['9', '90071992547409932', '90071992547409933']);
  for (const key of ['day', 'severity', 'title']) {
    sort(key);
    assert.deepEqual(ids(), ['90071992547409932', '90071992547409933', '9']);
    assert.equal($(`[data-sort="${key}"]`).closest('th').getAttribute('aria-sort'), 'ascending');
    sort(key);
    assert.deepEqual(ids(), ['90071992547409933', '90071992547409932', '9']);
    assert.equal($(`[data-sort="${key}"]`).closest('th').getAttribute('aria-sort'), 'descending');
  }
  sort('id'); assert.deepEqual(ids(), ['9', '90071992547409932', '90071992547409933']);
  sort('id'); assert.deepEqual(ids(), ['90071992547409933', '90071992547409932', '9']);
  assert.equal($('#incidents tr:last-child .incident-created').textContent, '');
  $('#reset-sort').click();
  assert.deepEqual(ids(), ['9', '90071992547409932', '90071992547409933']);
  assert.equal(runtime.writes.length, writes);
});

test('full-text search finds multiple keywords, safe literal matches and related incidents beyond the preview limit', async t => {
  const { $, ids, input } = await dashboard(t, [
    { id: '100', title: 'Worker <img src=x onerror=alert(1)> failure', notes: 'Background context. '.repeat(30) + 'Retry failed with (Timeout+)', day: '2026-11-18', errorMessage: 'SocketClosed' },
    { id: '200', title: 'Deployment failure', notes: 'Timeout' },
    ...Array.from({ length: 6 }, (_, index) => ({ id: String(301 + index), tracked: false, summaryIncidentId: '100', title: index === 5 ? 'Rotated credential' : '' }))
  ]);
  input(' WORKER   (timeout+) 2026-11-18 ');
  assert.deepEqual(ids(), ['100']);
  assert.match($('#incidents .summary-text').textContent, /\(Timeout\+\)/);
  assert.equal($('#incidents img'), null);
  assert.ok([...$('#incidents').querySelectorAll('mark')].some(mark => mark.textContent === '(Timeout+)'));
  input('worker SocketClosed'); assert.deepEqual(ids(), ['100']);
  assert.match($('#incidents .search-detail').textContent, /Error message: SocketClosed/);
  for (const value of ['#306', '#306 worker', M.incidentUrl('306'), 'worker rotated']) {
    input(value); assert.deepEqual(ids(), ['100']);
    assert.equal($('#incidents .related-incident-links a').textContent, '#306');
  }
  input(`${M.incidentUrl('306')} worker`); assert.deepEqual(ids(), ['100']);
  input(`${M.incidentUrl('306')} deployment`); assert.deepEqual(ids(), []);
  input('['); assert.deepEqual(ids(), []); assert.equal($('#no-results').hidden, false);
  $('#clear-search').click(); assert.deepEqual(ids(), ['200', '100']); assert.equal($('#no-results').hidden, true);
});

test('search, Needs summary and sorting survive cross-tab updates and preserve the editor target', async t => {
  const { runtime, reportId, page, $, ids, input, sort } = await dashboard(t, [
    { id: '100', title: 'Worker B', rootCause: '', notes: 'Existing manual notes' },
    { id: '200', title: 'Worker A', rootCause: 'Confirmed', resolution: 'Recovered' },
    { id: '300', title: 'Other incident' },
    { id: '400', title: 'Worker C' }
  ]);
  sort('title'); input('worker');
  $('#filter').value = 'incomplete'; $('#filter').dispatchEvent(new page.window.Event('change'));
  assert.deepEqual(ids(), ['100', '400']);
  await runtime.request('save', { reportId, incidentId: '400', patch: { title: 'Worker A' } });
  assert.deepEqual(ids(), ['400', '100']); assert.equal($('#search').value, 'worker');
  $('[aria-label="Edit notes for incident 100"]').click();
  assert.match($('.ico-editor[role="dialog"]').textContent, /100/);
  assert.equal($('[name="notes"]').value, 'Existing manual notes');
  assert.equal($('#search').value, 'worker');
});

test('search shortcuts focus and clear the report search without interfering with typing', async t => {
  const { page, $, input } = await dashboard(t, [{ id: '100', title: 'Worker' }]);
  const key = (target, value) => target.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  key(page.document.body, '/'); assert.equal(page.document.activeElement, $('#search'));
  input('worker'); key($('#search'), 'Escape'); assert.equal($('#search').value, '');
  $('#add-id').focus(); key($('#add-id'), '/'); assert.equal(page.document.activeElement, $('#add-id'));
});
