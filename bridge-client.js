((root) => {
  function create({ config, chrome, WebSocket: Socket, invoke, snapshot, backupDelayMs = 250, backupTimeoutMs = 15000 }) {
    let socket, reconnectTimer, heartbeat, state = 'disconnected', stopped = false;
    let backup = { state: 'offline' }, backupTimer, dirty = true, saving = false, sequence = 0;
    const pending = new Map();
    const alarm = 'icm-local-agent-reconnect';
    if (config.url !== 'ws://127.0.0.1:4176/extension' || typeof config.token !== 'string' || config.token.length < 32) {
      throw new Error('Invalid local agent configuration. Run the bridge installer again.');
    }
    function backupRequest(operation, data) {
      if (state !== 'connected' || socket?.readyState !== 1) return Promise.reject(new Error('The local backup service is offline.'));
      return new Promise((resolve, reject) => {
        const id = `backup-${++sequence}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Backup was not acknowledged. It will be retried automatically.')); }, backupTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ type: 'backup', id, operation, data })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    }
    async function flushBackup() {
      if (!snapshot || saving || !dirty || state !== 'connected' || ['not-installed', 'conflict'].includes(backup.state)) return;
      saving = true; dirty = false;
      backup = { ...backup, state: 'saving', error: undefined };
      const current = socket;
      let completed = false;
      try {
        const data = await snapshot();
        if (socket !== current) throw new Error('The backup connection changed. It will be retried automatically.');
        const result = await backupRequest('save', data);
        if (socket !== current) return;
        backup = { ...backup, ...result, state: dirty ? 'pending' : 'saved', error: undefined };
        completed = true;
      } catch (error) {
        dirty = true;
        if (socket === current) backup = { ...backup, state: state !== 'connected' ? 'offline' : error.code === 'WORKSPACE_MISMATCH' ? 'conflict' : 'error', error: error.message };
      } finally {
        saving = false;
        if (dirty && (completed || socket !== current)) scheduleBackup();
      }
    }
    function scheduleBackup() {
      dirty = true;
      if (!snapshot || stopped) return;
      if (state === 'connected' && !['not-installed', 'conflict', 'saving'].includes(backup.state)) backup = { ...backup, state: 'pending' };
      clearTimeout(backupTimer);
      backupTimer = setTimeout(flushBackup, backupDelayMs);
    }
    function connect() {
      if (stopped) return;
      if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
      clearTimeout(reconnectTimer);
      state = 'connecting';
      const current = socket = new Socket(config.url);
      const authTimeout = setTimeout(() => { if (state !== 'connected' && socket === current) current.close(); }, 6000);
      current.onopen = () => current.send(JSON.stringify({ type: 'hello', version: 1, token: config.token, extensionId: chrome.runtime.id }));
      current.onmessage = async event => {
        let message;
        try { message = JSON.parse(event.data); } catch { current.close(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { current.close(); return; }
        if (message.type === 'ready') {
          clearTimeout(authTimeout); state = 'connected';
          backup = message.backup ? { ...message.backup } : { state: 'not-installed', error: 'Restart the local bridge to enable automatic backup.' };
          clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            if (current.readyState === 1) current.send(JSON.stringify({ type: 'ping' }));
            flushBackup();
          }, 20000);
          scheduleBackup();
          return;
        }
        if (message.type === 'backup-result') {
          const item = pending.get(message.id); if (!item) return;
          clearTimeout(item.timer); pending.delete(message.id);
          if (message.ok) item.resolve(message.result);
          else item.reject(Object.assign(new Error(message.error || 'Automatic backup failed.'), { code: message.code }));
          return;
        }
        if (message.type !== 'request' || state !== 'connected' || typeof message.id !== 'string') return;
        let response;
        try { response = { type: 'response', id: message.id, ok: true, result: await invoke(message.request) }; }
        catch (error) { response = { type: 'response', id: message.id, ok: false, error: error.message || 'Could not save local notes.' }; }
        if (current.readyState === 1) current.send(JSON.stringify(response));
      };
      current.onerror = () => { state = 'disconnected'; current.close(); };
      current.onclose = () => {
        clearTimeout(authTimeout);
        if (socket !== current) return;
        clearInterval(heartbeat);
        socket = null; state = 'disconnected';
        backup = { ...backup, state: 'offline' }; dirty = true;
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('The backup service disconnected. Recent changes will be backed up after reconnecting.')); }
        pending.clear();
        if (!stopped) reconnectTimer = setTimeout(connect, 5000);
      };
    }
    chrome.alarms?.create(alarm, { periodInMinutes: 1 });
    chrome.alarms?.onAlarm.addListener(value => { if (value.name === alarm) connect(); });
    chrome.runtime.onStartup?.addListener(connect);
    return { connect, scheduleBackup,
      status: () => ({ state, endpoint: '127.0.0.1:4176', localNotesOnly: true, backup: { ...backup } }),
      retryBackup() { connect(); if (backup.state === 'conflict') return; scheduleBackup(); },
      async readBackup() {
        const result = await backupRequest('read');
        if (!result?.data) throw new Error('No automatic backup is available yet.');
        return result.data;
      },
      resumeBackup() { backup = { ...backup, state: 'pending', error: undefined }; scheduleBackup(); },
      stop() { stopped = true; clearTimeout(reconnectTimer); clearTimeout(backupTimer); clearInterval(heartbeat); socket?.close(); state = 'disconnected'; } };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IcmAgentBridge = api;
})(globalThis);
