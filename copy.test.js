const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const M = require('./model');
const { createRuntime, loadPage, waitFor } = require('./test/runtime');

const entry = (id, trackedAt, fields = {}) => ({ ...M.emptyEntry(id), tracked: true, trackedAt, title: `Incident ${id}`, day: '2026-11-17', ...fields });
const report = entries => ({ name: 'Daily handoff', startDate: '2026-11-16', endDate: '2026-11-22', entries: Object.fromEntries(entries.map(item => [item.id, item])) });
const click = element => element.dispatchEvent(new element.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
const input = (page, id, value) => { const element = page.document.getElementById(id); element.value = value; element.dispatchEvent(new page.window.Event('input')); };

test('headerless exports contain only data rows with the same columns, dates, notes and incident links', t => {
  const source = report([entry('123', 1, { title: '<Incident>', resolution: 'Recovered', notes: 'First line\nSecond line' }),
    entry('456', 2, { tracked: false, summaryIncidentId: '123' })]);
  const output = M.exportReport(source, { includeHeaders: false });
  const dom = new JSDOM(output.html); t.after(() => dom.window.close());
  const d = dom.window.document; const cells = [...d.querySelectorAll('td')];
  assert.equal(d.querySelectorAll('h2, p, thead, th').length, 0);
  assert.equal(d.querySelectorAll('tr').length, 1); assert.equal(cells.length, 11);
  assert.equal(cells[0].textContent, '2026-11-17');
  assert.deepEqual([...cells[8].querySelectorAll('a')].map(link => [link.textContent, link.href]), [['<Incident>', M.incidentUrl('123')], ['456', M.incidentUrl('456')]]);
  assert.match(cells[10].textContent, /Resolution: Recovered/); assert.match(output.html, /First line<br>Second line/);
  assert.equal(output.plain.split('\n').length, 1); assert.equal(output.plain.split('\t').length, 11);
  assert.ok(output.plain.startsWith('2026-11-17\t')); assert.ok(output.csv.startsWith('\uFEFF"2026-11-17",'));
  for (const value of [output.html, output.plain, output.csv]) assert.doesNotMatch(value, /Daily handoff|Reported by customer|2026-11-22/);
  assert.match(M.exportReport(source).html, /<h2>Daily handoff<\/h2>/);
});

test('copy-after excludes the anchor and older grouped incidents using tracking order, not numeric IDs', t => {
  const anchor = '31000000000123';
  const source = report([entry('90071992547409931', 1), entry(anchor, 2, { summaryGroup: 'Shared', notes: 'Old analysis' }),
    entry('123', 3, { summaryGroup: 'Shared', notes: 'New analysis' }), entry('122', 4, { summaryGroup: 'Shared' }),
    entry('111', 5, { tracked: false, summaryIncidentId: '123' })]);
  const original = JSON.stringify(source);
  for (const afterIncident of [anchor, `#${anchor}`, M.incidentUrl(anchor)]) {
    const output = M.exportReport(source, { afterIncident, includeHeaders: false });
    assert.equal(output.count, 1); assert.equal(output.incidentCount, 2); assert.equal(output.newestIncidentId, '122');
    const dom = new JSDOM(output.html); t.after(() => dom.window.close());
    assert.deepEqual([...dom.window.document.querySelectorAll('a')].map(link => link.textContent), ['Incident 122', 'Incident 123', '111']);
    for (const value of [output.html, output.plain, output.csv]) {
      assert.doesNotMatch(value, /31000000000123|90071992547409931|Old analysis/);
      assert.match(value, /New analysis/);
    }
  }
  assert.equal(JSON.stringify(source), original);
});

test('copy-after validates report membership and handles an empty range and stable timestamp ties', () => {
  const source = report([entry('123', 1), entry('124', 1), entry('125', 2), entry('999', 3, { tracked: false })]);
  assert.deepEqual(M.exportEntries(source, '124').map(item => item.id), ['125', '123']);
  for (const value of ['missing', 'https://example.com/imp/v5/incidents/details/123']) assert.throws(() => M.exportEntries(source, value), /numeric ICM ID/);
  for (const value of ['456', '999']) assert.throws(() => M.exportEntries(source, value), /not a tracked main incident/);
  assert.equal(M.exportReport(source, { afterIncident: '125' }).count, 0);
  assert.equal(M.exportEntries(source, '  ').length, 3);
});

async function dashboard(t) {
  const runtime = createRuntime(); const db = await runtime.request('get');
  Object.assign(M.currentReport(db), report([entry('999', 1), entry('31000000000123', 2), entry('123', 3), entry('122', 4)]));
  await runtime.chrome.storage.local.set({ [M.STORAGE_KEY]: db });
  const page = loadPage(runtime, { dashboard: true }); t.after(page.close);
  const copies = [];
  page.document.execCommand = command => {
    assert.equal(command, 'copy'); const copied = {};
    const event = new page.window.Event('copy', { cancelable: true });
    event.clipboardData = { setData(type, value) { copied[type] = value; } };
    page.document.dispatchEvent(event); copies.push(copied); return true;
  };
  await waitFor(() => page.document.querySelectorAll('#incidents tr').length === 4);
  return { runtime, page, copies };
}

test('both dashboard Copy buttons apply the exclusive range, independently of search filters', async t => {
  const { page, copies } = await dashboard(t); const d = page.document;
  input(page, 'copy-after', '31000000000123'); input(page, 'search', '999');
  assert.equal(d.querySelectorAll('#incidents tr').length, 1);
  assert.match(d.getElementById('copy-range-status').textContent, /2 incidents · 2 rows/);
  for (const button of ['copy', 'copy-without-headers']) {
    click(d.getElementById(button)); await waitFor(() => d.getElementById('copy-range-status').textContent.startsWith('Copied'));
    const copied = copies.at(-1); const exported = new page.window.DOMParser().parseFromString(copied['text/html'], 'text/html');
    assert.equal(exported.querySelectorAll('tbody tr').length, 2);
    assert.equal(exported.querySelectorAll('th').length, button === 'copy' ? 11 : 0);
    assert.equal(exported.querySelectorAll('h2').length, button === 'copy' ? 1 : 0);
    assert.doesNotMatch(copied['text/plain'], /31000000000123|Incident 999/);
    assert.match(copied['text/plain'], /Incident 123/); assert.match(copied['text/plain'], /Incident 122/);
    assert.match(d.getElementById('copy-range-status').textContent, /next batch, copy after #122/);
  }
  assert.equal(copies.length, 2);
  input(page, 'copy-after', ''); click(d.getElementById('copy-without-headers'));
  assert.equal(copies.length, 3); assert.match(copies.at(-1)['text/plain'], /Incident 999/);
});

test('invalid and empty ranges leave the clipboard alone, and switching reports clears the starting ICM', async t => {
  const { runtime, page, copies } = await dashboard(t); const d = page.document;
  for (const value of ['not-an-id', '888', '122']) {
    input(page, 'copy-after', value);
    assert.equal(d.getElementById('copy').disabled, true); assert.equal(d.getElementById('copy-without-headers').disabled, true);
    await assert.rejects(page.window.IcmOncallUI.copyReport(M.currentReport(await runtime.request('get')), { afterIncident: value, includeHeaders: false }));
  }
  assert.equal(copies.length, 0); assert.match(d.getElementById('copy-range-status').textContent, /No newly tracked incidents/);
  input(page, 'copy-after', '999'); assert.equal(d.getElementById('copy').disabled, false);
  assert.equal(d.getElementById('copy-after').hasAttribute('aria-invalid'), false);
  await runtime.request('create-report', { fields: { name: 'Next rotation' } });
  assert.equal(d.getElementById('copy-after').value, ''); assert.equal(d.getElementById('copy').disabled, true);
});

test('rich clipboard failures keep the starting ICM and do not report success', async t => {
  const { page, copies } = await dashboard(t); const d = page.document;
  page.window.ClipboardItem = class { constructor(values) { this.values = values; } };
  Object.defineProperty(page.window.navigator, 'clipboard', { value: { async write() { throw new Error('Clipboard permission denied'); } } });
  input(page, 'copy-after', '31000000000123'); click(d.getElementById('copy-without-headers'));
  await waitFor(() => d.getElementById('copy-range-status').textContent === 'Clipboard permission denied');
  assert.equal(d.getElementById('copy-after').value, '31000000000123'); assert.equal(copies.length, 0);
});
