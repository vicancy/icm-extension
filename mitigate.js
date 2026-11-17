(() => {
  const DEFAULTS = Object.freeze({ steps: 'Auto recovered', howFixed: 'Transient', causedByChange: false, region: 'Global' });
  const CLOSED = new Set(['Mitigated', 'Resolved']);
  const text = element => (element?.getAttribute('aria-label') || element?.textContent || '').replace(/[\ue000-\uf8ff]/g, '').replace(/\s+/g, ' ').trim();
  const visible = element => !!element && !element.closest('[hidden], [aria-hidden="true"]') && element.ownerDocument.defaultView.getComputedStyle(element).display !== 'none'
    && ![...ancestors(element)].some(parent => parent.ownerDocument.defaultView.getComputedStyle(parent).display === 'none');
  function* ancestors(element) { for (let parent = element.parentElement; parent; parent = parent.parentElement) yield parent; }
  const enabled = element => element && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  function find(root, selector, name) {
    const matches = [...root.querySelectorAll(selector)].filter(element => visible(element) && text(element) === name && !element.closest('.ico-mitigation'));
    if (matches.length > 1) throw new Error(`More than one ICM ${name} control was found. Complete the action in ICM.`);
    return matches[0];
  }
  const state = doc => doc.querySelector('[data-testid="incident-lifecycle"]')?.textContent.trim();
  function dialogFor(doc) {
    return [...doc.querySelectorAll('[role="dialog"]')].find(dialog => visible(dialog) && [...dialog.querySelectorAll('h1,h2,[role="heading"]')].some(heading => text(heading) === 'Mitigate incident(s)'));
  }
  function assertIncident(doc, id, signal) {
    if (signal?.aborted) throw new Error('Quick Mitigate stopped.');
    const url = new URL(doc.defaultView.location.href);
    if (url.origin !== 'https://portal.microsofticm.com' || url.pathname.match(/^\/imp\/v5\/incidents\/details\/(\d+)(?:\/|$)/)?.[1] !== id) {
      throw new Error('The incident page changed. Quick Mitigate stopped without continuing on another incident.');
    }
    const heading = [...doc.querySelectorAll('h3,[role="heading"]')].find(element => /^Incident\s+\d+\b/.test(text(element)));
    if (!heading || !new RegExp(`^Incident\\s+${id}\\b`).test(text(heading))) throw new Error('Wait for the correct incident to finish loading, then try again.');
  }
  async function waitFor(check, { signal, timeoutMs = 15000, pollMs = 100 } = {}, message = 'ICM did not finish loading. Complete the action in ICM.') {
    const end = Date.now() + timeoutMs;
    do {
      if (signal?.aborted) throw new Error('Quick Mitigate stopped.');
      const value = check(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    } while (Date.now() < end);
    throw new Error(message);
  }
  function putText(element, value) {
    const doc = element.ownerDocument;
    element.focus();
    if (element.matches('input,textarea')) {
      const proto = element.matches('textarea') ? doc.defaultView.HTMLTextAreaElement.prototype : doc.defaultView.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
      element.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
      element.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
    } else {
      const range = doc.createRange(); range.selectNodeContents(element);
      const selection = doc.defaultView.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      // ICM's rich-text editor listens for editing events. insertText preserves
      // that path without accessing private React state or an undocumented API.
      if (!doc.execCommand?.('insertText', false, value)) {
        element.textContent = value;
        element.dispatchEvent(new doc.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      }
      element.blur();
    }
  }
  function regionField(dialog) {
    const label = [...dialog.querySelectorAll('label,span,div')].find(element => /^Impacted region\(s\)\s*\*?$/.test(element.textContent.trim()) && ![...element.children].some(child => /^Impacted region\(s\)\s*\*?$/.test(child.textContent.trim())));
    let parent = label?.parentElement;
    for (let i = 0; parent && parent !== dialog && i < 6; i++, parent = parent.parentElement) {
      if (parent.querySelector('ul,[role="list"]')) return parent;
    }
    return null;
  }
  function hasRegion(field) {
    return !!field && [...field.querySelectorAll('li,[role="listitem"],button[aria-label]')].some(element => /^(?:remove|delete)\s+/i.test(element.getAttribute('aria-label') || '') || (element.matches('li,[role="listitem"]') && text(element) && !element.querySelector('[role="combobox"],button[aria-label="Add"]') && text(element) !== 'Add'));
  }
  function validationError(dialog) {
    const required = [...dialog.querySelectorAll('input[required],textarea[required],select[required]')].find(element => {
      if (element.disabled) return false;
      if (element.type === 'radio') return ![...dialog.querySelectorAll('input[type="radio"]')].some(other => other.name === element.name && other.checked);
      return element.type === 'checkbox' ? !element.checked : !element.value.trim();
    });
    return !!required || [...dialog.querySelectorAll('[aria-invalid="true"],[role="status"]')].some(element => element.getAttribute('aria-invalid') === 'true' || /field is required|invalid value/i.test(element.textContent));
  }

  async function run(doc, id, options = {}) {
    const defaults = options.defaults || DEFAULTS;
    const step = options.onProgress || (() => {});
    const check = () => assertIncident(doc, id, options.signal);
    const click = element => {
      check();
      if (!element?.isConnected || element.ownerDocument !== doc || !enabled(element)) throw new Error('ICM does not allow this action right now.');
      element.click();
    };
    check();
    if (CLOSED.has(state(doc))) return { status: state(doc), alreadyDone: true };
    if (state(doc) !== 'Active') throw new Error('Quick Mitigate is available only for an Active incident.');
    if ([...doc.querySelectorAll('[role="dialog"]')].some(dialog => visible(dialog) && dialog.textContent.trim() && !dialog.closest('.ico-mitigation'))) throw new Error('Close the existing ICM dialog before using Quick Mitigate.');
    step('Opening the ICM mitigation form…');
    let action = find(doc, 'button,[role="menuitem"]', 'Mitigate');
    if (!action) {
      click(find(doc, 'button', 'More lifecycle actions'));
      action = await waitFor(() => find(doc, '[role="menuitem"]', 'Mitigate'), options);
    }
    click(action);
    const dialog = await waitFor(() => dialogFor(doc), options);
    const general = find(dialog, '[role="tab"]', 'General');
    if (general) click(general);
    const steps = await waitFor(() => find(dialog, '[role="textbox"],textarea', 'Mitigation steps'), options);
    check(); putText(steps, defaults.steps);
    const how = await waitFor(() => {
      const element = find(dialog, '[role="combobox"]', 'How fixed');
      return element && !/Loading/.test(element.textContent) && enabled(element) && element;
    }, options);
    click(how);
    const reason = await waitFor(() => find(doc, '[role="option"]', defaults.howFixed), options, `ICM does not offer ${defaults.howFixed}. Choose How fixed in the form.`);
    click(reason);
    step('Using Auto recovered / Transient…');

    const rootTab = find(dialog, '[role="tab"]', 'Root cause details');
    if (rootTab) {
      click(rootTab);
      const noChange = await waitFor(() => [...dialog.querySelectorAll('input[type="radio"]')].find(input => visible(input) && [...input.labels || []].some(label => text(label) === (defaults.causedByChange ? 'Yes' : 'No'))), options);
      click(noChange);
      if (!noChange.checked) throw new Error('Select whether a change caused the incident in ICM.');
    }
    if (general) click(general);
    const field = regionField(dialog);
    if (field && !hasRegion(field)) {
      if (!defaults.region) throw new Error('Select Impacted region(s) in ICM, then finish the form. Quick Mitigate has stopped before submission.');
      click(find(field, 'button', 'Add'));
      const picker = await waitFor(() => find(field, '[role="combobox"]', 'picker'), options);
      click(picker);
      click(await waitFor(() => find(doc, '[role="option"]', defaults.region), options));
      await waitFor(() => hasRegion(field), options);
    }
    const date = dialog.querySelector('input[placeholder="Select date time..."]');
    if (date && !date.value.trim()) throw new Error('Enter the mitigation time in ICM, then finish the form.');
    const tabs = [...dialog.querySelectorAll('[role="tab"]')].filter(visible);
    if (tabs.some(tab => !['General', 'Root cause details', 'Agent feedback'].includes(text(tab)))) throw new Error('ICM requires an additional step. Complete it in the form.');
    if (tabs.length) click(tabs.at(-1));
    const submit = await waitFor(() => find(dialog, 'button', 'Submit'), options);
    // Let ICM's field validators settle after changing tabs. Never submit twice
    // or interpret a closed dialog alone as a successful server-side change.
    await new Promise(resolve => setTimeout(resolve, options.pollMs || 100));
    check();
    if (validationError(dialog)) {
      if (general) click(general);
      throw new Error('ICM needs additional required information. Complete the highlighted fields and submit in ICM.');
    }
    if (state(doc) !== 'Active') throw new Error('The incident state changed while preparing mitigation. Check its current state in ICM.');
    step('Submitting mitigation to ICM…', true);
    click(submit);
    const status = await waitFor(() => { check(); return CLOSED.has(state(doc)) && state(doc); }, options,
      'ICM has not confirmed mitigation. Check the incident status before trying again; the request may still be processing.');
    return { status, alreadyDone: false };
  }

  let active;
  const results = new Map();
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn());
  function managedFrame() {
    try { return !!window.frameElement?.classList.contains('ico-mitigation-frame'); } catch { return false; }
  }
  function start(id) {
    if (active) throw new Error('Finish or close the current Quick Mitigate action first.');
    if (!/^\d{1,20}$/.test(id)) throw new Error('Invalid incident ID.');
    const UI = IcmOncallUI;
    const controller = new AbortController();
    const panel = UI.node('section', 'ico-mitigation'); panel.dataset.busy = 'true';
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', `Quick Mitigate incident ${id}`);
    const header = UI.node('div', 'ico-mitigation-header');
    const title = UI.node('strong', '', `Mitigate incident ${id}`);
    const status = UI.node('span', 'ico-mitigation-status', 'Loading the ICM incident…'); status.setAttribute('role', 'status');
    const open = UI.node('a', 'ico-link', 'Open in ICM ↗'); open.href = IcmOncall.incidentUrl(id); open.target = '_blank'; open.rel = 'noopener noreferrer';
    const close = UI.button('Stop', 'ico-subtle');
    header.append(title, open, close); panel.append(header, status);
    const hint = UI.node('p', 'ico-mitigation-hint', 'Auto recovered · Transient · Not caused by a change · Global if no region is recorded. ICM also applies mitigation to correlated incidents.'); panel.append(hint);
    document.body.append(panel);
    let frame, targetDoc, timer, submitted = false, finish;
    const promise = new Promise(resolve => { finish = resolve; });
    active = { id, panel }; notify();
    const stop = result => {
      controller.abort(); clearInterval(timer); panel.remove(); active = null;
      if (result?.status) {
        results.set(id, result.status);
        // A stale query row may not refresh immediately. Do not retain this
        // hint indefinitely if the incident is later reactivated elsewhere.
        setTimeout(() => { results.delete(id); notify(); }, 60000);
      }
      notify(); finish(result || null);
    };
    close.addEventListener('click', () => {
      if (submitted) UI.toast('Submission was already sent. Check the incident status in ICM.');
      stop(null);
    });
    async function perform() {
      try {
        if (IcmOncall.incidentId(location.href) === id) {
          targetDoc = document;
          panel.classList.add('ico-mitigation-inline');
        } else {
          panel.classList.add('ico-mitigation-window');
          frame = UI.node('iframe', 'ico-mitigation-frame'); frame.title = `Mitigate incident ${id} in ICM`;
          frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox');
          panel.append(frame); frame.src = IcmOncall.incidentUrl(id);
          targetDoc = await waitFor(() => {
            try { const doc = frame.contentDocument; if (doc && state(doc) && IcmOncall.incidentId(doc.defaultView.location.href) === id) return doc; } catch { /* Wait for the same-origin ICM page. */ }
            return null;
          }, { signal: controller.signal, timeoutMs: 30000 }, 'The ICM page could not load. Open it in ICM and try there.');
        }
        const result = await run(targetDoc, id, { signal: controller.signal, onProgress(message, sent) { status.textContent = message; submitted ||= !!sent; close.textContent = submitted ? 'Close' : 'Stop'; } });
        stop(result); UI.toast(`Incident ${id} is ${result.status.toLowerCase()}.`);
      } catch (error) {
        if (controller.signal.aborted) return;
        panel.dataset.busy = 'false'; panel.dataset.dirty = 'true';
        status.textContent = error.message; status.classList.add('ico-error'); close.textContent = 'Close';
        // Automation stops on validation errors. The user can complete the
        // visible official form; this watcher only observes its final status.
        timer = setInterval(() => {
          try {
            if (targetDoc && IcmOncall.incidentId(targetDoc.defaultView.location.href) === id && CLOSED.has(state(targetDoc))) {
              const status = state(targetDoc); stop({ status, alreadyDone: false }); UI.toast(`Incident ${id} is ${status.toLowerCase()}.`);
            }
          } catch { /* Navigating away never triggers another submission. */ }
        }, 500);
      }
    }
    perform();
    return promise;
  }
  globalThis.IcmQuickMitigate = { DEFAULTS, run, start, managedFrame, subscribe: fn => listeners.add(fn), result: id => results.get(id), clearResult: id => results.delete(id), active: () => active?.id };
})();
