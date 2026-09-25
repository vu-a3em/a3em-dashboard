// End-to-end tests of the dashboard's card tools against the real card helper, on virtual disks.
//
//   node test/e2e/e2e.mjs --helper <a3em-card-helper> --cards <cards.json> [--app <app/dist>]
//                         [--only recover,prepare,match] [--out <folder>]
//
// One process serves the built dashboard, stands in for the browser extension, and drives
// headless Chrome through each scenario. The stand-in starts the real helper as a browser does
// and passes it every request in native messaging's framing — so a Stop reaches the copy it
// stops — in test mode: A3EM_HELPER_VIRTUAL_ONLY hides every real device, and only the virtual
// disks named in cards.json are listed, so nothing else can be chosen. See README.md.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []),
);
const HELPER = resolve(args.helper ?? '');
const CARDS = JSON.parse(readFileSync(args.cards, 'utf8'));
const APP = resolve(args.app ?? join(HERE, '../../../app/dist'));
const OUT = resolve(args.out ?? join(process.cwd(), 'e2e-results'));
const ONLY = (args.only ?? 'configure,recover,prepare,review,prepare-open,match').split(',');
const WORK = mkdtempSync(join(tmpdir(), 'a3em-e2e-'));
const PAGE_PORT = 8768;
const BRIDGE_PORT = 8790;
mkdirSync(OUT, { recursive: true });
if (!existsSync(HELPER)) throw new Error(`No helper at ${HELPER}`);
if (!existsSync(join(APP, 'index.html'))) throw new Error(`No built dashboard at ${APP}; run npm --workspace app run build`);
const allowed = ['old', 'prepared', 'damaged', 'blank', 'dirty'].map((role) => CARDS[role]).filter(Boolean);

// --- The built dashboard -------------------------------------------------------------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const page = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  let file = join(APP, path === '/' ? 'index.html' : path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(APP, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(PAGE_PORT);

// --- The extension stand-in ----------------------------------------------------------------
// One helper for the whole run, started as a browser starts it: with the extension's origin,
// and spoken to in native messaging's framing, a little-endian length before each message.
const helper = spawn(HELPER, ['chrome-extension://a3em-e2e/'], {
  // The setup's own state, where it has one, so the helper remembers preparing those cards.
  // And where an image is to go, so the helper answers its save dialog itself: no dialog opens.
  env: {
    ...process.env,
    A3EM_HELPER_VIRTUAL_ONLY: '1',
    A3EM_HELPER_STATE_DIR: CARDS.stateDir ?? join(WORK, 'state'),
    A3EM_HELPER_SAVE_AS_DIR: CARDS.imageDir ?? WORK,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const helperLog = [];
helper.stderr.on('data', (data) => helperLog.push(String(data)));
const calls = [];
// Requests in flight, by the id they were given here. Each page numbers its own from one, so
// the ids are the harness's, and a Stop's target is translated to match.
const inFlight = new Map();
const byPageId = new Map();
let nextId = 0;
const post = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  helper.stdin.write(Buffer.concat([length, body]));
};
const deliver = (message) => {
  const entry = inFlight.get(message.id);
  if (!entry) return;
  const reply = { ...message, id: entry.pageId };
  if (message.progress) {
    entry.res.write(JSON.stringify(reply) + '\n');
    return;
  }
  inFlight.delete(message.id);
  byPageId.delete(entry.pageId);
  if (Array.isArray(reply.devices)) reply.devices = reply.devices.filter((device) => allowed.includes(device.id));
  const { request } = entry;
  calls.push(`${request.op} ${request.device ?? request.devices ?? request.volume ?? request.target ?? ''} ${reply.ok ? 'ok' : `FAILED ${reply.code}: ${reply.error}`}`);
  entry.res.end(JSON.stringify(reply) + '\n');
};
let received = Buffer.alloc(0);
helper.stdout.on('data', (data) => {
  received = Buffer.concat([received, data]);
  while (received.length >= 4 && received.length >= 4 + received.readUInt32LE(0)) {
    const length = received.readUInt32LE(0);
    deliver(JSON.parse(received.subarray(4, 4 + length).toString('utf8')));
    received = received.subarray(4 + length);
  }
});
helper.on('close', (code) => {
  for (const entry of inFlight.values()) {
    entry.res.end(JSON.stringify({ id: entry.pageId, ok: false, error: `bridge: the helper exited (${code}): ${helperLog.join('').slice(-300)}`, code: 'unexpected' }) + '\n');
  }
  inFlight.clear();
});

const bridge = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    // How many marker files are on the picked card: none should be left behind.
    const mountOf = (role) => ({ dirty: CARDS.dirtyMount, old: CARDS.oldMount }[role] ?? CARDS.preparedMount);
    if (req.url.startsWith('/probes')) {
      const mount = mountOf(new URL(req.url, 'http://x').searchParams.get('role'));
      const names = mount && existsSync(mount) ? readdirSync(mount) : [];
      res.end(String(names.filter((name) => name.startsWith('.a3em-probe-')).length));
      return;
    }
    // What is in the image folder, to see that a stopped copy leaves nothing behind.
    if (req.url === '/images') {
      const folder = CARDS.localImageDir ?? CARDS.imageDir ?? WORK;
      res.end(JSON.stringify(existsSync(folder) ? readdirSync(folder).filter((name) => /\.img|\.partial/.test(name)) : []));
      return;
    }
    // A file left on a test card, as a card reused without copying off leaves one: onto a test
    // card's own mount, and only a plain path within it.
    if (req.url === '/put') {
      const { role, path, bytes } = JSON.parse(body);
      const mount = mountOf(role);
      if (!mount || typeof path !== 'string' || !/^[\w.-]+(\/[\w.-]+)*$/.test(path) || path.split('/').includes('..')) {
        res.writeHead(400);
        res.end();
        return;
      }
      mkdirSync(join(mount, dirname(path)), { recursive: true });
      writeFileSync(join(mount, path), Buffer.alloc(Number(bytes) || 0, 7));
      res.end('ok');
      return;
    }
    // The picker stand-in's marker file, written only onto the picked card's own volume.
    if (req.url === '/probe') {
      const { op, name, role } = JSON.parse(body);
      const mount = mountOf(role);
      if (!mount || !/^\.a3em-probe-[0-9a-f-]+$/.test(name)) {
        res.writeHead(400);
        res.end();
        return;
      }
      if (op === 'touch') writeFileSync(join(mount, name), '');
      else rmSync(join(mount, name), { force: true });
      res.end('ok');
      return;
    }
    const { id: pageId, ...request } = JSON.parse(body);
    // Images go to a scratch folder, not the person's Documents folder: cards.json's imageDir,
    // where the helper runs somewhere with other paths (a container), else a temporary one.
    if (request.op === 'image' && !request.destination) {
      request.destination = CARDS.imageDir ? `${CARDS.imageDir}/${request.device}-${Date.now()}.img` : join(WORK, `${request.device}-${Date.now()}.img`);
    }
    if (request.op === 'stop') request.target = byPageId.get(request.target) ?? request.target;
    const id = `e2e-${++nextId}`;
    inFlight.set(id, { res, request, pageId });
    byPageId.set(pageId, id);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    post({ ...request, id });
  });
}).listen(BRIDGE_PORT);

// --- Headless Chrome ------------------------------------------------------------------------
const CHROME =
  args.chrome ??
  process.env.CHROME ??
  {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  }[process.platform] ??
  'google-chrome';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function runScenario(name) {
  const profile = mkdtempSync(join(tmpdir(), 'a3em-e2e-chrome-'));
  const port = 9334;
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank'],
    { stdio: 'ignore' },
  );
  let targets;
  for (let i = 0; i < 100 && !targets; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {
      await sleep(200);
    }
  }
  const socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener('open', done));
  let next = 0;
  const waiting = new Map();
  const errors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
  });
  const send = (method, params = {}) =>
    new Promise((done) => {
      const id = ++next;
      waiting.set(id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 600));
    return reply.result?.result?.value;
  };
  const shot = async (label) => {
    const reply = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}-${label}.png`), Buffer.from(reply.result.data, 'base64'));
  };
  await send('Page.enable');
  await send('Runtime.enable');
  // Nothing reaches Google: the dashboard's sign-in is irrelevant here.
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*googleapis.com*', '*firebaseapp.com*', '*gstatic.com*', '*google.com*'] });
  const shims = ['extension.js', 'picker.js'].map((file) => readFileSync(join(HERE, 'shims', file), 'utf8')).join('\n');
  // The card the picker stand-in "picks": the dirty one for `review`, the old one for `prepare`
  // (which erases it while it is open), else the prepared one.
  const pick = { review: 'dirty', prepare: 'old' }[name] ?? 'prepared';
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__CARDS__ = ${JSON.stringify(CARDS)}; window.__PICK__ = ${JSON.stringify(pick)};\n${shims}` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${PAGE_PORT}/` });
  await sleep(3000);
  await evaluate(
    `window.$text = (el) => el ? el.innerText.replace(/\\n+/g, ' | ') : null; window.$btn = (text, root = document) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text));`,
  );
  const out = {};
  const failures = [];
  const expect = (what, ok, detail) => {
    if (!ok) failures.push(`${what}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 400)}`}`);
  };
  try {
    await (await import(`./scenarios/${name}.mjs`)).default({ evaluate, shot, sleep, out, expect, cards: CARDS });
  } catch (error) {
    failures.push(`scenario stopped: ${String(error).slice(0, 600)}`);
  }
  if (errors.length) out.consoleErrors = errors.slice(0, 20);
  socket.close();
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ failures, ...out }, null, 2));
  return failures;
}

let failed = 0;
for (const name of ONLY) {
  const before = calls.length;
  const failures = await runScenario(name);
  console.log(`\n== ${name}: ${failures.length ? 'FAILED' : 'passed'}`);
  for (const failure of failures) console.log(`  ✕ ${failure}`);
  console.log(`  helper calls: ${calls.slice(before).join(' · ')}`);
  failed += failures.length;
}
page.close();
bridge.close();
// As when the browser closes the port: the helper finishes and exits.
helper.stdin.end();
await new Promise((done) => (helper.exitCode !== null ? done() : helper.on('close', done)));
rmSync(WORK, { recursive: true, force: true });
console.log(`\nResults and screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
