// "Review card" for a card that opens but whose filesystem is damaged: the card itself is at the
// top, its check finds the problem, explains it and names the recording it touches; a copy to an
// image can be stopped, leaving nothing behind; it is copied — and still shown copying after a
// visit to another tab — then repaired by the helper's own repair, and opened again.
import { helperReady, rail, stopACopy, until } from './common.mjs';

const pane = `document.querySelector('details.physical-card')`;
const log = `(() => { const l = ${pane}?.querySelector('.card-log'); return l ? l.tagName + ' :: ' + $text(l) : null; })()`;

async function settlePane(evaluate, sleep, limit = 3000) {
  const seen = [];
  for (let i = 0; i < limit; i++) {
    const text = await evaluate(log);
    if (text && seen.at(-1) !== text) seen.push(text);
    if (text && (text.startsWith('DETAILS') || text.includes('✕'))) break;
    await sleep(100);
  }
  return seen;
}

export default async ({ evaluate, shot, sleep, out, expect, cards }) => {
  expect('the card tools report ready', await helperReady(evaluate, sleep));
  if (!cards.dirty) return;
  await evaluate(`$btn('Connect SD card').click()`);
  out.header = await until(evaluate, sleep, `(() => { const t = $text(document.querySelector('.topbar')); return t.includes('Eject') ? t : null; })()`, 300);
  expect('the dirty card is matched, so the header offers Eject', Boolean(out.header));
  if (!out.header) return;
  await evaluate(rail('Review card'));
  // Loaded on its own, so it may follow the rest of the page by a moment.
  await until(evaluate, sleep, `Boolean(${pane})`, 200);
  out.first = await evaluate(`document.querySelector('.content > details.card, .content > .card')?.querySelector('h2')?.textContent ?? null`);
  expect('"The card itself" is at the top of the page', out.first === 'The card itself', out.first);
  expect('no repair is offered before a check', !(await evaluate(`Boolean($btn('Repair', ${pane}))`)));

  await evaluate(`$btn('Check the filesystem', ${pane}).click()`);
  out.check = await settlePane(evaluate, sleep);
  out.checkResult = await evaluate(`$text(${pane}.querySelector('.card-result'))`);
  expect('the check finds the bitmap problem and says what it means', /found problems/.test(out.checkResult ?? '') && /record of which space is in use/.test(out.checkResult ?? ''), out.checkResult);
  expect('and a repair is offered', await evaluate(`Boolean($btn('Repair', ${pane}))`));
  expect('it names the recording the problem touches', /OWL_09\/clip\.wav/.test(out.checkResult ?? ''), out.checkResult);
  expect('it finds the log lines written past the log’s recorded end, for the copy', /OWL_09\/a3em\.log — [\d.,]+ (bytes|kB) of log text/.test(out.checkResult ?? '') && /“Check & copy” adds it/.test(out.checkResult ?? ''), out.checkResult);
  // Those lines are in the log's own cluster, which a repair leaves alone: nothing to warn of.
  expect('and the repair advice stands, since the repair leaves those lines alone', /changes no\s+file/.test(out.checkResult ?? '') && !/before any repair/.test(out.checkResult ?? ''), out.checkResult);

  // A copy can be stopped, and leaves no image, finished or not, behind.
  await stopACopy(evaluate, sleep, pane, expect, out);

  // Copying, away to another tab, and back: the copy is still showing.
  await evaluate(`$btn('Copy to an image file', ${pane}).click()`);
  await until(evaluate, sleep, `(${log} ?? '').includes('Copying the card sector by sector')`, 300);
  await evaluate(rail('Configure'));
  await sleep(700);
  await evaluate(rail('Review card'));
  out.backMidCopy = await until(evaluate, sleep, log, 50);
  expect('after another tab, the copy is still shown', /Copying the card sector by sector|What the card helper did/.test(out.backMidCopy ?? ''), out.backMidCopy);
  out.copy = await settlePane(evaluate, sleep);
  out.imageResult = await evaluate(`$text(${pane}.querySelector('.card-result'))`);
  expect('the card is copied to an image', /copied/.test(out.imageResult ?? ''), out.imageResult);

  await evaluate(`$btn('Repair', ${pane}).click()`);
  out.dialog = await until(evaluate, sleep, `$text(document.querySelector('dialog[open]'))`, 300);
  expect('the repair is confirmed, and with an image made asks nothing more', /repair the filesystem/i.test(out.dialog ?? '') && !/without an image/.test(out.dialog ?? ''), out.dialog);
  expect('the dialog says it is the narrow repair, undoable', /rewrites only what the check found wrong/.test(out.dialog ?? ''), out.dialog);
  await evaluate(`$btn('Repair', document.querySelector('dialog[open]')).click()`);
  out.repair = await settlePane(evaluate, sleep);
  out.repaired = await evaluate(`[...${pane}.querySelectorAll('.card-result')].map((r) => $text(r)).join(' || ')`);
  expect('the repair succeeds', /was repaired/.test(out.repaired ?? ''), out.repaired);
  expect('it says what it repaired, and where the old bytes are', /record of which space is in use, rebuilt from the files/.test(out.repaired ?? '') && /kept in .* for 30 days/.test(out.repaired ?? ''), out.repaired);
  out.reopened = await until(evaluate, sleep, `(() => { const t = $text(document.querySelector('.topbar')); return t.includes('Eject') ? t : null; })()`, 300);
  expect('the card is open again afterward', Boolean(out.reopened), await evaluate(`$text(document.querySelector('.topbar'))`));
  out.probesLeft = Number(await (await fetch('http://127.0.0.1:8790/probes?role=dirty')).text());
  expect('no marker file is left on the card', out.probesLeft === 0, out.probesLeft);
  await shot('1-repaired');

  // "Check & copy" adds the log's unrecorded lines to its copy, where they belong, using what the
  // check above found: no second password prompt.
  await evaluate(rail('Check & copy'));
  await until(evaluate, sleep, `Boolean($btn('Choose destination and copy'))`, 100);
  await evaluate(`$btn('Choose destination and copy').click()`);
  out.copyDone = await until(evaluate, sleep, `(() => { const t = $text(document.querySelector('.content')); return /Copy finished/.test(t) ? t : null; })()`, 600);
  expect('the copy says what it added past the card’s recorded end', /1 copy holds what the card had not recorded/.test(out.copyDone ?? '') && /OWL_09\/a3em\.log — 560 bytes of log text/.test(out.copyDone ?? ''), out.copyDone);
  out.logCopy = await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const copy = await root.getDirectoryHandle('copy-destination');
    const file = await (await (await copy.getDirectoryHandle('OWL_09')).getFileHandle('a3em.log')).getFile();
    const report = await (await copy.getFileHandle('a3em-copy-report.txt')).getFile();
    return { size: file.size, text: await file.text(), report: await report.text() };
  })()`);
  const expected = Array.from({ length: 120 }, (_, i) => `EVT|TICK|t=${1788000000 + i},ok\n`).join('').slice(0, 2560);
  expect('the log’s copy is its recorded 2,000 bytes and the 560 after them, in place', out.logCopy?.size === 2560 && out.logCopy?.text === expected, out.logCopy?.size);
  expect('and the copy report lists it', /OWL_09\/a3em\.log\t560 bytes of log text/.test(out.logCopy?.report ?? ''), out.logCopy?.report);
  await shot('2-copied');
};
