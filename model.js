((root) => {
  const STORAGE_KEY = 'icm-oncall-workspace-v1';
  const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
  const METADATA_FIELDS = ['title', 'severity', 'status', 'day'];
  const LIST_PREFERENCES = ['showTracked', 'showIgnored', 'hideMitigated'];
  const validWorkspaceId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  const FIELDS = [
    ['day', 'Day (ICM created date)', 80],
    ['title', 'Incident title', 2000], ['severity', 'Severity', 32], ['status', 'ICM status', 80],
    ['category', 'RP/Runtime', 120], ['reportedByCustomer', 'Reported by customer', 20],
    ['customersImpacted', 'Customers impacted', 500], ['occurrences', 'Occurrences', 80],
    ['rootCause', 'Root cause', 20000], ['resolution', 'Resolution', 20000],
    ['notes', 'Notes', 20000], ['errorMessage', 'Error message', 10000],
    ['relatedLinks', 'Evidence links (included in Notes)', 10000],
    ['summaryGroup', 'Summary group', 160]
  ];
  const FIELD_MAP = new Map(FIELDS.map(([key, label, limit]) => [key, { label, limit }]));
  const COLUMNS = [
    ['day', 'Day'], ['category', 'RP/Runtime'], ['reportedByCustomer', 'Reported by customer'],
    ['severity', 'Severity'], ['status', 'Status'], ['customersImpacted', '# of customers impacted'],
    ['occurrences', '# of occurrence'], ['rootCause', 'Root cause'],
    ['links', 'Bug and/or ICM to external team'], ['errorMessage', 'Error msg'], ['notes', 'Notes']
  ];
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const text = value => typeof value === 'string' ? value.trim() : '';
  const knownText = value => /^(unknown|not\s+established)$/i.test(text(value)) ? '' : typeof value === 'string' ? value : '';
  function createdDay(value) {
    // Keep the calendar date displayed by ICM, without machine-local conversion.
    const day = text(value).match(/^(\d{4}-\d{2}-\d{2})(?=$|T|\s)/)?.[1];
    if (!day) return '';
    const parsed = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : '';
  }
  function incidentId(value) {
    const raw = text(value);
    if (/^\d{1,20}$/.test(raw)) return raw;
    try {
      const url = new URL(raw, 'https://portal.microsofticm.com');
      if (url.origin !== 'https://portal.microsofticm.com') return null;
      return url.pathname.match(/^\/imp\/v[35]\/incidents\/details\/(\d{1,20})(?:\/|$)/i)?.[1] || null;
    } catch { return null; }
  }
  const incidentUrl = id => `https://portal.microsofticm.com/imp/v5/incidents/details/${id}/summary`;
  function parseIncidentIds(value) {
    if (typeof value !== 'string' || value.length > 20000) throw new Error('Enter incident IDs or ICM URLs (up to 200 at a time).');
    const ids = value.trim().split(/[\s,;]+/).filter(Boolean).map(token => {
      const id = incidentId(token.replace(/^#(?=\d+$)/, ''));
      if (!id) throw new Error('Use numeric incident IDs or portal.microsofticm.com incident URLs.');
      return id;
    });
    const unique = [...new Set(ids)];
    if (!unique.length || unique.length > 200) throw new Error('Enter between 1 and 200 incident IDs or URLs.');
    return unique;
  }
  function emptyEntry(id) {
    if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) throw new Error('Enter a valid incident ID or ICM incident URL.');
    return { id, tracked: false, ...Object.fromEntries(FIELDS.map(([key]) => [key, ''])) };
  }
  function patchEntry(entry, patch, base = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid incident update.');
    const next = { ...entry };
    for (const [key, value] of Object.entries(patch)) {
      if (key !== 'tracked' && !FIELD_MAP.has(key)) throw new Error(`Unknown incident field: ${key}`);
      if (key === 'tracked' ? typeof value !== 'boolean' : typeof value !== 'string') throw new Error(`Invalid value for ${key}.`);
      const clean = key === 'tracked' ? value : knownText(value.trim());
      if (FIELD_MAP.has(key) && clean.length > FIELD_MAP.get(key).limit) throw new Error(`${FIELD_MAP.get(key).label} is too long.`);
      if (key === 'reportedByCustomer' && !['', 'Yes', 'No'].includes(clean)) throw new Error('Choose Yes, No or leave customer reporting blank.');
      if (key === 'day' && clean && createdDay(clean) !== clean) throw new Error('Use the ICM creation date in YYYY-MM-DD format.');
      const current = entry[key] ?? (key === 'tracked' ? false : '');
      const expected = base[key] ?? (key === 'tracked' ? false : '');
      if (own(base, key) && current !== expected && current !== clean) {
        throw new Error(`${FIELD_MAP.get(key)?.label || 'Tracking'} changed in another window. Copy your draft, reopen the editor and try again.`);
      }
      next[key] = clean;
    }
    return next;
  }
  function reportFields(value) {
    const name = text(value.name);
    if (!name || name.length > 160) throw new Error('Give the report a name (up to 160 characters).');
    const startDate = text(value.startDate);
    const endDate = text(value.endDate);
    for (const date of [startDate, endDate]) {
      const parsed = new Date(`${date}T00:00:00Z`);
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)) {
        throw new Error('Enter valid report dates.');
      }
    }
    if (startDate && endDate && startDate > endDate) throw new Error('The end date must be on or after the start date.');
    return { name, startDate, endDate };
  }
  function currentReport(db, id = db.activeReportId) {
    const report = db.reports.find(item => item.id === id);
    if (!report) throw new Error('This report no longer exists. Reopen the dashboard.');
    return report;
  }
  const isIgnored = (db, id) => db.ignoredIncidents?.[id]?.ignored === true;
  const ignoredEntries = db => Object.values(db.ignoredIncidents || {}).filter(entry => entry.ignored)
    .sort((a, b) => b.ignoredAt - a.ignoredAt || a.id.localeCompare(b.id));
  function reportForDisplay(db, id = db.activeReportId) {
    const report = currentReport(db, id);
    return { ...report, entries: Object.fromEntries(Object.entries(report.entries).filter(([incidentId]) => !isIgnored(db, incidentId))) };
  }
  function triageBase(db, reportId, incidents) {
    const report = currentReport(db, reportId);
    return {
      baseTargets: Object.fromEntries(incidents.map(item => [item.id, report.entries[item.id]?.summaryIncidentId || ''])),
      baseIgnored: Object.fromEntries(incidents.map(item => [item.id, isIgnored(db, item.id)])),
      baseTracked: Object.fromEntries(incidents.map(item => [item.id, !!report.entries[item.id]?.tracked])),
    };
  }
  function listPreferences(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.entries(value).some(([key, enabled]) => !LIST_PREFERENCES.includes(key) || typeof enabled !== 'boolean')) {
      throw new Error('Invalid list visibility preferences.');
    }
    return { ...value };
  }
  const trackedEntries = report => Object.values(report.entries).filter(entry => entry.tracked)
    .sort((a, b) => (b.trackedAt || 0) - (a.trackedAt || 0) || a.id.localeCompare(b.id));
  const byIncidentId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
  const relatedEntries = (report, id) => Object.values(report.entries).filter(entry => entry.summaryIncidentId === id)
    .sort(byIncidentId);
  function relatedIndex(report) {
    const index = new Map();
    for (const entry of Object.values(report.entries)) {
      if (!entry.summaryIncidentId) continue;
      if (!index.has(entry.summaryIncidentId)) index.set(entry.summaryIncidentId, []);
      index.get(entry.summaryIncidentId).push(entry);
    }
    for (const entries of index.values()) entries.sort(byIncidentId);
    return index;
  }
  function linkedSummary(report, id) {
    const summaryId = report.entries[id]?.summaryIncidentId;
    const summary = summaryId && report.entries[summaryId];
    return summary?.tracked && !summary.summaryIncidentId ? summary : null;
  }
  function exportEntries(report, afterIncident = '') {
    const entries = trackedEntries(report);
    if (!text(afterIncident)) return entries;
    const id = incidentId(text(afterIncident).replace(/^#/, ''));
    if (!id) throw new Error('Enter a numeric ICM ID or an ICM incident URL to copy after.');
    const index = entries.findIndex(entry => entry.id === id);
    if (index < 0) throw new Error(`ICM #${id} is not a tracked main incident in this report.`);
    // The dashboard is newest-tracked first. IDs from different ICM clouds
    // are not comparable as numbers, and creation Day is not tracking order.
    return entries.slice(0, index);
  }
  function groups(report, entries = trackedEntries(report)) {
    const result = new Map();
    for (const entry of entries) {
      const key = entry.summaryGroup ? `group:${entry.summaryGroup.toLowerCase()}` : `incident:${entry.id}`;
      if (!result.has(key)) result.set(key, { name: entry.summaryGroup, entries: [] });
      result.get(key).entries.push(entry);
    }
    return [...result.values()];
  }
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const linesHtml = value => escapeHtml(value).replace(/\r?\n/g, '<br>');
  function linksHtml(value) {
    return value.split(/(https?:\/\/[^\s<>]+)/g).map(part => {
      if (!/^https?:\/\//i.test(part)) return linesHtml(part);
      try {
        const url = new URL(part);
        const id = incidentId(url.href);
        return `<a href="${escapeHtml(url.href)}">${escapeHtml(id ? `#${id}` : part)}</a>`;
      } catch { return escapeHtml(part); }
    }).join('');
  }
  function combined(entries, key) {
    const nonempty = entries.filter(entry => entry[key]);
    const values = [...new Set(nonempty.map(entry => entry[key]))];
    if (values.length <= 1) return values[0] || '';
    return nonempty.map(entry => `${entry.id}: ${entry[key]}`).join('\n\n');
  }
  function exportReport(report, { includeHeaders = true, afterIncident = '' } = {}) {
    const entries = exportEntries(report, afterIncident);
    const related = relatedIndex(report);
    const exportGroups = groups(report, entries).map(group => ({ ...group, entries: group.entries.map(entry => ({
      ...entry, ...Object.fromEntries(FIELDS.map(([key]) => [key, key === 'day' ? createdDay(entry.day) : knownText(entry[key])])),
      relatedIncidents: related.get(entry.id) || [],
    })) }));
    const exportText = (entries, key) => key === 'notes'
      ? combined(entries.map(entry => ({ ...entry, notes: [
          entry.resolution && entry.resolution !== entry.notes ? `Resolution: ${entry.resolution}` : '',
          entry.notes,
          entry.relatedLinks && !entry.notes.includes(entry.relatedLinks) ? `Evidence links:\n${entry.relatedLinks}` : '',
        ].filter(Boolean).join('\n\n') })), 'notes')
      : combined(entries, key);
    const rows = exportGroups.map(group => COLUMNS.map(([key]) => {
      if (key !== 'links') return exportText(group.entries, key);
      return group.entries.map(entry => [
        `${entry.title || `Incident ${entry.id}`}\n${incidentUrl(entry.id)}`,
        ...entry.relatedIncidents.map(item => `[${item.id}](${incidentUrl(item.id)})`),
      ].join('\n')).join('\n\n');
    }));
    const cellStyle = 'border:1px solid #b8c2cc;padding:8px;vertical-align:top;white-space:normal;';
    const tableRows = exportGroups.map(group => `<tr>${COLUMNS.map(([key]) => {
      const value = key === 'links'
        ? group.entries.map(entry => `<div><a href="${incidentUrl(entry.id)}">${escapeHtml(entry.title || `Incident ${entry.id}`)}</a>${entry.relatedIncidents.map(item => `<br><a href="${incidentUrl(item.id)}">${escapeHtml(item.id)}</a>`).join('')}</div>`).join('')
        : key === 'notes' ? linksHtml(exportText(group.entries, key)) : linesHtml(exportText(group.entries, key));
      return `<td style="${cellStyle}">${value}</td>`;
    }).join('')}</tr>`).join('');
    const dates = [report.startDate, report.endDate].filter(Boolean).join(' – ');
    const heading = includeHeaders ? `<h2>${escapeHtml(report.name)}</h2>${dates ? `<p>${escapeHtml(dates)}</p>` : ''}` : '';
    const tableHead = includeHeaders ? `<thead><tr>${COLUMNS.map(([, title]) => `<th style="${cellStyle}background:#edf1f5;text-align:left;">${escapeHtml(title)}</th>`).join('')}</tr></thead>` : '';
    const html = `<div style="font:12px Segoe UI,Arial,sans-serif;color:#172b4d">${heading}<table style="border-collapse:collapse;width:100%">${tableHead}<tbody>${tableRows}</tbody></table></div>`;
    const plain = [...(includeHeaders ? [report.name, dates, COLUMNS.map(([, title]) => title).join('\t')] : []), ...rows.map(row => row.map(value => value.replace(/\s*\n\s*/g, ' / ')).join('\t'))].filter(Boolean).join('\n');
    const csvCell = value => `"${String(value).replace(/^(?=\s*[=+@-])/, "'").replace(/"/g, '""')}"`;
    const csv = '\uFEFF' + [...(includeHeaders ? [COLUMNS.map(([, title]) => title)] : []), ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    return { html, plain, csv, count: rows.length, incidentCount: entries.length, newestIncidentId: entries[0]?.id || '' };
  }
  function validateBackup(input) {
    if (!input || input.version !== 1 || !Array.isArray(input.reports) || input.reports.length > 500) throw new Error('This is not a supported workspace backup.');
    const seen = new Set();
    const reports = input.reports.map(report => {
      if (!report || !/^[a-z0-9-]{1,80}$/i.test(report.id) || seen.has(report.id)) throw new Error('Invalid or duplicate report ID in backup.');
      seen.add(report.id);
      const fields = reportFields(report);
      if (!report.entries || typeof report.entries !== 'object' || Array.isArray(report.entries)) throw new Error('Invalid incident records in backup.');
      const entries = {};
      for (const [id, entry] of Object.entries(report.entries)) {
        const patch = Object.fromEntries([...FIELDS.map(([key]) => key), 'tracked'].filter(key => own(entry, key)).map(key => [key, entry[key]]));
        if (own(patch, 'day')) patch.day = createdDay(patch.day); // Old manual weekday values are not creation dates.
        const next = patchEntry(emptyEntry(id), patch);
        if (entry.summaryIncidentId !== undefined && entry.summaryIncidentId !== '') {
          emptyEntry(entry.summaryIncidentId);
          next.summaryIncidentId = entry.summaryIncidentId;
        }
        for (const key of ['updatedAt', 'trackedAt', 'observedAt']) if (Number.isFinite(entry[key])) next[key] = entry[key];
        entries[id] = next;
      }
      for (const entry of Object.values(entries)) {
        if (!entry.summaryIncidentId) continue;
        const summary = entries[entry.summaryIncidentId];
        if (!summary || summary.id === entry.id || summary.summaryIncidentId || entry.tracked) throw new Error('Invalid related incident link in backup.');
      }
      return { id: report.id, ...fields, entries, createdAt: Number.isFinite(report.createdAt) ? report.createdAt : Date.now(), updatedAt: Number.isFinite(report.updatedAt) ? report.updatedAt : Date.now() };
    });
    const ignoredIncidents = {};
    if (input.ignoredIncidents !== undefined) {
      if (!input.ignoredIncidents || typeof input.ignoredIncidents !== 'object' || Array.isArray(input.ignoredIncidents)) throw new Error('Invalid ignored incidents in backup.');
      for (const [id, entry] of Object.entries(input.ignoredIncidents)) {
        emptyEntry(id);
        if (!entry || typeof entry.ignored !== 'boolean' || typeof entry.title !== 'string' || entry.title.length > 2000) throw new Error('Invalid ignored incident in backup.');
        ignoredIncidents[id] = { id, ignored: entry.ignored, title: entry.title.trim(), ignoredAt: Number.isFinite(entry.ignoredAt) ? entry.ignoredAt : 0, updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0 };
      }
    }
    const metadata = {};
    if (input.workspaceId !== undefined) {
      if (!validWorkspaceId(input.workspaceId)) throw new Error('Invalid workspace identity in backup.');
      metadata.workspaceId = input.workspaceId;
    }
    if (input.listPreferences !== undefined) {
      metadata.listPreferences = listPreferences(input.listPreferences);
    }
    return { version: 1, ...metadata, activeReportId: seen.has(input.activeReportId) ? input.activeReportId : reports[0]?.id, reports, ignoredIncidents };
  }
  const api = { STORAGE_KEY, MAX_BACKUP_BYTES, METADATA_FIELDS, validWorkspaceId, FIELDS, COLUMNS, knownText, createdDay, incidentId, incidentUrl, parseIncidentIds, emptyEntry, patchEntry, reportFields, currentReport, reportForDisplay, triageBase, listPreferences, isIgnored, ignoredEntries, trackedEntries, relatedEntries, relatedIndex, linkedSummary, groups, exportEntries, exportReport, validateBackup, escapeHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IcmOncall = api;
})(globalThis);
