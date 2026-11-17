const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./model');
const { createRuntime, loadPage, waitFor } = require('./test/runtime');

async function fixture(t, { asyncRender = false, stuckId } = {}) {
  const runtime = createRuntime(); const { activeReportId: reportId } = await runtime.request('get');
  for (const id of ['200', '900']) await runtime.request('save', { reportId, incidentId: id, patch: { tracked: true } });
  await runtime.request('ignore', { reportId, incidentId: '300', ignored: true });
  await runtime.request('link-incidents', { reportId, targetId: '900', incidents: [{ id: '400' }], baseTargets: { 400: '' }, baseTracked: { 400: false }, baseIgnored: { 400: false } });
  await runtime.request('list-preferences', { patch: { hideMitigated: true } });
  const ids = ['100', '200', '300', '400', '500', '600'];
  const page = loadPage(runtime, { html: `<div class="ms-DetailsList" role="grid" tabindex="0"><div class="ms-DetailsHeader" role="row"><div role="columnheader"><div role="checkbox" data-selection-toggle="true" aria-label="Toggle selection for all items" aria-checked="false" tabindex="0"></div></div></div><input aria-label="Search list"><div class="ms-List">${ids.map(id => `<div class="ms-List-cell"><div class="ms-DetailsRow" role="row" aria-selected="false" data-id="${id}"><div role="gridcell" data-selection-toggle="true"><div role="checkbox" data-selection-toggle="true" aria-label="select the row" aria-checked="false"></div></div><div role="gridcell" data-automation-key="Title"><a href="${M.incidentUrl(id)}">Incident ${id}</a></div><div data-automation-key="State">${id === '500' ? 'Mitigated' : 'Active'}</div></div></div>`).join('')}</div></div><div role="menubar" aria-label="Bulk actions"><button id="native-action">Native test action</button></div><output id="native-count">0</output>` });
  t.after(page.close);
  const $ = selector => page.document.querySelector(selector);
  const row = id => $(`[data-id="${id}"]`);
  const checkbox = id => row(id).querySelector('[role="checkbox"]');
  const header = $('.ms-DetailsHeader [role="checkbox"]');
  const model = new Set(); let headerCalls = 0, actionCalls = 0, cancelClicks = 0, shiftHeld = false;
  $('.ms-DetailsList').addEventListener('mousedown', event => { shiftHeld = event.shiftKey; }, true);
  const setAttribute = (element, key, value) => { if (element.getAttribute(key) !== value) element.setAttribute(key, value); };
  function render() {
    for (const id of ids) {
      setAttribute(row(id), 'aria-selected', String(model.has(id)));
      setAttribute(checkbox(id), 'aria-checked', String(model.has(id)));
    }
    setAttribute(header, 'aria-checked', model.size === ids.length ? 'true' : model.size ? 'mixed' : 'false');
    $('#native-count').textContent = String(model.size);
  }
  function update(selected) { model.clear(); selected.forEach(id => model.add(id)); render(); }
  for (const id of ids) checkbox(id).addEventListener('click', event => {
    if (model.has(id) && !event.shiftKey && !shiftHeld) cancelClicks++;
    if (id === stuckId) return;
    if (event.shiftKey || shiftHeld) { ids.slice(0, ids.indexOf(id) + 1).forEach(item => model.add(item)); }
    else if (model.has(id)) model.delete(id); else model.add(id);
    if (asyncRender) page.window.setTimeout(render, 0); else render();
  });
  header.addEventListener('click', () => { headerCalls++; update(model.size === ids.length ? [] : ids); });
  $('.ms-DetailsList').addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === 'a' && event.target.tagName !== 'INPUT') { headerCalls++; update(ids); }
  });
  $('#native-action').addEventListener('click', () => { actionCalls++; });
  await waitFor(() => page.document.querySelectorAll('.ico-row-hidden').length === 4);
  return { runtime, page, $, ids, row, checkbox, header, model, update,
    get headerCalls() { return headerCalls; }, get actionCalls() { return actionCalls; }, get cancelClicks() { return cancelClicks; } };
}

test('native select-all selects only visible incidents and a second mixed-header click clears them', async t => {
  const h = await fixture(t);
  h.header.click();
  await waitFor(() => h.$('.ico-selected-count').textContent === '2 selected');
  assert.deepEqual([...h.model], ['100', '600']); assert.equal(h.$('#native-count').textContent, '2');
  assert.equal(h.headerCalls, 0); assert.equal(h.header.getAttribute('aria-checked'), 'mixed');
  assert.equal(h.page.document.querySelectorAll('.ico-row-hidden').length, 4);
  h.header.click(); await waitFor(() => h.model.size === 0 && h.$('.ico-selected-count').textContent === '0 selected');
  h.header.dispatchEvent(new h.page.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  await waitFor(() => h.model.size === 2);
  h.$('#native-action').click(); assert.equal(h.actionCalls, 1);
});

test('range selection removes tracked, ignored, linked and mitigated rows from the native model before bulk actions', async t => {
  const h = await fixture(t, { asyncRender: true });
  h.checkbox('600').dispatchEvent(new h.page.window.MouseEvent('mousedown', { shiftKey: true, bubbles: true }));
  h.checkbox('600').dispatchEvent(new h.page.window.MouseEvent('click', { shiftKey: true, bubbles: true }));
  await waitFor(() => h.model.size === 2 && h.$('#native-count').textContent === '2' && h.$('.ico-selected-count').textContent === '2 selected');
  assert.deepEqual([...h.model], ['100', '600']); assert.equal(h.cancelClicks, 4);
  assert.equal(h.page.document.querySelectorAll('.ico-row-hidden').length, 4);
  assert.equal(h.page.document.querySelectorAll('.ico-row-hidden[aria-selected="true"]').length, 0);
  h.$('#native-action').click(); assert.equal(h.actionCalls, 1);
  // A second range selection is reconciled too, rather than inheriting a stale guard.
  h.checkbox('600').dispatchEvent(new h.page.window.MouseEvent('mousedown', { shiftKey: true, bubbles: true }));
  h.checkbox('600').dispatchEvent(new h.page.window.MouseEvent('click', { shiftKey: true, bubbles: true }));
  await waitFor(() => h.cancelClicks === 8 && h.model.size === 2);
});

test('Ctrl+A is scoped to the list, preserves text selection, and explicit Show filters permit selecting those incidents', async t => {
  const h = await fixture(t);
  const shortcut = () => new h.page.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
  const typing = shortcut(); h.$('input').dispatchEvent(typing);
  assert.equal(typing.defaultPrevented, false); assert.equal(h.model.size, 0);
  h.$('.ms-DetailsList').dispatchEvent(shortcut()); await waitFor(() => h.model.size === 2);
  h.$('.ms-DetailsList').dispatchEvent(shortcut()); assert.equal(h.model.size, 2);
  assert.equal(h.headerCalls, 0);
  await h.runtime.request('list-preferences', { patch: { showTracked: true, showIgnored: true, hideMitigated: false } });
  h.header.click(); await waitFor(() => h.model.size === 6 && h.$('.ico-selected-count').textContent === '6 selected');
  assert.equal(h.headerCalls, 1); assert.equal(h.page.document.querySelectorAll('.ico-row-hidden').length, 0);
  // Turning a filter back on removes that incident from both selections.
  await h.runtime.request('list-preferences', { patch: { hideMitigated: true } });
  await waitFor(() => !h.model.has('500') && h.$('.ico-selected-count').textContent === '5 selected');
});

test('if native deselection fails, the row is visible, excluded from extension batches and blocks native bulk actions', async t => {
  const h = await fixture(t, { stuckId: '200' });
  h.update(['100', '200']);
  await waitFor(() => !h.row('200').classList.contains('ico-row-hidden') && h.$('.ico-selected-count').textContent === '1 selected');
  assert.equal(h.cancelClicks, 1);
  h.$('#native-action').click(); assert.equal(h.actionCalls, 0);
  assert.ok(h.$('.ico-toast.ico-error'));
  assert.equal(h.cancelClicks, 1); // No repeating toggle loop.
  await h.runtime.request('list-preferences', { patch: { showTracked: true } });
  h.$('#native-action').click(); assert.equal(h.actionCalls, 1);
});

test('a bulk click before the selection observer runs still excludes filtered IDs, including an entirely hidden page', async t => {
  const h = await fixture(t);
  h.checkbox('100').click(); await waitFor(() => h.$('.ico-selected-count').textContent === '1 selected');
  h.update(h.ids); // Native range update, immediately followed by the bulk click.
  h.$('[data-action="ignore-selected"]').click();
  await waitFor(() => h.$('.ico-bulk-status').textContent === '2 ignored.');
  const db = await h.runtime.request('get');
  assert.deepEqual(M.ignoredEntries(db).map(item => item.id).sort(), ['100', '300', '600']);
  assert.equal(M.currentReport(db).entries['200'].tracked, true);
  assert.equal(M.currentReport(db).entries['400'].summaryIncidentId, '900');
  await waitFor(() => h.model.size === 0 && h.page.document.querySelectorAll('.ico-row-hidden').length === 6);
  h.header.click();
  assert.equal(h.headerCalls, 0); assert.equal(h.model.size, 0);
});
