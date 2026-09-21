#!/usr/bin/env node
/**
 * Compile the FIRMWARE's solar calculation and check it against the dashboard's copy.
 *
 * WHY THIS EXISTS
 * ---------------
 * `solar.ts` and `a3em-firmware/src/app/solar.c` implement the same NOAA algorithm twice.
 * The device owns the real one — it recomputes its schedule every local day — and the
 * dashboard's copy exists only so the editor can show what the device will do before a card
 * is written. The moment the two disagree, the dashboard is lying about the hardware, and it
 * lies quietly: a preview that is half an hour out looks exactly like a correct one.
 *
 * So this compiles `solar.c` for the host against a stub header, runs both implementations
 * over several hundred positions, dates and UTC offsets, and diffs them field for field.
 *
 * NOT part of `npm run ci`, because it needs a host C compiler and the firmware submodule.
 * Run it whenever either implementation changes:
 *
 *     npm run check:solar
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIRMWARE = process.env.A3EM_FIRMWARE_PATH ?? join(HERE, '..', '..', 'a3em-firmware');
const SOLAR_C = join(FIRMWARE, 'src', 'app', 'solar.c');
const SOLAR_H = join(FIRMWARE, 'src', 'app', 'solar.h');
const CASE_COUNT = 500;

if (!existsSync(SOLAR_C)) {
  console.error(`No firmware solar.c at ${SOLAR_C}.`);
  console.error('Run `git submodule update --init a3em-firmware`, or set A3EM_FIRMWARE_PATH.');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'a3em-solar-'));
try {
  /*
     solar.h includes static_config.h, which pulls in the whole Ambiq BSP. The stub supplies
     only what solar.c actually uses, which is why solar.h was kept free of any other firmware
     header — that independence is what makes this check possible at all.
  */
  writeFileSync(
    join(work, 'static_config.h'),
    `#ifndef __STATIC_CONFIG_HEADER_H__
#define __STATIC_CONFIG_HEADER_H__
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#endif
`,
  );

  writeFileSync(
    join(work, 'harness.c'),
    `#include <stdio.h>
#include "solar.h"
int main(void) {
   double lat, lon; long ts; int off;
   while (scanf("%lf %lf %ld %d", &lat, &lon, &ts, &off) == 4) {
      solar_day_t d;
      solar_compute(lat, lon, (uint32_t)ts, off, &d);
      for (int a = 0; a < SOLAR_NUM_ANCHORS; ++a)
         printf("%s%d:%d", a ? "," : "", d.available[a], d.available[a] ? d.seconds_of_day[a] : -1);
      printf(",%d,%d\\n", d.polar_day, d.polar_night);
   }
   return 0;
}
`,
  );

  /*
     The firmware sources are linked INTO the work directory rather than reached with a second
     -I. Adding the real src/app to the include path puts the genuine static_config.h ahead of
     the stub, and the build then fails looking for the Ambiq BSP.
  */
  symlinkSync(SOLAR_H, join(work, 'solar.h'));
  symlinkSync(SOLAR_C, join(work, 'solar.c'));

  const cc = process.env.CC ?? 'cc';
  execFileSync(
    cc,
    ['-O2', `-I${work}`, '-o', join(work, 'harness'), join(work, 'harness.c'), join(work, 'solar.c'), '-lm'],
    { stdio: 'inherit' },
  );

  // A fixed seed, so a failure is reproducible and a passing run means the same thing twice.
  let seed = 20260919;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const cases = [];
  for (let i = 0; i < CASE_COUNT; ++i) {
    // Latitudes past the Arctic and Antarctic circles are deliberately included: the polar
    // branches are where the two implementations are most likely to diverge.
    const latitude = Number((random() * 160 - 80).toFixed(4));
    const longitude = Number((random() * 360 - 180).toFixed(4));
    const ts = Math.floor(1767225600 + random() * (1798761600 - 1767225600));
    const offsets = [-43200, -28800, -21600, -18000, 0, 3600, 7200, 10800, 19800, 28800, 46800];
    const offset = offsets[Math.floor(random() * offsets.length)];
    cases.push(`${latitude} ${longitude} ${ts} ${offset}`);
  }

  const fromC = execFileSync(join(work, 'harness'), { input: cases.join('\n') + '\n', encoding: 'utf8' })
    .trim()
    .split('\n');

  const { solarDay } = await import('@a3em/config-schema');
  const ANCHORS = ['DAWN', 'SUNRISE', 'SUNSET', 'DUSK'];
  const mismatches = [];

  cases.forEach((line, index) => {
    const [latitude, longitude, ts, offset] = line.split(/\s+/).map(Number);
    const day = solarDay(ts, { latitude, longitude }, offset);
    const mine =
      ANCHORS.map((a) => `${day.available[a] ? 1 : 0}:${day.available[a] ? day.secondsOfDay[a] : -1}`).join(',') +
      `,${day.polarDay ? 1 : 0},${day.polarNight ? 1 : 0}`;
    if (mine !== fromC[index]) {
      mismatches.push(`  ${line}\n    firmware: ${fromC[index]}\n    dashboard: ${mine}`);
    }
  });

  if (mismatches.length) {
    console.error(`${mismatches.length} of ${CASE_COUNT} cases disagree between solar.c and solar.ts:\n`);
    console.error(mismatches.slice(0, 10).join('\n'));
    if (mismatches.length > 10) console.error(`  ... and ${mismatches.length - 10} more`);
    process.exit(1);
  }

  console.log(`solar.c and solar.ts agree on all ${CASE_COUNT} cases.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
