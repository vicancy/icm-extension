const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readConfig } = require('./config.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(config, route, body) {
  const response = await fetch(`http://127.0.0.1:${config.port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(body ? 20000 : 1500),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `Local API returned ${response.status}`);
  return result;
}
async function ensureServer(config) {
  try { return await request(config, '/v1/status'); }
  catch (error) {
    if (!['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code)) throw error;
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(150);
    try { return await request(config, '/v1/status'); } catch (error) { if (attempt === 19) throw error; }
  }
}
async function call(method, params = {}) {
  const config = readConfig();
  let status = await ensureServer(config);
  for (let attempt = 0; !status.connected && attempt < 20; attempt++) {
    await sleep(500); status = await request(config, '/v1/status');
  }
  if (!status.connected) throw new Error('Bridge is running, but the extension is offline. Reload it in Edge once, then retry.');
  return (await request(config, '/v1/call', { method, params })).result;
}
async function main() {
  const [command, method, file] = process.argv.slice(2);
  if (command === 'status') return ensureServer(readConfig());
  if (command !== 'call' || !method) throw new Error('Usage: node bridge/cli.cjs status | call list_reports | call read_incident|save_incident params.json');
  const params = file ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  return call(method, params);
}
if (require.main === module) main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
module.exports = { call, request };
