const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { readConfig } = require('./config.cjs');
const { createBackupStore } = require('./backup.cjs');
const { MAX_BACKUP_BYTES } = require('../model.js');
const METHODS = new Set(['list_reports', 'read_incident', 'save_incident']);
const MAX_BYTES = 256 * 1024;
function equalSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function createBridgeServer({ token, port = 4176, requestTimeoutMs = 15000, backupPath }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A strong local token is required.');
  let extension = null, extensionId = null;
  const backup = backupPath ? createBackupStore(backupPath) : null;
  const backupStatus = async () => {
    if (!backup) return { state: 'not-installed' };
    try { return { state: 'ready', ...await backup.status() }; }
    catch (error) { return { state: 'error', path: backupPath, error: error.message }; }
  };
  const pending = new Map();
  const sockets = new Set();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BACKUP_BYTES + MAX_BYTES });
  function reply(response, status, value) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
  }
  function finish(id, status, value) {
    const item = pending.get(id); if (!item) return;
    pending.delete(id); clearTimeout(item.timer); reply(item.response, status, value);
  }
  const server = http.createServer(async (request, response) => {
    if (request.headers.host !== `127.0.0.1:${server.address().port}` || request.headers.origin
      || !equalSecret(request.headers.authorization, `Bearer ${token}`)) {
      reply(response, 403, { ok: false, error: 'Local API authentication required.' }); return;
    }
    if (request.method === 'GET' && request.url === '/v1/status') {
      reply(response, 200, { ok: true, connected: extension?.readyState === WebSocket.OPEN, extensionId, localNotesOnly: true, backup: await backupStatus() }); return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/call') {
      reply(response, 404, { ok: false, error: 'Unknown local API route.' }); return;
    }
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
      reply(response, 415, { ok: false, error: 'Use application/json.' }); return;
    }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BYTES) { reply(response, 413, { ok: false, error: 'Request is too large.' }); return; }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || !METHODS.has(input.method) || (input.params !== undefined && (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)))) {
        reply(response, 400, { ok: false, error: 'Unsupported local notes request.' }); return;
      }
      if (extension?.readyState !== WebSocket.OPEN) {
        reply(response, 503, { ok: false, error: 'Extension is offline. Reload the installed extension and keep Edge running.' }); return;
      }
      if (pending.size >= 32) { reply(response, 429, { ok: false, error: 'Too many pending requests.' }); return; }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => finish(id, 504, { ok: false, error: 'Extension did not acknowledge. Save outcome is unconfirmed; read the incident before retrying.' }), requestTimeoutMs);
      pending.set(id, { response, timer });
      response.on('close', () => { const item = pending.get(id); if (item) { clearTimeout(item.timer); pending.delete(id); } });
      extension.send(JSON.stringify({ type: 'request', id, request: input }), error => {
        if (error) finish(id, 503, { ok: false, error: 'Extension disconnected; read the incident before retrying a save.' });
      });
    } catch { reply(response, 400, { ok: false, error: 'Invalid JSON request.' }); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000;
  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin || '';
    if (request.url !== '/extension' || request.headers.host !== `127.0.0.1:${server.address().port}`
      || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || sockets.size >= 8) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wsServer.handleUpgrade(request, socket, head, client => wsServer.emit('connection', client, request));
  });
  wsServer.on('connection', (client, request) => {
    sockets.add(client); let authenticated = false;
    const timer = setTimeout(() => client.close(1008, 'Authentication required'), 5000);
    client.on('error', () => {});
    client.on('message', async raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { client.close(1008, 'Invalid message'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { client.close(1008, 'Invalid message'); return; }
      if (!authenticated) {
        if (message.type !== 'hello' || message.version !== 1 || !equalSecret(message.token, token)
          || `chrome-extension://${message.extensionId}` !== request.headers.origin) {
          client.close(1008, 'Authentication failed'); return;
        }
        if (extension && extension !== client && extension.readyState === WebSocket.OPEN) {
          client.close(1008, 'Another browser profile is already connected'); return;
        }
        clearTimeout(timer); authenticated = true; extension = client; extensionId = message.extensionId;
        const status = await backupStatus();
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'ready', version: 1, backup: status })); return;
      }
      if (message.type === 'ping') { client.send(JSON.stringify({ type: 'pong' })); return; }
      if (message.type === 'backup' && typeof message.id === 'string') {
        let response;
        try {
          if (!backup) throw new Error('Automatic backup is not installed. Run the bridge installer.');
          let result;
          if (message.operation === 'save') result = await backup.save(message.data);
          else if (message.operation === 'read') result = await backup.read();
          else throw new Error('Unknown backup operation.');
          response = { type: 'backup-result', id: message.id, ok: true, result };
        } catch (error) {
          response = { type: 'backup-result', id: message.id, ok: false, code: error.code,
            error: error.code && !['WORKSPACE_MISMATCH', 'INVALID_BACKUP', 'BACKUP_READ_FAILED'].includes(error.code)
              ? `Could not write the backup file (${error.code}). The previous backup is kept.` : error.message };
        }
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(response));
        return;
      }
      if (message.type === 'response' && typeof message.id === 'string') {
        finish(message.id, message.ok === true ? 200 : 409, message.ok === true
          ? { ok: true, result: message.result }
          : { ok: false, error: typeof message.error === 'string' ? message.error : 'Extension rejected the update.' });
      }
    });
    client.on('close', () => {
      clearTimeout(timer); sockets.delete(client);
      if (extension !== client) return;
      extension = null; extensionId = null;
      for (const id of pending.keys()) finish(id, 503, { ok: false, error: 'Extension disconnected; read the incident before retrying a save.' });
    });
  });
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address()); });
    }),
    close: async () => {
      for (const id of pending.keys()) finish(id, 503, { ok: false, error: 'Bridge stopped.' });
      for (const client of sockets) client.terminate();
      wsServer.close(); server.closeIdleConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
if (require.main === module) {
  const bridge = createBridgeServer(readConfig());
  bridge.listen().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => bridge.close().then(() => process.exit()));
}
module.exports = { createBridgeServer };
