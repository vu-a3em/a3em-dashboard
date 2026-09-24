/**
 * Reader for `a3em.log`, in both the legacy and 2026.08.1 formats.
 *
 * A deployment now scatters its log across one file per 4-hour directory, plus the
 * root log for pre-activation events. The review workspace stitches them into a single
 * time-ordered view so nobody has to walk directories to find out what happened.
 *
 * Two line shapes are recognized:
 *
 *   [1770368400] INFO: Device activated!
 *   [1770368400] EVT|ACTIVATED|activation=3
 *
 * The `EVT|` lines carry stable codes and keys, so parsing does not depend on English
 * phrasing. Legacy logs have neither the prefix nor the event lines, and are handled by
 * falling back to the periodic `Current Device Details` block for telemetry and by
 * carrying the last known timestamp forward for everything else.
 */

import { activationFromPath } from './card-layout.js';

export type LogSeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface LogEntry {
  /** ISO instant, or null when the device had no valid clock yet. */
  timestamp: string | null;
  severity: LogSeverity;
  /** Stable event code for `EVT|` lines; null for prose lines. */
  code: string | null;
  /** Parsed key/value payload for `EVT|` lines. */
  fields: Record<string, string>;
  /** The original message text, for display. */
  message: string;
  /** Which file on the card this came from. */
  source: string;
}

export interface TelemetrySample {
  timestamp: string;
  batteryMv: number;
  temperatureC: number;
  /** Null when GPS is unavailable — the device logs [0,0,0], which is not a position. */
  latitude: number | null;
  longitude: number | null;
  altitudeM: number | null;
  ledsActive: boolean;
  vhfActive: boolean;
  /** Present only from the current firmware. */
  sdFreeMb: number | null;
  /**
   * Storage and buffer health, as the firmware's own health struct reports it.
   *
   * These replaced an earlier read/write/timeout triple. The firmware counts recoveries
   * rather than raw errors, because a write that failed and then succeeded on a reopen
   * is a different event from one that lost data, and only the second costs recordings.
   */
  sdWriteFailures: number | null;
  sdReopenRecoveries: number | null;
  sdRemountRecoveries: number | null;
  imuBuffersDropped: number | null;
  audioBuffersDropped: number | null;
  /** Buffers captured since boot. Zero here alongside a running device is a fault. */
  audioBuffersCaptured: number | null;
  /**
   * Whether the audio DMA completion path has proved itself this run.
   *
   * The firmware watches for completions it never received; until it has seen enough
   * clean ones it reports the path as unproven rather than claiming health it has not
   * demonstrated.
   */
  dmaCompletionTrusted: boolean | null;
  /** Instruction cache hit rate, which is what decides the cache sizing question. */
  instructionCacheHitPercent: number | null;
  /**
   * The sample rate the device MEASURED itself running at, as opposed to the one it was
   * asked for or the one it calculated it would achieve.
   *
   * This is the empirical figure: the firmware counts samples against its clock while
   * recording. It is the last word on what a recording's timebase actually was.
   */
  measuredSampleRateHz: number | null;
  /** Whether that measurement has stabilized. An unsettled estimate is still moving. */
  sampleRateSettled: boolean | null;
}

export interface MicrophoneHealthSample {
  timestamp: string;
  result: 'PASS' | 'WARN_SILENT' | 'FAIL_CONSTANT' | 'FAIL';
  rms: number;
  peak: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  samples: number | null;
  dcOffset: number | null;
}

/** A clock correction the device applied to itself, from `EVT|CLOCK_SYNC`. */
/**
 * A moment in the deployment's life, from the events the device logs about itself.
 *
 * Assembled into one ordered list because that is how it is read: the question is not
 * "when did it activate" but "what happened, in order, and where are the surprises" —
 * a restart in week two, a phase that started twice, a stop nobody expected.
 */
export interface LifecycleEvent {
  timestamp: string | null;
  kind: 'ACTIVATED' | 'DEACTIVATED' | 'PHASE_START' | 'PHASE_END' | 'BOOT' | 'SELF_TEST' | 'BATTERY_LOW';
  /** One line in the terms a person reviewing the card would use. */
  summary: string;
  /** True for events that mean something went wrong. */
  notable: boolean;
}

/** The device's own record of restarting, which a healthy deployment does rarely. */
export interface RestartHistory {
  /** Distinct power-on epochs seen. More than one means the device lost power entirely. */
  powerOnCount: number;
  /** Highest reset count within a single power-on epoch. */
  maxResetsInEpoch: number;
  /** Reasons seen across all restarts, most recent last. */
  reasons: string[];
  /** True when any restart was a crash, a watchdog bite, or a peripheral timeout. */
  hadFault: boolean;
}

/**
 * One self-test run as the log recorded it.
 *
 * The results file at the card root carries the latest run in full; this is the same
 * information across EVERY activation, which is what shows a microphone or a card
 * degrading between deployments rather than only its state right now.
 */
export interface SelfTestRun {
  timestamp: string | null;
  firmwareVersion: string | null;
  passed: boolean | null;
  failedSubsystem: string | null;
  /** Per-subsystem verdicts with whatever measurement the firmware reported. */
  checks: Array<{
    check: string;
    result: string | null;
    /** Measurement keys in the order the firmware wrote them, for display. */
    detail: Array<{ key: string; value: string }>;
  }>;
}

/** The analog microphone verdict taken at startup, before any recording. */
export interface MicrophoneCheck {
  timestamp: string | null;
  type: string;
  result: 'PASS' | 'FAIL';
  dcOffset: number;
  nominal: number;
  tolerance: number;
}

export interface ClockSyncRecord {
  /** Device-clock instant immediately before the correction. */
  beforeDeviceTime: string;
  /** True UTC instant it was corrected to. */
  afterTrueTime: string;
  source: string;
}

/** Legacy logs announce each run in prose: `INFO: Current activation is #3`. */
const LEGACY_ACTIVATION = /^INFO: Current activation is #(\d+)/;

/** What the device made of its sun-anchored schedule, day by day. */
export interface SolarScheduleHistory {
  /** Days the device resolved the schedule at all, whether from the sun or the fallback. */
  daysResolved: number;
  /** Days the sun supplied nothing usable and the fixed windows were used instead. */
  fallbackDays: number;
  /** The most recent windows the sun produced, as seconds past local midnight. */
  lastWindowCount: number | null;
  lastStartSecond: number | null;
  lastEndSecond: number | null;
  /**
   * Days on which at least one solar window ended before it started and was skipped, and
   * how many windows that was in all. A configuration mistake the device reports rather
   * than silently recording less than it was asked to.
   */
  reversedDays: number;
  reversedWindows: number;
}

export interface ParsedLog {
  entries: LogEntry[];
  telemetry: TelemetrySample[];
  /**
   * Activations this log could actually place lines into.
   *
   * Empty means the log carries no attribution at all — no activation directory, no
   * `ACTIVATED` event, and none of the legacy `Current activation is #N` lines — so an
   * activation filter cannot narrow it and everything shown is the whole card. The UI
   * says so rather than leaving a chart that never changes.
   */
  activationsAttributed: number[];
  microphoneHealth: MicrophoneHealthSample[];
  /**
   * Clock corrections the device recorded itself. Only GPS units produce these, and
   * they are the one exact way to establish the clock error.
   */
  clockSyncs: ClockSyncRecord[];
  /**
   * How the device got on reading its configuration file.
   *
   * `CORRECTED` is the one worth acting on: the file parsed, but the firmware had to
   * change something to make it usable — a clip cap of zero, a sample rate out of range,
   * an inverted frequency band — and the deployment ran with settings nobody chose.
   */
  configResult: 'OK' | 'CORRECTED' | 'FAIL' | null;
  /**
   * How a sun-anchored schedule actually fared, or null if the deployment used clock times.
   *
   * The number worth looking at is `fallbackDays`. A solar schedule cannot be resolved on a
   * day with no sunrise, and the device quietly uses its fixed windows instead — correct
   * behavior, but it means the recordings for those days are not the ones that were asked
   * for. Above the Arctic circle that is most of the summer, and nothing else on the card
   * would say so.
   */
  solarSchedule: SolarScheduleHistory | null;
  /** Ordered account of what the device did, for the review timeline. */
  lifecycle: LifecycleEvent[];
  /** Restart history, or null when the log predates boot reporting. */
  restarts: RestartHistory | null;
  /** Startup microphone checks, one per boot. */
  microphoneChecks: MicrophoneCheck[];
  /** Every self-test the log recorded, oldest first. */
  selfTests: SelfTestRun[];
  /**
   * Set when the device had to rebuild its clock from evidence on the card.
   *
   * Every timestamp before this point came from a clock that had stopped, so they are
   * only as good as whatever source was recovered from. It changes how far a clock
   * correction can be trusted.
   */
  clockRecovery: { timestamp: string | null; source: string; chosenTime: string | null } | null;
  /**
   * What the digital microphone clock was set to, and what it turned out to be.
   *
   * The firmware reports this twice under one event code: once when it configures the
   * clock tree, and again after measuring the rate it actually achieved against a
   * reference. The two are separate fields here because the second is evidence and the
   * first is only intent.
   */
  pdmClock: {
    requestedHz: number;
    /** The rate the divider arithmetic predicts. */
    nominalHz: number;
    micClockHz: number;
    /** The rate the device measured itself running at, once it had settled. */
    measuredHz: number | null;
  } | null;
  /**
   * Crashes the firmware recorded, one per hard fault it came back from.
   *
   * The device writes this on the boot AFTER the crash, reading the fault address and
   * the Cortex-M Configurable Fault Status Register out of the registers it preserved
   * across the reset. An address of zero means the processor branched through a null
   * function pointer, which is the signature of a callback that was cleared while it
   * was still installed rather than of a bad memory access.
   */
  hardFaults: HardFault[];
  /** Distinct severities seen, for a quick "were there errors?" answer. */
  errorCount: number;
  warningCount: number;
  /** True when any line carried a `[timestamp]` prefix or an `EVT|` line. */
  modernFormat: boolean;
}

export interface HardFault {
  timestamp: string | null;
  /** Program counter at the fault. Zero means a branch through a null pointer. */
  address: number;
  /** Raw CFSR. Zero alongside a zero address is the null-branch signature. */
  cfsr: number;
  /** Plain-language reading of the CFSR bits, for someone who is not holding the ARM manual. */
  cause: string;
  /**
   * The shutdown step in progress when it died, if it died during one.
   *
   * Absent when the firmware reported `NONE`, which means the fault did not happen while
   * tearing peripherals down — so a value here narrows the search to one subsystem, and its
   * absence is itself informative.
   */
  teardown?: string;
}

/** Firmware `system_teardown_stage_name()` values, in words a reader can act on. */
const TEARDOWN_STAGE_LABELS: Record<string, string> = {
  MRAM: 'onboard memory',
  STORAGE: 'the SD card',
  AUDIO: 'the microphone',
  TRACKER: 'the GPS tracker',
  IMU: 'the motion sensor',
  MAGNET: 'the magnet sensor',
  BATTERY: 'the battery monitor',
  LEDS: 'the indicator LEDs',
  LOGGING: 'logging',
  COMPLETE: 'the last step of shutdown',
};

/**
 * Cortex-M Configurable Fault Status Register, ARMv7-M B3.2.15.
 *
 * Only the bits that distinguish one cause from another are named. The register packs
 * three sub-registers: MemManage in bits 0-7, BusFault in 8-15, UsageFault in 16-31.
 */
const CFSR_BITS: ReadonlyArray<{ mask: number; meaning: string }> = [
  { mask: 0x0000_0001, meaning: 'instruction fetch from a forbidden address' },
  { mask: 0x0000_0002, meaning: 'data access to a forbidden address' },
  { mask: 0x0000_0100, meaning: 'bus error on an instruction fetch' },
  { mask: 0x0000_0200, meaning: 'bus error on a data access' },
  { mask: 0x0001_0000, meaning: 'undefined instruction' },
  { mask: 0x0002_0000, meaning: 'invalid processor state' },
  { mask: 0x0004_0000, meaning: 'failed exception return' },
  { mask: 0x0100_0000, meaning: 'unaligned access' },
  { mask: 0x0200_0000, meaning: 'divide by zero' },
];

export function describeHardFault(address: number, cfsr: number): string {
  const causes = CFSR_BITS.filter(({ mask }) => (cfsr & mask) !== 0).map(({ meaning }) => meaning);
  if (causes.length > 0) return causes.join('; ');
  // No CFSR bit set and no address is the classic null function pointer: the processor
  // faulted trying to execute address zero, so there is nothing for the register to report.
  if (address === 0) return 'branched through a null function pointer';
  return 'cause not recorded';
}

/**
 * Restart reasons the FIRMWARE calls a failure, mirroring `reset_reason_is_error()`.
 *
 * Deliberately its list rather than one of our own. A battery reaching its cutoff reads
 * like a fault and is not one — the deployment ended exactly as configured — and a
 * disagreement here would have the dashboard flagging restarts the device considers
 * routine. A test pins this to the firmware source.
 */
const FAULT_REASONS: ReadonlySet<string> = new Set([
  'AUDIO-ERROR',
  'HARD-FAULT',
  'NO-CONFIG',
  'PERIPH-TIMEOUT',
  'RTC-STOPPED',
  'SD-FAILURE',
]);

/** Exposed so the contract test can compare it against the firmware snapshot. */
export const FIRMWARE_FAULT_REASONS = FAULT_REASONS;

const LINE_PREFIX = /^\[(\d+|-+)\]\s*/;
const SEVERITY = /^(INFO|WARNING|ERROR):\s*/;

/**
 * Parses one or more log files into a single time-ordered view.
 *
 * Pass every `a3em.log` found on the card, in any order. Entries are sorted by
 * timestamp; entries without one keep their position relative to the preceding
 * timestamped entry, which is what makes legacy logs readable at all.
 */
export function parseLogs(
  files: Array<{ name: string; text: string }>,
  options: { activation?: number | null } = {},
): ParsedLog {
  /**
   * Which run a line belongs to.
   *
   * Two independent sources, because neither covers every card. The directory a log sits
   * in attributes it wholesale, which is how the current firmware separates runs. A log
   * that pools several runs into one file instead carries `EVT|ACTIVATED|activation=N` at
   * each boundary, which attributes it line by line.
   *
   * Lines that neither source can place stay in view rather than vanishing: a log with no
   * activation markers at all should show the whole card, not an empty chart. Callers can
   * tell the difference from `activationsAttributed`.
   */
  const wanted = options.activation ?? null;
  const activationsAttributed = new Set<number>();
  const entries: LogEntry[] = [];
  const telemetry: TelemetrySample[] = [];
  const microphoneHealth: MicrophoneHealthSample[] = [];
  const clockSyncs: ClockSyncRecord[] = [];
  let modernFormat = false;
  let configResult: 'OK' | 'CORRECTED' | 'FAIL' | null = null;
  let solarSchedule: SolarScheduleHistory | null = null;
  const lifecycle: LifecycleEvent[] = [];
  const microphoneChecks: MicrophoneCheck[] = [];
  const bootEpochs = new Set<number>();
  const restartReasons: string[] = [];
  let maxResetsInEpoch = 0;
  let sawBoot = false;
  const selfTests: SelfTestRun[] = [];
  let clockRecovery: ParsedLog['clockRecovery'] = null;
  let pdmClock: ParsedLog['pdmClock'] = null;
  const hardFaults: HardFault[] = [];

  for (const file of files) {
    let lastTimestamp: string | null = null;
    /**
     * Where this log physically sits, which outranks anything written inside it.
     *
     * The firmware passes one number both to the directory namer and to the prose it
     * prints on every boot, so on a card it wrote itself the two always agree. When they
     * disagree the card has been rearranged since — a directory copied or renamed by
     * hand — and the path is the fact while the prose is a stale copy of one. Trusting
     * the prose there splits a duplicated run in half: the lines before the first marker
     * stay with the directory, everything after is handed to the run it names, so one
     * activation reads short and the other double-counts.
     */
    const pathActivation = activationFromPath(file.name);
    let activation = pathActivation;
    if (activation !== null) activationsAttributed.add(activation);
    /**
     * Whether this log's firmware stamps its events with a time at all.
     *
     * Where it does, a missing `t=` is the firmware saying outright that the clock could
     * not be trusted at that moment, and carrying a neighboring time onto the line would
     * erase precisely that signal. Where it never does, the log simply predates the
     * feature and the nearest known time is the best available answer.
     */
    const stampsEvents = /EVT\|[A-Z_]+\|t=/.test(file.text);
    const lines = file.text.split('\n');

    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index].replace(/\r$/, '');
      if (!raw.trim()) continue;

      let body = raw;
      let timestamp: string | null = lastTimestamp;

      const prefixMatch = LINE_PREFIX.exec(body);
      if (prefixMatch) {
        modernFormat = true;
        body = body.slice(prefixMatch[0].length);
        // `[----------]` marks a line written before the clock was valid.
        timestamp = prefixMatch[1].startsWith('-')
          ? null
          : new Date(Number(prefixMatch[1]) * 1000).toISOString();
        if (timestamp) lastTimestamp = timestamp;
      }

      // Read the boundary marker BEFORE deciding whether to skip, so the line that opens
      // a run is attributed to the run it opens rather than to the one before it.
      // Markers only decide attribution for a log the path cannot place: the root log, or a
      // card that pools every run into one file. Inside `Activation_NNNN` they are ignored.
      if (body.startsWith('EVT|ACTIVATED|')) {
        const marked = Number(parseFields(body.split('|')[2] ?? '').activation ?? NaN);
        if (Number.isFinite(marked) && pathActivation === null) {
          activation = marked;
          activationsAttributed.add(marked);
        }
      } else {
        // The legacy format has no events at all, but it announces the run it is starting
        // in prose on every boot. The number it prints is `config_get_activation_number()`,
        // which is the same value the firmware passes to the directory namer — so it lines
        // up with `Activation_NNNN` on the card with no adjustment.
        const legacy = LEGACY_ACTIVATION.exec(body);
        if (legacy && pathActivation === null) {
          activation = Number(legacy[1]);
          activationsAttributed.add(activation);
        }
      }
      if (wanted !== null && activation !== null && activation !== wanted) continue;

      if (body.startsWith('EVT|')) {
        modernFormat = true;
        const [, code = '', payload = ''] = body.split('|');
        const fields = parseFields(payload);
        // From 2026.08 every event carries `t=` — but ONLY while the real-time clock
        // held a time it could vouch for. Its absence means the device genuinely did not
        // know when the event happened, which is worth preserving rather than papering
        // over with the surrounding line's time.
        //
        // A telemetry reading is timed by `time=`, which is when the reading was taken
        // rather than when the line was written, so it wins where both are present.
        const eventTime = Number(fields.t ?? 0);
        const readingTime = code === 'TELEM' ? Number(fields.time ?? 0) : 0;
        const authoritative = readingTime > 0 ? readingTime : eventTime;
        if (authoritative > 0) timestamp = new Date(authoritative * 1000).toISOString();
        // A line that knows its own time also dates the lines that follow it, exactly as a
        // line prefix would. Firmware that stamps nothing at all otherwise leaves every
        // event undated even where precisely-timed telemetry sits beside it.
        if (!stampsEvents && timestamp) lastTimestamp = timestamp;
        entries.push({ timestamp, severity: severityForCode(code), code, fields, message: body, source: file.name });

        if (code === 'TELEM') {
          if (timestamp) telemetry.push(telemetryFromFields(timestamp, fields));
        } else if (code === 'CLOCK_SYNC') {
          // Carries its own before/after, so it does not depend on the line prefix —
          // which is written after the correction and would be misleading here.
          const before = Number(fields.before ?? 0);
          const after = Number(fields.after ?? 0);
          if (before > 0 && after > 0) {
            clockSyncs.push({
              beforeDeviceTime: new Date(before * 1000).toISOString(),
              afterTrueTime: new Date(after * 1000).toISOString(),
              source: fields.source ?? 'unknown',
            });
          }
        } else if (code === 'BOOT') {
          // Every restart passes through here, so this is where the device's stability
          // over the deployment becomes visible. A healthy run boots once.
          sawBoot = true;
          const epoch = Number(fields.epoch ?? 0);
          const resets = Number(fields.resets ?? 0);
          if (Number.isFinite(epoch)) bootEpochs.add(epoch);
          if (Number.isFinite(resets)) maxResetsInEpoch = Math.max(maxResetsInEpoch, resets);
          const reason = fields.last_stop ?? 'UNKNOWN';
          restartReasons.push(reason);
          lifecycle.push({
            timestamp,
            kind: 'BOOT',
            summary:
              resets > 0
                ? `Restarted (${resets} since power-on) after ${reason}`
                : `Powered on, running firmware version ${fields.fw ?? 'unknown firmware'}`,
            notable: FAULT_REASONS.has(reason),
          });
        } else if (code === 'SELF_TEST_START') {
          selfTests.push({
            timestamp,
            firmwareVersion: fields.fw ?? null,
            passed: null,
            failedSubsystem: null,
            checks: [],
          });
        } else if (code === 'SELF_TEST_DETAIL') {
          // A run emits several of these, and the microphone emits two: one describing
          // the clock it configured and one carrying the verdict. Both are kept, in the
          // order written, rather than collapsed into a single row that loses one.
          const run = selfTests.at(-1);
          if (run) {
            const { check, result, ...rest } = fields;
            run.checks.push({
              check: check ?? 'UNKNOWN',
              result: result ?? null,
              detail: Object.entries(rest).map(([key, value]) => ({ key, value })),
            });
          }
        } else if (code === 'CLOCK_RECOVERED') {
          const chosen = Number(fields.chosen ?? 0);
          clockRecovery = {
            timestamp,
            source: fields.source ?? 'unknown',
            chosenTime: chosen > 0 ? new Date(chosen * 1000).toISOString() : null,
          };
          lifecycle.push({
            timestamp,
            kind: 'BOOT',
            summary: `Clock was lost and rebuilt from the ${fields.source ?? 'card'}`,
            notable: true,
          });
        } else if (code === 'HARD_FAULT') {
          const address = Number(fields.address ?? 0);
          const cfsr = Number(fields.cfsr ?? 0);
          // Which shutdown step was in progress when it died. A fault with an address of zero
          // and no fault-status bits says almost nothing on its own — this says which
          // peripheral was being torn down, which is the difference between "it crashed" and
          // "it crashed closing the audio subsystem".
          const teardown = fields.teardown && fields.teardown !== 'NONE' ? fields.teardown : undefined;
          const cause = describeHardFault(address, cfsr);
          hardFaults.push({ timestamp, address, cfsr, cause, teardown });
          const where = teardown ? ` while shutting down ${TEARDOWN_STAGE_LABELS[teardown] ?? teardown}` : '';
          lifecycle.push({
            timestamp,
            kind: 'BOOT',
            summary: `Recovered from a crash at 0x${address.toString(16).padStart(8, '0')}${where} — ${cause}`,
            notable: true,
          });
        } else if (code === 'PDM_CLOCK') {
          // Two shapes share this code. Merging rather than replacing keeps the
          // configuration when a later measurement line arrives, which otherwise
          // overwrote every field it does not carry with zero.
          const base: NonNullable<ParsedLog['pdmClock']> =
            pdmClock ?? { requestedHz: 0, nominalHz: 0, micClockHz: 0, measuredHz: null };
          pdmClock = fields.phase === 'MEASURED'
            ? {
                ...base,
                nominalHz: Number(fields.nominal_rate_hz ?? base.nominalHz),
                measuredHz: Number(fields.measured_rate_hz ?? 0) || base.measuredHz,
              }
            : {
                ...base,
                requestedHz: Number(fields.requested_hz ?? base.requestedHz),
                nominalHz: Number(fields.nominal_hz ?? base.nominalHz),
                micClockHz: Number(fields.cko_hz ?? base.micClockHz),
              };
        } else if (code === 'RECOVERED') {
          lifecycle.push({
            timestamp,
            kind: 'BOOT',
            summary: `Recovered and carried on after ${fields.from ?? 'a failure'}`,
            notable: false,
          });
        } else if (code === 'ACTIVATED') {
          lifecycle.push({
            timestamp,
            kind: 'ACTIVATED',
            summary: `Activated with the magnet — activation ${fields.activation ?? '?'}`,
            notable: false,
          });
        } else if (code === 'DEACTIVATED') {
          lifecycle.push({
            timestamp,
            kind: 'DEACTIVATED',
            summary: `Switched off (${fields.reason ?? 'unrecorded reason'})`,
            notable: false,
          });
        } else if (code === 'PHASE_START') {
          lifecycle.push({
            timestamp,
            kind: 'PHASE_START',
            summary: `Recording phase ${fields.phase ?? '?'} began`,
            notable: false,
          });
        } else if (code === 'PHASE_END') {
          // The reason is a reset-reason name, so the same set that decides whether a
          // restart was a fault decides whether a phase ended badly.
          const reason = fields.reason ?? 'UNKNOWN';
          lifecycle.push({
            timestamp,
            kind: 'PHASE_END',
            summary: `Recording phase ended — ${reason.toLowerCase().replace(/[-_]/g, ' ')}`,
            notable: FAULT_REASONS.has(reason),
          });
        } else if (code === 'BATTERY_LOW') {
          lifecycle.push({
            timestamp,
            kind: 'BATTERY_LOW',
            summary: `Battery reached ${fields.batt_mv ?? '?'} mV, at or below the ${fields.cutoff_mv ?? '?'} mV cutoff`,
            notable: true,
          });
        } else if (code === 'SELF_TEST_END') {
          const passed = fields.result === 'PASS';
          const run = selfTests.at(-1);
          if (run && run.passed === null) {
            run.passed = passed;
            run.failedSubsystem = fields.failed_subsystem ?? null;
          }
          lifecycle.push({
            timestamp,
            kind: 'SELF_TEST',
            summary: passed
              ? 'Self-test passed'
              : `Self-test FAILED (subsystem ${fields.failed_subsystem ?? '?'})`,
            notable: !passed,
          });
        } else if (code === 'MIC_CHECK') {
          microphoneChecks.push({
            timestamp,
            type: fields.type ?? 'ANALOG',
            result: fields.result === 'FAIL' ? 'FAIL' : 'PASS',
            dcOffset: Number(fields.dc_offset ?? 0),
            nominal: Number(fields.nominal ?? 0),
            tolerance: Number(fields.tolerance ?? 0),
          });
        } else if (code === 'SOLAR_REVERSED') {
          solarSchedule ??= emptySolarHistory();
          solarSchedule.reversedDays += 1;
          solarSchedule.reversedWindows += Number(fields.windows ?? 0);
        } else if (code === 'SOLAR_SCHEDULE') {
          // One of these per local day, so it is accumulated rather than pushed onto the
          // timeline: a three-month deployment would otherwise add ninety near-identical rows.
          solarSchedule ??= emptySolarHistory();
          solarSchedule.daysResolved += 1;
          const windows = Number(fields.windows ?? 0);
          if (windows > 0) {
            solarSchedule.lastWindowCount = windows;
            solarSchedule.lastStartSecond = fields.first_start === undefined ? null : Number(fields.first_start);
            solarSchedule.lastEndSecond = fields.first_end === undefined ? null : Number(fields.first_end);
          } else {
            solarSchedule.fallbackDays += 1;
          }
        } else if (code === 'CONFIG') {
          const result = fields.result;
          if (result === 'OK' || result === 'CORRECTED' || result === 'FAIL') configResult = result;
        } else if (code === 'MIC_HEALTH' && timestamp) {
          microphoneHealth.push({
            timestamp,
            result: coerceHealthResult(fields.result),
            rms: Number(fields.rms ?? 0),
            peak: Number(fields.peak ?? 0),
            // min/max come from every sample while rms is subsampled, so a wide span
            // beside a low rms is a quiet recording with real transients in it.
            min: fields.min !== undefined ? Number(fields.min) : null,
            max: fields.max !== undefined ? Number(fields.max) : null,
            mean: fields.mean !== undefined ? Number(fields.mean) : null,
            samples: fields.samples !== undefined ? Number(fields.samples) : null,
            dcOffset: fields.dc_offset !== undefined ? Number(fields.dc_offset) : null,
          });
        }
        continue;
      }

      // Prose line. Legacy logs reach here for everything, including the multi-line
      // `Current Device Details` block, which is the only telemetry they carry.
      const severityMatch = SEVERITY.exec(body);
      const severity = (severityMatch?.[1] as LogSeverity) ?? 'INFO';
      const message = severityMatch ? body.slice(severityMatch[0].length) : body;

      if (message.startsWith('Current Device Details')) {
        const block = readDetailsBlock(lines, index);
        if (block.sample) {
          // Only used when no EVT|TELEM line covers the same instant, so a modern log
          // does not double-count.
          const alreadyPresent = telemetry.some((s) => s.timestamp === block.sample!.timestamp);
          if (!alreadyPresent) telemetry.push(block.sample);
          lastTimestamp = block.sample.timestamp;
        }
        index = block.lastIndex;
        entries.push({ timestamp: block.sample?.timestamp ?? timestamp, severity, code: null, fields: {}, message, source: file.name });
        continue;
      }

      entries.push({ timestamp, severity, code: null, fields: {}, message, source: file.name });
    }
  }

  entries.sort(byTimestamp);
  telemetry.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  microphoneHealth.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  clockSyncs.sort((a, b) => Date.parse(a.beforeDeviceTime) - Date.parse(b.beforeDeviceTime));

  return {
    entries,
    telemetry,
    activationsAttributed: [...activationsAttributed].sort((a, b) => a - b),
    microphoneHealth,
    clockSyncs,
    errorCount: entries.filter((e) => e.severity === 'ERROR').length,
    warningCount: entries.filter((e) => e.severity === 'WARNING').length,
    configResult,
    solarSchedule,
    lifecycle,
    restarts: sawBoot
      ? {
          powerOnCount: bootEpochs.size,
          maxResetsInEpoch,
          reasons: restartReasons,
          hadFault: restartReasons.some((reason) => FAULT_REASONS.has(reason)),
        }
      : null,
    microphoneChecks,
    selfTests,
    clockRecovery,
    pdmClock,
    hardFaults,
    modernFormat,
  };
}

/** Stable ordering that keeps undated lines adjacent to the entry they followed. */
function byTimestamp(a: LogEntry, b: LogEntry): number {
  if (a.timestamp && b.timestamp) return Date.parse(a.timestamp) - Date.parse(b.timestamp);
  if (a.timestamp) return -1;
  if (b.timestamp) return 1;
  return 0;
}

function parseFields(payload: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const pair of payload.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) fields[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return fields;
}

function severityForCode(code: string): LogSeverity {
  if (code === 'BATTERY_LOW') return 'WARNING';
  if (code === 'SD_ERROR') return 'ERROR';
  return 'INFO';
}

/** Splits an "a/b/c" counter triple, preserving "absent" as null rather than zero. */
function splitCounters(value: string | undefined): [number | null, number | null, number | null] {
  if (!value) return [null, null, null];
  const parts = value.split('/');
  const at = (i: number) => (parts[i] !== undefined && parts[i] !== '' ? Number(parts[i]) : null);
  return [at(0), at(1), at(2)];
}

function coerceHealthResult(value: string | undefined): MicrophoneHealthSample['result'] {
  return value === 'FAIL_CONSTANT' || value === 'WARN_SILENT' || value === 'FAIL' ? value : 'PASS';
}

function telemetryFromFields(timestamp: string, fields: Record<string, string>): TelemetrySample {
  // Absent is not zero. A legacy log carries none of these, and reporting them as zero
  // would claim a clean run on a card that simply never counted.
  const counter = (value: string | undefined) => (value !== undefined ? Number(value) : null);
  return {
    timestamp,
    batteryMv: Number(fields.batt_mv ?? 0),
    temperatureC: Number(fields.temp_c ?? 0),
    ...coordinates(Number(fields.lat ?? 0), Number(fields.lon ?? 0), Number(fields.alt ?? 0)),
    ledsActive: fields.leds === '1',
    vhfActive: fields.vhf === '1',
    sdFreeMb: counter(fields.sd_free_mb),
    audioBuffersCaptured: counter(fields.audio_buffers),
    // Emitted as the words the firmware logs, not as a number.
    dmaCompletionTrusted: fields.dcmp !== undefined ? fields.dcmp === 'trusted' : null,
    instructionCacheHitPercent: counter(fields.icache_hit_pct),
    measuredSampleRateHz: counter(fields.rate_est_hz),
    sampleRateSettled: fields.rate_settled !== undefined ? fields.rate_settled === '1' : null,
    sdWriteFailures: counter(fields.sd_write_fail),
    sdReopenRecoveries: counter(fields.sd_reopen),
    sdRemountRecoveries: counter(fields.sd_remount),
    imuBuffersDropped: counter(fields.imu_dropped),
    audioBuffersDropped: counter(fields.audio_dropped),
  };
}

/**
 * A device without GPS logs `[0.000000, 0.000000, 0.00]` every time. Treating that as a
 * position would place every such deployment off the coast of Africa.
 */
function coordinates(lat: number, lon: number, alt: number) {
  const hasFix = lat !== 0 || lon !== 0;
  return {
    latitude: hasFix ? lat : null,
    longitude: hasFix ? lon : null,
    altitudeM: hasFix ? alt : null,
  };
}

/** Reads the multi-line `Current Device Details` block used by legacy firmware. */
function readDetailsBlock(lines: string[], startIndex: number): { sample: TelemetrySample | null; lastIndex: number } {
  const values = new Map<string, string>();
  let index = startIndex + 1;
  for (; index < lines.length; index++) {
    const line = lines[index].replace(LINE_PREFIX, '');
    if (!/^\s{2,}\S/.test(line)) break;
    const colon = line.indexOf(':');
    if (colon < 0) break;
    values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  const epoch = Number(values.get('UTC Timestamp') ?? '0');
  if (!epoch) return { sample: null, lastIndex: index - 1 };

  const location = (values.get('Location') ?? '').replace(/[[\]]/g, '').split(',').map(Number);
  /*
    The prose block carries write failures after all, in the middle field of
    "SD Errors (read/write/timeout)". This parsed all three and then threw them away,
    reporting `sdWriteFailures: null` beneath a comment claiming a legacy log has none —
    so a card that really had recovered write failures read as a card that had none.
    Reads and timeouts have nowhere to go: no TelemetrySample field holds them.
  */
  const sdWriteFailures = splitCounters(values.get('SD Errors (read/write/timeout)'))[1];
  const freeMb = values.get('SD Free (MB)');

  return {
    lastIndex: index - 1,
    sample: {
      timestamp: new Date(epoch * 1000).toISOString(),
      batteryMv: Number(values.get('Battery Voltage (mV)') ?? 0),
      temperatureC: Number(values.get('Temperature (C)') ?? 0),
      ...coordinates(location[0] ?? 0, location[1] ?? 0, location[2] ?? 0),
      ledsActive: values.get('LEDs Active') === 'True',
      vhfActive: values.get('VHF Active') === 'True',
      sdFreeMb: freeMb !== undefined ? Number(freeMb) : null,
      sdWriteFailures,
      // The prose block predates the RECOVERY counters, which have no legacy equivalent.
      sdReopenRecoveries: null,
      sdRemountRecoveries: null,
      imuBuffersDropped: null,
      audioBuffersDropped: null,
      audioBuffersCaptured: null,
      dmaCompletionTrusted: null,
      instructionCacheHitPercent: null,
      measuredSampleRateHz: null,
      sampleRateSettled: null,
    },
  };
}

function emptySolarHistory(): SolarScheduleHistory {
  return {
    daysResolved: 0,
    fallbackDays: 0,
    lastWindowCount: null,
    lastStartSecond: null,
    lastEndSecond: null,
    reversedDays: 0,
    reversedWindows: 0,
  };
}
