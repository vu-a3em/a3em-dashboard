#!/usr/bin/env node
/**
 * Builds the two hardware-validation configurations, through the same code the app uses.
 *
 *   node tools/make-test-config.mjs quick [--start ISO] [--tz ZONE] [--card GB] [--battery MAH]
 *   node tools/make-test-config.mjs soak  [--start ISO] [--tz ZONE] [--card GB] [--battery MAH]
 *
 * Dates are computed at generation time rather than baked in, because every phase boundary and
 * every scheduled listening window is an absolute instant or a time of day: a file written last
 * week describes a deployment that has already happened. Regenerate immediately before writing
 * the card.
 *
 * Both configurations assume a DIGITAL microphone, which rules out amplitude-triggered
 * recording entirely -- see the coverage notes printed at the end.
 */

import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, defaultPhase } from '../packages/config-schema/dist/defaults.js';
import { serializeConfig } from '../packages/config-schema/dist/serialize.js';
import { validateConfig } from '../packages/config-schema/dist/validate.js';
import { FIRMWARE_CURRENT } from '../packages/config-schema/dist/firmware-profile.js';
import { forecast } from '../packages/config-schema/dist/power/forecast.js';
import { secondsPastLocalMidnight } from '../packages/config-schema/dist/timezone.js';

const args = process.argv.slice(2);
const kind = args.find((a) => !a.startsWith('--')) ?? 'quick';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (!['quick', 'soak', 'gaps', 'wd', 'wdfast'].includes(kind)) {
  console.error('usage: make-test-config.mjs <quick|soak|gaps|wd|wdfast> [--start ISO] [--tz ZONE] [--card GB] [--battery MAH]');
  process.exit(2);
}

const timezone = flag('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
const cardGb = Number(flag('card', 128));
const batteryMah = Number(flag('battery', 2400));

// Default to the next clean boundary far enough out to write the card and swipe the magnet.
// wdfast exists to be re-run over and over, so it does not make you wait ten minutes to start.
const LEAD_MINUTES = kind === 'soak' ? 30 : kind === 'wdfast' ? 5 : 10;
const defaultStart = new Date(Math.ceil((Date.now() + LEAD_MINUTES * 60_000) / 300_000) * 300_000);
const start = new Date(flag('start', defaultStart.toISOString()));
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const plus = (base, seconds) => new Date(base.getTime() + seconds * 1000);

const config = defaultConfig(timezone);
config.timezone = timezone;
config.micType = 'DIGITAL';
config.micAmplificationDb = 18; // exactly on the PDM ladder, so nothing is silently rounded
config.gpsAvailable = false;
config.awakeOnMagnet = true; // the magnet path is itself under test
config.setRtcAtMagnetDetect = true;
config.ledsEnabled = true;
config.batteryLowMv = 3000;
config.isPhased = true;
config.startTime = iso(start);

/** Phase specs: every field that differs from the default, plus why the phase exists. */
const QUICK_MINUTES = 5;
// The soak no longer splits its week evenly. M1 and M2 are the paths a previous run already
// proved -- 56 hours, 1674 valid clips, zero resets -- so they are cut to a sanity check, and
// the time goes to the four phases that have never completed. Each spec carries its own hours.
const SOAK_HOURS = 28;

const SPECS = {
  quick: [
    { name: 'Q1 baseline', purpose: 'Plain continuous WAV with IMU paired to audio.',
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 16000, audioClipLengthSeconds: 10,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 50 } },
    { name: 'Q2 silence+band', purpose: 'Silence gate and band-pass filter, both new.',
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 16000, audioClipLengthSeconds: 10,
           silenceThreshold: 0.02, minFrequencyHz: 500, maxFrequencyHz: 6000,
           audioFilterType: 'BAND', audioFilterLowHz: 300, audioFilterHighHz: 7000,
           imuRecordingMode: 'NONE' } },
    { name: 'Q3 interval+motion', purpose: 'Interval scheduling, deep sleep, motion-triggered IMU.',
      p: { audioRecordingMode: 'INTERVAL', audioTriggerInterval: 1, audioTriggerIntervalTimeScale: 'MINUTES',
           audioSampleRateHz: 24000, audioClipLengthSeconds: 15,
           audioFilterType: 'HIGH', audioFilterLowHz: 1000,
           imuRecordingMode: 'ACTIVITY', imuSampleRateHz: 25, imuTriggerThresholdMg: 100 } },
    { name: 'Q4 scheduled', purpose: 'Listening windows, low rate, low-pass filter.',
      p: { audioRecordingMode: 'SCHEDULED', audioSampleRateHz: 8000, audioClipLengthSeconds: 10,
           audioFilterType: 'LOW', audioFilterHighHz: 3000,
           minFrequencyHz: 250, maxFrequencyHz: 3800,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 100 },
      windows: [[0, 90], [150, 270]] },
    { name: 'Q5 opus', purpose: 'Opus encoding and its forced 48 kHz rate.',
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 48000, audioClipLengthSeconds: 20,
           useOpusEncoding: true, opusBitrate: 32000,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 200 } },
    { name: 'Q6 inexact rate', purpose: 'A rate the PDM clock cannot hit exactly, plus the fastest IMU.',
      p: { audioRecordingMode: 'INTERVAL', audioTriggerInterval: 2, audioTriggerIntervalTimeScale: 'MINUTES',
           audioSampleRateHz: 32000, audioClipLengthSeconds: 30, silenceThreshold: 0.01,
           minFrequencyHz: 500, maxFrequencyHz: 15000,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 800 } },
  ],
  // What the two quick runs still have not shown. The second run closed VHF, the deployment
  // close-out and the LED expiry, and it proved the gate's MECHANISM in interval mode: phase 6
  // captured exactly one buffer per interval occurrence and wrote nothing, which is the gate
  // starting the converter, judging one buffer, and going back to sleep. What no run has shown
  // is the gate saying YES outside continuous mode — opening a file when a buffer is not
  // silent. Both phases below are that positive case, and both need real noise: a quiet room
  // cannot tell a working gate from one that rejects everything.
  gaps: [
    { name: 'G1 interval+silence', purpose: 'Does the gate ever say YES in INTERVAL mode? Make noise.',
      p: { audioRecordingMode: 'INTERVAL', audioTriggerInterval: 1, audioTriggerIntervalTimeScale: 'MINUTES',
           audioSampleRateHz: 16000, audioClipLengthSeconds: 20,
           silenceThreshold: 0.02, minFrequencyHz: 500, maxFrequencyHz: 6000,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 50 } },
    { name: 'G2 scheduled+silence', purpose: 'The same, in SCHEDULED mode - the one path soak phase M4 rests on.',
      p: { audioRecordingMode: 'SCHEDULED', audioSampleRateHz: 16000, audioClipLengthSeconds: 10,
           silenceThreshold: 0.02, minFrequencyHz: 500, maxFrequencyHz: 6000,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 50 },
      windows: [[0, 300]] },
  ],
  // Every sleep in the quick test is shorter than the watchdog timeout, which is exactly why it
  // cleared a soak that then collapsed. This one exists to sleep PAST the timeout, on both of the
  // two distinct wait paths -- the interval branch and the scheduled branch arm the timer
  // differently -- so that a fix to the feed is proven before a week is committed to it.
  // Four minutes that re-check only the clip-start work, for iterating on it without paying
  // for `wd` every time. It proves nothing about the watchdog: its longest sleep is about 40 s,
  // far inside the 480 s timeout. Use it only while the sleep paths are untouched, and run the
  // full `wd` before committing to a deployment.
  //
  // 8 kHz is the point. The DMA period is `48000 / sample_rate`, so the buffer is SIX seconds
  // here against three at 16 kHz, and a mis-set clip start shows up as a six-second difference
  // between a clip and the IMU file beside it. Against an 18 s clip that is impossible to miss.
  wdfast: [
    { name: 'X1 fresh starts', hours: 175 / 3600,
      purpose: 'Every clip restarts the front end, so every clip pays the settling delay.',
      p: { audioRecordingMode: 'INTERVAL', audioTriggerInterval: 60, audioTriggerIntervalTimeScale: 'SECONDS',
           audioSampleRateHz: 8000, audioClipLengthSeconds: 18,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 800 } },
    { name: 'X2 back to back', hours: 90 / 3600,
      purpose: 'One window, two clips: the first settles, the second must not wait again.',
      p: { audioRecordingMode: 'SCHEDULED', audioSampleRateHz: 8000, audioClipLengthSeconds: 18,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 400 },
      windows: [[20, 56]] },
  ],
  wd: [
    { name: 'W1 interval sleep', hours: 35 / 60,
      purpose: 'Sleeps 870 s per cycle, past the 480 s watchdog. Expect 3 clips, 3 full .imu.',
      p: { audioRecordingMode: 'INTERVAL', audioTriggerInterval: 15, audioTriggerIntervalTimeScale: 'MINUTES',
           audioSampleRateHz: 16000, audioClipLengthSeconds: 30,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 800 } },
    { name: 'W2 scheduled sleep', hours: 20 / 60,
      purpose: 'The other wait path: 600 s asleep before the window, 480 s after it.',
      p: { audioRecordingMode: 'SCHEDULED', audioSampleRateHz: 16000, audioClipLengthSeconds: 60,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 400 },
      windows: [[600, 720]] },
  ],
  // Reordered so that the four phases which have never completed run first, and renumbered by
  // execution order so the card's directories read in the order they were written. The mapping to
  // the previous run is M3=old M6, M4=old M5, M5=old M4, M6=old M3.
  soak: [
    { name: 'M1 continuous', hours: 8,
      purpose: 'Sanity check on the one path already proven: rollover, naming, IMU pairing.',
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 16000, audioClipLengthSeconds: 60,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 50 } },
    { name: 'M2 silence gate', hours: 8,
      purpose: 'The suppression control: a quiet room should store almost nothing here.',
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 24000, audioClipLengthSeconds: 30,
           silenceThreshold: 0.03, minFrequencyHz: 1000, maxFrequencyHz: 10000,
           audioFilterType: 'BAND', audioFilterLowHz: 800, audioFilterHighHz: 11000,
           imuRecordingMode: 'NONE' } },
    { name: 'M3 inexact rate', hours: 24,
      purpose: 'Never once executed. Achieved-rate labeling held for a full day.',
      p: { audioRecordingMode: 'CONTINUOUS', audioSampleRateHz: 32000, audioClipLengthSeconds: 120,
           silenceThreshold: 0.01, minFrequencyHz: 500, maxFrequencyHz: 15000,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 400 } },
    { name: 'M4 imu volume', hours: 40,
      purpose: 'The best test of both fixes: 1800 s sleeps, 300 s clips, 800 Hz IMU.',
      p: { audioRecordingMode: 'INTERVAL', audioTriggerInterval: 30, audioTriggerIntervalTimeScale: 'MINUTES',
           audioSampleRateHz: 8000, audioClipLengthSeconds: 300,
           audioFilterType: 'LOW', audioFilterHighHz: 3500,
           minFrequencyHz: 250, maxFrequencyHz: 3800,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 800 } },
    { name: 'M5 dawn/dusk', hours: 48,
      purpose: 'The full 12 listening windows at the highest rate, over two whole days.',
      p: { audioRecordingMode: 'SCHEDULED', audioSampleRateHz: 48000, audioClipLengthSeconds: 30,
           audioFilterType: 'HIGH', audioFilterLowHz: 2000,
           silenceThreshold: 0.02, minFrequencyHz: 2000, maxFrequencyHz: 20000,
           imuRecordingMode: 'AUDIO', imuSampleRateHz: 100 },
      // 12 windows of 10 min, the array's exact capacity, spread across the day.
      windows: Array.from({ length: 12 }, (_, i) => [i * 7200, i * 7200 + 600]) },
    { name: 'M6 opus+motion', hours: 40,
      purpose: 'Opus over many files, plus the ACTIVITY IMU path. Needs 150 mg to log motion.',
      p: { audioRecordingMode: 'INTERVAL', audioTriggerInterval: 10, audioTriggerIntervalTimeScale: 'MINUTES',
           audioSampleRateHz: 48000, audioClipLengthSeconds: 60, useOpusEncoding: true, opusBitrate: 24000,
           imuRecordingMode: 'ACTIVITY', imuSampleRateHz: 25, imuTriggerThresholdMg: 150 } },
  ],
};

const specs = SPECS[kind];
const phaseSeconds = kind === 'soak' ? SOAK_HOURS * 3600 : QUICK_MINUTES * 60;
// Phases are laid end to end rather than on a fixed grid, so a spec can state its own length.
const lengths = specs.map((spec) => Math.round(spec.hours ? spec.hours * 3600 : phaseSeconds));
const offsets = lengths.reduce((acc, len) => [...acc, acc[acc.length - 1] + len], [0]);

config.phases = specs.map((spec, index) => {
  const phaseStart = plus(start, offsets[index]);
  const phaseEnd = plus(start, offsets[index + 1]);
  const phase = { ...defaultPhase(spec.name), startTime: iso(phaseStart), endTime: iso(phaseEnd), ...spec.p };
  if (spec.windows) {
    // Windows are seconds past LOCAL midnight and repeat daily. For the short test they have to
    // line up with the wall clock the phase actually runs at, or the phase records nothing.
    const base = kind === 'soak' ? 0 : secondsPastLocalMidnight(timezone, iso(phaseStart));
    phase.audioTriggerTimes = spec.windows.map(([s, e]) => ({
      startSecond: (base + s) % 86400,
      endSecond: (base + e) % 86400,
    }));
  }
  return phase;
});
config.endTime = iso(plus(start, offsets[specs.length]));
config.deviceLabel = { quick: 'A3EM_QUICK', soak: 'A3EM_SOAK', gaps: 'A3EM_GAPS', wd: 'A3EM_WD', wdfast: 'A3EM_WDFAST' }[kind];
config.vhfMode = 'END'; // beacon fires at the end of the deployment, exercising the VHF path
config.vhfStartTime = config.endTime;
config.ledsActiveSeconds = kind === 'soak' ? 600 : 1800;
config.forbidDeactivationSeconds = kind === 'soak' ? 3600 : 60;

const issues = validateConfig(config, FIRMWARE_CURRENT);
const errors = issues.filter((i) => i.severity === 'error');
const warnings = issues.filter((i) => i.severity === 'warning');

const text = serializeConfig(config);
const outDir = path.join(process.cwd(), 'test-configs');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${kind}_a3em.cfg`);
fs.writeFileSync(outFile, text);

const f = forecast({ config, sdCardCapacityGb: cardGb, batteryCapacityMah: batteryMah,
                     microphone: 'DIGITAL', firmware: FIRMWARE_CURRENT });
const hours = offsets[specs.length] / 3600;
const gb = (bytes) => (bytes / 1024 ** 3).toFixed(2);

console.log(`\n${kind.toUpperCase()} TEST  —  ${config.deviceLabel}`);
console.log(`  timezone   ${timezone}`);
console.log(`  starts     ${config.startTime}`);
console.log(`  ends       ${config.endTime}   (${hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} h`})`);
console.log(`  written to ${path.relative(process.cwd(), outFile)}   (longest line ${Math.max(...text.split('\n').map((l) => l.length))} of 79)\n`);

console.log('  phase              window                        what it proves');
config.phases.forEach((p, i) => {
  const from = new Date(p.startTime).toLocaleString('en-GB', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' });
  console.log(`  ${p.name.padEnd(18)} ${from.padEnd(29)} ${specs[i].purpose}`);
});

console.log(`\n  FORECAST on a ${cardGb} GB card / ${batteryMah} mAh cell`);
console.log(`    worst-case written   ${gb(f.totalBytes)} GB  (${(f.cardUsedFraction * 100).toFixed(1)}% of the card)`);
console.log(`    average current      ${f.averageCurrentMa.toFixed(1)} mA`);
console.log(`    card lasts           ${f.storageDays === Infinity ? 'indefinitely' : `${f.storageDays.toFixed(1)} days`}`);
console.log(`    battery lasts        ${f.batteryDays.toFixed(1)} days`);
console.log(`    deployment needs     ${f.deploymentDays.toFixed(2)} days`);
const cardOk = f.storageDays >= f.deploymentDays;
const battOk = f.batteryDays >= f.deploymentDays;
console.log(`    verdict              card ${cardOk ? 'OK' : 'TOO SMALL'}, battery ${battOk ? 'OK' : 'TOO SMALL'}`);

// What the card should hold afterward. Derived, not guessed, so the post-run check has real
// numbers to compare against rather than an impression of "looks about right".
console.log('\n  EXPECTED ON THE CARD');
console.log('    phase              recordings          each        IMU');
config.phases.forEach((p) => {
  const seconds = (Date.parse(p.endTime) - Date.parse(p.startTime)) / 1000;
  const rate = p.useOpusEncoding ? 48000 : p.audioSampleRateHz;
  // The PDM clock cannot hit every rate; the file is written at, and labeled with, what it got.
  const actual = { 4000: 3906, 11025: 10989, 22050: 21978, 32000: 31914, 44100: 44117 }[rate] ?? rate;
  const bytes = p.useOpusEncoding
    ? (p.opusBitrate / 8) * p.audioClipLengthSeconds
    : actual * 2 * p.audioClipLengthSeconds + 44;
  let count;
  switch (p.audioRecordingMode) {
    case 'CONTINUOUS': count = Math.floor(seconds / p.audioClipLengthSeconds); break;
    case 'INTERVAL': {
      const every = p.audioTriggerInterval * { SECONDS: 1, MINUTES: 60, HOURS: 3600, DAYS: 86400 }[p.audioTriggerIntervalTimeScale];
      count = Math.ceil(seconds / every); break;
    }
    case 'SCHEDULED': {
      // Windows are seconds past local midnight and repeat daily. Prorating them across a day
      // understates a short phase deliberately aligned to one, so count the real overlap.
      const offset = secondsPastLocalMidnight(timezone, p.startTime);
      let recorded = 0;
      for (let day = -1; day * 86400 < seconds + 86400; day++) {
        for (const w of p.audioTriggerTimes) {
          const from = w.startSecond - offset + day * 86400;
          const to = w.endSecond - offset + day * 86400;
          recorded += Math.max(0, Math.min(to, seconds) - Math.max(from, 0));
        }
      }
      count = Math.floor(recorded / p.audioClipLengthSeconds); break;
    }
    default: count = 0;
  }
  const gated = p.silenceThreshold > 0 ? ` or fewer` : '';
  const imu = p.imuRecordingMode === 'NONE' ? 'none'
    : p.imuRecordingMode === 'ACTIVITY' ? `.imu only when moved (${p.imuSampleRateHz} Hz)`
    : `.imu beside each clip (${p.imuSampleRateHz} Hz)`;
  const size = bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`;
  const label = `${count}${gated}`;
  console.log(`    ${p.name.padEnd(18)} ${label.padEnd(19)} ${(size + (actual !== rate ? ` @${actual}Hz` : '')).padEnd(16)} ${imu}`);
});

console.log(`\n  VALIDATION  ${errors.length} errors, ${warnings.length} warnings`);
for (const i of [...errors, ...warnings]) console.log(`    ${i.severity.padEnd(7)} [${i.path}] ${i.message}`);
console.log('');
