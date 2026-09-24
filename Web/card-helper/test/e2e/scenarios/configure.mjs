// Configure: with the card tools, the forecast sends formatting to "Prepare devices" rather than
// listing commands to type.
import { helperReady, until } from './common.mjs';

export default async ({ evaluate, shot, sleep, out, expect }) => {
  expect('the card tools report ready', await helperReady(evaluate, sleep));
  out.format = await until(evaluate, sleep, `$text(document.querySelector('.format-steps'))`, 100);
  expect('the forecast points to "Prepare devices"', /using the Prepare devices page/.test(out.format ?? ''), out.format);
  expect('and lists no commands to type', !(await evaluate(`Boolean(document.querySelector('.format-steps code'))`)));
  await evaluate(`[...document.querySelectorAll('.format-steps .link-button')].find((b) => b.textContent === 'Prepare devices').click()`);
  out.title = await until(evaluate, sleep, `(() => { const t = document.querySelector('.topbar h1')?.textContent; return t === 'Prepare a batch of devices' ? t : null; })()`, 50);
  expect('the link opens "Prepare devices"', Boolean(out.title), await evaluate(`document.querySelector('.topbar h1')?.textContent`));
  await shot('1-forecast');
};
