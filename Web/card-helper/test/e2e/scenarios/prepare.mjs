// "Check this card", then one "Prepare this card" that does the least each card needs: erasing
// the old card, only writing settings to the prepared one, and nothing for a card with no unit.
// The old card is open in the dashboard meanwhile, and is let go of once it is erased.
import { card, helperReady, rail, settle, until } from './common.mjs';

const pick = (id, label) =>
  `(() => { const s = ${card(id)}.querySelector('select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(label)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`;

export default async ({ evaluate, shot, sleep, out, expect, cards }) => {
  expect('the A3EM Card Helper reports ready', await helperReady(evaluate, sleep));
  // Open the old card first, as someone reviewing a card before reusing it would have it.
  await evaluate(`$btn('Connect SD card').click()`);
  out.opened = await until(evaluate, sleep, `(() => { const t = $text(document.querySelector('.topbar')); return t.includes('Eject') ? t : null; })()`, 300);
  await evaluate(rail('Prepare devices'));
  expect('the old card is listed', await until(evaluate, sleep, `Boolean(${card(cards.old)})`, 200));
  out.order = await evaluate(`[...document.querySelectorAll('.card h2, .card .card-head h2')].map((h) => h.textContent.trim())`);
  expect('the cards come after the batch', out.order.findIndex((t) => t.startsWith('Devices in this batch')) < out.order.indexOf('Cards connected to this computer'), out.order);
  out.contents = await evaluate(`$text([...document.querySelectorAll('.card')].find((c) => c.querySelector('h2')?.textContent === 'What each card will contain'))`);
  expect('the batch says what each card will contain, from Configure, as a link', /The settings from Configure/.test(out.contents ?? '') && (await evaluate(`Boolean([...document.querySelectorAll('.card .hint .link-button')].find((b) => b.textContent === 'Configure'))`)), out.contents);
  const prepareButton = (id) => `$btn('Prepare this card', ${card(id)})`;
  out.noBatch = await evaluate(`[${prepareButton(cards.old)}.disabled, ${prepareButton(cards.old)}.title]`);
  expect('without a batch, "Prepare this card" cannot be pressed, and says why', out.noBatch[0] === true && /Create a batch/.test(out.noBatch[1]), out.noBatch);

  // Two units for the cards in view: the old and the prepared card get them, the rest none.
  await evaluate(`(() => { const input = document.getElementById('count'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '2'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`$btn('Create batch').click()`);
  await sleep(300);
  await evaluate(pick(cards.old, 'A3EM_01'));
  await evaluate(pick(cards.prepared, 'A3EM_02'));
  await sleep(200);
  out.units = await evaluate(`[...document.querySelectorAll('.connected-card')].map((c) => [c.dataset.device, c.querySelector('select')?.value || 'none'])`);
  expect('a card beyond the batch has no unit', out.units.some(([, unit]) => unit === 'none'), out.units);
  out.beforeCheck = await evaluate(`${prepareButton(cards.old)}.disabled`);
  expect('with a batch, "Prepare this card" can be pressed before any check', out.beforeCheck === false);

  // Prepare without checking: the check runs first, in the same log, and leads into preparing.
  await evaluate(`[...document.querySelectorAll('.connected-card-batch button')].find((b) => b.textContent.startsWith('Prepare')).click()`);
  out.checkFirst = await until(evaluate, sleep, `(() => { const l = ${card(cards.old)}.querySelector('.card-log'); return l && /Checking the cards? first/.test(l.textContent) ? $text(l) : null; })()`, 100);
  expect('it checks the cards first', Boolean(out.checkFirst), out.checkFirst);
  out.dialog = await until(evaluate, sleep, `$text(document.querySelector('dialog[open]'))`, 1200);
  expect('only the card being erased is confirmed', (out.dialog ?? '').includes('Becomes unit A3EM_01') && !(out.dialog ?? '').includes('A3EM_02'), out.dialog);
  out.plans = { old: await evaluate(`$text(${card(cards.old)}.querySelector('.card-log'))`) };
  await shot('1-confirm');
  await evaluate(`document.querySelectorAll('dialog[open] input[type=checkbox]').forEach((box) => box.click())`);
  await sleep(100);
  await evaluate(`$btn('Erase and prepare', document.querySelector('dialog[open]')).click()`);
  await sleep(1500);
  await settle(evaluate, sleep, card(cards.old));
  await settle(evaluate, sleep, card(cards.prepared));
  await sleep(500);
  const banner = (id) => evaluate(`$text(${card(id)}.querySelector('.card-result .banner'))`);
  out.after = { old: await banner(cards.old), prepared: await banner(cards.prepared) };
  expect('the old card is prepared', /^Prepared/.test(out.after.old ?? ''), out.after.old);
  expect('the prepared card has its settings', /^Settings written/.test(out.after.prepared ?? ''), out.after.prepared);
  // Checked first, as part of preparing it: that check's layout stands, rather than "not checked".
  out.preparedResult = await evaluate(`$text(${card(cards.prepared)}.querySelector('.card-result'))`);
  expect('and its layout, checked on the way, is still shown as checked', /Layout matches the reference/.test(out.preparedResult ?? '') && !/Layout not checked/.test(out.preparedResult ?? ''), out.preparedResult);
  // Its text, folded or not: a closed <details> shows only its summary.
  out.oldLog = await evaluate(`${card(cards.old)}.querySelector('details.card-log')?.textContent ?? null`);
  expect('one log runs from the check through the preparation', /Checking the cards? first/.test(out.oldLog ?? '') && /Writing the A3EM layout/.test(out.oldLog ?? ''), out.oldLog);
  out.unitList = await evaluate(`[...document.querySelectorAll('.batch-units .period-row')].map((r) => $text(r))`);
  expect('both units show "Card written"', out.unitList.length === 2 && out.unitList.every((row) => row.startsWith('Card written')), out.unitList);
  out.plan = await evaluate(`$text(${card(cards.old)}.querySelector('.readiness-plan'))`);
  // Where the harness can mark the old card, it was matched to the folder open on it: erasing it
  // takes that folder away, and the header says so rather than showing what was on it before.
  if (out.opened) {
    out.afterErase = await until(evaluate, sleep, `(() => { const t = $text(document.querySelector('.topbar')); return /was erased to prepare it as A3EM_01/.test(t) ? t : null; })()`, 100);
    expect('the card that was open is let go of once erased, and the header says why', Boolean(out.afterErase), await evaluate(`$text(document.querySelector('.topbar'))`));
    await evaluate(rail('Review card'));
    await sleep(300);
    out.reviewAfterErase = await evaluate(`document.querySelector('.content .card h2')?.textContent ?? null`);
    expect('and "Review card" shows no card, not the old one', out.reviewAfterErase === 'No card connected', out.reviewAfterErase);
  }
  await shot('2-prepared');
};
