// A folder picker that "picks" a card: the prepared one, or the one a scenario names. Its contents come from the browser's private
// storage (OPFS), named like the card's volume, but the marker file that matches a folder to a
// card is written onto the real mounted card, through the harness — which is what the helper's
// `identify` then looks for.
(() => {
  const BRIDGE = 'http://127.0.0.1:8790/';
  const ROLE = window.__PICK__ || 'prepared';
  const cards = window.__CARDS__ ?? {};
  const NAME = { dirty: cards.dirtyLabel, old: cards.oldLabel }[ROLE] || cards.preparedLabel || 'OWL_01';
  let picks = 0;
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    // After the card, a folder to copy it into, unless a scenario asks for the card again.
    if (picks++ > 0 && !window.__PICK_CARD_AGAIN__) return root.getDirectoryHandle('copy-destination', { create: true });
    const dir = await root.getDirectoryHandle(NAME, { create: true });
    const cfg = await dir.getFileHandle('_conf.a3m', { create: true });
    const writer = await cfg.createWritable();
    await writer.write(`DEVICE_LABEL = "${NAME}"\n`);
    await writer.close();
    if (ROLE === 'dirty') {
      // The dirty card's log as its directory entry records it: the first 2,000 bytes (setup-macos.sh).
      const lines = Array.from({ length: 120 }, (_, i) => `EVT|TICK|t=${1788000000 + i},ok\n`).join('');
      const log = await (await dir.getDirectoryHandle('OWL_09', { create: true })).getFileHandle('a3em.log', { create: true });
      const logWriter = await log.createWritable();
      await logWriter.write(lines.slice(0, 2000));
      await logWriter.close();
    }
    const getFileHandle = dir.getFileHandle.bind(dir);
    const removeEntry = dir.removeEntry.bind(dir);
    const probe = (op, name) => fetch(BRIDGE + 'probe', { method: 'POST', body: JSON.stringify({ op, name, role: ROLE }) });
    // Methods patched on the real handle, not a Proxy: the dashboard stores the handle in
    // IndexedDB, which cannot store a Proxy.
    dir.getFileHandle = async (name, options) =>
      name.startsWith('.a3em-probe-')
        ? { createWritable: async () => ({ write: async () => {}, close: async () => { await probe('touch', name); } }) }
        : getFileHandle(name, options);
    dir.removeEntry = async (name, options) => (name.startsWith('.a3em-probe-') ? void (await probe('rm', name)) : removeEntry(name, options));
    return dir;
  };
})();
