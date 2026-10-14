#!/usr/bin/env node
/**
 * Builds the power-validation deployments, through the same code the app uses.
 *
 *   node tools/power/make-power-configs.mjs digital      [--minutes 60] [--start ISO] [--tz ZONE]
 *   node tools/power/make-power-configs.mjs analog       [--minutes 60] [--start ISO] [--tz ZONE]
 *   node tools/power/make-power-configs.mjs transitions  [--minutes 3]  [--start ISO] [--tz ZONE]
 *   node tools/power/make-power-configs.mjs shelf        [--shelf-minutes 120] [--start ISO] [--tz ZONE]
 *   node tools/power/make-power-configs.mjs suite --suite core --temperature room [--card ID] [--microphone ID]
 *                                                 [--battery ID] [--window 60] [--soak-minutes 0] [--label TEXT]
 *
 * `suite` writes the _power.cfg that tells the characterization firmware which suite to run and
 * what it is running with, after checking the temperature and parts against the catalogue so a
 * typo cannot surface later as a run that will not ingest.
 *
 * The characterization firmware measures the pieces; these measure the whole. Each is an
 * ordinary deployment run on the deployment firmware built with POWER_MARKERS=1, which marks
 * every phase start and end on the test points, under a PPK2 capture. The forecaster is right
 * when the charge it predicts for each phase matches the charge the capture measured between
 * that phase's markers.
 *
 *   digital      one phase per recording behaviour a digital-microphone deployment can have
 *   analog       the amplitude-triggered and continuous analog paths
 *   transitions  many short phases, so the cost of ending one phase and booting into the next
 *                is the charge between each PHASE_END and the PHASE_START after it
 *   shelf        configured and activated well before it starts, one short phase, then over:
 *                the pre-deployment wait and the post-deployment sleep, which together are
 *                most of the life of a device that sits on a shelf or in a tree
 *
 * Dates are computed at generation time, so regenerate immediately before writing the card.
 * The low-battery cutoff is off throughout: these runs are on the bench supply.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, defaultPhase } from '../../packages/config-schema/dist/defaults.js';
import { serializeConfig } from '../../packages/config-schema/dist/serialize.js';
import { validateConfig } from '../../packages/config-schema/dist/validate.js';
import { FIRMWARE_CURRENT } from '../../packages/config-schema/dist/firmware-profile.js';
import { secondsPastLocalMidnight } from '../../packages/config-schema/dist/timezone.js';

const KINDS = ['digital', 'analog', 'transitions', 'shelf', 'suite'];
const args = process.argv.slice(2);
const kind = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (!KINDS.includes(kind)) {
  console.error(`usage: make-power-configs.mjs <${KINDS.join('|')}> [--minutes N] [--start ISO] [--tz ZONE]`);
  process.exit(2);
}

const powerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'reference', 'power');
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ignore', 'test-configs', 'power');

if (kind === 'suite') {
  writeSuiteConfig();
  process.exit(0);
}

function writeSuiteConfig() {
  // Which parts each suite has to name, because its quantities depend on them
  const SUITES = { core: [], sd: ['card'], mic: ['microphone'], analog: [], dsp: [], imu: [], battery: ['battery'],
                   brownout: ['card', 'microphone'] };
  const catalogue = JSON.parse(fs.readFileSync(path.join(powerDir, 'measurements.json'), 'utf8'));
  const components = JSON.parse(fs.readFileSync(path.join(powerDir, 'components.json'), 'utf8'));
  const suite = flag('suite', 'core');
  const temperature = flag('temperature', '');
  const fail = (message) => { console.error(`ERROR: ${message}`); process.exit(2); };
  if (!(suite in SUITES)) fail(`--suite must be one of ${Object.keys(SUITES).join(', ')}`);
  if (!(temperature in catalogue.conditions.temperatures)) fail(`--temperature must be one of ${Object.keys(catalogue.conditions.temperatures).join(', ')}`);
  const groups = { card: 'cards', microphone: 'microphones', battery: 'batteries' };
  const parts = {};
  for (const part of Object.keys(groups)) {
    const id = flag(part, '');
    if (id && !components[groups[part]].some((c) => c.id === id)) {
      fail(`--${part} ${id} is not in reference/power/components.json (${components[groups[part]].map((c) => c.id).join(', ')})`);
    }
    if (!id && SUITES[suite].includes(part)) fail(`the ${suite} suite needs --${part}`);
    parts[part] = id;
  }
  const soakMinutes = Number(flag('soak-minutes', temperature === 'room' ? 0 : 60));
  const lines = [
    '# Power characterization run. Lines must end with a newline; values may not contain commas.',
    `SUITE = ${suite}`,
    `WINDOW_SECONDS = ${Number(flag('window', 60))}`,
    `START_DELAY_SECONDS = ${soakMinutes * 60}`,
    `REPEAT = ${Number(flag('repeat', 1))}`,
    `LABEL = ${flag('label', `${suite} ${temperature}`)}`,
    `CARD = ${parts.card}`,
    `MIC = ${parts.microphone}`,
    `BATTERY = ${parts.battery}`,
    `TEMPERATURE = ${temperature}`,
  ];
  fs.mkdirSync(outDir, { recursive: true });
  const name = [suite, parts.card, parts.microphone, parts.battery, temperature].filter(Boolean).join('_');
  const outFile = path.join(outDir, `${name}_power.cfg`);
  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  const steps = catalogue.quantities.filter((q) => q.suite === suite);
  console.log(`\nwritten to ${path.relative(process.cwd(), outFile)}: copy it to the card root as _power.cfg`);
  console.log(`  ${steps.length} steps; soak ${soakMinutes} min at the floor before the first`);
}

const timezone = flag('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
const minutes = Number(flag('minutes', kind === 'transitions' ? 3 : 60));
const shelfMinutes = Number(flag('shelf-minutes', 120));
// Far enough out to write the card, start the capture, and swipe the magnet; the shelf run waits on purpose
const leadMinutes = kind === 'shelf' ? shelfMinutes : 10;
const defaultStart = new Date(Math.ceil((Date.now() + leadMinutes * 60_000) / 300_000) * 300_000);
const start = new Date(flag('start', defaultStart.toISOString()));
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const plus = (base, seconds) => new Date(base.getTime() + seconds * 1000);

const quiet = { imuRecordingMode: 'NONE' };
const SPECS = {
  digital: [
    { name: 'V1 wav 16k', purpose: 'Capture, staged WAV flushes, clip rollover: the common case.',
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 16000, audioClipLengthSeconds: 60, ...quiet } },
    { name: 'V2 wav 48k+imu', purpose: 'The heaviest WAV load: top rate with the IMU at 800 Hz beside it.',
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 48000, audioClipLengthSeconds: 60,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 800 } },
    { name: 'V3 opus 32k', purpose: 'Encode-bound: Opus at the default bitrate.',
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 48000, audioClipLengthSeconds: 60,
           useOpusEncoding: true, opusBitrate: 32000, ...quiet } },
    { name: 'V4 interval', purpose: 'A 30 s clip every 5 min: microphone starts and the sleep between.',
      p: { audioRecordingMode: 'INTERVAL', audioTriggerInterval: 5, audioTriggerIntervalTimeScale: 'MINUTES',
           audioSampleRateHz: 16000, audioClipLengthSeconds: 30, ...quiet } },
    { name: 'V5 scheduled', purpose: 'Two 5 min listening windows: the scheduled wait path.',
      p: { audioRecordingMode: 'SCHEDULED', audioSampleRateHz: 16000, audioClipLengthSeconds: 60, ...quiet },
      windows: (len) => [[Math.round(len * 0.15), Math.round(len * 0.15) + 300], [Math.round(len * 0.6), Math.round(len * 0.6) + 300]] },
    { name: 'V6 motion armed', purpose: 'IMU waiting for movement; leave the device still. Audio is a rare 10 s clip.',
      p: { audioRecordingMode: 'INTERVAL', audioTriggerInterval: 30, audioTriggerIntervalTimeScale: 'MINUTES',
           audioSampleRateHz: 16000, audioClipLengthSeconds: 10,
           imuRecordingMode: 'ACTIVITY', imuSampleRateHz: 25, imuTriggerThresholdMg: 100 } },
    { name: 'V7 gate+filter', purpose: 'Silence gate and band-pass in a quiet room: processing with little storage.',
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 16000, audioClipLengthSeconds: 60,
           silenceThreshold: 0.02, minFrequencyHz: 500, maxFrequencyHz: 6000,
           audioFilterType: 'BAND', audioFilterLowHz: 300, audioFilterHighHz: 7000, ...quiet } },
    { name: 'V8 armed idle', purpose: 'One 10 s clip an hour: almost all of it is the between-clips state.',
      p: { audioRecordingMode: 'INTERVAL', audioTriggerInterval: 1, audioTriggerIntervalTimeScale: 'HOURS',
           audioSampleRateHz: 16000, audioClipLengthSeconds: 10, ...quiet } },
  ],
  analog: [
    { name: 'A1 amplitude armed', purpose: 'Waiting for a sound with the comparator live; keep the room quiet.',
      p: { audioRecordingMode: 'AMPLITUDE', audioTriggerThreshold: 0.25, maxAudioClips: 60, maxClipsTimeScale: 'HOURS',
           audioSampleRateHz: 16000, audioClipLengthSeconds: 10, ...quiet } },
    { name: 'A2 analog wav 16k', purpose: 'Continuous capture on the analog front end.',
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 16000, audioClipLengthSeconds: 60, ...quiet } },
  ],
  transitions: Array.from({ length: 12 }, (_, i) => (i % 2 === 0
    ? { name: `T${i + 1} continuous`, purpose: 'Recording right up to the phase edge.',
        p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 16000, audioClipLengthSeconds: 30, ...quiet } }
    : { name: `T${i + 1} interval`, purpose: 'Asleep at the phase edge.',
        p: { audioRecordingMode: 'INTERVAL', audioTriggerInterval: 1, audioTriggerIntervalTimeScale: 'MINUTES',
             audioSampleRateHz: 16000, audioClipLengthSeconds: 10, ...quiet } })),
  shelf: [
    { name: 'S1 brief', purpose: 'Ten minutes of recording between a long wait and the sleep after it.', minutes: 10,
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 16000, audioClipLengthSeconds: 60, ...quiet } },
  ],
};

const config = defaultConfig(timezone);
config.timezone = timezone;
config.micType = kind === 'analog' ? 'ANALOG' : 'DIGITAL';
config.gpsAvailable = false; // the markers borrow the GPS board's lines
config.awakeOnMagnet = true;
config.setRtcAtMagnetDetect = true;
config.ledsEnabled = true;
config.batteryLowMv = 0;
config.vhfMode = 'NEVER';
config.isPhased = true;
config.startTime = iso(start);
config.deviceLabel = { digital: 'PWR_DIGITAL', analog: 'PWR_ANALOG', transitions: 'PWR_TRANS', shelf: 'PWR_SHELF' }[kind];

const specs = SPECS[kind];
const lengths = specs.map((spec) => Math.round((spec.minutes ?? minutes) * 60));
const offsets = lengths.reduce((acc, len) => [...acc, acc[acc.length - 1] + len], [0]);
config.phases = specs.map((spec, index) => {
  const phaseStart = plus(start, offsets[index]);
  const phase = {
    ...defaultPhase(spec.name),
    startTime: iso(phaseStart),
    endTime: iso(plus(start, offsets[index + 1])),
    ...spec.p,
  };
  if (spec.windows) {
    // Windows are seconds past local midnight and repeat daily, so they are placed against the phase's own start
    const base = secondsPastLocalMidnight(timezone, iso(phaseStart));
    phase.audioTriggerTimes = spec.windows(lengths[index]).map(([s, e]) => ({
      startSecond: (base + s) % 86400,
      endSecond: (base + e) % 86400,
    }));
  }
  return phase;
});
config.endTime = iso(plus(start, offsets[specs.length]));

const issues = validateConfig(config, FIRMWARE_CURRENT);
const errors = issues.filter((i) => i.severity === 'error');
const warnings = issues.filter((i) => i.severity === 'warning');
const text = serializeConfig(config);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${kind}_conf.a3m`);
fs.writeFileSync(outFile, text);

const hours = offsets[specs.length] / 3600;
const captureHours = kind === 'shelf' ? (shelfMinutes + 10 + 120) / 60 : hours + 0.5;
const local = (d) => new Date(d).toLocaleString('en-GB', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' });
console.log(`\nPOWER VALIDATION  ${kind.toUpperCase()}  -  ${config.deviceLabel}  (${config.micType.toLowerCase()} microphone)`);
console.log(`  timezone   ${timezone}`);
console.log(`  starts     ${config.startTime}  (${local(config.startTime)} local)`);
console.log(`  ends       ${config.endTime}  (${hours.toFixed(1)} h of phases)`);
console.log(`  written to ${path.relative(process.cwd(), outFile)}\n`);
console.log('  phase                  starts            what it validates');
config.phases.forEach((p, i) => console.log(`  ${p.name.padEnd(22)} ${local(p.startTime).padEnd(17)} ${specs[i].purpose}`));
console.log('\n  RUN IT');
console.log('    1. Flash the deployment firmware built with markers: cd a3em-firmware && make POWER_MARKERS=1');
console.log('    2. Copy the config to the card root as _conf.a3m, insert the card, disconnect the J-Link.');
console.log(`    3. python3 tools/power/ppk2_capture.py capture --out captures/validate_${kind}_<temperature> --max-hours ${captureHours.toFixed(1)}`);
console.log('    4. Swipe the magnet to activate once the capture is running.');
if (kind === 'shelf') {
  console.log(`    5. Leave it: ${shelfMinutes} min waiting to start, 10 min recording, then keep capturing 2 h of post-deployment sleep.`);
}
console.log('\n  The capture writes the charge between consecutive markers as segments: each PHASE_START to PHASE_END');
console.log('  is a phase to compare against the forecast, and each PHASE_END to the next PHASE_START is a transition.');
console.log(`\n  VALIDATION  ${errors.length} errors, ${warnings.length} warnings`);
for (const i of [...errors, ...warnings]) console.log(`    ${i.severity.padEnd(7)} [${i.path}] ${i.message}`);
console.log('');
if (errors.length) process.exit(1);
