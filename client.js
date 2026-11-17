(() => {
  async function request(type, payload = {}) {
    try {
      const response = await chrome.runtime.sendMessage({ type: `oncall:${type}`, ...payload });
      if (!response?.ok) throw new Error(response?.error || 'The workspace did not respond. Reload the extension and refresh this page.');
      return response.data;
    } catch (error) {
      if (/context invalidated|receiving end does not exist/i.test(error.message || '')) {
        throw new Error('The extension was updated. Refresh this page and try again. Your saved notes are still available.');
      }
      throw error;
    }
  }
  globalThis.IcmOncallClient = { request };
})();
