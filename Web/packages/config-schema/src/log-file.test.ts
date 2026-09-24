import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { FIRMWARE_FAULT_REASONS, parseLogs } from './log-file.js';

/**
 * `fixtures/legacy.log` is the opening of a real deployment log (SAM_elephant_10,
 * February 2026) — the pre-2026.08.1 format, with no timestamp prefixes and no event
 * lines. It is the ground truth for what the reader must still handle.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const legacyLog = () => readFileSync(resolve(FIXTURES, 'legacy.log'), 'utf8');

describe('legacy log (real deployment)', () => {
  it('is recognized as the older format', () => {
    assert.equal(parseLogs([{ name: 'a3em.log', text: legacyLog() }]).modernFormat, false);
  });

  it('recovers telemetry from the Current Device Details block', () => {
    const parsed = parseLogs([{ name: 'a3em.log', text: legacyLog() }]);
    assert.ok(parsed.telemetry.length > 0, 'no telemetry recovered from a real log');
    const first = parsed.telemetry[0];
    assert.equal(first.timestamp, '2026-02-06T09:00:00.000Z');
    assert.equal(first.batteryMv, 3538);
    assert.ok(Math.abs(first.temperatureC - 22.68) < 1e-9);
    assert.equal(first.ledsActive, true);
    assert.equal(first.vhfActive, false);
  });

  it('treats a GPS-less [0,0,0] as no fix rather than a position', () => {
    // The device logs zeros when GPS is unavailable. Taking that literally would put
    // every such deployment in the Gulf of Guinea.
    const first = parseLogs([{ name: 'a3em.log', text: legacyLog() }]).telemetry[0];
    assert.equal(first.latitude, null);
    assert.equal(first.longitude, null);
  });

  it('reports no SD diagnostics, which the old format never carried', () => {
    const first = parseLogs([{ name: 'a3em.log', text: legacyLog() }]).telemetry[0];
    assert.equal(first.sdFreeMb, null);
    assert.equal(first.sdWriteFailures, null);
  });

  it('carries the last known timestamp onto undated prose lines', () => {
    const parsed = parseLogs([{ name: 'a3em.log', text: legacyLog() }]);
    const dcOffsetLine = parsed.entries.find((e) => e.message.includes('DC offset calculated'));
    assert.ok(dcOffsetLine, 'expected the DC offset line in the fixture');
    assert.equal(dcOffsetLine!.timestamp, '2026-02-06T09:00:00.000Z');
  });
});

describe('2026.08.1 format', () => {
  const modern = [
    '[----------] INFO: System hardware initialized, UID = C3:1A:5A:B9:0C:04',
    '[----------] EVT|BOOT|fw=2026.08.1+d997aaf,hw=A,uid=C3:1A:5A:B9:0C:04,last_stop=MAGNET',
    '[1770368400] INFO: Device activated!',
    '[1770368400] EVT|ACTIVATED|activation=3',
    '[1770368400] EVT|MIC_CHECK|type=ANALOG,dc_offset=32320,nominal=32768,tolerance=4000,result=PASS',
    '[1770368700] EVT|TELEM|batt_mv=3538,temp_c=22.68,lat=0.000000,lon=0.000000,alt=0.00,' +
      'leds=1,vhf=0,sd_free_mb=118000,sd_write_fail=0,sd_reopen=0,sd_remount=0,imu_dropped=0,audio_dropped=0',
    '[1770383100] EVT|MIC_HEALTH|result=PASS,rms=412,peak=2140,min=-2140,max=1980,mean=1,' +
      'samples=1440000,dc_offset=32320',
    '[1770383400] ERROR: Failed to call the synchronous write API...Number of bytes written = 0',
    '',
  ].join('\n');

  it('is recognized as the modern format', () => {
    assert.equal(parseLogs([{ name: 'a3em.log', text: modern }]).modernFormat, true);
  });

  it('reads telemetry from the event line, including SD diagnostics', () => {
    const parsed = parseLogs([{ name: 'a3em.log', text: modern }]);
    assert.equal(parsed.telemetry.length, 1);
    assert.equal(parsed.telemetry[0].batteryMv, 3538);
    assert.equal(parsed.telemetry[0].sdFreeMb, 118000);
    assert.equal(parsed.telemetry[0].sdWriteFailures, 0);
  });

  it('reads microphone health over time', () => {
    const health = parseLogs([{ name: 'a3em.log', text: modern }]).microphoneHealth;
    assert.equal(health.length, 1);
    assert.equal(health[0].result, 'PASS');
    assert.equal(health[0].rms, 412);
    assert.equal(health[0].dcOffset, 32320);
  });

  it('marks pre-clock lines as having no timestamp rather than inventing one', () => {
    const boot = parseLogs([{ name: 'a3em.log', text: modern }]).entries.find((e) => e.code === 'BOOT');
    assert.equal(boot?.timestamp, null);
    assert.equal(boot?.fields.fw, '2026.08.1+d997aaf');
  });

  it('counts errors without matching on phrasing', () => {
    assert.equal(parseLogs([{ name: 'a3em.log', text: modern }]).errorCount, 1);
  });
});

describe('stitching logs across directories', () => {
  it('merges files into one time-ordered view regardless of input order', () => {
    // The whole point of per-directory logs: the user should never navigate
    // directories to read the deployment's history.
    const later = '[1770400000] EVT|PHASE_END|phase=1,clips=1402,reason=PHASE_ENDED\n';
    const earlier = '[1770368400] EVT|PHASE_START|phase=1\n';
    const parsed = parseLogs([
      { name: '2026-02-07/00/a3em.log', text: later },
      { name: '2026-02-06/08/a3em.log', text: earlier },
    ]);
    assert.deepEqual(
      parsed.entries.map((e) => e.code),
      ['PHASE_START', 'PHASE_END'],
    );
  });

  it('keeps the originating file so a corrupt window can be identified', () => {
    const parsed = parseLogs([{ name: '2026-02-06/08/a3em.1.log', text: '[1770368400] INFO: Hello\n' }]);
    assert.equal(parsed.entries[0].source, '2026-02-06/08/a3em.1.log');
  });

  it('does not double-count telemetry when both forms are present', () => {
    // A modern log has EVT|TELEM alongside the human block describing the same instant.
    const both =
      '[1770368400] INFO: Current Device Details:\n' +
      '[1770368400]    UTC Timestamp: 1770368400\n' +
      '[1770368400]    Battery Voltage (mV): 3538\n' +
      '[1770368400]    Temperature (C): 22.68\n' +
      '[1770368400] EVT|TELEM|batt_mv=3538,temp_c=22.68,leds=0,vhf=0\n';
    assert.equal(parseLogs([{ name: 'a3em.log', text: both }]).telemetry.length, 1);
  });
});

describe('the device reporting on its own configuration', () => {
  const line = (result: string) =>
    `[1770368400] EVT|CONFIG|result=${result},phases=1\n`;

  it('reports that the device had to correct the file', () => {
    // The state worth acting on: the file parsed, but the deployment ran settings
    // nobody chose. Without this a card looks like it ran exactly as configured.
    assert.equal(parseLogs([{ name: 'a3em.log', text: line('CORRECTED') }]).configResult, 'CORRECTED');
  });

  it('distinguishes that from a clean read and from a failure', () => {
    assert.equal(parseLogs([{ name: 'a3em.log', text: line('OK') }]).configResult, 'OK');
    assert.equal(parseLogs([{ name: 'a3em.log', text: line('FAIL') }]).configResult, 'FAIL');
  });

  it('says nothing for a log that never reported it', () => {
    assert.equal(parseLogs([{ name: 'a3em.log', text: 'INFO: Device woke up!\n' }]).configResult, null);
  });
});

describe('telemetry carrying its own timestamp', () => {
  it('prefers the payload time over the line prefix', () => {
    // From 2026.08.2 the reading timestamps itself, so the two cannot disagree about
    // when it was taken.
    const text = '[1770000000] EVT|TELEM|time=1770368400,batt_mv=3500,temp_c=21.0\n';
    const sample = parseLogs([{ name: 'a3em.log', text }]).telemetry[0];
    assert.equal(sample.timestamp, new Date(1770368400 * 1000).toISOString());
  });

  it('still lands from a log whose line prefix was lost', () => {
    const text = 'EVT|TELEM|time=1770368400,batt_mv=3500,temp_c=21.0\n';
    assert.equal(parseLogs([{ name: 'a3em.log', text }]).telemetry.length, 1);
  });

  it('reports counters a legacy log never carried as absent, not zero', () => {
    const text = '[1770368400] EVT|TELEM|batt_mv=3500,temp_c=21.0\n';
    const sample = parseLogs([{ name: 'a3em.log', text }]).telemetry[0];
    assert.equal(sample.audioBuffersCaptured, null);
    assert.equal(sample.dmaCompletionTrusted, null);
  });

  it('reads the audio path verdict as the words the firmware logs', () => {
    const trusted = '[1] EVT|TELEM|time=1770368400,batt_mv=1,temp_c=1,dcmp=trusted\n';
    const unproven = '[1] EVT|TELEM|time=1770368400,batt_mv=1,temp_c=1,dcmp=unproven\n';
    assert.equal(parseLogs([{ name: 'a', text: trusted }]).telemetry[0].dmaCompletionTrusted, true);
    assert.equal(parseLogs([{ name: 'a', text: unproven }]).telemetry[0].dmaCompletionTrusted, false);
  });
});

describe('events that carry their own timestamp', () => {
  it('uses t= as the event time', () => {
    const text = 'EVT|ACTIVATED|t=1770368400,activation=3\n';
    const entry = parseLogs([{ name: 'a3em.log', text }]).entries[0];
    assert.equal(entry.timestamp, new Date(1770368400 * 1000).toISOString());
  });

  it('leaves an event undated when the clock could not vouch for a time', () => {
    // The firmware omits t= entirely rather than stamping a placeholder, because before
    // the clock is set it genuinely does not know when the event happened.
    const text = 'EVT|ACTIVATED|activation=3\n';
    assert.equal(parseLogs([{ name: 'a3em.log', text }]).entries[0].timestamp, null);
  });

  it('prefers t= over a surrounding line prefix', () => {
    const text = '[1770000000] EVT|PHASE_START|t=1770368400,phase=1\n';
    const entry = parseLogs([{ name: 'a3em.log', text }]).entries[0];
    assert.equal(entry.timestamp, new Date(1770368400 * 1000).toISOString());
  });

  it('dates the lifecycle from it', () => {
    const text = 'EVT|ACTIVATED|t=1770368400,activation=3\n';
    assert.equal(parseLogs([{ name: 'a3em.log', text }]).lifecycle[0].timestamp,
      new Date(1770368400 * 1000).toISOString());
  });
});

describe('activation attribution', () => {
  const telem = (t: number, mv: number) => `EVT|TELEM|t=${t},time=${t},batt_mv=${mv},temp_c=20.0`;

  it('splits by the directory a log sits in', () => {
    const files = [
      { name: 'SAM/Activation_0001/0000086400/0000003600/a3em.log', text: telem(1770368400, 3100) },
      { name: 'SAM/Activation_0002/0000086400/0000003600/a3em.log', text: telem(1770368400, 3200) },
    ];
    assert.deepEqual(parseLogs(files).activationsAttributed, [1, 2]);
    assert.deepEqual(parseLogs(files, { activation: 2 }).telemetry.map((s) => s.batteryMv), [3200]);
  });

  it('splits a pooled log on its ACTIVATED markers', () => {
    // One file holding two runs, which is what a card without per-activation logs has.
    const files = [
      {
        name: 'a3em.log',
        text: [
          'EVT|ACTIVATED|activation=1',
          telem(1770368400, 3100),
          'EVT|ACTIVATED|activation=2',
          telem(1770368400, 3200),
        ].join('\n'),
      },
    ];
    assert.deepEqual(parseLogs(files).activationsAttributed, [1, 2]);
    assert.deepEqual(parseLogs(files, { activation: 1 }).telemetry.map((s) => s.batteryMv), [3100]);
    assert.deepEqual(parseLogs(files, { activation: 2 }).telemetry.map((s) => s.batteryMv), [3200]);
  });

  it('keeps lines it cannot place, and says it could not place them', () => {
    // A log with no directory and no markers must not filter down to an empty chart.
    const files = [{ name: 'a3em.log', text: telem(1770368400, 3100) }];
    const parsed = parseLogs(files, { activation: 2 });
    assert.deepEqual(parsed.activationsAttributed, []);
    assert.equal(parsed.telemetry.length, 1);
  });

  it('keeps a copied run whole, against the number written inside it', () => {
    /*
      A directory copied by hand carries the original's prose and markers, which still name
      the run it was copied FROM. Letting that override the path split the copy in half at
      its first marker: the duplicate read short and the original absorbed what it lost.
    */
    const body = [telem(1770368400, 3100), 'INFO: Current activation is #1', telem(1770368460, 3110)].join('\n');
    const files = [
      { name: 'SAM/Activation_0001/0000086400/0000003600/a3em.log', text: body },
      { name: 'SAM/Activation_0002/0000086400/0000003600/a3em.log', text: body },
    ];
    assert.deepEqual(parseLogs(files, { activation: 1 }).telemetry.map((s) => s.batteryMv), [3100, 3110]);
    assert.deepEqual(parseLogs(files, { activation: 2 }).telemetry.map((s) => s.batteryMv), [3100, 3110]);
  });

  it('still lets a pooled log name its own runs when the path cannot', () => {
    // The override only yields to a path that places the file; a root log has none.
    const files = [
      {
        name: '_a3em.boot.txt',
        text: ['EVT|ACTIVATED|activation=1', telem(1770368400, 3100)].join('\n'),
      },
    ];
    assert.deepEqual(parseLogs(files, { activation: 1 }).telemetry.map((s) => s.batteryMv), [3100]);
    assert.deepEqual(parseLogs(files, { activation: 2 }).telemetry, []);
  });

  it('attributes the ACTIVATED line to the run it opens', () => {
    const files = [
      { name: 'a3em.log', text: ['EVT|ACTIVATED|activation=1', 'EVT|ACTIVATED|activation=2'].join('\n') },
    ];
    const second = parseLogs(files, { activation: 2 });
    assert.equal(second.entries.filter((e) => e.code === 'ACTIVATED').length, 1);
    assert.equal(second.entries[0]?.fields.activation, '2');
  });
});

describe('legacy activation attribution', () => {
  // Shaped exactly like the real card: one pooled root log, no events, prose boundaries.
  const details = (timestamp: number, mv: number) =>
    [
      'INFO: Current Device Details:',
      `   UTC Timestamp: ${timestamp}`,
      `   Battery Voltage (mV): ${mv}`,
      '   Temperature (C): 22.68',
      '   Location: [0.000000, 0.000000, 0.00]',
      '   LEDs Active: True',
      '   VHF Active: False',
    ].join('\n');
  const legacy = [
    'INFO: Device is ACTIVATED',
    'INFO: Current activation is #1',
    details(1770368400, 3540),
    'INFO: Device is ACTIVATED',
    'INFO: Current activation is #3',
    details(1770454800, 3630),
  ].join('\n');

  it('splits a pooled legacy log on its prose activation lines', () => {
    const files = [{ name: 'a3em.log', text: legacy }];
    assert.deepEqual(parseLogs(files).activationsAttributed, [1, 3]);
    assert.deepEqual(parseLogs(files, { activation: 1 }).telemetry.map((s) => s.batteryMv), [3540]);
    assert.deepEqual(parseLogs(files, { activation: 3 }).telemetry.map((s) => s.batteryMv), [3630]);
  });

  it('numbers runs the way the directories do', () => {
    // config_get_activation_number() feeds both the prose line and the directory namer,
    // so #3 is Activation_0003 with no adjustment. A drift here would silently attribute
    // every legacy card's telemetry to the wrong run.
    const files = [{ name: 'a3em.log', text: 'INFO: Current activation is #3' }];
    assert.deepEqual(parseLogs(files).activationsAttributed, [3]);
  });

  it('leaves lines before the first announcement in view', () => {
    const files = [{ name: 'a3em.log', text: ['INFO: booting', 'INFO: Current activation is #2'].join('\n') }];
    const scoped = parseLogs(files, { activation: 2 });
    assert.ok(scoped.entries.some((e) => e.message.includes('booting')));
  });
});

describe('dating events from neighboring times', () => {
  it('dates an event from the telemetry reading before it', () => {
    // Firmware 2026.08.27 wrote neither a line prefix nor `t=`, so every event on such a
    // card came back undated even though telemetry beside it was precisely timed.
    const text = [
      'EVT|TELEM|time=1770368400,batt_mv=3429,temp_c=31.95',
      'EVT|MIC_CHECK|type=ANALOG,dc_offset=33392,nominal=32768,tolerance=4000,result=PASS',
    ].join('\n');
    const parsed = parseLogs([{ name: 'a3em.log', text }]);
    assert.equal(parsed.entries.find((e) => e.code === 'TELEM')?.timestamp, '2026-02-06T09:00:00.000Z');
    assert.equal(parsed.entries.find((e) => e.code === 'MIC_CHECK')?.timestamp, '2026-02-06T09:00:00.000Z');
  });

  it('leaves an event before any known time undated', () => {
    const text = ['EVT|BOOT|fw=x', 'EVT|TELEM|time=1770368400,batt_mv=3429'].join('\n');
    const parsed = parseLogs([{ name: 'a3em.log', text }]);
    assert.equal(parsed.entries.find((e) => e.code === 'BOOT')?.timestamp, null);
  });

  it('does not paper over a clock the firmware said it could not vouch for', () => {
    // Once a log carries `t=` anywhere, a line WITHOUT it is the firmware reporting an
    // untrustworthy clock. Inheriting the previous line's time would erase that.
    const text = [
      'EVT|TELEM|t=1770368400,time=1770368400,batt_mv=3429',
      'EVT|HARD_FAULT|addr=0x1234',
    ].join('\n');
    const parsed = parseLogs([{ name: 'a3em.log', text }]);
    assert.equal(parsed.entries.find((e) => e.code === 'TELEM')?.timestamp, '2026-02-06T09:00:00.000Z');
    assert.equal(parsed.entries.find((e) => e.code === 'HARD_FAULT')?.timestamp, null);
  });

  it('prefers when a reading was taken over when its line was written', () => {
    const text = 'EVT|TELEM|t=1770368460,time=1770368400,batt_mv=3429';
    const parsed = parseLogs([{ name: 'a3em.log', text }]);
    assert.equal(parsed.telemetry[0]?.timestamp, '2026-02-06T09:00:00.000Z');
  });
});

describe('a crash during shutdown', () => {
  it('names the subsystem being torn down, and says nothing when there was none', () => {
    // A fault at address zero with no CFSR bits is the null-branch signature, which on its own
    // does not say where. The firmware now records which deinit step was in flight, and that is
    // the difference between "it crashed" and "it crashed closing the microphone".
    const log = [
      '[----------] EVT|HARD_FAULT|t=1789590605,address=0x00000000,cfsr=0x00000000,teardown=AUDIO',
      '[----------] EVT|HARD_FAULT|t=1789590905,address=0x00000000,cfsr=0x00000000,teardown=NONE',
      '',
    ].join('\n');
    const { hardFaults, lifecycle } = parseLogs([{ name: 'a3em.log', text: log }]);
    assert.equal(hardFaults.length, 2);
    assert.equal(hardFaults[0]!.teardown, 'AUDIO');
    assert.equal(hardFaults[1]!.teardown, undefined, 'NONE means it did not die in teardown');
    assert.match(lifecycle[0]!.summary, /while shutting down the microphone/);
    assert.doesNotMatch(lifecycle[1]!.summary, /while shutting down/);
  });
});

describe('phase endings', () => {
  it('records why a recording phase stopped', () => {
    const text = 'EVT|PHASE_END|reason=MAGNET-OFF,code=0x05';
    const [event] = parseLogs([{ name: 'a3em.log', text }]).lifecycle;
    assert.equal(event?.kind, 'PHASE_END');
    assert.match(event!.summary, /magnet off/);
    assert.equal(event!.notable, false);
  });

  it('marks a phase that ended on a fault', () => {
    // The reason is a reset-reason name, so a fault ending must read as notable exactly
    // as the same reason does when it ends a boot.
    const reason = [...FIRMWARE_FAULT_REASONS][0];
    const text = `EVT|PHASE_END|reason=${reason},code=0x01`;
    const [event] = parseLogs([{ name: 'a3em.log', text }]).lifecycle;
    assert.equal(event?.notable, true, `${reason} should be notable`);
  });
});
