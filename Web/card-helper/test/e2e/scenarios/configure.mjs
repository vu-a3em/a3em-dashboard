// Configure: with the card tools, the forecast sends formatting to Prepare devices, in one sentence
// with the tab as a link, rather than listing commands to type.
import { helperReady, until } from './common.mjs';

export default async ({ evaluate, shot, sleep, out, expect }) => {
  expect('the A3EM Card Helper reports ready', await helperReady(evaluate, sleep));
  const note = `[...document.querySelectorAll('.stat-note')].find((e) => /using the Prepare devices page/.test(e.textContent))`;
  out.format = await until(evaluate, sleep, `$text(${note})`, 100);
  expect('the forecast points to Prepare devices', /^Format the card as exFAT with .+ clusters using the Prepare devices page\.$/.test(out.format ?? ''), out.format);
  out.mentions = await evaluate(`(document.querySelector('.content').textContent.match(/Format the card as exFAT/g) ?? []).length`);
  expect('and says so once, not twice', out.mentions === 1, out.mentions);
  expect('and lists no commands to type', !(await evaluate(`Boolean(document.querySelector('.format-steps code'))`)));
  await evaluate(`[...${note}.querySelectorAll('.link-button')].find((b) => b.textContent === 'Prepare devices').click()`);
  out.title = await until(evaluate, sleep, `(() => { const t = document.querySelector('.topbar h1')?.textContent; return t === 'Prepare a batch of devices' ? t : null; })()`, 50);
  expect('the link opens "Prepare devices"', Boolean(out.title), await evaluate(`document.querySelector('.topbar h1')?.textContent`));
  await shot('1-forecast');
};
