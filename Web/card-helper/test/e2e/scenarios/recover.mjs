// "Recover card": each kind of card is described for what it is, and a damaged one is copied to
// an image — once stopped partway, leaving nothing behind — checked, repaired and opened, in
// that order.
import { card, helperReady, rail, settle, stopACopy, until } from './common.mjs';

export default async ({ evaluate, shot, sleep, out, expect, cards }) => {
  expect('the A3EM Card Helper reports ready', await helperReady(evaluate, sleep));
  await evaluate(rail('Recover card'));
  expect('the damaged card is listed', await until(evaluate, sleep, `Boolean(${card(cards.damaged)})`, 200));
  const chip = (id) => evaluate(`${card(id)}?.querySelector('.connected-card-head .chip')?.textContent ?? null`);
  out.listed = await evaluate(`[...document.querySelectorAll('.connected-card')].map((c) => c.dataset.device)`);
  expect('only cards that do not open are listed', !out.listed.includes(cards.prepared) && !out.listed.includes(cards.old) && (!cards.dirty || !out.listed.includes(cards.dirty)), out.listed);
  out.chips = { damaged: await chip(cards.damaged), blank: await chip(cards.blank) };
  expect('the damaged card is not open', ['Not open', 'Cannot be opened'].includes(out.chips.damaged), out.chips);
  expect('the blank card has no partitions', out.chips.blank === 'No partitions', out.chips);
  out.hint = await evaluate(`$text(document.querySelector('.card .hint'))`);
  expect('the page says which cards it shows', /Only cards that are corrupted, unmountable, or unreadable will be shown/.test(out.hint ?? ''), out.hint);
  await shot('1-listed');

  const damaged = card(cards.damaged);
  await evaluate(`$btn('Open it', ${damaged}).click()`);
  out.openFirst = await settle(evaluate, sleep, damaged);
  expect('opening the damaged card fails and says so', out.openFirst.at(-1)?.includes('✕'), out.openFirst.at(-1));

  await stopACopy(evaluate, sleep, damaged, expect, out);

  await evaluate(`$btn('Copy to an image file', ${damaged}).click()`);
  out.image = await settle(evaluate, sleep, damaged);
  expect('it says where the image goes and how much room is there', out.image.some((line) => /Saving it as .* where .* is free/.test(line)), out.image);
  out.imageResult = await evaluate(`$text(${damaged}.querySelector('.card-result'))`);
  expect('the whole card is copied to an image', /copied/.test(out.imageResult ?? ''), out.imageResult);

  await evaluate(`$btn('Check the filesystem', ${damaged}).click()`);
  out.check = await settle(evaluate, sleep, damaged);
  out.checkResult = await evaluate(`[...${damaged}.querySelectorAll('.card-result')].map((r) => $text(r)).join(' || ')`);
  expect('the check finds problems', /found problems/.test(out.checkResult ?? ''), out.checkResult);
  expect('it finds the damaged boot region, and that its backup can replace it', /boot region/.test(out.checkResult ?? '') && /backup copy is intact/.test(out.checkResult ?? ''), out.checkResult);

  await evaluate(`$btn('Repair', ${damaged}).click()`);
  out.dialog = await until(evaluate, sleep, `$text(document.querySelector('dialog[open]'))`, 300);
  expect('the repair is confirmed in the helper’s words', /repair the filesystem/i.test(out.dialog ?? ''), out.dialog);
  expect('with an image made, no extra acknowledgment is asked', !/without an image/.test(out.dialog ?? ''), out.dialog);
  expect('the dialog says it is the narrow repair', /rewrites only what the check found wrong/.test(out.dialog ?? ''), out.dialog);
  await shot('2-repair');
  await evaluate(`$btn('Repair', document.querySelector('dialog[open]')).click()`);
  out.repair = await settle(evaluate, sleep, damaged);
  out.repairResult = await evaluate(`[...${damaged}.querySelectorAll('.card-result')].map((r) => $text(r)).join(' || ')`);
  expect('the repair reports success', /was repaired/.test(out.repairResult ?? ''), out.repairResult);
  expect('it restored the boot region from its copy', /boot region, restored from its intact copy/.test(out.repairResult ?? ''), out.repairResult);

  if ((await chip(cards.damaged)) !== 'Opens now') {
    await evaluate(`$btn('Open it', ${card(cards.damaged)}).click()`);
    out.openAfter = await settle(evaluate, sleep, card(cards.damaged));
  }
  out.afterChip = await until(evaluate, sleep, `(() => { const c = ${card(cards.damaged)}?.querySelector('.connected-card-head .chip')?.textContent; return c === 'Opens now' ? c : null; })()`, 200);
  expect('the recovered card opens, and stays listed so that is seen', out.afterChip === 'Opens now', await chip(cards.damaged));
  await shot('3-repaired');
};
