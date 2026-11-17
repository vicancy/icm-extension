const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { WebSocket } = require('ws');
const { createBridgeServer } = require('./bridge/server.cjs');
const { create: createClient } = require('./bridge-client');
const { createRuntime, waitFor } = require('./test/runtime');
const TOKEN = 'a'.repeat(64), ID = 'a'.repeat(32);
async function setup(t, options = {}) {
  const bridge = createBridgeServer({ token: TOKEN, port: 0, ...options });
  const { port } = await bridge.listen();
  t.after(() => bridge.close());
  const api = (body, headers = {}) => fetch(`http://127.0.0.1:${port}${body ? '/v1/call' : '/v1/status'}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const socket = () => new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${ID}` });
  return { bridge, port, api, socket };
}
test('local HTTP API rejects missing authentication, website origins and non-note methods', async t => {
  const { api, port } = await setup(t);
  assert.equal((await api(null, { Authorization: '' })).status, 403);
  assert.equal((await api(null, { Origin: 'https://portal.microsofticm.com' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/v1/status', headers: { Host: 'attacker.example', Authorization: `Bearer ${TOKEN}` } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await api({ method: 'mitigate_incident' })).status, 400);
  assert.equal((await api({ method: 'list_reports' })).status, 503);
});
test('unauthenticated extension sockets cannot connect or replace an authenticated profile', async t => {
  const { api, socket } = await setup(t);
  const bad = socket(); await once(bad, 'open'); const rejected = once(bad, 'close');
  bad.send(JSON.stringify({ type: 'hello', version: 1, token: 'wrong', extensionId: ID }));
  assert.equal((await rejected)[0], 1008);
  const good = socket(); await once(good, 'open'); const ready = once(good, 'message');
  good.send(JSON.stringify({ type: 'hello', version: 1, token: TOKEN, extensionId: ID })); await ready;
  const second = socket(); await once(second, 'open'); const refused = once(second, 'close');
  second.send(JSON.stringify({ type: 'hello', version: 1, token: TOKEN, extensionId: ID }));
  assert.equal((await refused)[0], 1008);
  assert.equal((await (await api()).json()).connected, true);
});
test('HTTP through the actual bridge client and service worker persists notes before acknowledging', async t => {
  const { port, api } = await setup(t);
  const runtime = createRuntime();
  class LocalSocket extends WebSocket { constructor() { super(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${ID}` }); } }
  const client = createClient({ config: { url: 'ws://127.0.0.1:4176/extension', token: TOKEN },
    chrome: { runtime: { id: ID } }, WebSocket: LocalSocket, invoke: runtime.agentRequest });
  t.after(() => client.stop()); client.connect();
  await waitFor(() => client.status().state === 'connected');
  const list = await (await api({ method: 'list_reports' })).json();
  const reportId = list.result.activeReportId;
  const saved = await (await api({ method: 'save_incident', params: { reportId, incidentId: '123', fields: { rootCause: 'Cross tenant', resolution: 'Cleaned up' } } })).json();
  assert.equal(saved.ok, true); assert.equal(saved.result.saved, true);
  const read = await (await api({ method: 'read_incident', params: { incidentId: '123', reportId } })).json();
  assert.equal(read.result.entry.resolution, 'Cleaned up');
  assert.equal(runtime.writes.at(-1)['icm-oncall-workspace-v1'].reports[0].entries['123'].rootCause, 'Cross tenant');
  runtime.failWrites();
  const failed = await api({ method: 'save_incident', params: { reportId, incidentId: '456', fields: { notes: 'Must not acknowledge' } } });
  assert.equal(failed.status, 409); assert.equal((await failed.json()).ok, false);
});
test('unacknowledged writes report an uncertain outcome instead of success', async t => {
  const { api, socket } = await setup(t, { requestTimeoutMs: 30 });
  const client = socket(); await once(client, 'open'); const ready = once(client, 'message');
  client.send(JSON.stringify({ type: 'hello', version: 1, token: TOKEN, extensionId: ID })); await ready;
  const response = await api({ method: 'save_incident', params: {} });
  assert.equal(response.status, 504); assert.match((await response.json()).error, /unconfirmed/);
});
