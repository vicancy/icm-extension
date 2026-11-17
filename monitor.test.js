const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const M = require('./monitor');
const { waitFor } = require('./test/runtime');

test('Monitor search encodes the whole selection into q on the fixed trusted site', () => {
  const query = '/subscriptions/example/resourceGroups/rg/providers/Microsoft.SignalRService/SignalR/name & date=old#fragment';
  const url = new URL(M.searchUrl(`  ${query}  `));
  assert.equal(url.origin, 'https://srprodmonitor.azurewebsites.net');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('q'), query);
  assert.equal(url.searchParams.size, 1);
  assert.equal(url.hash, '');
  assert.throws(() => M.searchUrl('line 1\nline 2'), /one resource/);
  assert.throws(() => M.searchUrl(' '), /one resource/);
  assert.throws(() => M.searchUrl('x'.repeat(2049)), /2,048/);
});

function chromeFixture({ failOpen = false } = {}) {
  const stored = {}, createdTabs = [], openedPanels = [], registrations = [];
  let click, installed, resolveStorage;
  const chrome = {
    runtime: { getURL: name => `chrome-extension://test/${name}`, onInstalled: { addListener: fn => { installed = fn; } } },
    contextMenus: {
      update(id, options, callback) { chrome.runtime.lastError = { message: 'Not found' }; callback(); delete chrome.runtime.lastError; },
      create(options, callback) { registrations.push(options); callback(); },
      onClicked: { addListener: fn => { click = fn; } },
    },
    storage: { session: { set(values) { Object.assign(stored, values); return new Promise(resolve => { resolveStorage = resolve; }); } } },
    sidePanel: { async open(options) { openedPanels.push(options); if (failOpen) throw new Error('Unsupported panel'); } },
    tabs: { async create(options) { createdTabs.push(options); } },
  };
  M.install(chrome);
  return { chrome, stored, createdTabs, openedPanels, registrations, click: (...args) => click(...args), installed: () => installed(), resolveStorage: () => resolveStorage?.() };
}

test('context menu opens the side panel in the original click gesture and scopes selection to its window', async () => {
  const fixture = chromeFixture();
  assert.deepEqual(fixture.registrations[0], { id: M.MENU_ID, title: 'Search in SignalR Monitor', contexts: ['selection'] });
  const pending = fixture.click({ menuItemId: M.MENU_ID, selectionText: 'my-signalr' }, { windowId: 7 });
  assert.deepEqual(fixture.openedPanels, [{ windowId: 7 }]); // Storage is deliberately still pending.
  assert.equal(fixture.stored[M.storageKey(7)].query, 'my-signalr');
  assert.equal(fixture.stored[M.storageKey(8)], undefined);
  fixture.resolveStorage(); await pending;
  assert.deepEqual(fixture.createdTabs, []);
  await fixture.click({ menuItemId: 'unrelated', selectionText: 'ignored' }, { windowId: 8 });
  assert.equal(fixture.openedPanels.length, 1);
});

test('unavailable side panel falls back to the same Monitor search in a regular tab', async () => {
  const fixture = chromeFixture({ failOpen: true });
  const pending = fixture.click({ menuItemId: M.MENU_ID, selectionText: 'a-resource' }, { windowId: 7 });
  fixture.resolveStorage(); await pending;
  assert.deepEqual(fixture.createdTabs, [{ url: M.searchUrl('a-resource') }]);
  delete fixture.chrome.sidePanel;
  await fixture.click({ menuItemId: M.MENU_ID, selectionText: 'another-resource' }, { windowId: 8 });
  assert.equal(fixture.createdTabs[1].url, M.searchUrl('another-resource'));
});

test('invalid multi-line selections never load Monitor with the selected content', async () => {
  const fixture = chromeFixture();
  const pending = fixture.click({ menuItemId: M.MENU_ID, selectionText: 'resource\naccidental text' }, { windowId: 7 });
  fixture.resolveStorage(); await pending;
  const saved = fixture.stored[M.storageKey(7)];
  assert.match(saved.error, /one resource/);
  assert.equal(saved.query, undefined);
  assert.equal(JSON.stringify(saved).includes('accidental'), false);
  assert.equal(fixture.createdTabs.length, 0);
});

test('panel loads the selected resource, refreshes on later selections and keeps a usable new-tab link', async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, 'monitor-panel.html'), 'utf8'), { url: 'https://extension.test/monitor-panel.html', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  let listener;
  dom.window.chrome = { windows: { async getCurrent() { return { id: 7 }; } }, storage: {
    session: { async get(key) { return { [key]: { query: 'first-resource' } }; } },
    onChanged: { addListener: fn => { listener = fn; } },
  } };
  for (const file of ['monitor.js', 'monitor-panel.js']) dom.window.eval(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  const $ = id => dom.window.document.getElementById(id);
  await waitFor(() => !$('monitor-frame').hidden);
  assert.equal($('monitor-frame').src, M.searchUrl('first-resource'));
  assert.equal($('open-monitor').href, M.searchUrl('first-resource'));
  listener({ [M.storageKey(8)]: { newValue: { query: 'other-window' } } }, 'session');
  assert.equal($('monitor-query').value, 'first-resource');
  listener({ [M.storageKey(7)]: { newValue: { query: 'second-resource' } } }, 'session');
  assert.equal($('monitor-frame').src, M.searchUrl('second-resource'));
  $('monitor-frame').dispatchEvent(new dom.window.Event('load'));
  assert.doesNotMatch($('monitor-status').textContent, /loaded|found|success/i);
  $('monitor-query').value = 'edited-resource';
  $('monitor-search').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal($('open-monitor').href, M.searchUrl('edited-resource'));
  $('monitor-frame').dispatchEvent(new dom.window.Event('error'));
  assert.match($('monitor-status').textContent, /Open in new tab/);
  listener({ [M.storageKey(7)]: { newValue: { error: 'Select one resource name.' } } }, 'session');
  assert.equal($('monitor-frame').hidden, true);
  assert.equal($('monitor-frame').hasAttribute('src'), false);
  assert.equal($('monitor-query').value, '');
});
