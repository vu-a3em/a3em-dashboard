// Configure, with the prepared card open: "Prepare {card}…" in place of writing its configuration.
// It checks the card and does the least it needs — only the settings, when that is all that
// differs; erasing and setting it up again, confirmed first, once the card holds a file from
// before — and after erasing lets go of the folder that was open on the card, saying what it did.
import { helperReady, rail, until } from './common.mjs';

const sidebar = `[...document.querySelectorAll('.card')].find((c) => c.querySelector('button')?.textContent.startsWith('Prepare OWL_01'))`;
const outcome = `(() => { const b = document.querySelector('.banner.ok strong'); return b ? $text(b.parentElement) : null; })()`;

export default async ({ evaluate, shot, sleep, out, expect }) => {
  expect('the card tools report ready', await helperReady(evaluate, sleep));
  await evaluate(`$btn('Connect SD card').click()`);
  out.header = await until(evaluate, sleep, `(() => { const t = $text(document.querySelector('.topbar')); return t.includes('Eject') ? t : null; })()`, 300);
  expect('the open folder is matched to its card', Boolean(out.header), await evaluate(`$text(document.querySelector('.topbar'))`));
  if (!out.header) return;

  await evaluate(rail('Configure'));
  await evaluate(`(() => { const input = document.getElementById('label'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'OWL_01'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  out.button = await until(evaluate, sleep, `$btn('Prepare OWL_01')?.textContent ?? null`, 100);
  expect('Configure offers "Prepare OWL_01…" for the open card', out.button === 'Prepare OWL_01…', out.button);
  expect('and no longer writes the configuration on its own', !(await evaluate(`Boolean($btn('Write to'))`)));

  // Its settings are another unit's, from "prepare": only they need writing.
  await evaluate(`$btn('Prepare OWL_01').click()`);
  out.settings = await until(evaluate, sleep, outcome, 600);
  expect('a card needing only its settings gets them, and nothing is erased', /OWL_01 is unit OWL_01/.test(out.settings ?? '') && /settings written; nothing needed erasing/.test(out.settings ?? ''), out.settings ?? (await evaluate(`$text(${sidebar})`)));
  expect('and nothing asked to confirm an erase', !(await evaluate(`Boolean(document.querySelector('dialog[open]'))`)));

  // A recording from before, on the card: now it must be erased first, and says so.
  await fetch('http://127.0.0.1:8790/put', { method: 'POST', body: JSON.stringify({ role: 'prepared', path: 'OWL_01/1700000000.wav', bytes: 50000 }) });
  await sleep(300);
  await evaluate(`$btn('Prepare OWL_01').click()`);
  out.dialog = await until(evaluate, sleep, `$text(document.querySelector('dialog[open]'))`, 600);
  expect('a card holding files is erased only once confirmed, in the helper’s words', /Erase and prepare this card\?/.test(out.dialog ?? '') && /Becomes unit OWL_01/.test(out.dialog ?? ''), out.dialog);
  await shot('1-confirm');
  await evaluate(`document.querySelectorAll('dialog[open] input[type=checkbox]').forEach((box) => box.click())`);
  await sleep(100);
  await evaluate(`$btn('Erase and prepare', document.querySelector('dialog[open]')).click()`);
  out.prepared = await until(evaluate, sleep, `(() => { const t = ${outcome}; return t && /prepared as unit/.test(t) ? t : null; })()`, 1200);
  expect('the card is erased and set up again, and what was done stays on screen', /OWL_01 prepared as unit OWL_01/.test(out.prepared ?? '') && /layout verified/.test(out.prepared ?? ''), out.prepared);
  out.afterErase = await evaluate(`$text(document.querySelector('.topbar'))`);
  expect('the folder open on it is let go of, and the header says why', /OWL_01 was erased to prepare it as OWL_01/.test(out.afterErase ?? ''), out.afterErase);
  await shot('2-prepared');
};
