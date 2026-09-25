// A folder picker that "picks" a card: the prepared one, or the one a scenario names. Its contents come from the browser's private
// storage (OPFS), named like the card's volume, but the marker file that matches a folder to a
// card is written onto the real mounted card, through the harness — which is what the helper's
// `identify` then looks for.
(() => {
  const BRIDGE = 'http://127.0.0.1:8790/';
  const ROLE = window.__PICK__ || 'prepared';
  const cards = window.__CARDS__ ?? {};
  const NAME = { dirty: cards.dirtyLabel, old: cards.oldLabel }[ROLE] || cards.preparedLabel || 'OWL_01';
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(NAME, { create: true });
    const cfg = await dir.getFileHandle('_a3em.cfg', { create: true });
    const writer = await cfg.createWritable();
    await writer.write(`DEVICE_LABEL = "${NAME}"\n`);
    await writer.close();
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
