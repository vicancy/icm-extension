const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');

function createRuntime(initial = {}, options = {}) {
  const data = structuredClone(initial);
  const listeners = new Set();
  const messages = [];
  const writes = [];
  const tabs = [];
  let handler;
  let failWrites = false;
  const chrome = {
    runtime: { id: options.extensionId || 'test-extension', getURL: name => `chrome-extension://test-extension/${name}`,
      onMessage: { addListener: fn => { handler = fn; } },
      sendMessage: message => new Promise(resolve => {
        messages.push(structuredClone(message));
        handler(message, { id: chrome.runtime.id }, resolve);
      })
    },
    storage: {
      local: {
        async get(key) { return structuredClone(key ? { [key]: data[key] } : data); },
        async set(values) {
          if (failWrites) throw new Error('Storage quota exceeded');
          const changes = {};
          for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
          writes.push(structuredClone(values));
          for (const listener of listeners) listener(structuredClone(changes), 'local');
        }
      },
      onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
    },
    tabs: { async create(options) { tabs.push(options); } },
    action: { onClicked: { addListener() {} } }
  };
  const context = vm.createContext({ chrome, crypto, URL, console, Date, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval, WebSocket: options.WebSocket });
  context.importScripts = (...names) => names.forEach(name => {
    if (name === 'bridge-config.js') { if (options.bridgeConfig) context.IcmBridgeConfig = options.bridgeConfig; return; }
    vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const request = async (type, payload = {}) => {
    const response = await chrome.runtime.sendMessage({ type: `oncall:${type}`, ...payload });
    if (!response.ok) throw new Error(response.error);
    return response.data;
  };
  // Lexical declarations are accessed inside the VM, just like service-worker callbacks.
  const invokeAgent = async request => {
    context.testAgentRequest = structuredClone(request);
    return vm.runInContext('((request) => enqueue(() => agentApi(request)))(testAgentRequest)', context);
  };
  return { data, chrome, request, agentRequest: invokeAgent, messages, writes, tabs, failWrites(value = true) { failWrites = value; }, stop() { vm.runInContext('agentBridge?.stop()', context); } };
}

function loadPage(runtime, { html, url = 'https://portal.microsofticm.com/imp/v5/incidents/queries/my-teams', embedded = false, dashboard = false, ignored = false } = {}) {
  const content = html || (dashboard || ignored ? fs.readFileSync(path.join(root, ignored ? 'ignored.html' : 'dashboard.html'), 'utf8') : `<!doctype html><title>Incident Queries - IcM</title><div role="grid"><div class="ms-DetailsHeader" role="row"><div role="columnheader" data-item-key="Title">Title</div></div><div class="ms-DetailsRow" role="row"><div role="gridcell" data-automation-key="Title"><span><a href="https://portal.microsofticm.com/imp/v5/incidents/details/123">A sample incident</a></span></div><div data-automation-key="Severity">3</div><div data-automation-key="State">Active</div></div></div>`);
  const dom = new JSDOM(content, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  if (embedded) dom.reconfigure({ windowTop: {} });
  const registered = [];
  dom.window.chrome = { ...runtime.chrome, storage: { ...runtime.chrome.storage, onChanged: { addListener(fn) { registered.push(fn); runtime.chrome.storage.onChanged.addListener(fn); } } } };
  dom.window.confirm = () => true;
  for (const file of ['model.js', 'client.js', 'ui.js', ...(ignored ? ['ignored.js'] : dashboard ? ['dashboard.js'] : ['mitigate.js', 'observations.js', 'content.js'])]) dom.window.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  const close = () => { registered.forEach(fn => runtime.chrome.storage.onChanged.removeListener(fn)); dom.window.close(); };
  return { dom, window: dom.window, document: dom.window.document, close };
}

async function waitFor(condition, message = 'condition did not become true') {
  for (let i = 0; i < 150; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
}

module.exports = { createRuntime, loadPage, waitFor, root };
