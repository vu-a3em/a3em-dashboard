// The extension's page-facing API (chrome.runtime.sendMessage and connect), backed by the
// harness, which runs the real helper for each request and streams its progress back.
(() => {
  const BRIDGE = 'http://127.0.0.1:8790/';
  async function run(message, onLine) {
    const response = await fetch(BRIDGE, { method: 'POST', body: JSON.stringify(message) });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) onLine(JSON.parse(line));
      }
    }
  }
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    sendMessage(_id, message, callback) {
      let last;
      run(message, (m) => {
        if (!m.progress) last = m;
      }).then(() => callback(last), () => callback(undefined));
    },
    connect() {
      const onMessage = [];
      const onDisconnect = [];
      return {
        postMessage(message) {
          run(message, (m) => onMessage.forEach((listener) => listener(m))).catch(() => onDisconnect.forEach((listener) => listener()));
        },
        disconnect() {},
        onMessage: { addListener: (listener) => onMessage.push(listener) },
        onDisconnect: { addListener: (listener) => onDisconnect.push(listener) },
      };
    },
  };
})();
