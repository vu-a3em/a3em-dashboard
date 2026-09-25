// What every scenario needs: finding things, and waiting for them.
export const card = (id) => `document.querySelector('.connected-card[data-device=${JSON.stringify(id)}]')`;
export const rail = (label) => `[...document.querySelectorAll('.rail-link')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`;
export const logOf = (box) => `(() => { const l = ${box}?.querySelector('.card-log'); return l ? l.tagName + ' :: ' + $text(l) : null; })()`;

export async function until(evaluate, sleep, expression, limit = 600) {
  for (let i = 0; i < limit; i++) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(100);
  }
  return null;
}

/** Waits for a card's log to finish (fold away) or fail, and returns what it showed on the way. */
export async function settle(evaluate, sleep, box, limit = 3000) {
  const seen = [];
  for (let i = 0; i < limit; i++) {
    const text = await evaluate(logOf(box));
    if (text && seen.at(-1) !== text) seen.push(text);
    if (text && (text.startsWith('DETAILS') || text.includes('✕'))) break;
    await sleep(100);
  }
  return seen;
}

// A request straight to the helper, through the harness's bridge: its last line is the reply.
export async function helperCall(request) {
  const response = await fetch('http://127.0.0.1:8790/', { method: 'POST', body: JSON.stringify({ id: `scenario-${Date.now()}`, ...request }) });
  return JSON.parse((await response.text()).trim().split('\n').at(-1));
}

/** Names a test card back to what the scenarios after this one expect. */
export async function renameBack(device, label) {
  const listed = await helperCall({ op: 'listDevices' });
  const volume = listed.devices?.find((entry) => entry.id === device)?.volumes?.[0]?.id;
  return volume ? helperCall({ op: 'rename', volume, label }) : null;
}

export async function helperReady(evaluate, sleep) {
  return until(evaluate, sleep, `document.querySelector('.rail-foot')?.textContent.includes('ready')`, 200);
}

// Starts a copy of the card in `box` to an image, stops it once it is under way, and checks that
// it says so and leaves no image, finished or not, behind.
export async function stopACopy(evaluate, sleep, box, expect, out) {
  const images = async () => JSON.parse(await (await fetch('http://127.0.0.1:8790/images')).text());
  const logText = `(${box}?.querySelector('.card-log')?.textContent ?? '')`;
  const before = await images();
  await evaluate(`$btn('Copy to an image file', ${box}).click()`);
  await until(evaluate, sleep, `${logText}.includes('Copying the card sector by sector')`, 300);
  out.stopOffered = await evaluate(`Boolean($btn('Stop', ${box}))`);
  expect('a running copy offers Stop', out.stopOffered);
  if (!out.stopOffered) return;
  await evaluate(`$btn('Stop', ${box}).click()`);
  await until(evaluate, sleep, `${logText}.includes('Stopped.') || ${logText}.includes('✕')`, 300);
  out.stopped = await evaluate(logText);
  expect('the copy stops, and says the unfinished image is gone', /Stopped\. The unfinished image was deleted/.test(out.stopped), out.stopped);
  out.imagesAfterStop = (await images()).filter((name) => !before.includes(name));
  expect('and no image or partial file is left', out.imagesAfterStop.length === 0, out.imagesAfterStop);
  const results = await evaluate(`[...${box}.querySelectorAll('.card-result')].map((r) => $text(r)).join(' || ')`);
  expect('no copy is reported for a stopped copy', !/The whole card was copied|Copied, except/.test(results ?? ''), results);
  // Until the page has let go of the stopped copy, the next one is not offered.
  await until(evaluate, sleep, `!$btn('Copy to an image file', ${box})?.disabled`, 100);
}
