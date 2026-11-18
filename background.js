importScripts('model.js');
importScripts('agent-api.js', 'bridge-client.js');
importScripts('monitor.js');
try { importScripts('bridge-config.js'); } catch { /* Optional local installation. */ }
const M = IcmOncall;
IcmSignalRMonitor.install(chrome);
let queue = Promise.resolve();
let agentBridge;

function enqueue(work) {
  const pending = queue.then(work);
  queue = pending.catch(() => undefined);
  return pending;
}

function newReport(fields) {
  return { id: crypto.randomUUID(), ...M.reportFields(fields), entries: {}, createdAt: Date.now(), updatedAt: Date.now() };
}

async function database() {
  const stored = (await chrome.storage.local.get(M.STORAGE_KEY))[M.STORAGE_KEY];
  if (stored) {
    if (stored.version !== 1) throw new Error('Unsupported workspace data version. Export a backup before updating the extension.');
    if (!stored.workspaceId) {
      const upgraded = { ...stored, workspaceId: crypto.randomUUID() };
      try {
        await chrome.storage.local.set({ [M.STORAGE_KEY]: upgraded });
        agentBridge?.scheduleBackup();
        return upgraded;
      } catch { /* Keep existing notes readable/exportable even when storage is full. */ }
    }
    return stored;
  }
  const report = newReport({ name: 'Current on-call', startDate: '', endDate: '' });
  const db = { version: 1, workspaceId: crypto.randomUUID(), activeReportId: report.id, reports: [report] };
  await chrome.storage.local.set({ [M.STORAGE_KEY]: db });
  agentBridge?.scheduleBackup();
  return db;
}

function applySave(db, message) {
  const report = M.currentReport(db, message.reportId);
  M.emptyEntry(message.incidentId);
  const previous = report.entries[message.incidentId] || M.emptyEntry(message.incidentId);
  const next = M.patchEntry(previous, message.patch, message.base || {});
  const ignored = M.isIgnored(db, next.id);
  if (message.patch.tracked === true) {
    if (previous.summaryIncidentId) throw new Error(`This incident is linked to #${previous.summaryIncidentId}. Unlink it before tracking it separately, or save notes with tracked: false.`);
    if (message.baseIgnored !== undefined && message.baseIgnored !== ignored) throw new Error('Ignore changed in another window. Reopen this incident and try again.');
    if (ignored && !message.restoreIgnored) throw new Error('This incident is ignored. Restore it or choose Track in Ignored incidents first.');
    if (ignored) db.ignoredIncidents[next.id] = { ...db.ignoredIncidents[next.id], ignored: false, updatedAt: Date.now() };
  }
  if (next.tracked && !previous.tracked) next.trackedAt = Date.now();
  next.updatedAt = Date.now();
  report.entries[next.id] = next;
  report.updatedAt = Date.now();
}

function applyLinks(db, message) {
  const report = M.currentReport(db, message.reportId);
  const related = M.relatedIndex(report);
  const targetId = message.targetId;
  if (typeof targetId !== 'string') throw new Error('Choose a tracked incident.');
  if (targetId) {
    M.emptyEntry(targetId);
    const target = report.entries[targetId];
    if (!target?.tracked || target.summaryIncidentId || M.isIgnored(db, targetId)) throw new Error('The selected summary is no longer tracked. Reopen Link and choose a tracked incident.');
  }
  if (!Array.isArray(message.incidents) || !message.incidents.length || message.incidents.length > 200) throw new Error('Choose between 1 and 200 incidents.');
  const updates = new Map();
  for (const source of message.incidents) {
    M.emptyEntry(source?.id);
    if (source.id === targetId) throw new Error('An incident cannot link to itself.');
    const previous = report.entries[source.id] || M.emptyEntry(source.id);
    const currentTarget = previous.summaryIncidentId || '';
    const expected = message.baseTargets?.[source.id];
    if (typeof expected !== 'string' || (currentTarget !== expected && currentTarget !== targetId)) throw new Error('The related incident changed in another window. Reopen it and try again.');
    if (targetId && (typeof message.baseTracked?.[source.id] !== 'boolean'
      || (previous.tracked !== message.baseTracked[source.id] && currentTarget !== targetId))) throw new Error('Tracking changed in another window. Reopen Link and try again.');
    const ignored = M.isIgnored(db, source.id);
    if (targetId && (typeof message.baseIgnored?.[source.id] !== 'boolean' || message.baseIgnored[source.id] !== ignored)) throw new Error('Ignore changed in another window. Reopen Link and try again.');
    const patch = {};
    // Capture only visible metadata; keep each incident's existing private notes.
    for (const key of M.METADATA_FIELDS) {
      if (!previous[key] && typeof source[key] === 'string' && source[key].trim()) patch[key] = source[key];
    }
    const next = M.patchEntry(previous, patch);
    if (targetId) { next.summaryIncidentId = targetId; next.tracked = false; }
    else delete next.summaryIncidentId;
    next.updatedAt = Date.now();
    updates.set(source.id, next);
  }
  const selectedIds = new Set(updates.keys());
  if (targetId) {
    // Move each summary's current children directly to the new summary. Keep
    // their latest annotations and any metadata supplied in the same batch.
    for (const id of selectedIds) {
      for (const entry of related.get(id) || []) {
        updates.set(entry.id, { ...(updates.get(entry.id) || entry), summaryIncidentId: targetId, tracked: false, updatedAt: Date.now() });
      }
    }
    // Append from the latest saved records inside the serialized operation.
    // A summary already holds its children's appended Notes; carry it once,
    // even when a child is also selected. Retries do not append again.
    const additions = [...selectedIds]
      .filter(id => !selectedIds.has(report.entries[id]?.summaryIncidentId))
      .filter(id => report.entries[id]?.summaryIncidentId !== targetId)
      .map(id => M.knownText(report.entries[id]?.notes))
      .filter(notes => notes.trim());
    if (additions.length) {
      const target = report.entries[targetId];
      const notes = [M.knownText(target.notes), ...additions].filter(value => value.trim()).join('\n');
      const next = M.patchEntry(target, { notes }, { notes: target.notes ?? '' });
      updates.set(targetId, { ...next, updatedAt: Date.now() });
    }
  }
  for (const [id, entry] of updates) {
    report.entries[id] = entry;
    // Only explicitly selected incidents are restored from Ignore.
    if (targetId && selectedIds.has(id) && M.isIgnored(db, id)) db.ignoredIncidents[id] = { ...db.ignoredIncidents[id], ignored: false, updatedAt: Date.now() };
  }
  report.updatedAt = Date.now();
}

function applyObservations(db, message) {
  const report = M.currentReport(db, message.reportId);
  const displayedReport = M.reportForDisplay(db, report.id);
  let changed = false;
  for (const snapshot of (message.snapshots || []).slice(0, 500)) {
    const entry = report.entries[snapshot.id];
    if (!(entry?.tracked || M.linkedSummary(displayedReport, snapshot.id)) || M.isIgnored(db, snapshot.id)) continue;
    const patch = {};
    const base = message.base?.[snapshot.id] || {};
    for (const key of M.METADATA_FIELDS) {
      if (key === 'day' && M.createdDay(snapshot.day) !== snapshot.day) continue;
      // An observation may have waited behind a save from another tab.
      if (Object.prototype.hasOwnProperty.call(base, key) && (entry[key] ?? '') !== base[key]) continue;
      if (typeof snapshot[key] === 'string' && snapshot[key].trim() && snapshot[key].trim() !== entry[key]) patch[key] = snapshot[key];
    }
    if (!Object.keys(patch).length) continue;
    report.entries[entry.id] = { ...M.patchEntry(entry, patch), observedAt: Date.now() };
    changed = true;
  }
  return changed;
}

function applyIgnore(db, message) {
  const batch = message.type === 'oncall:ignore-incidents';
  const incidents = batch ? message.incidents : [{ id: message.incidentId, title: message.title }];
  if (!Array.isArray(incidents) || !incidents.length || incidents.length > 200) throw new Error('Choose between 1 and 200 incidents.');
  if (typeof message.ignored !== 'boolean') throw new Error('Choose Ignore or Restore.');
  const report = M.currentReport(db, message.reportId);
  const updates = new Map();
  for (const source of incidents) {
    M.emptyEntry(source?.id);
    const entry = report.entries[source.id];
    if (batch && (message.baseIgnored?.[source.id] !== M.isIgnored(db, source.id)
      || message.baseTracked?.[source.id] !== !!entry?.tracked
      || message.baseTargets?.[source.id] !== (entry?.summaryIncidentId || ''))) {
      throw new Error('An incident changed in another window. Review the selection and try again.');
    }
    const title = source.title ?? entry?.title ?? db.ignoredIncidents?.[source.id]?.title ?? '';
    M.patchEntry(M.emptyEntry(source.id), { title });
    updates.set(source.id, title.trim());
  }
  db.ignoredIncidents ||= {};
  for (const [id, title] of updates) {
    const previous = db.ignoredIncidents[id];
    // Validate the entire batch before making the single storage write.
    // Keep restored records so old backups cannot undo later decisions.
    db.ignoredIncidents[id] = { id, title, ignored: message.ignored,
      ignoredAt: message.ignored ? Date.now() : previous?.ignoredAt || 0, updatedAt: Date.now() };
    const entry = report.entries[id];
    if (entry?.tracked) {
      report.entries[id] = { ...entry, tracked: false, updatedAt: Date.now() };
      report.updatedAt = Date.now();
    }
  }
}

function applyImport(db, imported, restoring) {
  if (restoring && (!M.validWorkspaceId(imported.workspaceId) || !imported.reports.length)) throw new Error('No valid automatic backup is available.');
  const knownIds = new Set([...Object.keys(db.ignoredIncidents || {}), ...db.reports.flatMap(report => Object.keys(report.entries))]);
  db.ignoredIncidents ||= {};
  for (const [id, entry] of Object.entries(imported.ignoredIncidents)) if (!knownIds.has(id)) db.ignoredIncidents[id] = entry;
  // Import as new reports; existing records are never overwritten.
  for (const report of imported.reports) {
    const copy = { ...report, id: crypto.randomUUID(), name: `${report.name.slice(0, 149)} (imported)` };
    db.reports.push(copy);
    if (restoring && report.id === imported.activeReportId) db.activeReportId = copy.id;
  }
  if (restoring) {
    db.workspaceId = imported.workspaceId;
    if (imported.listPreferences) db.listPreferences = { ...imported.listPreferences, ...db.listPreferences };
  }
}

async function handle(message) {
  if (message.type === 'oncall:bridge-status') {
    agentBridge?.connect();
    return agentBridge?.status() || { state: 'not-installed' };
  }
  if (message.type === 'oncall:backup-now') {
    if (!agentBridge) throw new Error('Install the local backup service first.');
    agentBridge.retryBackup();
    return agentBridge.status();
  }
  if (message.type === 'oncall:open' || message.type === 'oncall:open-ignored') {
    await chrome.tabs.create({ url: chrome.runtime.getURL(message.type === 'oncall:open-ignored' ? 'ignored.html' : 'dashboard.html') });
    return null;
  }
  const db = await database();
  if (message.type === 'oncall:get') return db;
  if (message.type === 'oncall:create-report') {
    const report = newReport(message.fields);
    db.reports.push(report);
    db.activeReportId = report.id;
  } else if (message.type === 'oncall:select-report') {
    M.currentReport(db, message.reportId);
    db.activeReportId = message.reportId;
  } else if (message.type === 'oncall:edit-report') {
    Object.assign(M.currentReport(db, message.reportId), M.reportFields(message.fields), { updatedAt: Date.now() });
  } else if (message.type === 'oncall:save') {
    applySave(db, message);
  } else if (message.type === 'oncall:link-incidents') {
    applyLinks(db, message);
  } else if (message.type === 'oncall:observe') {
    if (!applyObservations(db, message)) return db;
  } else if (message.type === 'oncall:ignore' || message.type === 'oncall:ignore-incidents') {
    applyIgnore(db, message);
  } else if (message.type === 'oncall:list-preferences') {
    db.listPreferences = { ...db.listPreferences, ...M.listPreferences(message.patch) };
  } else if (message.type === 'oncall:import' || message.type === 'oncall:restore-backup') {
    const restoring = message.type === 'oncall:restore-backup';
    if (restoring && !agentBridge) throw new Error('The local backup service is not installed.');
    const imported = M.validateBackup(restoring ? await agentBridge.readBackup() : message.data);
    applyImport(db, imported, restoring);
  } else {
    throw new Error('Unknown workspace action.');
  }
  await chrome.storage.local.set({ [M.STORAGE_KEY]: db });
  if (message.type === 'oncall:restore-backup') agentBridge.resumeBackup();
  else agentBridge?.scheduleBackup();
  return db;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type?.startsWith('oncall:')) return false;
  if (sender.id !== chrome.runtime.id) return false;
  const pending = enqueue(() => handle(message));
  pending.then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

const agentApi = IcmAgentApi.create({ model: M, database, save: message => handle({ type: 'oncall:save', ...message }) });
if (globalThis.IcmBridgeConfig && typeof WebSocket !== 'undefined') {
  agentBridge = IcmAgentBridge.create({
    config: IcmBridgeConfig, chrome, WebSocket,
    invoke: request => enqueue(() => agentApi(request)),
    snapshot: () => enqueue(database),
  });
  agentBridge.connect();
}
