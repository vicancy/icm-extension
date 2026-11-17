// Development fixture only. This file is never loaded by the extension manifest.
(() => {
  const listeners = new Set();
  let serialized;
  function publish(db) {
    if (!db?.reports) return;
    const next = JSON.stringify(db);
    if (next === serialized) return;
    serialized = next;
    for (const listener of listeners) listener({ 'icm-oncall-workspace-v1': { newValue: db } }, 'local');
  }
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        if (message.type === 'oncall:open') window.open('/dashboard.html', '_blank');
        if (message.type === 'oncall:open-ignored') window.open('/ignored.html', '_blank');
        const response = await fetch('/__message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
        const result = await response.json();
        if (result.ok) publish(result.data);
        return result;
      }
    },
    storage: { onChanged: { addListener: fn => listeners.add(fn) } }
  };
  setInterval(async () => {
    try { publish(await (await fetch('/__state')).json()); } catch { /* The preview server may have stopped. */ }
  }, 500);
})();
