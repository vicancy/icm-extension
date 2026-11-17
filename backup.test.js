const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const M = require('./model');
const { createBackupStore } = require('./bridge/backup.cjs');
const { createBridgeServer } = require('./bridge/server.cjs');
const { installStartup } = require('./bridge/startup.cjs');
const { createRuntime, loadPage, waitFor } = require('./test/runtime');
const TOKEN = 'b'.repeat(64), ID = 'b'.repeat(32);
const fixture = () => ({ version: 1, workspaceId: crypto.randomUUID(), activeReportId: 'report-1',
  reports: [{ id: 'report-1', name: 'Rotation', startDate: '', endDate: '', createdAt: 1, updatedAt: 2,
    entries: { '123': { ...M.emptyEntry('123'), notes: 'Manual analysis\nEvidence kept verbatim.', rootCause: 'Confirmed cause', resolution: 'Recovered', tracked: false } } }],
  ignoredIncidents: { '456': { id: '456', ignored: true, title: 'Buildout', ignoredAt: 3, updatedAt: 3 } }, listPreferences: { showIgnored: true } });
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icm-backup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'oncall-workspace-backup.json') };
}
async function eventually(fn, describe = async () => ({})) {
  for (let i = 0; i < 250; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Backup did not reach the expected state: ${JSON.stringify(await describe())}`);
}
async function readFile(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }
function runtimeAt(port, initial) {
  class LocalSocket extends WebSocket { constructor() { super(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${ID}` }); } }
  return createRuntime(initial, { extensionId: ID, bridgeConfig: { url: 'ws://127.0.0.1:4176/extension', token: TOKEN }, WebSocket: LocalSocket });
}

test('automatic backup keeps one complete latest file, including untracked notes and Ignore decisions', async t => {
  const { directory, file } = await temporary(t); const store = createBackupStore(file); const data = fixture();
  const first = await store.save(data);
  assert.deepEqual(await readFile(file), data);
  assert.equal((await store.save(structuredClone(data))).lastSavedAt, first.lastSavedAt);
  data.reports[0].entries['123'].notes += '\nNew evidence.';
  await store.save(data);
  assert.deepEqual(await readFile(file), data);
  assert.deepEqual(await fs.readdir(directory), ['oncall-workspace-backup.json']);
  assert.equal(M.validateBackup(await readFile(file)).workspaceId, data.workspaceId);
});

test('failed replacement and partial writes leave the previous complete backup intact', async t => {
  const { directory, file } = await temporary(t); const original = fixture();
  await createBackupStore(file).save(original);
  const next = structuredClone(original); next.reports[0].entries['123'].notes = 'New unsynced notes';
  const denied = Object.assign(new Error('Access denied'), { code: 'EACCES' });
  let renameAttempts = 0;
  const renameFailure = createBackupStore(file, { ...fs, rename: async () => { renameAttempts++; throw denied; } }, { platform: 'win32' });
  await assert.rejects(renameFailure.save(next), /Access denied/);
  assert.equal(renameAttempts, 5);
  const partialFailure = createBackupStore(file, { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { writeFile: async () => { await handle.writeFile('{partial'); throw denied; }, close: () => handle.close() };
  } });
  await assert.rejects(partialFailure.save(next), /Access denied/);
  assert.deepEqual(await readFile(file), original);
  assert.deepEqual(await fs.readdir(directory), ['oncall-workspace-backup.json']);
});

test('a transient Windows file lock is retried atomically without losing the previous backup', async t => {
  const { directory, file } = await temporary(t); const original = fixture();
  await createBackupStore(file).save(original);
  const next = structuredClone(original); next.reports[0].entries['123'].notes = 'Saved after the lock is released';
  let attempts = 0;
  const store = createBackupStore(file, { ...fs, rename: async (...args) => {
    attempts++;
    if (attempts <= 2) {
      assert.deepEqual(await readFile(file), original);
      throw Object.assign(new Error('File is temporarily in use'), { code: 'EPERM' });
    }
    return fs.rename(...args);
  } }, { platform: 'win32' });
  await store.save(next);
  assert.ok(attempts >= 3 && attempts <= 5);
  assert.deepEqual(await readFile(file), next);
  assert.deepEqual(await fs.readdir(directory), ['oncall-workspace-backup.json']);
});

test('a different or newly empty workspace cannot overwrite an existing backup; corrupt files are preserved', async t => {
  const { file } = await temporary(t); const store = createBackupStore(file); const original = fixture();
  await store.save(original);
  const fresh = fixture(); fresh.reports[0].entries = {};
  await assert.rejects(store.save(fresh), error => error.code === 'WORKSPACE_MISMATCH');
  assert.deepEqual(await readFile(file), original);
  await fs.writeFile(file, '{unreadable');
  await assert.rejects(store.save(original), /left untouched/);
  assert.equal(await fs.readFile(file, 'utf8'), '{unreadable');
});

test('real service worker backs up successful changes and catches up after the service restarts', async t => {
  const { file } = await temporary(t);
  let server = createBridgeServer({ token: TOKEN, port: 0, backupPath: file });
  const { port } = await server.listen();
  const runtime = runtimeAt(port); t.after(async () => { runtime.stop(); await server.close(); });
  const initial = await runtime.request('get'); const reportId = initial.activeReportId;
  await eventually(async () => (await runtime.request('bridge-status')).backup?.state === 'saved');
  await runtime.request('save', { reportId, incidentId: '123', patch: { tracked: true, notes: 'Saved from dashboard' } });
  await runtime.request('ignore', { reportId, incidentId: '456', ignored: true, title: 'Buildout' });
  await eventually(async () => (await readFile(file))?.ignoredIncidents?.['456']?.ignored);
  assert.equal((await readFile(file)).reports[0].entries['123'].notes, 'Saved from dashboard');
  runtime.failWrites();
  await assert.rejects(runtime.request('save', { reportId, incidentId: '123', patch: { notes: 'Failed browser save' } }), /quota/);
  runtime.failWrites(false);
  assert.equal((await readFile(file)).reports[0].entries['123'].notes, 'Saved from dashboard');
  await server.close();
  await runtime.agentRequest({ method: 'save_incident', params: { reportId, incidentId: '123', fields: { notes: 'Saved while offline' }, base: { notes: 'Saved from dashboard' } } });
  assert.equal((await readFile(file)).reports[0].entries['123'].notes, 'Saved from dashboard');
  server = createBridgeServer({ token: TOKEN, port, backupPath: file }); await server.listen();
  await eventually(async () => { await runtime.request('bridge-status'); return (await readFile(file))?.reports[0].entries['123'].notes === 'Saved while offline'; }, () => runtime.request('bridge-status'));
  assert.deepEqual(await readFile(file), runtime.data[M.STORAGE_KEY]);
});

test('fresh install protects the old backup and explicit recovery preserves new manual notes', async t => {
  const { file } = await temporary(t); const original = fixture();
  await createBackupStore(file).save(original);
  const server = createBridgeServer({ token: TOKEN, port: 0, backupPath: file }); const { port } = await server.listen();
  const runtime = runtimeAt(port); const page = loadPage(runtime, { dashboard: true });
  t.after(async () => { page.close(); runtime.stop(); await server.close(); });
  const db = await runtime.request('get');
  await runtime.request('save', { reportId: db.activeReportId, incidentId: '789', patch: { notes: 'New manual note' } });
  await eventually(async () => (await runtime.request('bridge-status')).backup?.state === 'conflict');
  page.document.querySelector('#agent-status').click();
  await waitFor(() => !page.document.querySelector('#restore-backup').hidden);
  assert.match(page.document.querySelector('#auto-backup-status').textContent, /recovery available/);
  assert.deepEqual(await readFile(file), original);
  page.document.querySelector('#restore-backup').click();
  await eventually(async () => (await readFile(file))?.reports.length === 2, async () => ({
    bridge: await runtime.request('bridge-status'), status: page.document.querySelector('#status').textContent,
    restoreRequested: runtime.messages.some(message => message.type === 'oncall:restore-backup'),
  }));
  const restored = await runtime.request('get');
  assert.equal(restored.workspaceId, original.workspaceId);
  assert.equal(restored.reports[0].entries['789'].notes, 'New manual note');
  assert.equal(restored.reports[1].entries['123'].notes, original.reports[0].entries['123'].notes);
  assert.equal(restored.ignoredIncidents['456'].ignored, true);
  assert.deepEqual(await readFile(file), runtime.data[M.STORAGE_KEY]);
});

test('backups larger than the notes API request limit work and failures appear in the dashboard', async t => {
  const { file } = await temporary(t); const original = fixture();
  for (let id = 1000; id < 1040; id++) original.reports[0].entries[id] = { ...M.emptyEntry(String(id)), notes: 'Evidence '.repeat(1000) };
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 256 * 1024);
  const server = createBridgeServer({ token: TOKEN, port: 0, backupPath: file }); const { port } = await server.listen();
  const runtime = runtimeAt(port, { [M.STORAGE_KEY]: original }); const page = loadPage(runtime, { dashboard: true });
  t.after(async () => { page.close(); runtime.stop(); await server.close(); });
  await eventually(async () => (await runtime.request('bridge-status')).backup?.state === 'saved');
  assert.deepEqual(await readFile(file), original);
  let copied;
  Object.defineProperty(page.window.navigator, 'clipboard', { value: { async writeText(value) { copied = value; } } });
  page.document.querySelector('#agent-status').click();
  await waitFor(() => page.document.querySelector('#auto-backup-path').textContent === file);
  page.document.querySelector('#copy-backup-path').click();
  await waitFor(() => copied === file);
  await fs.writeFile(file, 'do not overwrite corrupt backup');
  await runtime.request('save', { reportId: original.activeReportId, incidentId: '123', patch: { notes: 'Saved locally' } });
  await eventually(async () => (await runtime.request('bridge-status')).backup?.state === 'error');
  page.document.querySelector('#agent-status').click();
  await waitFor(() => page.document.querySelector('#auto-backup-status').textContent.includes('needs attention'));
  assert.match(page.document.querySelector('#auto-backup-detail').textContent, /left untouched/);
  assert.equal((await runtime.request('get')).reports[0].entries['123'].notes, 'Saved locally');
});

test('Windows sign-in launcher runs Node hidden, quotes paths and contains no credentials', async t => {
  const { directory } = await temporary(t);
  const args = { platform: 'win32', appData: directory, node: 'C:\\Program Files\\nodejs\\node.exe', server: 'Q:\\my repo\\bridge\\server.cjs' };
  const file = installStartup(args); const script = await fs.readFile(file, 'utf8');
  assert.match(script, /""C:\\Program Files\\nodejs\\node.exe"" ""Q:\\my repo\\bridge\\server.cjs""/);
  assert.match(script, /, 0, False/);
  assert.doesNotMatch(script, /token|Bearer/);
  assert.equal(installStartup(args), file);
  await fs.writeFile(file, 'manual launcher');
  assert.throws(() => installStartup(args), /left untouched/);
});

test('adding a backup identity never prevents reading existing notes when browser storage is full', async () => {
  const legacy = fixture(); delete legacy.workspaceId;
  const runtime = createRuntime({ [M.STORAGE_KEY]: legacy }); runtime.failWrites();
  const loaded = await runtime.request('get');
  assert.equal(loaded.reports[0].entries['123'].notes, legacy.reports[0].entries['123'].notes);
  assert.equal(runtime.data[M.STORAGE_KEY].workspaceId, undefined);
  runtime.failWrites(false);
  const upgraded = await runtime.request('get');
  assert.equal(M.validWorkspaceId(upgraded.workspaceId), true);
  assert.equal(upgraded.reports[0].entries['123'].notes, legacy.reports[0].entries['123'].notes);
});
