// Configure, with the prepared card open: "Configure SD Card" in place of writing its configuration.
// It checks the card and does the least it needs — only the settings, when that is all that
// differs; erasing and setting it up again, confirmed first, once the card holds a file from
// before; the settings and the card's name, for another device — and after erasing or renaming
// lets go of the folder that was open on the card, saying what it did. And a batch's written
// card, once the settings change on Configure, no longer counts as written.
import { card, helperReady, rail, renameBack, until } from './common.mjs';

const sidebar = `[...document.querySelectorAll('.card')].find((c) => c.querySelector('button')?.textContent.startsWith('Configure SD Card'))`;
const outcome = `(() => { const b = document.querySelector('.banner.ok strong'); return b ? $text(b.parentElement) : null; })()`;
const banner = (kind) => `(() => { const b = document.querySelector('.stack > .banner.${kind}, .content > .banner.${kind}'); return b ? $text(b) : null; })()`;
const unit = `$text(document.querySelector('.batch-units .period-row'))`;

export default async ({ evaluate, shot, sleep, out, expect, cards }) => {
  expect('the A3EM Card Helper reports ready', await helperReady(evaluate, sleep));

  // First, on Prepare devices, one card pressed straight to "Prepare this card", unchecked, when
  // it needs only its settings: the check it makes on the way is the one its result shows.
  await evaluate(rail('Prepare devices'));
  await until(evaluate, sleep, `Boolean(${card(cards.prepared)})`, 200);
  const type = (id, value) => evaluate(`(() => { const input = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  // One unit, OWL_01, which the prepared card is already named for.
  await type('prefix', 'OWL');
  await type('count', '1');
  await evaluate(`$btn('Create batch').click()`);
  await sleep(300);
  await evaluate(`$btn('Prepare this card', ${card(cards.prepared)}).click()`);
  out.single = await until(evaluate, sleep, `(() => { const r = ${card(cards.prepared)}.querySelector('.card-result'); return r && /Settings written/.test(r.textContent) ? $text(r) : null; })()`, 600);
  expect('one card needing only its settings gets them, with its layout shown as checked', /Settings written/.test(out.single ?? '') && /Layout matches the reference/.test(out.single ?? '') && !/Layout not checked/.test(out.single ?? ''), out.single);

  await evaluate(`$btn('Connect SD card').click()`);
  out.header = await until(evaluate, sleep, `(() => { const t = $text(document.querySelector('.topbar')); return t.includes('Eject') ? t : null; })()`, 300);
  expect('the open folder is matched to its card', Boolean(out.header), await evaluate(`$text(document.querySelector('.topbar'))`));
  if (!out.header) return;

  await evaluate(rail('Configure'));
  // The batch's card has these settings: Configure says so before anything is changed.
  out.before = await until(evaluate, sleep, banner('warn'), 100);
  expect('Configure warns that changing the settings would split the batch', /A card of your batch has been written with these settings/.test(out.before ?? '') && /OWL_01/.test(out.before ?? ''), out.before);
  await type('label', 'OWL_01');
  expect('a label of its own is no change to the batch', Boolean(await evaluate(banner('warn'))));
  // And one setting changed from what the step above wrote, so there is something to write.
  await evaluate(`document.getElementById('rtc-at-activation').click()`);
  out.after = await until(evaluate, sleep, banner('crit'), 100);
  expect('and once changed, says the card written already now differs', /A card of your batch was written with different settings/.test(out.after ?? '') && /back to “No card yet”/.test(out.after ?? ''), out.after);
  await shot('0-batch-differs');
  out.button = await until(evaluate, sleep, `$btn('Configure SD Card')?.textContent ?? null`, 100);
  expect('Configure offers "Configure SD Card" for the open card', out.button === 'Configure SD Card', out.button);
  expect('and no longer writes the configuration on its own', !(await evaluate(`Boolean($btn('Write to'))`)));

  // Its settings differ from those on the card by that one: only they need writing.
  await evaluate(`$btn('Configure SD Card').click()`);
  out.settings = await until(evaluate, sleep, outcome, 600);
  expect('a card needing only its settings gets them, and nothing is erased', /OWL_01 configured as OWL_01/.test(out.settings ?? '') && /Settings written; nothing needed erasing/.test(out.settings ?? ''), out.settings ?? (await evaluate(`$text(${sidebar})`)));
  expect('and nothing asked to confirm an erase', !(await evaluate(`Boolean(document.querySelector('dialog[open]'))`)));

  // A recording from before, on the card: now it must be erased first, and says so.
  await fetch('http://127.0.0.1:8790/put', { method: 'POST', body: JSON.stringify({ role: 'prepared', path: 'OWL_01/1700000000.wav', bytes: 50000 }) });
  await sleep(300);
  await evaluate(`$btn('Configure SD Card').click()`);
  out.dialog = await until(evaluate, sleep, `$text(document.querySelector('dialog[open]'))`, 600);
  expect('a card holding files is erased only once confirmed, in the helper’s words', /Erase and prepare this card\?/.test(out.dialog ?? '') && /Becomes OWL_01/.test(out.dialog ?? ''), out.dialog);
  await shot('1-confirm');
  await evaluate(`document.querySelectorAll('dialog[open] input[type=checkbox]').forEach((box) => box.click())`);
  await sleep(100);
  await evaluate(`$btn('Erase and prepare', document.querySelector('dialog[open]')).click()`);
  out.prepared = await until(evaluate, sleep, `(() => { const t = ${outcome}; return t && /layout verified/.test(t) ? t : null; })()`, 1200);
  expect('the card is erased and set up again, and what was done stays on screen', /OWL_01 configured as OWL_01/.test(out.prepared ?? '') && /layout verified/.test(out.prepared ?? ''), out.prepared);
  out.afterErase = await evaluate(`$text(document.querySelector('.topbar'))`);
  expect('the folder open on it is let go of, and the header says why', /OWL_01 was erased and configured as OWL_01/.test(out.afterErase ?? ''), out.afterErase);
  await shot('2-prepared');

  // Back on Prepare devices, the unit written with the earlier settings is waiting again...
  await evaluate(rail('Prepare devices'));
  await until(evaluate, sleep, `Boolean(${card(cards.prepared)})`, 200);
  out.unit = await evaluate(unit);
  expect('the unit written before the change is back to “No card yet”, saying why', /No card yet/.test(out.unit ?? '') && /before the settings changed on Configure/.test(out.unit ?? ''), out.unit);
  expect('and the page says so at the top', /1 card was|One card was/.test((await evaluate(banner('warn'))) ?? ''), await evaluate(banner('warn')));
  // ...until its card, prepared on Configure with the settings as they are now, is checked.
  await evaluate(`$btn('Check this card', ${card(cards.prepared)}).click()`);
  out.found = await until(evaluate, sleep, `(() => { const t = ${unit}; return /Card written/.test(t) ? t : null; })()`, 600);
  expect('a card found prepared for the unit counts as its card', Boolean(out.found), `${await evaluate(unit)} || ${await evaluate(`$text(${card(cards.prepared)}.querySelector('.card-result'))`)}`);
  expect('and nothing is left to warn about', !(await evaluate(banner('warn'))));
  await shot('3-found');

  // Last, Configure for another device: the card gets its settings and its name, erasing
  // nothing, and the folder open on it, which the new name moves, is let go of.
  await evaluate(rail('Configure'));
  const reopen = async (step) => {
    await until(evaluate, sleep, `Boolean($btn('Connect SD card'))`, 100);
    await evaluate(`window.__PICK_CARD_AGAIN__ = true; $btn('Connect SD card')?.click()`);
    const opened = await until(evaluate, sleep, `$text(document.querySelector('.topbar')).includes('Eject')`, 300);
    const button = opened && (await until(evaluate, sleep, `Boolean($btn('Configure SD Card'))`, 100));
    expect(`the card opens again, ${step}`, Boolean(button), await evaluate(`$text(document.querySelector('.topbar'))`));
    if (!button) await shot(`4-not-open-${step}`);
    return Boolean(button);
  };
  if (!(await reopen('to name it for another device'))) return;
  await type('label', 'OWL_02');
  await evaluate(`$btn('Configure SD Card').click()`);
  out.renamed = await until(evaluate, sleep, `(() => { const t = ${outcome}; return t && /OWL_02/.test(t) ? t : null; })()`, 600);
  expect(
    'a card for another device gets its settings and its name, and nothing is erased',
    /OWL_01 configured as OWL_02/.test(out.renamed ?? '') && /Settings written, card named OWL_02; nothing needed erasing/.test(out.renamed ?? ''),
    out.renamed ?? (await evaluate(`$text(${sidebar})`)),
  );
  expect('and the folder the new name moved is let go of, saying so', /Renaming it closed the folder/.test(out.renamed ?? '') && /OWL_01 was renamed OWL_02/.test(await evaluate(`$text(document.querySelector('.topbar'))`)), await evaluate(`$text(document.querySelector('.topbar'))`));
  await shot('4-renamed');

  // The card as it was for the scenarios after this one: named OWL_01, with OWL_01's settings.
  const back = await renameBack(cards.prepared, 'OWL_01');
  expect('the card can be named back', back?.ok === true, back);
  await type('label', 'OWL_01');
  if (!(await reopen('named back'))) return;
  await evaluate(`$btn('Configure SD Card').click()`);
  out.restored = await until(evaluate, sleep, `(() => { const t = ${outcome}; return t && /configured as OWL_01/.test(t) ? t : null; })()`, 600);
  expect('and given its settings again, keeping the name it has', /Settings written; nothing needed erasing/.test(out.restored ?? ''), out.restored);
};
