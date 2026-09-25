// "Connect SD card", matched to its physical card: the header can eject it, and Review card
// shows the card itself — a card prepared and not yet deployed, which each page says rather than
// showing an empty deployment. Leaves no marker file behind.
import { helperReady, rail, until } from './common.mjs';

export default async ({ evaluate, shot, sleep, out, expect }) => {
  expect('the A3EM Card Helper reports ready', await helperReady(evaluate, sleep));
  await evaluate(`$btn('Connect SD card').click()`);
  out.header = await until(evaluate, sleep, `(() => { const t = $text(document.querySelector('.topbar')); return t.includes('Eject') ? t : null; })()`, 300);
  expect('the open folder is matched to its card, so the header offers Eject', Boolean(out.header), await evaluate(`$text(document.querySelector('.topbar'))`));
  // Everything after depends on the match.
  if (!out.header) return;
  out.probesLeft = Number(await (await fetch('http://127.0.0.1:8790/probes')).text());
  expect('no marker file is left on the card', out.probesLeft === 0, out.probesLeft);

  await evaluate(rail('Review card'));
  out.physical = await until(evaluate, sleep, `(() => { const t = $text(document.querySelector('details.physical-card')); return t && !t.includes('Reading the card’s details…') ? t : null; })()`, 300);
  expect('Review card shows the card itself', /device/i.test(out.physical ?? ''), out.physical);
  expect('and what this computer found when it prepared it', /Prepared on this computer/.test(out.physical ?? ''), out.physical);
  if (!out.physical) return;
  await evaluate(`document.querySelector('details.physical-card').scrollIntoView(); $btn('Check the filesystem', document.querySelector('details.physical-card')).click()`);
  out.check = await until(evaluate, sleep, `$text(document.querySelector('details.physical-card .card-result'))`, 3000);
  expect('the filesystem check finds no problems', /No problems found/.test(out.check ?? ''), out.check);
  out.reviewNote = await evaluate(`$text([...document.querySelectorAll('.content > .card')].find((c) => c.querySelector('h2')?.textContent === 'Not deployed yet'))`);
  expect('Review card says the card is not deployed yet, in place of an empty deployment', /prepared for OWL_01/.test(out.reviewNote ?? '') && /so there is nothing to review\./.test(out.reviewNote ?? '') && !/set to run from/.test(out.reviewNote ?? ''), out.reviewNote);
  await shot('1-review');
  for (const [tab, words] of [['Listen', 'so there is nothing to listen to.'], ['Check & copy', 'so there is nothing to check or copy.']]) {
    await evaluate(rail(tab));
    const note = await until(evaluate, sleep, `(() => { const c = [...document.querySelectorAll('.content .card')].find((e) => e.querySelector('h2')?.textContent === 'Not deployed yet'); return c ? $text(c) : null; })()`, 100);
    expect(`${tab} says the card is not deployed yet`, (note ?? '').includes(words), note ?? (await evaluate(`$text(document.querySelector('.content'))`))?.slice(0, 300));
  }
  await evaluate(rail('Review card'));

  await evaluate(`$btn('Eject', document.querySelector('.topbar')).click()`);
  out.afterEject = await until(evaluate, sleep, `(() => { const t = $text(document.querySelector('.topbar')); return t.includes('Reopen') ? t : null; })()`, 300);
  expect('after Eject, the header offers to reopen the card', Boolean(out.afterEject), await evaluate(`$text(document.querySelector('.topbar'))`));
};
