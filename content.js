(() => {
  const M = IcmOncall;
  const UI = IcmOncallUI;
  const request = IcmOncallClient.request;
  const mitigate = IcmQuickMitigate;
  const ROWS = '.ms-DetailsRow[role="row"], .searchresults-k-grid .k-grid-content tr[role="row"]';
  const METADATA_FIELDS = ['title', 'severity', 'status', 'day'];
  let db, toolbar, editor, timer;
  let observing = false;
  const observedSnapshots = new Map();
  let currentUrl = location.href;
  const report = () => M.currentReport(db);

  function rowSnapshot(row) {
    const links = [...row.querySelectorAll('a[href*="/incidents/details/"]')].filter(link => M.incidentId(link.href));
    if (!links.length) return null;
    const titleCell = row.querySelector('[data-automation-key="Title"]');
    const titleLink = titleCell?.querySelector('a[href*="/incidents/details/"]') || links.sort((a, b) => b.textContent.length - a.textContent.length)[0];
    const id = M.incidentId(titleLink.href);
    if (!id) return null;
    const title = titleLink.textContent.trim();
    const snapshot = { id, title: title === id ? '' : title };
    for (const [key, field] of [['severity', 'Severity'], ['status', 'State']]) {
      const cell = row.querySelector(`[data-automation-key="${field}"]`);
      if (cell) snapshot[key] = cell.textContent.trim();
    }
    const created = row.querySelector('[data-automation-key="CreatedDate"]');
    snapshot.day = M.createdDay(created?.querySelector('time')?.textContent || created?.textContent);
    return { ...snapshot, cell: titleCell || titleLink.closest('td, [role="gridcell"]') };
  }
  function detailSnapshot() {
    const id = M.incidentId(location.href);
    if (!id) return null;
    const titleId = document.title.match(/^Incident\s+(\d+)/i)?.[1];
    if (titleId && titleId !== id) return { id, title: '' };
    const title = document.title.replace(/^Incident\s+\d+\s*[:\-]?\s*/i, '').replace(/\s*[-–]\s*IcM\s*$/i, '').trim();
    const status = document.querySelector('[data-testid="incident-lifecycle"]')?.textContent.trim();
    // The native Duration card distinguishes Incident created from Source created
    // and Impact start. Read it only when present; never open/load it automatically.
    const createdLabel = [...document.querySelectorAll('h3')].find(label => /^Incident created:?$/i.test(label.textContent.trim()));
    const day = M.createdDay(createdLabel?.nextElementSibling?.querySelector('time')?.textContent);
    return { id, title: title && title !== 'IcM' && title !== id ? title : '', ...(status ? { status } : {}), ...(day ? { day } : {}) };
  }
  const metadata = snapshot => Object.fromEntries(METADATA_FIELDS.filter(key => snapshot[key]).map(key => [key, snapshot[key]]));
  function filterRows() {
    const isQuery = /\/incidents\/(?:queries|search)(?:\/|$)/i.test(location.pathname);
    const displayedReport = M.reportForDisplay(db);
    let hidden = 0, selected = 0;
    for (const row of document.querySelectorAll(ROWS)) {
      const snapshot = rowSnapshot(row);
      const ignored = snapshot && M.isIgnored(db, snapshot.id);
      const tracked = snapshot && !ignored && report().entries[snapshot.id]?.tracked;
      const linked = snapshot && M.linkedSummary(displayedReport, snapshot.id);
      const shouldHide = isQuery && snapshot && (ignored ? !db.listPreferences?.showIgnored : (tracked || linked) && !db.listPreferences?.showTracked);
      // Native bulk selection must never leave selected incidents invisible.
      const isSelected = row.getAttribute('aria-selected') === 'true' || row.classList.contains('k-state-selected') || [...row.querySelectorAll('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]')].some(item => !item.closest('.ico-row-actions'));
      const hide = !!shouldHide && !isSelected;
      if (row.classList.contains('ico-row-hidden') !== hide) row.classList.toggle('ico-row-hidden', hide);
      if (hide) hidden++;
      else if (shouldHide && isSelected) selected++;
    }
    if (toolbar) {
      toolbar.querySelector('.ico-list-filters').hidden = !isQuery;
      toolbar.querySelector('[name="showTracked"]').checked = !!db.listPreferences?.showTracked;
      toolbar.querySelector('[name="showIgnored"]').checked = !!db.listPreferences?.showIgnored;
      toolbar.querySelector('.ico-hidden-count').textContent = `${hidden} hidden in loaded rows${selected ? ` · ${selected} selected kept visible` : ''}`;
      toolbar.querySelector('[data-action="open-ignored"]').textContent = `Ignored (${M.ignoredEntries(db).length})`;
    }
  }
  function refreshControls() {
    if (!db) return;
    for (const controls of document.querySelectorAll('.ico-row-actions, .ico-detail-actions')) {
      const snapshot = controls._snapshot?.();
      if (!snapshot) { controls.hidden = true; continue; }
      controls.hidden = false;
      const entry = report().entries[snapshot.id];
      const ignored = M.isIgnored(db, snapshot.id);
      const tracked = !ignored && entry?.tracked;
      const linkedId = entry?.summaryIncidentId;
      const track = controls.querySelector('[data-action="track"]');
      track.textContent = tracked ? 'Tracked' : 'Track';
      track.setAttribute('aria-pressed', String(!!tracked));
      track.setAttribute('aria-label', `${tracked ? 'Untrack' : 'Track'} incident ${snapshot.id}`);
      track.title = ignored ? 'Restore this incident and track it in the current report' : 'Include or remove this incident from the current report';
      track.disabled = !!linkedId;
      if (linkedId) track.title = `Unlink from #${linkedId} before tracking separately`;
      const link = controls.querySelector('[data-action="link"]');
      const relatedCount = M.relatedEntries(report(), snapshot.id).length;
      link.textContent = linkedId ? `Linked #${linkedId}` : tracked || relatedCount ? `Related (${relatedCount})` : 'Link';
      link.title = tracked || relatedCount ? 'Manage related ICMs' : 'Link to a tracked incident';
      link.setAttribute('aria-label', linkedId ? `Change summary link for incident ${snapshot.id}` : tracked || relatedCount ? `Related ICMs for incident ${snapshot.id}` : `Link incident ${snapshot.id} to a tracked incident`);
      const ignore = controls.querySelector('[data-action="ignore"]');
      ignore.textContent = ignored ? 'Restore' : 'Ignore';
      ignore.setAttribute('aria-label', `${ignored ? 'Restore' : 'Ignore'} incident ${snapshot.id}`);
      ignore.title = ignored ? 'Stop ignoring this incident; do not add it to the report' : 'Hide this incident across reports until restored. Notes are kept.';
      const notes = controls.querySelector('[data-action="notes"]');
      notes.setAttribute('aria-label', `Notes for incident ${snapshot.id}`);
      notes.classList.toggle('ico-has-notes', !!(entry?.rootCause || entry?.resolution || entry?.notes));
      const quick = controls.querySelector('[data-action="mitigate"]');
      if (quick) {
        const status = mitigate.result(snapshot.id) || snapshot.status;
        const done = /^(Mitigated|Resolved)$/i.test(status || '');
        quick.textContent = mitigate.active() === snapshot.id ? 'Mitigating…' : done ? status : 'Mitigate';
        quick.disabled = !!mitigate.active() || done;
        quick.setAttribute('aria-label', `${done ? status : 'Mitigate'} incident ${snapshot.id}`);
      }
    }
    if (toolbar) toolbar.querySelector('.ico-report-name').textContent = report().name;
    filterRows();
  }
  function openNotes(snapshot, anchor) {
    if (!snapshot || editor?.panel.isConnected) return;
    const selectedReport = report();
    const entry = selectedReport.entries[snapshot.id] || M.emptyEntry(snapshot.id);
    const ignored = M.isIgnored(db, snapshot.id);
    editor = UI.openEditor({ report: selectedReport, entry, snapshot, ignored, returnFocus: anchor, onSave: async (patch, base) => {
      db = await request('save', { reportId: selectedReport.id, incidentId: snapshot.id, patch, base, restoreIgnored: ignored, baseIgnored: ignored }); refreshControls();
    } });
  }
  function controls(getSnapshot, className) {
    const wrapper = UI.node('span', className); wrapper._snapshot = getSnapshot;
    wrapper.setAttribute('data-selection-disabled', 'true');
    const track = UI.button('Track', 'ico-track'); track.dataset.action = 'track';
    const notes = UI.button('Notes', 'ico-notes'); notes.dataset.action = 'notes';
    const ignore = UI.button('Ignore', 'ico-ignore'); ignore.dataset.action = 'ignore';
    const link = UI.button('Link', 'ico-link-incident'); link.dataset.action = 'link';
    wrapper.append(track, notes, link, ignore);
    link.addEventListener('click', () => {
      const snapshot = getSnapshot(); if (!snapshot || !db || editor?.panel.isConnected) return;
      const selectedReport = report();
      const onChange = async payload => { db = await request('link-incidents', payload); refreshControls(); return db; };
      if (selectedReport.entries[snapshot.id]?.tracked || M.relatedEntries(selectedReport, snapshot.id).length) {
        editor = UI.openRelatedIncidents({ db, reportId: selectedReport.id, incidentId: snapshot.id, onChange, returnFocus: link });
      } else editor = UI.openLinkPicker({ db, reportId: selectedReport.id, incident: { id: snapshot.id, ...metadata(snapshot) }, onChange, returnFocus: link });
    });
    if (!mitigate.managedFrame()) {
      const quick = UI.button('Mitigate', 'ico-mitigate-button'); quick.dataset.action = 'mitigate';
      quick.title = 'Mitigate in ICM: Auto recovered / Transient / Not caused by a change / Global if no region is recorded. Correlated incidents may also be affected.';
      quick.addEventListener('click', async event => {
        // Only a deliberate user action may start an official incident change.
        if (!event.isTrusted) return;
        const snapshot = getSnapshot(); if (!snapshot || !db) return;
        const selectedReport = report();
        try {
          const result = await mitigate.start(snapshot.id);
          if (result?.status) {
            db = await request('observe', { reportId: selectedReport.id, snapshots: [{ id: snapshot.id, status: result.status }] });
            refreshControls();
          }
        } catch (error) { UI.toast(error.message, true); }
      });
      wrapper.append(quick);
    }
    for (const name of ['pointerdown', 'mousedown', 'click', 'dblclick', 'keydown', 'keyup']) wrapper.addEventListener(name, event => event.stopPropagation());
    track.addEventListener('click', async () => {
      const snapshot = getSnapshot();
      if (!snapshot || !db) return;
      const selectedReport = report();
      const ignored = M.isIgnored(db, snapshot.id);
      const tracked = ignored || !selectedReport.entries[snapshot.id]?.tracked;
      track.disabled = true;
      try { db = await request('save', { reportId: selectedReport.id, incidentId: snapshot.id, patch: { ...metadata(snapshot), tracked }, restoreIgnored: ignored, baseIgnored: ignored }); refreshControls(); }
      catch (error) { UI.toast(error.message, true); }
      finally { track.disabled = false; refreshControls(); }
    });
    ignore.addEventListener('click', async () => {
      const snapshot = getSnapshot(); if (!snapshot || !db) return;
      const selectedReport = report(); const ignored = !M.isIgnored(db, snapshot.id);
      ignore.disabled = true;
      try {
        db = await request('ignore', { reportId: selectedReport.id, incidentId: snapshot.id, ignored, title: snapshot.title || selectedReport.entries[snapshot.id]?.title || '' });
        refreshControls(); UI.toast(ignored ? 'Ignored. Restore it from Ignored incidents at any time.' : 'Restored to the query list. Not added to this report.');
      } catch (error) { UI.toast(error.message, true); }
      finally { ignore.disabled = false; }
    });
    notes.addEventListener('click', () => openNotes(getSnapshot(), notes));
    return wrapper;
  }
  function enhance() {
    if (!db) return;
    const snapshots = [];
    for (const row of document.querySelectorAll(ROWS)) {
      const snapshot = rowSnapshot(row);
      const old = row.querySelector('.ico-row-actions');
      if (!snapshot?.cell) { old?.remove(); if (row.classList.contains('ico-row-hidden')) row.classList.remove('ico-row-hidden'); continue; }
      if (!old || old.parentElement !== snapshot.cell) {
        old?.remove(); snapshot.cell.prepend(controls(() => rowSnapshot(row), 'ico-row-actions')); snapshot.cell.classList.add('ico-incident-cell');
      }
      snapshots.push({ id: snapshot.id, ...metadata(snapshot) });
    }
    const detail = detailSnapshot();
    let dock = document.querySelector('.ico-detail-actions');
    if (detail && !dock && !mitigate.managedFrame()) { dock = controls(detailSnapshot, 'ico-detail-actions'); document.body.appendChild(dock); }
    else if (!detail) dock?.remove();
    if (detail) snapshots.push({ id: detail.id, ...metadata(detail) });
    for (const snapshot of snapshots) if (snapshot.status && mitigate.result(snapshot.id) === snapshot.status) mitigate.clearResult(snapshot.id);
    if (window.top === window.self && !toolbar?.isConnected) {
      toolbar = UI.node('div', 'ico-toolbar');
      const name = UI.node('span', 'ico-report-name');
      const open = UI.button('On-call dashboard', 'ico-primary');
      open.addEventListener('click', () => request('open').catch(error => UI.toast(error.message, true)));
      const ignored = UI.button('Ignored', 'ico-subtle'); ignored.dataset.action = 'open-ignored';
      ignored.addEventListener('click', () => request('open-ignored').catch(error => UI.toast(error.message, true)));
      const filters = UI.node('div', 'ico-list-filters');
      for (const [key, label] of [['showTracked', 'Show tracked / linked'], ['showIgnored', 'Show ignored']]) {
        const wrapper = UI.node('label', 'ico-filter-check'); const input = UI.node('input'); input.type = 'checkbox'; input.name = key;
        input.addEventListener('change', async () => {
          input.disabled = true;
          try { db = await request('list-preferences', { patch: { [key]: input.checked } }); }
          catch (error) { UI.toast(error.message, true); }
          finally { input.disabled = false; refreshControls(); }
        });
        wrapper.append(input, UI.node('span', '', label)); filters.append(wrapper);
      }
      const count = UI.node('span', 'ico-hidden-count'); count.setAttribute('role', 'status'); count.title = 'Local filtering of loaded rows only. ICM totals and pagination are unchanged.';
      filters.append(count);
      toolbar.append(name, open, ignored, filters); document.body.appendChild(toolbar);
    }
    refreshControls();
    // Only publish new metadata, except that a newly tracked incident can use
    // an already visible creation date. Never replay stale title/status fields
    // when it is tracked from the dashboard, local API or another tab.
    if (observing) return;
    const changed = snapshots.flatMap(snapshot => {
      const key = `${report().id}:${snapshot.id}`;
      const signature = JSON.stringify(metadata(snapshot));
      const previous = observedSnapshots.get(key);
      const entry = report().entries[snapshot.id];
      const eligible = !!(entry?.tracked || M.linkedSummary(M.reportForDisplay(db), snapshot.id)) && !M.isIgnored(db, snapshot.id);
      observedSnapshots.set(key, { signature, eligible });
      if (!eligible) return [];
      const candidate = previous?.signature !== signature ? snapshot
        : !previous.eligible && snapshot.day && !M.createdDay(entry.day) ? { id: snapshot.id, day: snapshot.day } : null;
      return candidate && METADATA_FIELDS.some(field => candidate[field] && candidate[field] !== entry[field]) ? [candidate] : [];
    });
    if (changed.length) {
      observing = true;
      request('observe', { reportId: report().id, snapshots: changed })
        .then(value => { db = value; refreshControls(); }).catch(error => UI.toast(error.message, true)).finally(() => { observing = false; enhance(); });
    }
  }
  const observer = new MutationObserver(mutations => {
    if (!mutations.some(mutation => {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      if (target?.closest('.ico-row-actions, .ico-detail-actions, .ico-overlay, .ico-toolbar, .ico-toast, .ico-mitigation')) return false;
      if (mutation.type === 'attributes' || mutation.type === 'characterData') return true;
      if ([...mutation.removedNodes].some(node => node.nodeType === 1 && node.matches('.ico-row-actions') && target?.closest(ROWS))) return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(node => node.nodeType === 3 || (node.nodeType === 1 && !node.matches('.ico-row-actions, .ico-detail-actions, .ico-overlay, .ico-toolbar, .ico-toast, .ico-mitigation')));
    })) return;
    clearTimeout(timer); timer = setTimeout(enhance, 80);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[M.STORAGE_KEY]?.newValue) return;
    db = changes[M.STORAGE_KEY].newValue; refreshControls();
    clearTimeout(timer); timer = setTimeout(enhance, 80);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['href', 'aria-selected', 'aria-checked', 'checked', 'class'] });
  mitigate.subscribe(refreshControls);
  document.addEventListener('change', event => {
    if (event.target.closest?.(ROWS) && !event.target.closest('.ico-row-actions')) { clearTimeout(timer); timer = setTimeout(enhance, 0); }
  }, true);
  setInterval(() => { if (location.href !== currentUrl) { currentUrl = location.href; enhance(); } }, 500);
  request('get').then(value => { db = value; enhance(); }).catch(error => UI.toast(error.message, true));
})();
