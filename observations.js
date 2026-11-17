((root) => {
  function create(M) {
    const observed = new Map();
    function collect(report, displayedReport, snapshots) {
      const changes = new Map();
      const base = {};
      for (const snapshot of snapshots) {
        const key = `${report.id}:${snapshot.id}`;
        const metadata = Object.fromEntries(M.METADATA_FIELDS.filter(field => snapshot[field]).map(field => [field, snapshot[field]]));
        const signature = JSON.stringify(metadata);
        const previous = observed.get(key);
        const entry = report.entries[snapshot.id];
        const visible = displayedReport.entries[snapshot.id];
        const eligible = !!visible && !!(visible.tracked || M.linkedSummary(displayedReport, snapshot.id));
        const pending = eligible ? { ...previous?.pending } : {};
        // Newly tracked incidents may backfill a visible date, but must not
        // replay a stale tab's title/status over another tab's saved metadata.
        const candidate = previous?.signature !== signature ? metadata
          : !previous.eligible && snapshot.day && !M.createdDay(entry?.day) ? { day: snapshot.day } : {};
        if (eligible) {
          for (const [field, raw] of Object.entries(candidate)) {
            if (typeof raw !== 'string' || !raw.trim() || (field === 'day' && M.createdDay(raw) !== raw)) continue;
            const value = raw.trim();
            // Retain the original base of a failed update until confirmed or superseded.
            if (pending[field]?.value !== value) pending[field] = { value, base: entry[field] ?? '' };
          }
        }
        const patch = {}, expected = {};
        for (const [field, update] of Object.entries(pending)) {
          const current = entry[field] ?? '';
          if (current === M.knownText(update.value) || current !== update.base) {
            delete pending[field]; // Already saved, or another writer has changed this field.
          } else {
            patch[field] = update.value;
            expected[field] = update.base;
          }
        }
        observed.set(key, { signature, eligible, pending });
        changes.delete(snapshot.id);
        delete base[snapshot.id];
        if (Object.keys(patch).length) {
          changes.set(snapshot.id, { id: snapshot.id, ...patch });
          base[snapshot.id] = expected;
        }
      }
      return { reportId: report.id, snapshots: [...changes.values()], base };
    }
    return { collect };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IcmObservations = api;
})(globalThis);
