const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, loadPage, waitFor } = require('./test/runtime');

test('agent saves directly to a chosen report and the dashboard refreshes without import', async t => {
  const runtime = createRuntime();
  const page = loadPage(runtime, { dashboard: true }); t.after(page.close);
  const { activeReportId } = await runtime.agentRequest({ method: 'list_reports' });
  const request = { method: 'save_incident', params: { reportId: activeReportId, incidentId: '123', fields: {
    title: 'An expired identity', rootCause: 'Cross-tenant renewal rejected', resolution: 'Operator completed cleanup', notes: 'Ready to mitigate',
  } } };
  const receipt = await runtime.agentRequest(request);
  assert.equal(receipt.saved, true); assert.equal(receipt.officialIcmChanged, false);
  await waitFor(() => page.document.querySelector('#incidents').textContent.includes('Operator completed cleanup'));
  await runtime.agentRequest(request);
  assert.equal((await runtime.agentRequest({ method: 'list_reports' })).reports[0].trackedCount, 1);
  assert.equal(page.document.querySelectorAll('#incidents tr').length, 1);
  assert.equal(runtime.tabs.length, 0);
});

test('agent requires explicit target and protects manual changes with field-level base checks', async () => {
  const runtime = createRuntime(); const { activeReportId } = await runtime.agentRequest({ method: 'list_reports' });
  await runtime.request('save', { reportId: activeReportId, incidentId: '123', patch: { notes: 'Human note' } });
  await assert.rejects(runtime.agentRequest({ method: 'save_incident', params: { incidentId: '123', fields: { notes: 'Replacement' } } }), /reportId/);
  await assert.rejects(runtime.agentRequest({ method: 'save_incident', params: { reportId: activeReportId, incidentId: '123', fields: { notes: 'Replacement' } } }), /already has content/);
  const before = await runtime.agentRequest({ method: 'read_incident', params: { incidentId: '123' } });
  await runtime.request('save', { reportId: activeReportId, incidentId: '123', patch: { notes: 'New human note' } });
  await assert.rejects(runtime.agentRequest({ method: 'save_incident', params: { reportId: activeReportId, incidentId: '123', fields: { notes: 'Merged' }, base: { notes: before.entry.notes } } }), /another window/);
  const receipt = await runtime.agentRequest({ method: 'save_incident', params: { reportId: activeReportId, incidentId: '123', fields: { notes: 'New human note\nNew evidence' }, base: { notes: 'New human note' } } });
  assert.equal(receipt.entry.notes, 'New human note\nNew evidence');
});

test('active-report changes do not redirect a pending agent save', async () => {
  const runtime = createRuntime(); const { activeReportId } = await runtime.agentRequest({ method: 'list_reports' });
  const next = await runtime.request('create-report', { fields: { name: 'Another rotation' } });
  await runtime.agentRequest({ method: 'save_incident', params: { reportId: activeReportId, incidentId: '123', fields: { notes: 'Original rotation' } } });
  assert.equal((await runtime.agentRequest({ method: 'read_incident', params: { reportId: activeReportId, incidentId: '123' } })).entry.notes, 'Original rotation');
  assert.equal((await runtime.agentRequest({ method: 'read_incident', params: { reportId: next.activeReportId, incidentId: '123' } })).exists, false);
});

test('agent returns failures for failed storage and rejects non-note operations', async () => {
  const runtime = createRuntime(); const { activeReportId } = await runtime.agentRequest({ method: 'list_reports' });
  runtime.failWrites();
  await assert.rejects(runtime.agentRequest({ method: 'save_incident', params: { reportId: activeReportId, incidentId: '123', fields: { notes: 'Not saved' } } }), /quota/);
  assert.equal((await runtime.agentRequest({ method: 'read_incident', params: { incidentId: '123' } })).exists, false);
  await assert.rejects(runtime.agentRequest({ method: 'mitigate_incident', params: { incidentId: '123' } }), /Unknown local notes/);
  runtime.failWrites(false);
  await assert.rejects(runtime.agentRequest({ method: 'save_incident', params: { reportId: activeReportId, incidentId: '123', fields: { execute: 'anything' } } }), /Unknown incident field/);
});
