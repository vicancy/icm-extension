(() => {
  const M = IcmOncall;
  const UI = IcmOncallUI;
  const request = IcmOncallClient.request;
  const mitigate = IcmQuickMitigate;
  const ROWS = '.ms-DetailsRow[role="row"], .searchresults-k-grid .k-grid-content tr[role="row"]';
  const METADATA_FIELDS = M.METADATA_FIELDS;
  let db, toolbar, detailActions, editor, timer;
  let observing = false, observationReadback = false, bulkBusy = false;
  const observations = IcmObservations.create(M);
  const deselectionAttempts = new WeakMap();
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
  const isQueryPage = () => /\/incidents\/(?:queries|search)(?:\/|$)/i.test(location.pathname);
  const rowSelected = row => row.getAttribute('aria-selected') === 'true' || row.classList.contains('k-state-selected') || [...row.querySelectorAll('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]')].some(item => !item.closest('.ico-row-actions'));
  function listContext() {
    const selectedReport = report();
    return { report: selectedReport, displayedReport: M.reportForDisplay(db, selectedReport.id), isQuery: isQueryPage(),
      rows: new Map([...document.querySelectorAll(ROWS)].map(row => [row, rowSnapshot(row)])) };
  }
  function rowFiltered(snapshot, context) {
    if (!context.isQuery || !snapshot) return false;
    const ignored = M.isIgnored(db, snapshot.id);
    const tracked = !ignored && context.report.entries[snapshot.id]?.tracked;
    const linked = M.linkedSummary(context.displayedReport, snapshot.id);
    const mitigated = /^Mitigated$/i.test(mitigate.result(snapshot.id) || snapshot.status || '');
    return !!((db.listPreferences?.hideMitigated && mitigated)
      || (ignored ? !db.listPreferences?.showIgnored : (tracked || linked) && !db.listPreferences?.showTracked));
  }
  function selectionCheckbox(row) {
    return [...row.querySelectorAll('[role="checkbox"][data-selection-toggle="true"], input[type="checkbox"], [role="checkbox"]')]
      .find(item => !item.disabled && item.getAttribute('aria-disabled') !== 'true' && !item.closest('.ico-row-actions'));
  }
  function toggleSelection(checkbox) {
    // Fluent remembers modifiers from mousedown. Clear Shift/Ctrl for each
    // individual toggle so cleaning up a range cannot extend that range again.
    checkbox.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
    checkbox.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    checkbox.click();
  }
  function selectedIncidents(context = listContext()) {
    if (!context.isQuery) return [];
    const selected = new Map();
    for (const [row, snapshot] of context.rows) {
      if (!rowSelected(row)) continue;
      if (snapshot && !rowFiltered(snapshot, context)) selected.set(snapshot.id, { id: snapshot.id, ...metadata(snapshot), status: mitigate.result(snapshot.id) || snapshot.status });
    }
    return [...selected.values()];
  }
  function deselectIncidents(incidents) {
    const ids = new Set(incidents.map(item => item.id));
    for (const row of document.querySelectorAll(ROWS)) {
      if (!ids.has(rowSnapshot(row)?.id) || !rowSelected(row)) continue;
      // Let ICM update its selection model before filtering the row.
      const checkbox = selectionCheckbox(row);
      if (checkbox) toggleSelection(checkbox);
    }
  }
  function filterRows(context = listContext()) {
    const isQuery = context.isQuery;
    let hidden = 0, selected = 0;
    for (const [row, snapshot] of context.rows) {
      const shouldHide = rowFiltered(snapshot, context);
      if (shouldHide && rowSelected(row)) {
        const checkbox = selectionCheckbox(row);
        if (checkbox && deselectionAttempts.get(row)?.id !== snapshot.id) {
          const attempt = { id: snapshot.id, settled: false };
          deselectionAttempts.set(row, attempt);
          // Update ICM's actual selection model, not just its ARIA attributes.
          toggleSelection(checkbox);
          requestAnimationFrame(() => {
            if (deselectionAttempts.get(row) !== attempt) return;
            attempt.settled = true; refreshControls();
          });
        }
      } else deselectionAttempts.delete(row);
      const isSelected = rowSelected(row);
      const pending = deselectionAttempts.get(row)?.settled === false;
      // If native deselection is unavailable, keep the selected row visible
      // and block bulk actions rather than concealing an official target.
      const hide = shouldHide && (!isSelected || pending);
      if (row.classList.contains('ico-row-hidden') !== hide) row.classList.toggle('ico-row-hidden', hide);
      if (hide) hidden++;
      else if (shouldHide && isSelected) selected++;
    }
    if (toolbar) {
      toolbar.querySelector('.ico-list-filters').hidden = !isQuery;
      toolbar.querySelector('[name="showTracked"]').checked = !!db.listPreferences?.showTracked;
      toolbar.querySelector('[name="showIgnored"]').checked = !!db.listPreferences?.showIgnored;
      toolbar.querySelector('[data-action="hide-mitigated"]').setAttribute('aria-pressed', String(!!db.listPreferences?.hideMitigated));
      toolbar.querySelector('.ico-hidden-count').textContent = `${hidden} hidden${selected ? ` · ${selected} selected kept visible` : ''}`;
      toolbar.querySelector('[data-action="open-ignored"]').textContent = `Ignored (${M.ignoredEntries(db).length})`;
      const selectedItems = selectedIncidents(context);
      const bulk = toolbar.querySelector('.ico-bulk-actions');
      bulk.hidden = !isQuery || (!selectedItems.length && !bulkBusy);
      bulk.querySelector('.ico-selected-count').textContent = `${selectedItems.length} selected`;
      for (const button of bulk.querySelectorAll('button')) button.disabled = !selectedItems.length || bulkBusy || mitigate.busy();
      if (selectedItems.length && selectedItems.every(item => /^(Mitigated|Resolved)$/i.test(item.status || ''))) bulk.querySelector('[data-action="mitigate-selected"]').disabled = true;
    }
  }
  const SELECT_ALL = '.ms-DetailsHeader [role="checkbox"], .ms-DetailsHeader input[type="checkbox"], .searchresults-k-grid .k-grid-header input[type="checkbox"]';
  function selectVisibleRows(event) {
    if (!db || !isQueryPage()) return;
    const target = event.target.closest?.('*');
    if (!target || target.closest('.ico-toolbar, .ico-overlay, .ico-row-actions, .ico-mitigation')) return;
    const header = target.closest(SELECT_ALL);
    const shortcut = event.type === 'keydown' && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a';
    if (shortcut && target.closest('input, textarea, [role="textbox"], [contenteditable="true"], [contenteditable=""]')) return;
    if (!shortcut && (!header || (event.type === 'keydown' && ![' ', 'Enter'].includes(event.key)))) return;
    const scope = target.closest('.ms-DetailsList, .searchresults-k-grid, [role="grid"]');
    if (!scope) return;
    const context = listContext();
    const rows = [...context.rows].filter(([row]) => scope.contains(row));
    if (!rows.some(([, snapshot]) => rowFiltered(snapshot, context))) return;
    const visible = rows.filter(([, snapshot]) => !rowFiltered(snapshot, context)).map(([row]) => row);
    if (visible.some(row => !selectionCheckbox(row))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    // The native header is mixed when only visible rows are selected. Base
    // its next toggle on those rows so a second click still clears selection.
    const select = shortcut || (visible.length > 0 && !visible.every(rowSelected));
    for (const row of visible) if (rowSelected(row) !== select) toggleSelection(selectionCheckbox(row));
    filterRows(context);
  }
  document.addEventListener('click', selectVisibleRows, true);
  document.addEventListener('keydown', selectVisibleRows, true);
  document.addEventListener('click', event => {
    if (!db || !isQueryPage() || !event.target.closest?.('[role="menubar"][aria-label="Bulk actions"]')) return;
    const context = listContext();
    filterRows(context);
    if ([...context.rows].some(([row, snapshot]) => rowFiltered(snapshot, context) && rowSelected(row))) {
      event.preventDefault(); event.stopImmediatePropagation();
      UI.toast('Clear the filtered incidents from the selection before using this action.', true);
    }
  }, true);
  function refreshControls(context) {
    if (!db) return;
    context ||= listContext();
    const related = M.relatedIndex(context.report);
    for (const controls of document.querySelectorAll('.ico-row-actions, .ico-detail-actions')) {
      const row = controls.closest(ROWS);
      const snapshot = row ? context.rows.get(row) : controls._snapshot?.();
      if (!snapshot) { controls.hidden = true; continue; }
      if (row) controls.hidden = false;
      const entry = context.report.entries[snapshot.id];
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
      const relatedCount = related.get(snapshot.id)?.length || 0;
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
        quick.disabled = mitigate.busy() || done;
        quick.setAttribute('aria-label', `${done ? status : 'Mitigate'} incident ${snapshot.id}`);
      }
    }
    if (toolbar) {
      const name = toolbar.querySelector('.ico-report-name'); name.textContent = context.report.name; name.title = context.report.name;
    }
    filterRows(context);
  }
  function bulkControls() {
    const wrapper = UI.node('div', 'ico-bulk-actions'); wrapper.hidden = true;
    const count = UI.node('strong', 'ico-selected-count');
    const link = UI.button('Link'); link.dataset.action = 'link-selected'; link.setAttribute('aria-label', 'Link selected incidents');
    const ignore = UI.button('Ignore'); ignore.dataset.action = 'ignore-selected'; ignore.setAttribute('aria-label', 'Ignore selected incidents');
    const quick = UI.button('Mitigate', 'ico-mitigate-button'); quick.dataset.action = 'mitigate-selected'; quick.setAttribute('aria-label', 'Mitigate selected incidents');
    const status = UI.node('span', 'ico-bulk-status'); status.setAttribute('role', 'status');
    function showStatus(message, error = false) { status.textContent = message; status.title = message; status.classList.toggle('ico-error', error); }
    link.addEventListener('click', () => {
      const incidents = selectedIncidents();
      if (!incidents.length || bulkBusy || mitigate.busy() || editor?.panel.isConnected) return;
      const sourceUrl = location.href;
      editor = UI.openLinkPicker({ db, reportId: report().id, incidents, returnFocus: link, onChange: async payload => {
        db = await request('link-incidents', payload);
        if (payload.targetId && location.href === sourceUrl && report().id === payload.reportId) deselectIncidents(incidents);
        refreshControls();
        showStatus(`${payload.incidents.length} linked.`); return db;
      } });
    });
    ignore.addEventListener('click', async () => {
      const incidents = selectedIncidents();
      if (!incidents.length || bulkBusy || mitigate.busy()) return;
      const selectedReport = report(), sourceUrl = location.href;
      const payload = { reportId: selectedReport.id, incidents, ignored: true,
        ...M.triageBase(db, selectedReport.id, incidents),
      };
      bulkBusy = true; showStatus('Ignoring…'); refreshControls();
      try {
        db = await request('ignore-incidents', payload);
        if (location.href === sourceUrl && report().id === selectedReport.id) deselectIncidents(incidents);
        showStatus(`${incidents.length} ignored.`);
      }
      catch (error) { showStatus(error.message, true); }
      finally { bulkBusy = false; refreshControls(); }
    });
    quick.addEventListener('click', async event => {
      // The batch is an official ICM action, authorized only by a real click.
      if (!event.isTrusted || bulkBusy || mitigate.busy()) return;
      const incidents = selectedIncidents(); if (!incidents.length) return;
      const selectedReportId = report().id, sourceUrl = location.href;
      bulkBusy = true; showStatus('Mitigating…'); refreshControls();
      try {
        const result = await mitigate.startBatch(incidents, {
          shouldContinue: () => location.href === sourceUrl && report().id === selectedReportId,
          onResult: async (id, result) => {
            db = await request('observe', { reportId: selectedReportId, snapshots: [{ id, status: result.status }] });
            refreshControls();
          },
        });
        showStatus(`${result.completed.length} mitigated · ${result.skipped.length} skipped${result.stoppedAt ? ` · Stopped at #${result.stoppedAt}: ${result.error}` : ''}`, !!result.stoppedAt);
      } catch (error) { showStatus(error.message, true); }
      finally { bulkBusy = false; refreshControls(); }
    });
    wrapper.append(count, link, ignore, quick, status);
    return wrapper;
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
  function positionToolbar() {
    if (!toolbar) return;
    const query = isQueryPage();
    const detail = !!M.incidentId(location.href);
    const anchor = query && (document.querySelector('[role="menubar"][aria-label="Bulk actions"]')?.closest('.ms-Stack')
      || document.querySelector('.searchresults-k-grid'));
    // Keep workspace navigation in the incident action bar on detail pages.
    // Both inline placements wait for their native anchor during remounts.
    const hidden = query ? !anchor : detail && (!detailActions?.isConnected || detailActions.hidden);
    if (hidden && !toolbar.hidden) toolbar.hidden = true;
    if (toolbar.classList.contains('ico-toolbar-inline') !== query) toolbar.classList.toggle('ico-toolbar-inline', query);
    if (toolbar.classList.contains('ico-toolbar-detail') !== detail) toolbar.classList.toggle('ico-toolbar-detail', detail);
    if (detail && detailActions) {
      if (toolbar.parentElement !== detailActions) detailActions.appendChild(toolbar);
    } else if (anchor) {
      if (toolbar.nextElementSibling !== anchor) anchor.before(toolbar);
    } else if (toolbar.parentElement !== document.body) document.body.appendChild(toolbar);
    if (toolbar.hidden !== hidden) toolbar.hidden = hidden;
  }
  function positionDetailActions(detail) {
    if (!detail || mitigate.managedFrame()) { detailActions?.remove(); detailActions = null; return; }
    if (!detailActions) {
      detailActions = controls(detailSnapshot, 'ico-detail-actions');
      detailActions.setAttribute('role', 'group');
      detailActions.setAttribute('aria-label', 'MeOncall incident actions');
      detailActions.hidden = true;
    }
    const anchor = document.querySelector('#incident-details-container [aria-label="action-bar"]');
    // Stay in the page flow, below native overlays. Never cover form footers
    // while the incident action bar is loading or being remounted.
    if (anchor) {
      if (detailActions.nextElementSibling !== anchor) anchor.before(detailActions);
    } else {
      if (!detailActions.hidden) detailActions.hidden = true;
      if (detailActions.parentElement !== document.body) document.body.appendChild(detailActions);
    }
    if (detailActions.hidden !== !anchor) detailActions.hidden = !anchor;
  }
  function enhance() {
    if (!db) return;
    const context = listContext();
    const snapshots = [];
    for (const [row, snapshot] of context.rows) {
      const old = row.querySelector('.ico-row-actions');
      if (!snapshot?.cell) { old?.remove(); if (row.classList.contains('ico-row-hidden')) row.classList.remove('ico-row-hidden'); continue; }
      if (!old || old.parentElement !== snapshot.cell) {
        old?.remove(); snapshot.cell.prepend(controls(() => rowSnapshot(row), 'ico-row-actions'));
      }
      snapshots.push({ id: snapshot.id, ...metadata(snapshot) });
    }
    const detail = detailSnapshot();
    positionDetailActions(detail);
    if (detail) snapshots.push({ id: detail.id, ...metadata(detail) });
    for (const snapshot of snapshots) if (snapshot.status && mitigate.result(snapshot.id) === snapshot.status) mitigate.clearResult(snapshot.id);
    if (window.top === window.self && !toolbar) {
      toolbar = UI.node('div', 'ico-toolbar');
      toolbar.hidden = true;
      const name = UI.node('span', 'ico-report-name');
      const open = UI.button('MeOncall dashboard', 'ico-primary');
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
      const hideMitigated = UI.button('Hide mitigated', 'ico-hide-mitigated'); hideMitigated.dataset.action = 'hide-mitigated';
      hideMitigated.addEventListener('click', async () => {
        hideMitigated.disabled = true;
        try { db = await request('list-preferences', { patch: { hideMitigated: !db.listPreferences?.hideMitigated } }); }
        catch (error) { UI.toast(error.message, true); }
        finally { hideMitigated.disabled = false; refreshControls(); }
      });
      const count = UI.node('span', 'ico-hidden-count'); count.setAttribute('role', 'status'); count.title = 'Local filtering of loaded rows only. ICM totals and pagination are unchanged.';
      filters.append(hideMitigated, count);
      toolbar.append(name, open, ignored, filters, bulkControls());
    }
    positionToolbar();
    refreshControls(context);
    publishObservations(snapshots, context);
  }
  async function publishObservations(snapshots, context) {
    if (observing) return;
    observing = true;
    let saved = false;
    try {
      if (observationReadback) {
        // A missing acknowledgement may still have committed the update.
        db = await request('get');
        observationReadback = false;
        context = { report: M.currentReport(db, context.report.id), displayedReport: M.reportForDisplay(db, context.report.id) };
        refreshControls();
      }
      const batch = observations.collect(context.report, context.displayedReport, snapshots);
      if (!batch.snapshots.length) return;
      db = await request('observe', batch);
      saved = true;
      refreshControls();
    } catch (error) {
      observationReadback = true;
      UI.toast(error.message, true);
    } finally {
      observing = false;
      // Reconcile changes that arrived during a successful save. On failure,
      // retain pending metadata until the next page/storage update, without a retry loop.
      if (saved) enhance();
    }
  }
  const observer = new MutationObserver(mutations => {
    // Reconcile range/keyboard selection before painting hidden rows or
    // exposing them to a bulk action; other page enhancement stays debounced.
    if (db && mutations.some(mutation => mutation.type === 'attributes'
      && ['aria-selected', 'aria-checked', 'checked', 'class'].includes(mutation.attributeName)
      && mutation.target.closest?.(ROWS) && !mutation.target.closest('.ico-row-actions'))) filterRows();
    if (!mutations.some(mutation => {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      if (target?.closest('.ico-row-actions, .ico-detail-actions, .ico-overlay, .ico-toolbar, .ico-toast, .ico-mitigation')) return false;
      if (mutation.type === 'attributes' || mutation.type === 'characterData') return true;
      if ([...mutation.removedNodes].some(node => node.nodeType === 1 && node.matches('.ico-row-actions') && target?.closest(ROWS))) return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(node => node.nodeType === 3 || (node.nodeType === 1 && !node.matches('.ico-row-actions, .ico-detail-actions, .ico-overlay, .ico-toolbar, .ico-toast, .ico-mitigation')));
    })) return;
    positionToolbar();
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
