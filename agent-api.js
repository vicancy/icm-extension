((root) => {
  function create({ model: M, database, save }) {
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    return async function invoke(request) {
      if (!object(request) || !object(request.params || {})) throw new Error('Invalid API request.');
      const { method, params = {} } = request;
      if (!['list_reports', 'read_incident', 'save_incident'].includes(method)) throw new Error('Unknown local notes method.');
      const db = await database();
      if (method === 'list_reports') {
        return { activeReportId: db.activeReportId, reports: db.reports.map(report => ({
          id: report.id, name: report.name, startDate: report.startDate, endDate: report.endDate,
          trackedCount: M.trackedEntries(M.reportForDisplay(db, report.id)).length,
        })) };
      }
      const id = M.incidentId(params.incidentId);
      if (!id) throw new Error('Enter a valid incident ID or ICM URL.');
      if (params.reportId !== undefined && typeof params.reportId !== 'string') throw new Error('Invalid report ID.');
      if (method === 'save_incident' && !params.reportId) throw new Error('Choose a reportId from list_reports before saving.');
      const report = M.currentReport(db, params.reportId || db.activeReportId);
      const previous = report.entries[id] || M.emptyEntry(id);
      if (method === 'read_incident') {
        return { reportId: report.id, reportName: report.name, exists: Boolean(report.entries[id]), ignored: M.isIgnored(db, id),
          relatedIncidentIds: M.relatedEntries(M.reportForDisplay(db, report.id), id).map(entry => entry.id), entry: previous };
      }
      if (!object(params.fields) || !Object.keys(params.fields).length) throw new Error('Provide at least one note field.');
      if (params.base !== undefined && !object(params.base)) throw new Error('Invalid base fields.');
      const base = params.base || {};
      const patch = { tracked: true, ...params.fields };
      // Reusing the editor validation also rejects unknown fields and oversized notes.
      M.patchEntry(previous, patch, base);
      for (const [key, value] of Object.entries(params.fields)) {
        const clean = typeof value === 'string' ? value.trim() : value;
        if (key !== 'tracked' && previous[key] && previous[key] !== clean && !own(base, key)) {
          throw new Error(`${key} already has content. Read the incident and provide its base value before replacing it.`);
        }
      }
      const updated = await save({ reportId: report.id, incidentId: id, patch, base });
      return { reportId: report.id, reportName: report.name, saved: true,
        entry: M.currentReport(updated, report.id).entries[id], officialIcmChanged: false };
    };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IcmAgentApi = api;
})(globalThis);
