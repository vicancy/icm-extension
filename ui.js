(() => {
  const M = IcmOncall;
  const LONG_FIELDS = new Set(['rootCause', 'resolution', 'notes', 'errorMessage', 'relatedLinks']);
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(text, className = '') {
    const element = node('button', `ico-button ${className}`, text);
    element.type = 'button';
    return element;
  }
  function toast(message, error = false) {
    const element = node('div', `ico-toast${error ? ' ico-error' : ''}`, message);
    element.setAttribute('role', error ? 'alert' : 'status');
    document.body.appendChild(element);
    setTimeout(() => element.remove(), error ? 10000 : 4000);
  }
  function modal(title, subtitle, returnFocus, submitLabel = 'Save', trackChanges = true) {
    const overlay = node('div', 'ico-overlay');
    const panel = node('section', 'ico-editor');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', title);
    const header = node('header', 'ico-editor-header');
    const heading = node('div');
    heading.append(node('h2', '', title), node('p', 'ico-muted', subtitle));
    const close = button('×', 'ico-close');
    close.setAttribute('aria-label', 'Close editor');
    header.append(heading, close);
    const form = node('form', 'ico-editor-form');
    const body = node('div', 'ico-editor-body');
    const footer = node('footer', 'ico-editor-footer');
    const status = node('p', 'ico-form-status');
    status.setAttribute('role', 'status');
    const cancel = button('Cancel');
    const save = button(submitLabel, 'ico-primary');
    save.type = 'submit';
    footer.append(status, cancel, save);
    form.append(body, footer);
    panel.append(header, form);
    overlay.append(panel);
    const controller = new AbortController();
    let dirty = false;
    let busy = false;
    const destroy = () => {
      controller.abort();
      overlay.remove();
      if (returnFocus?.isConnected) returnFocus.focus();
    };
    const dismiss = () => {
      if (busy) return;
      if (dirty && !window.confirm('Discard your unsaved changes?')) return;
      destroy();
    };
    form.addEventListener('input', () => { if (trackChanges) { dirty = true; panel.dataset.dirty = 'true'; } });
    form.addEventListener('change', () => { if (trackChanges) { dirty = true; panel.dataset.dirty = 'true'; } });
    close.addEventListener('click', dismiss);
    cancel.addEventListener('click', dismiss);
    overlay.addEventListener('click', event => { if (event.target === overlay) dismiss(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismiss();
      } else if (event.key === 'Tab') {
        const items = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')];
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    }, { capture: true, signal: controller.signal });
    for (const name of ['pointerdown', 'mousedown', 'click', 'keydown', 'keyup']) overlay.addEventListener(name, event => event.stopPropagation());
    document.body.appendChild(overlay);
    return { body, form, save, status, destroy, panel, markClean() { dirty = false; delete panel.dataset.dirty; }, setBusy(value) {
      busy = value;
      panel.dataset.busy = String(value);
      for (const input of form.querySelectorAll('input, textarea, select')) input.disabled = value;
      save.disabled = close.disabled = cancel.disabled = value;
      save.textContent = value ? 'Saving…' : submitLabel;
    } };
  }
  function field(key, label, value, limit, type = 'text') {
    const wrapper = node('label', `ico-field${LONG_FIELDS.has(key) || key === 'title' ? ' ico-full' : ''}`);
    wrapper.append(node('span', 'ico-field-label', label));
    let input;
    if (key === 'reportedByCustomer') {
      input = node('select', 'ico-input');
      for (const option of ['', 'Yes', 'No']) {
        const element = node('option', '', option); element.value = option; input.append(element);
      }
    } else {
      input = node(LONG_FIELDS.has(key) ? 'textarea' : 'input', 'ico-input');
      if (LONG_FIELDS.has(key)) input.rows = key === 'notes' ? 5 : 3;
      else input.type = type;
      input.maxLength = limit;
    }
    input.name = key; input.value = value || ''; wrapper.append(input);
    return { wrapper, input };
  }
  function openEditor({ report, entry, snapshot = {}, ignored = false, onSave, returnFocus }) {
    const base = { ...M.emptyEntry(entry.id), ...entry };
    const editor = modal(`Incident ${entry.id}`, `${report.name} · Saved only to this extension`, returnFocus);
    const open = node('a', 'ico-link', 'Open in ICM ↗');
    open.href = M.incidentUrl(entry.id); open.target = '_blank'; open.rel = 'noopener noreferrer';
    const include = node('label', 'ico-check');
    const tracked = node('input'); tracked.type = 'checkbox'; tracked.name = 'tracked'; tracked.checked = entry.tracked && !ignored;
    include.append(tracked, node('span', '', 'Track this incident in the current report'));
    editor.body.append(open, include);
    if (ignored) editor.body.append(node('p', 'ico-muted', 'Ignored across reports. Checking Track also restores this incident.'));
    const grid = node('div', 'ico-fields');
    const inputs = new Map();
    const ordered = ['rootCause', 'resolution', 'notes', 'summaryGroup', 'title', 'day', 'severity', 'status', 'category', 'reportedByCustomer', 'customersImpacted', 'occurrences', 'errorMessage', 'relatedLinks'];
    for (const key of ordered) {
      const [, label, limit] = M.FIELDS.find(([name]) => name === key);
      const value = key === 'day' ? M.createdDay(snapshot.day || entry.day) : M.knownText(entry[key] || snapshot[key]);
      const { wrapper, input } = field(key, label, value, limit);
      if (key === 'summaryGroup') { wrapper.classList.add('ico-full'); input.placeholder = 'Optional: use the same name to combine related incidents in the export'; }
      if (key === 'relatedLinks') input.placeholder = 'Supporting links, included in Notes; the Bug column links to this incident automatically';
      if (key === 'rootCause') input.placeholder = 'Concise root cause summary; leave blank if not established';
      if (key === 'notes') input.placeholder = 'Analysis, supporting evidence, timestamps and correlation IDs';
      if (key === 'errorMessage') input.placeholder = 'Exception or error message from the logs; leave blank if unavailable';
      if (key === 'day') {
        input.readOnly = true;
        input.placeholder = 'Captured from ICM Created Time';
        input.title = 'ICM creation date, as displayed on the incident list or native Duration card';
      }
      inputs.set(key, input); grid.append(wrapper);
    }
    editor.body.append(grid);
    editor.form.addEventListener('submit', async event => {
      event.preventDefault();
      if (editor.save.disabled) return;
      const patch = {}; const expected = {};
      for (const [key, input] of inputs) if (input.value.trim() !== base[key]) { patch[key] = input.value.trim(); expected[key] = base[key]; }
      if (tracked.checked !== base.tracked) { patch.tracked = tracked.checked; expected.tracked = base.tracked; }
      editor.setBusy(true); editor.status.textContent = '';
      try { await onSave(patch, expected); editor.destroy(); toast('Incident notes saved.'); }
      catch (error) { editor.status.textContent = error.message || 'Could not save your notes. Your draft is still here.'; editor.status.classList.add('ico-error'); editor.setBusy(false); }
    });
    inputs.get('rootCause').focus();
    return editor;
  }
  function editReport(report, onSave, returnFocus) {
    const editor = modal(report ? 'Report settings' : 'New on-call report', 'Choose the period covered by this handoff.', returnFocus);
    const fields = [field('name', 'Report name', report?.name || '', 160), field('startDate', 'Start date', report?.startDate, 10, 'date'), field('endDate', 'End date', report?.endDate, 10, 'date')];
    fields[0].input.required = true; editor.body.append(...fields.map(item => item.wrapper));
    editor.form.addEventListener('submit', async event => {
      event.preventDefault(); editor.setBusy(true);
      try { await onSave(Object.fromEntries(fields.map(({ input }) => [input.name, input.value]))); editor.destroy(); }
      catch (error) { editor.status.textContent = error.message; editor.status.classList.add('ico-error'); editor.setBusy(false); }
    });
    fields[0].input.focus();
  }
  function linkPayload(db, reportId, targetId, incidents) {
    return { reportId, targetId, incidents, ...M.triageBase(db, reportId, incidents) };
  }
  function openLinkPicker({ db, reportId, incident, incidents = [incident], onChange, returnFocus }) {
    const report = M.currentReport(db, reportId);
    const single = incidents.length === 1 ? incidents[0] : null;
    const editor = modal('Link to tracked incident', `${single ? `#${single.id}` : `${incidents.length} selected`} · ${report.name}`, returnFocus, 'Save', false);
    editor.save.remove();
    let busy = false;
    const candidates = M.trackedEntries(M.reportForDisplay(db, reportId)).filter(item => item.id !== single?.id && !item.summaryIncidentId);
    const search = node('input', 'ico-input'); search.type = 'search'; search.placeholder = 'Find tracked incident'; search.setAttribute('aria-label', 'Find tracked incident');
    const searchField = node('div', 'ico-field'); searchField.append(search);
    const choices = node('div', 'ico-summary-choices');
    const currentTarget = single && report.entries[single.id]?.summaryIncidentId;
    async function choose(targetId) {
      if (busy) return;
      busy = true; editor.setBusy(true); editor.status.textContent = '';
      try {
        // The selected main incident remains tracked if it is in the batch.
        await onChange(linkPayload(db, reportId, targetId, incidents.filter(item => item.id !== targetId)));
        editor.destroy(); toast(targetId ? `Linked to #${targetId}.` : 'Incident unlinked.');
      } catch (error) { editor.status.textContent = error.message; editor.status.classList.add('ico-error'); editor.setBusy(false); busy = false; }
    }
    if (currentTarget) {
      const current = node('div', 'ico-related-item'); const link = node('a', 'ico-link', `#${currentTarget}`); link.href = M.incidentUrl(currentTarget); link.target = '_blank'; link.rel = 'noopener noreferrer';
      const unlink = button('Unlink'); unlink.addEventListener('click', () => choose(''));
      current.append(link, unlink); editor.body.append(current);
    }
    function renderChoices() {
      const query = search.value.toLowerCase().trim();
      const matches = candidates.filter(item => `${item.id} ${item.title} ${item.rootCause}`.toLowerCase().includes(query));
      choices.replaceChildren(...matches.map(item => {
        const choice = button('', 'ico-summary-choice'); choice.dataset.incidentId = item.id;
        choice.append(node('strong', '', `#${item.id} ${item.title || ''}`));
        if (item.rootCause) choice.append(node('span', '', item.rootCause.slice(0, 180)));
        choice.addEventListener('click', () => choose(item.id)); return choice;
      }));
      if (!matches.length) choices.append(node('p', 'ico-muted', candidates.length ? 'No matching tracked incidents.' : 'Track a main incident first.'));
    }
    const selectedIds = new Set(incidents.map(item => item.id));
    if (Object.values(report.entries).some(item => selectedIds.has(item.summaryIncidentId))) {
      editor.body.append(node('p', 'ico-muted', 'Existing related ICMs move with their summary. The summary\'s saved Notes are appended once.'));
    }
    editor.body.append(searchField, choices);
    search.addEventListener('input', renderChoices);
    editor.form.addEventListener('submit', event => event.preventDefault());
    renderChoices(); search.focus();
    return editor;
  }
  function openRelatedIncidents({ db, reportId, incidentId, onChange, returnFocus }) {
    const editor = modal('Related ICMs', `#${incidentId} · ${M.currentReport(db, reportId).name}`, returnFocus, 'Add');
    let currentDb = db, busy = false;
    const list = node('div', 'ico-related-list');
    const wrapper = node('label', 'ico-field'); wrapper.append(node('span', 'ico-field-label', 'Add incident IDs or URLs'));
    const input = node('textarea', 'ico-input'); input.name = 'relatedIncidents'; input.rows = 3; input.maxLength = 20000; input.placeholder = '123456789, 987654321'; wrapper.append(input);
    editor.body.append(list, wrapper, node('p', 'ico-muted', 'Adding a summary also moves its related ICMs. The summary\'s saved Notes are appended once.'));
    function renderList() {
      const report = M.currentReport(currentDb, reportId);
      list.replaceChildren(...M.relatedEntries(report, incidentId).map(entry => {
        const row = node('div', 'ico-related-item');
        const link = node('a', 'ico-link', `#${entry.id}${entry.title ? ` · ${entry.title}` : ''}`); link.href = M.incidentUrl(entry.id); link.target = '_blank'; link.rel = 'noopener noreferrer';
        if (M.isIgnored(currentDb, entry.id)) link.append(node('span', 'ico-muted', ' (Ignored)'));
        const unlink = button('Unlink', 'ico-subtle'); unlink.setAttribute('aria-label', `Unlink incident ${entry.id}`);
        unlink.addEventListener('click', () => update('', [{ id: entry.id }])); row.append(link, unlink); return row;
      }));
      list.hidden = !list.childElementCount;
    }
    async function update(targetId, incidents) {
      if (busy) return;
      busy = true; editor.setBusy(true); editor.status.textContent = ''; editor.status.classList.remove('ico-error');
      try {
        currentDb = await onChange(linkPayload(currentDb, reportId, targetId, incidents));
        if (targetId) { input.value = ''; editor.markClean(); }
        renderList();
      } catch (error) { editor.status.textContent = error.message; editor.status.classList.add('ico-error'); }
      finally { busy = false; editor.setBusy(false); }
    }
    editor.form.addEventListener('submit', event => {
      event.preventDefault();
      try { update(incidentId, M.parseIncidentIds(input.value).map(id => ({ id }))); }
      catch (error) { editor.status.textContent = error.message; editor.status.classList.add('ico-error'); }
    });
    renderList(); input.focus();
    return editor;
  }
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = node('a'); link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copyReport(report, options = {}) {
    const output = M.exportReport(report, options);
    if (!output.count) throw new Error(options.afterIncident?.trim() ? 'No newly tracked incidents after this ICM.' : 'Track at least one incident before exporting.');
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([output.html], { type: 'text/html' }), 'text/plain': new Blob([output.plain], { type: 'text/plain' }) })]);
    } else {
      let copied = false;
      const onCopy = event => { event.clipboardData.setData('text/html', output.html); event.clipboardData.setData('text/plain', output.plain); event.preventDefault(); copied = true; };
      document.addEventListener('copy', onCopy);
      try { document.execCommand('copy'); } finally { document.removeEventListener('copy', onCopy); }
      if (!copied) throw new Error('Copy is unavailable. Download HTML, open the file and copy its table into OneNote.');
    }
    return output;
  }
  globalThis.IcmOncallUI = { node, button, toast, openEditor, editReport, openLinkPicker, openRelatedIncidents, download, copyReport };
})();
