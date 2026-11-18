const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../model');
const { createRuntime, root } = require('./runtime');

async function main() {
  const runtime = createRuntime();
  const initial = await runtime.request('get');
  const reportId = initial.activeReportId;
  await runtime.request('edit-report', { reportId, fields: { name: 'Runtime on-call · Nov 16–22', startDate: '2026-11-16', endDate: '2026-11-22' } });
  const samples = [
    { id: '120000104', title: 'Intermittent deployment timeouts in West Europe', severity: '3', status: 'Active', category: 'RP', reportedByCustomer: 'No', notes: 'Investigating a spike after the deployment. Compare with the previous release.', customersImpacted: 'Unknown', occurrences: '3' },
    { id: '120000103', title: 'Worker authentication failures after certificate rotation', severity: '2', status: 'Mitigated', category: 'Runtime', reportedByCustomer: 'Yes', rootCause: 'A stale certificate remained in the worker cache.', notes: 'Write up the permanent fix with the identity team.', customersImpacted: '1', occurrences: '1' },
    { id: '120000102', title: 'Related allocation failure in a second subscription', severity: '3', status: 'Resolved', category: 'Runtime', reportedByCustomer: 'Yes', rootCause: 'Regional capacity exhausted during scale-out.', resolution: 'Moved workloads to an available capacity pool.', notes: 'Confirmed recovery with the second subscription owner.', summaryGroup: 'Regional capacity', customersImpacted: '2', occurrences: '2' },
    { id: '120000101', title: 'Allocation failures during regional scale-out', severity: '2', status: 'Mitigated', category: 'Runtime', reportedByCustomer: 'Yes', rootCause: 'Regional capacity exhausted during scale-out.', resolution: 'Moved workloads to an available capacity pool.', notes: 'Capacity follow-up remains open with the owning team.', summaryGroup: 'Regional capacity', customersImpacted: '2', occurrences: '2', relatedLinks: 'https://example.com/bugs/capacity-follow-up', errorMessage: 'AllocationFailed' }
  ];
  for (const [index, { id, ...fields }] of samples.entries()) await runtime.request('save', { reportId, incidentId: id, patch: { tracked: true, day: index ? `2026-11-${19 - index}` : '', ...fields } });

  const assetNames = ['model.js', 'client.js', 'ui.js', 'mitigate.js', 'observations.js', 'content.js', 'content.css', 'dashboard.js', 'dashboard.css', 'ignored.js', 'test/browser-bridge.js', 'icons/icon-32.png'];
  const assets = new Map(assetNames.map(name => [`/${name}`, path.join(root, name)]));
  const scripts = '<script src="/test/browser-bridge.js"></script>' + ['model.js', 'client.js', 'ui.js', 'mitigate.js', 'observations.js', 'content.js'].map(file => `<script src="/${file}" defer></script>`).join('');
  const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic ICM list</title><link rel="stylesheet" href="/content.css">${scripts}<style>
    body{margin:0;font:14px/1.5 Segoe UI,Arial,sans-serif;color:#242424;background:#fff}.topbar{padding:16px 30px;background:#063c75;color:#fff}.fixture{padding:26px 32px}.fixture h1{font-size:24px;font-weight:600}.fixture p{color:#66778e}.ms-DetailsHeader,.ms-DetailsRow{white-space:nowrap;min-width:1050px;border-bottom:1px solid #e6e9ed}.ms-DetailsHeader{font-weight:600;background:#f8fafc}.ms-DetailsHeader>div,.ms-DetailsRow>div{display:inline-block;vertical-align:middle;box-sizing:border-box;padding:14px 12px;width:100px;white-space:normal}.ms-DetailsHeader>div:nth-child(2),.ms-DetailsRow>div:nth-child(2){width:650px}.ms-DetailsRow-cell.ico-incident-cell{display:inline-flex}.ms-DetailsRow a{color:#0067b8;text-decoration:none}.grid{overflow:auto}.ms-DetailsHeader{line-height:24px}a{color:#185abe}</style></head><body><div class="topbar">ICM · Synthetic fixture</div><main class="fixture"><h1>My teams' incidents</h1><p>Synthetic data for testing Track and Notes. <a href="/dashboard.html">Open on-call dashboard</a> · <a href="/report.html">View exported table</a></p><div class="grid" role="grid"><div class="ms-DetailsHeader" role="row"><div role="columnheader">Incident ID</div><div role="columnheader" data-item-key="Title">Title</div><div role="columnheader">Severity</div><div role="columnheader">State</div></div>${samples.map(entry => `<div class="ms-DetailsRow" role="row"><div class="ms-DetailsRow-cell" role="gridcell">${entry.id}</div><div class="ms-DetailsRow-cell" role="gridcell" data-automation-key="Title"><span><a href="${M.incidentUrl(entry.id)}">${M.escapeHtml(entry.title)}</a></span></div><div class="ms-DetailsRow-cell" role="gridcell" data-automation-key="Severity">${entry.severity}</div><div class="ms-DetailsRow-cell" role="gridcell" data-automation-key="State">${entry.status}</div></div>`).join('')}</div></main></body></html>`;
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'text/html;charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); };
    try {
      if (!['127.0.0.1:4175', 'localhost:4175'].includes(req.headers.host)) return send(403, 'Invalid host');
      const url = new URL(req.url, 'http://127.0.0.1:4175');
      if (req.method === 'POST' && url.pathname === '/__message') {
        if (req.headers['content-type'] !== 'application/json') return send(415, 'JSON required');
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 9 * 1024 * 1024) return send(413, 'Request too large'); }
        const result = await runtime.chrome.runtime.sendMessage(JSON.parse(body));
        return send(200, JSON.stringify(result), 'application/json');
      }
      if (req.method !== 'GET') return send(405, 'Method not allowed');
      if (url.pathname === '/__state') return send(200, JSON.stringify(await runtime.request('get')), 'application/json');
      if (url.pathname === '/' || url.pathname === '/dashboard.html' || url.pathname === '/ignored.html') {
        const html = fs.readFileSync(path.join(root, url.pathname === '/ignored.html' ? 'ignored.html' : 'dashboard.html'), 'utf8').replace('<head>', '<head><script src="/test/browser-bridge.js"></script>');
        return send(200, html);
      }
      if (url.pathname === '/fixture-list.html') return send(200, fixture);
      if (url.pathname === '/report.html') return send(200, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sample on-call export</title><body>${M.exportReport(M.reportForDisplay(await runtime.request('get'))).html}</body></html>`);
      if (assets.has(url.pathname)) return send(200, fs.readFileSync(assets.get(url.pathname)), { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' }[path.extname(url.pathname)]);
      send(404, 'Not found');
    } catch (error) { send(500, JSON.stringify({ ok: false, error: error.message }), 'application/json'); }
  });
  server.listen(4175, '127.0.0.1', () => console.log('Synthetic workspace: http://127.0.0.1:4175/dashboard.html'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
