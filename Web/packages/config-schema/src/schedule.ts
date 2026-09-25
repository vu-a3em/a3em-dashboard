import { solarDay } from './solar.js';
import { utcOffsetSecondsAt } from './timezone.js';
import type { DeploymentConfig, PhaseConfig, TriggerWindow } from './types.js';

/**
 * Recording periods as the editor holds them, and as the device runs them.
 *
 * The two differ in one place. The editor lets a period run past midnight — 21:00 to
 * 03:00 is one period to anyone recording bats, owls, or frogs — and stores it with an
 * end past 86 400, so its duration is simply `end - start`. The firmware cannot express
 * that: `seconds_until_next_scheduled_recording()` compares one seconds-of-day value
 * against sorted, non-wrapping entries. So an overnight period is written as the two
 * entries either side of midnight, and read back into one.
 *
 * The seam costs nothing on the device. An entry may end at exactly 86 400, which no
 * seconds-of-day value reaches, so the evening half runs to midnight; the morning half
 * starts at zero; and a clip in progress always runs to its full length, so the clip that
 * straddles midnight is simply followed by the next one.
 */

export const SECONDS_PER_DAY = 86_400;

/** Whether a period runs past midnight into the next day. */
export function isOvernight(window: TriggerWindow): boolean {
  return window.endSecond > SECONDS_PER_DAY;
}

/** Recording seconds in one occurrence of the period. */
export function periodDuration(window: TriggerWindow): number {
  return Math.max(0, window.endSecond - window.startSecond);
}

/**
 * The end of a period from the clock time typed for it.
 *
 * An end at or before the start is read as the next day — which is also how "22:00 to
 * 00:00" comes to mean "until midnight" rather than an error. An end equal to the start is
 * left equal, and validation says so: silently turning a slip into a 24-hour period would
 * fill a card nobody meant to fill.
 */
export function periodEndFromClock(startSecond: number, endClockSecond: number): number {
  if (endClockSecond === startSecond) return endClockSecond;
  return endClockSecond < startSecond ? endClockSecond + SECONDS_PER_DAY : endClockSecond;
}

/**
 * The part(s) of each day a period covers, as non-wrapping `[start, end)` segments.
 *
 * One segment for an ordinary period, two for an overnight one. Everything that asks
 * "does this period cover this moment of the day" — the day strip, overlap checks, the
 * coverage grid — works from these.
 */
export function periodSegments(window: TriggerWindow): TriggerWindow[] {
  if (!isOvernight(window)) return [{ startSecond: window.startSecond, endSecond: window.endSecond }];
  return [
    { startSecond: window.startSecond, endSecond: SECONDS_PER_DAY },
    { startSecond: 0, endSecond: window.endSecond - SECONDS_PER_DAY },
  ].filter((segment) => segment.endSecond > segment.startSecond);
}

/**
 * The AUDIO_TRIGGER_SCHEDULE entries for a list of periods: split at midnight and sorted.
 *
 * Sorting is not cosmetic. The firmware walks the entries in file order and stops at the
 * first whose end has not passed, so an evening period written before a morning one hides
 * the morning period entirely — at 07:00 it would sleep until the evening.
 */
export function firmwareTriggerTimes(windows: readonly TriggerWindow[]): TriggerWindow[] {
  return windows.flatMap(periodSegments).sort((a, b) => a.startSecond - b.startSecond || a.endSecond - b.endSecond);
}

/** How many AUDIO_TRIGGER_SCHEDULE entries the periods occupy, against the device's limit. */
export function firmwareEntryCount(windows: readonly TriggerWindow[]): number {
  return windows.reduce((count, window) => count + periodSegments(window).length, 0);
}

/**
 * The inverse of `firmwareTriggerTimes`: an entry ending at midnight and one starting at
 * midnight become the one overnight period they were written from.
 *
 * Also correct for a card written by anything else, since the two are indistinguishable to
 * the device — back-to-back entries across midnight record exactly as one period does.
 */
export function mergeMidnightPeriods(windows: readonly TriggerWindow[]): TriggerWindow[] {
  const evening = windows.findIndex((window) => window.endSecond === SECONDS_PER_DAY && window.startSecond > 0);
  const morning = windows.findIndex((window) => window.startSecond === 0 && window.endSecond < SECONDS_PER_DAY);
  if (evening < 0 || morning < 0) return windows.map((window) => ({ ...window }));
  const merged: TriggerWindow = {
    startSecond: windows[evening].startSecond,
    endSecond: SECONDS_PER_DAY + windows[morning].endSecond,
  };
  return windows
    .map((window, index) => (index === evening ? merged : window))
    .filter((_, index) => index !== morning)
    .map((window) => ({ ...window }));
}

// ---------------------------------------------------------------------------
// What the device will actually record on a given day
// ---------------------------------------------------------------------------

/**
 * The periods a scheduled phase records during on one local day, as the DEVICE resolves them.
 *
 * A mirror of `process_audio_scheduled()` and `resolve_solar_schedule()`:
 *
 *  - A clock schedule is its periods, every day.
 *  - A solar schedule resolves each window against the day's sun. One whose anchor does not
 *    occur is dropped; one that runs past midnight becomes the two entries either side of
 *    it; one that ends before it starts is skipped and counted, and the device logs it as
 *    SOLAR_REVERSED. If none resolve, the clock periods are the fallback.
 *  - An empty schedule — no periods at all, or a solar day with no fallback — is NOT
 *    silence. `seconds_until_next_scheduled_recording()` returns zero for an empty list, so
 *    the device records continuously. Reported as `continuous` so callers can say so.
 *
 * `utcOffsetSeconds` is the single offset the device is given, not the zone's offset on the
 * day, because that is what it runs on.
 */
export interface DaySchedule {
  periods: TriggerWindow[];
  /** True when the device will record all day because it has nothing to schedule by. */
  continuous: boolean;
  /** True for a solar schedule that fell back to its clock periods today. */
  usedFallback: boolean;
  /** Solar windows that ended before they started today, which the device skips and logs. */
  reversed: number;
}

export function scheduleOnDay(
  phase: PhaseConfig,
  config: Pick<DeploymentConfig, 'latitude' | 'longitude'>,
  utcTimestampSeconds: number,
  utcOffsetSeconds: number,
): DaySchedule {
  const clock = phase.audioTriggerTimes.map((window) => ({ ...window }));
  if (phase.audioScheduleType !== 'SOLAR' || phase.audioSolarWindows.length === 0) {
    return { periods: clock, continuous: clock.length === 0, usedFallback: false, reversed: 0 };
  }

  const resolved: TriggerWindow[] = [];
  let reversed = 0;
  if (config.latitude !== null && config.longitude !== null) {
    const day = solarDay(utcTimestampSeconds, { latitude: config.latitude, longitude: config.longitude }, utcOffsetSeconds);
    for (const window of phase.audioSolarWindows) {
      if (!day.available[window.startAnchor] || !day.available[window.endAnchor]) continue;
      // Unfolded, as the firmware now works: the order of the two ends is what separates a
      // window across midnight, which is recorded, from one that ends before it starts.
      const start = day.secondsFromMidnight[window.startAnchor] + window.startOffsetSeconds;
      const end = day.secondsFromMidnight[window.endAnchor] + window.endOffsetSeconds;
      if (end <= start) {
        reversed++;
        continue;
      }
      const duration = Math.min(SECONDS_PER_DAY, end - start);
      const from = duration >= SECONDS_PER_DAY ? 0 : wrapDay(start);
      // Held as one period, running past 86 400 where it crosses midnight; the device gets it
      // as the two entries either side, which `periodSegments` reproduces.
      resolved.push({ startSecond: from, endSecond: from + duration });
    }
  }
  if (resolved.length) {
    return {
      periods: resolved.sort((a, b) => a.startSecond - b.startSecond),
      continuous: false,
      usedFallback: false,
      reversed,
    };
  }
  return { periods: clock, continuous: clock.length === 0, usedFallback: true, reversed };
}

/** The UTC offset the device is given, which is the zone's offset at the deployment start. */
export function deviceUtcOffsetSeconds(config: Pick<DeploymentConfig, 'timezone' | 'startTime'>): number {
  try {
    return utcOffsetSecondsAt(config.timezone, config.startTime);
  } catch {
    return 0;
  }
}

/**
 * Audio seconds recorded in one day's periods, clip-quantized the way the device records.
 *
 * A clip that starts inside a period always runs to its full length, so a period records
 * `ceil(duration / clip)` clips, not `duration / clip` of them. Across midnight the halves
 * are back to back and record as one period, which is why this works from the periods as
 * the editor holds them rather than from the split file entries.
 */
export function recordedSecondsInPeriods(periods: readonly TriggerWindow[], clipSeconds: number): number {
  if (clipSeconds <= 0) return 0;
  return periods.reduce(
    (sum, window) => sum + Math.ceil(periodDuration(window) / clipSeconds) * clipSeconds,
    0,
  );
}

function wrapDay(seconds: number): number {
  const wrapped = seconds % SECONDS_PER_DAY;
  return wrapped < 0 ? wrapped + SECONDS_PER_DAY : wrapped;
}

// ---------------------------------------------------------------------------
// Daylight saving
// ---------------------------------------------------------------------------

/**
 * A change in the zone's UTC offset inside a deployment.
 *
 * The device holds one offset for the whole deployment — the one in force at the start — so
 * a clock-time recording period drifts an hour against the local clock from the moment the
 * zone changes. Sun-anchored periods do not: the sun is the same sun either side of the
 * change, and the device resolves it in the same frame it always has.
 */
export interface OffsetChange {
  /** Epoch milliseconds of the change. */
  at: number;
  offsetBeforeSeconds: number;
  offsetAfterSeconds: number;
}

const DAY_MS = 86_400_000;

function offsetAt(timezone: string, ms: number): number {
  return utcOffsetSecondsAt(timezone, new Date(ms).toISOString());
}

/** Every offset change in `[fromMs, toMs)`, to the minute. */
export function offsetChanges(timezone: string, fromMs: number, toMs: number): OffsetChange[] {
  const changes: OffsetChange[] = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return changes;
  let before: number;
  try {
    before = offsetAt(timezone, fromMs);
  } catch {
    return changes;
  }
  // A day at a time, then halving to the minute where the offset moved. Zones change at
  // most a few times a year, so this is a few hundred lookups for a long deployment.
  for (let t = fromMs; t < toMs; t += DAY_MS) {
    const next = Math.min(t + DAY_MS, toMs);
    const after = offsetAt(timezone, next);
    if (after === before) continue;
    // In whole minutes, which is the finest any zone changes on.
    let low = Math.floor(t / 60_000);
    let high = Math.ceil(next / 60_000);
    while (high - low > 1) {
      const middle = low + Math.floor((high - low) / 2);
      if (offsetAt(timezone, middle * 60_000) === before) low = middle;
      else high = middle;
    }
    const at = high * 60_000;
    if (at < toMs) changes.push({ at, offsetBeforeSeconds: before, offsetAfterSeconds: after });
    before = after;
  }
  return changes;
}

/** A phase as the card will carry it once daylight saving has been accounted for. */
export interface DstSegment {
  phase: PhaseConfig;
  /** Index of the phase in `config.phases` this segment came from. */
  phaseIndex: number;
  startTime: string;
  endTime: string;
  /** How far this segment's clock periods move on the device's clock, in seconds. */
  shiftSeconds: number;
}

/** Whether a phase has clock-time periods that daylight saving would move. */
function hasClockPeriods(phase: PhaseConfig): boolean {
  return phase.audioRecordingMode === 'SCHEDULED' && phase.audioTriggerTimes.length > 0;
}

/**
 * The deployment's phases cut at every offset change that moves a clock-time period.
 *
 * Each segment's periods need shifting by `device offset − local offset` to fire at the same
 * wall-clock time: after the autumn change in Chicago the device still runs on CDT, so a
 * 06:00 CST period is 07:00 by its clock. Phases with nothing on the clock are left whole.
 */
export function dstSegments(config: DeploymentConfig): DstSegment[] {
  const deviceOffset = deviceUtcOffsetSeconds(config);
  const ordered = config.phases
    .map((phase, phaseIndex) => ({ phase, phaseIndex }))
    .sort((a, b) => Date.parse(a.phase.startTime ?? config.startTime) - Date.parse(b.phase.startTime ?? config.startTime));
  if (!config.isPhased) ordered.splice(1);

  const segments: DstSegment[] = [];
  for (const { phase, phaseIndex } of ordered) {
    const startTime = config.isPhased ? (phase.startTime ?? config.startTime) : config.startTime;
    const endTime = config.isPhased ? (phase.endTime ?? config.endTime) : config.endTime;
    const from = Date.parse(startTime);
    const to = Date.parse(endTime);
    if (!hasClockPeriods(phase) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      segments.push({ phase, phaseIndex, startTime, endTime, shiftSeconds: 0 });
      continue;
    }
    let cursor = from;
    for (const cut of [...offsetChanges(config.timezone, from, to).map((change) => change.at), to]) {
      let shift = 0;
      try {
        shift = deviceOffset - offsetAt(config.timezone, cursor);
      } catch {
        shift = 0;
      }
      segments.push({
        phase,
        phaseIndex,
        startTime: new Date(cursor).toISOString(),
        endTime: new Date(cut).toISOString(),
        shiftSeconds: shift,
      });
      cursor = cut;
    }
  }
  return segments;
}

/**
 * The offset changes that would move this deployment's clock-time periods, ignoring whether
 * the adjustment is switched on — which is what decides whether to offer it at all.
 */
export function dstChangesAffectingSchedule(config: DeploymentConfig): OffsetChange[] {
  const start = Date.parse(config.startTime);
  const end = Date.parse(config.endTime);
  const phases = config.isPhased ? config.phases : config.phases.slice(0, 1);
  const spans = phases.filter(hasClockPeriods).map((phase) => ({
    from: config.isPhased ? Date.parse(phase.startTime ?? config.startTime) : start,
    to: config.isPhased ? Date.parse(phase.endTime ?? config.endTime) : end,
  }));
  if (!spans.length) return [];
  // Any phase still running after the change is on the wrong offset from then on, whether
  // it spans the change or starts after it.
  return offsetChanges(config.timezone, start, end).filter((change) => spans.some((span) => span.to > change.at));
}

/** Whether the card will carry daylight-saving-adjusted phases. */
export function dstAdjustmentApplies(config: DeploymentConfig): boolean {
  return config.adjustForDst !== false && dstSegments(config).some((segment) => segment.shiftSeconds !== 0);
}

/** Periods moved by `shiftSeconds` on the device's clock, keeping their lengths. */
export function shiftPeriods(periods: readonly TriggerWindow[], shiftSeconds: number): TriggerWindow[] {
  if (!shiftSeconds) return periods.map((period) => ({ ...period }));
  return periods.map((period) => {
    const duration = periodDuration(period);
    const startSecond = wrapDay(period.startSecond + shiftSeconds);
    return { startSecond, endSecond: startSecond + duration };
  });
}

/**
 * The inverse of the serializer's daylight-saving split: each phase's periods moved back onto
 * the local clock, and the pieces of one phase joined up again.
 *
 * Pieces are recognized by what the serializer guarantees about them — the same name, end to
 * end in time, and identical settings once unshifted — so a deliberate pair of phases that
 * happen to share a name but differ in anything is left alone. Periods are compared as the
 * entries the device is given: two periods that meet at midnight read back as one overnight
 * period, and moved by the change they may come back as two, the same recording either way.
 */
export function joinDstSegments(config: DeploymentConfig): { phases: PhaseConfig[]; isPhased: boolean } {
  const deviceOffset = deviceUtcOffsetSeconds(config);
  const unshifted = [...config.phases]
    .sort((a, b) => Date.parse(a.startTime ?? config.startTime) - Date.parse(b.startTime ?? config.startTime))
    .map((phase) => {
      let shift = 0;
      try {
        shift = deviceOffset - offsetAt(config.timezone, Date.parse(phase.startTime ?? config.startTime));
      } catch {
        shift = 0;
      }
      return { ...phase, audioTriggerTimes: shiftPeriods(phase.audioTriggerTimes, -shift) };
    });

  const joined: PhaseConfig[] = [];
  for (const phase of unshifted) {
    const previous = joined[joined.length - 1];
    if (
      previous &&
      previous.name === phase.name &&
      previous.endTime !== undefined &&
      phase.startTime !== undefined &&
      Date.parse(previous.endTime) === Date.parse(phase.startTime) &&
      settingsKey(asEntries(previous)) === settingsKey(asEntries(phase))
    ) {
      previous.endTime = phase.endTime;
      continue;
    }
    joined.push({ ...phase });
  }

  // One phase spanning the whole deployment is what an unphased deployment was split from.
  const only = joined.length === 1 ? joined[0] : null;
  if (
    only &&
    Date.parse(only.startTime ?? config.startTime) === Date.parse(config.startTime) &&
    Date.parse(only.endTime ?? config.endTime) === Date.parse(config.endTime)
  ) {
    return { phases: [{ ...only, startTime: undefined, endTime: undefined }], isPhased: false };
  }
  return { phases: joined, isPhased: true };
}

/** A phase with its periods as the device's entries, which two ways of entering one recording share. */
function asEntries(phase: PhaseConfig): PhaseConfig {
  return { ...phase, audioTriggerTimes: firmwareTriggerTimes(phase.audioTriggerTimes) };
}

/** A phase's settings without its times, in a fixed key order, for comparing two of them. */
function settingsKey(phase: PhaseConfig): string {
  const { startTime: _start, endTime: _end, ...settings } = phase;
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, sorted(item)]),
      );
    }
    return value;
  };
  return JSON.stringify(sorted(settings));
}

/** How one solar period behaves across the days a phase runs. */
export interface SolarPeriodReport {
  daysChecked: number;
  /** Days it ends before it starts, which the device skips and logs as SOLAR_REVERSED. */
  reversedDays: number;
  firstReversedAt: number | null;
  /** Days it runs past midnight, which the device records as two entries. */
  overnightDays: number;
}

/** Each of a phase's solar periods, resolved against the sun across `[fromMs, toMs)`. */
export function solarPeriodReports(
  phase: PhaseConfig,
  config: Pick<DeploymentConfig, 'latitude' | 'longitude' | 'timezone' | 'startTime'>,
  fromMs: number,
  toMs: number,
  maxDays = 120,
): SolarPeriodReport[] {
  const reports = phase.audioSolarWindows.map(() => ({
    daysChecked: 0,
    reversedDays: 0,
    firstReversedAt: null as number | null,
    overnightDays: 0,
  }));
  if (config.latitude === null || config.longitude === null || !(toMs > fromMs)) return reports;
  const position = { latitude: config.latitude, longitude: config.longitude };
  const offset = deviceUtcOffsetSeconds(config);
  const days = Math.max(1, Math.ceil((toMs - fromMs) / DAY_MS));
  const samples = Math.min(days, maxDays);
  for (let i = 0; i < samples; i++) {
    const at = fromMs + ((i + 0.5) / samples) * (toMs - fromMs);
    const day = solarDay(Math.floor(at / 1000), position, offset);
    phase.audioSolarWindows.forEach((window, index) => {
      if (!day.available[window.startAnchor] || !day.available[window.endAnchor]) return;
      const report = reports[index];
      report.daysChecked++;
      const start = day.secondsFromMidnight[window.startAnchor] + window.startOffsetSeconds;
      const end = day.secondsFromMidnight[window.endAnchor] + window.endOffsetSeconds;
      if (end <= start) {
        report.reversedDays++;
        report.firstReversedAt ??= at;
      } else if (wrapDay(start) + (end - start) > SECONDS_PER_DAY) {
        report.overnightDays++;
      }
    });
  }
  return reports;
}

/**
 * Local solar noon at a position, in minutes past local midnight on the given offset.
 *
 * Accurate to the equation of time (about a quarter of an hour), which is ample for its one
 * use: noticing that a position and a timezone describe different places.
 */
export function approximateSolarNoonMinutes(longitude: number, utcOffsetSeconds: number): number {
  const minutes = 720 - 4 * longitude + utcOffsetSeconds / 60;
  return ((minutes % 1440) + 1440) % 1440;
}
