const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createRuntime, loadPage, waitFor } = require('./test/runtime');

// Representative native controls observed in ICM. No real ICM API is called.
function fixture(t, { region = 'Central US', status = 'Active', outcome = 'Mitigated', disabled = false, extraRequired = false, onReason } = {}) {
  const dom = new JSDOM('<!doctype html><h3>Incident 123 created by monitor</h3><span data-testid="incident-lifecycle"></span><button aria-label="More lifecycle actions">More</button>', { url: 'https://portal.microsofticm.com/imp/v5/incidents/details/123/summary', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const d = dom.window.document;
  d.querySelector('[data-testid]').textContent = status;
  let submissions = 0, payload;
  const actions = [];
  d.querySelector('button').onclick = () => {
    actions.push('menu');
    const menu = d.createElement('button'); menu.setAttribute('role', 'menuitem'); menu.textContent = 'Mitigate'; menu.disabled = disabled;
    d.body.append(menu);
    menu.onclick = () => {
      actions.push('open'); menu.remove();
      const dialog = d.createElement('section'); dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = `<h1>Mitigate incident(s)</h1>
        <button role="tab" aria-label="General">1. General</button><button role="tab" aria-label="Root cause details">2. Root cause details</button><button role="tab" aria-label="Agent feedback">3. Agent feedback</button>
        <div data-page="General">
          <label>Mitigation steps</label><div role="textbox" aria-label="Mitigation steps" contenteditable="true"></div>
          <label>How fixed</label><div role="combobox" aria-label="How fixed" tabindex="0"></div>
          <input placeholder="Select date time..." value="2026-11-16 14:34:50 GMT+8">
          <div class="region-field"><label>Impacted region(s) *</label><ul>${region ? `<li>${region}<button aria-label="Remove ${region}">×</button></li>` : ''}<li><button aria-label="Add">Add</button></li></ul></div>
          <div role="textbox" aria-label="Tsg output" contenteditable="true"></div>
          <label><input type="checkbox" aria-label="Customer/SLA impacting">Customer/SLA impacting</label>
          <label><input type="checkbox" aria-label="Noise">Noise</label>
          <label><input type="checkbox" aria-label="Auto resolve">Auto resolve</label>
        </div>
        <div data-page="Root cause details" hidden><p>Was this incident caused by a change?</p>
          <input id="yes" name="change" type="radio" required><label for="yes">Yes</label><input id="no" name="change" type="radio" required><label for="no">No</label>
          <input aria-label="Root cause title"><textarea aria-label="Root cause details"></textarea>
        </div>
        <div data-page="Agent feedback" hidden><input id="feedback" type="radio" name="feedback"><label for="feedback">Helpful</label></div>
        ${extraRequired ? '<label>New required field<input required aria-label="New required field"></label>' : ''}
        <button aria-label="Cancel">Cancel</button><button aria-label="Next">Next</button>`;
      d.body.append(dialog);
      dialog.querySelector('[aria-label="Cancel"]').onclick = () => dialog.remove();
      const submit = dialog.querySelector('[aria-label="Next"]');
      for (const tab of dialog.querySelectorAll('[role="tab"]')) tab.onclick = () => {
        actions.push(tab.getAttribute('aria-label'));
        for (const page of dialog.querySelectorAll('[data-page]')) page.hidden = page.dataset.page !== tab.getAttribute('aria-label');
        const label = tab.getAttribute('aria-label') === 'Agent feedback' ? 'Submit' : 'Next';
        submit.setAttribute('aria-label', label); submit.textContent = label;
      };
      const reason = dialog.querySelector('[aria-label="How fixed"]');
      reason.onclick = () => {
        const option = d.createElement('div'); option.setAttribute('role', 'option'); option.textContent = 'Transient';
        d.body.append(option); option.onclick = () => { reason.textContent = 'Transient'; option.remove(); onReason?.(dom); };
      };
      dialog.querySelector('[aria-label="Add"]').onclick = event => {
        event.target.hidden = true;
        const picker = d.createElement('button'); picker.setAttribute('role', 'combobox'); picker.setAttribute('aria-label', 'picker'); picker.textContent = 'Select an item';
        event.target.parentElement.append(picker);
        picker.onclick = () => {
          const option = d.createElement('div'); option.setAttribute('role', 'option'); option.textContent = 'Global'; d.body.append(option);
          option.onclick = () => { const chip = d.createElement('li'); chip.textContent = 'Global'; dialog.querySelector('.region-field ul').prepend(chip); picker.remove(); option.remove(); };
        };
      };
      submit.onclick = () => {
        submissions++;
        payload = {
          steps: dialog.querySelector('[aria-label="Mitigation steps"]').textContent,
          reason: reason.textContent,
          noChange: dialog.querySelector('#no').checked,
          region: dialog.querySelector('.region-field ul').textContent,
          rootCause: dialog.querySelector('[aria-label="Root cause title"]').value,
          details: dialog.querySelector('[aria-label="Root cause details"]:not([role="tab"])').value,
          flags: [...dialog.querySelectorAll('input[type="checkbox"]')].some(input => input.checked),
          feedback: dialog.querySelector('#feedback').checked
        };
        if (outcome === 'closed-only') dialog.remove();
        else if (outcome !== 'Active') { d.querySelector('[data-testid]').textContent = outcome; dialog.remove(); }
      };
    };
  };
  for (const file of ['model.js', 'ui.js', 'mitigate.js']) dom.window.eval(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  return { dom, document: d, api: dom.window.IcmQuickMitigate, actions, get submissions() { return submissions; }, get payload() { return payload; }, run(options = {}) { return dom.window.IcmQuickMitigate.run(d, '123', { timeoutMs: 200, pollMs: 1, ...options }); } };
}

test('one click runs native mitigation with approved defaults and verifies the official result', async t => {
  const h = fixture(t);
  const result = await h.run();
  assert.equal(result.status, 'Mitigated'); assert.equal(h.submissions, 1);
  assert.equal(h.payload.steps, 'Auto recovered'); assert.equal(h.payload.reason, 'Transient'); assert.equal(h.payload.noChange, true);
  assert.match(h.payload.region, /Central US/);
  assert.doesNotMatch(h.payload.region, /Global/);
  assert.equal(h.payload.rootCause, ''); assert.equal(h.payload.details, ''); assert.equal(h.payload.flags, false); assert.equal(h.payload.feedback, false);
  assert.ok(h.actions.includes('Agent feedback'));
});

test('a missing region leaves the official form open if the fallback is explicitly disabled', async t => {
  const h = fixture(t, { region: '' });
  await assert.rejects(h.run({ defaults: { ...h.api.DEFAULTS, region: '' } }), /Select Impacted region/);
  assert.equal(h.submissions, 0); assert.ok(h.document.querySelector('[role="dialog"]'));
  assert.equal(h.document.querySelector('[aria-label="Mitigation steps"]').textContent, 'Auto recovered');
  assert.equal(h.document.querySelector('#no').checked, true);
});

test('the approved Global default is selected when no region was recorded', async t => {
  const h = fixture(t, { region: '' });
  await h.run();
  assert.match(h.payload.region, /Global/); assert.equal(h.submissions, 1);
});

test('new required native fields stop automation before submission', async t => {
  const h = fixture(t, { extraRequired: true });
  await assert.rejects(h.run(), /additional required information/);
  assert.equal(h.submissions, 0);
});

test('disabled mitigation never acknowledges or changes the incident', async t => {
  const h = fixture(t, { disabled: true });
  await assert.rejects(h.run(), /does not allow/);
  assert.equal(h.submissions, 0); assert.equal(h.actions.includes('open'), false);
});

test('already mitigated and resolved incidents are never reactivated or resubmitted', async t => {
  for (const status of ['Mitigated', 'Resolved']) {
    const h = fixture(t, { status });
    const result = await h.run(); assert.equal(result.status, status); assert.equal(result.alreadyDone, true);
    assert.equal(h.submissions, 0); assert.deepEqual(h.actions, []);
  }
});

test('route changes and user cancellation prevent all subsequent submissions', async t => {
  const moved = fixture(t, { onReason: dom => dom.reconfigure({ url: 'https://portal.microsofticm.com/imp/v5/incidents/details/456/summary' }) });
  await assert.rejects(moved.run(), /incident page changed/); assert.equal(moved.submissions, 0);
  const controller = new AbortController();
  const cancelled = fixture(t, { onReason: () => controller.abort() });
  await assert.rejects(cancelled.run({ signal: controller.signal }), /stopped/); assert.equal(cancelled.submissions, 0);
});

test('a disappeared dialog or server refusal is an unconfirmed outcome and never automatically retried', async t => {
  for (const outcome of ['closed-only', 'Active']) {
    const h = fixture(t, { outcome });
    await assert.rejects(h.run(), /not confirmed mitigation/); assert.equal(h.submissions, 1);
  }
});

test('an existing native draft is not reused or overwritten', async t => {
  const h = fixture(t); const dialog = h.document.createElement('section'); dialog.setAttribute('role', 'dialog'); dialog.textContent = 'My existing form'; h.document.body.append(dialog);
  await assert.rejects(h.run(), /Close the existing ICM dialog/);
  assert.equal(dialog.textContent, 'My existing form'); assert.equal(h.submissions, 0);
});

test('list actions disable completed incidents and cannot be triggered by an untrusted page script', async t => {
  const runtime = createRuntime(); const page = loadPage(runtime); t.after(page.close);
  await waitFor(() => page.document.querySelector('[data-action="mitigate"]'));
  const button = page.document.querySelector('[data-action="mitigate"]');
  assert.equal(button.textContent, 'Mitigate'); button.click();
  assert.equal(page.document.querySelector('.ico-mitigation'), null);
  page.document.querySelector('[data-automation-key="State"]').textContent = 'Resolved';
  await waitFor(() => button.disabled); assert.equal(button.textContent, 'Resolved');
  assert.equal(runtime.messages.some(message => /mitigat/.test(message.type)), false);
});

test('the progress UI prevents duplicate clicks and records success only after ICM confirms', async t => {
  const h = fixture(t);
  const first = h.api.start('123');
  assert.throws(() => h.api.start('123'), /current Quick Mitigate/);
  const result = await first;
  assert.equal(result.status, 'Mitigated'); assert.equal(h.submissions, 1);
  assert.equal(h.api.active(), undefined); assert.equal(h.api.result('123'), 'Mitigated');
  assert.equal(h.document.querySelector('.ico-mitigation'), null);
});
