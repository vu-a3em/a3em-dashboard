import { secondsPastLocalMidnight, utcOffsetSecondsAt } from './timezone.js';
import type { DeploymentConfig, PhaseConfig } from './types.js';

/**
 * When a deployment actually recorded, against when it was meant to.
 *
 * "Did it run to plan?" is the question a retrieved card has to answer first, and a list
 * of files cannot answer it — a gap in the middle of a three-week deployment is invisible
 * in a directory listing and obvious in a grid. This turns the recordings into hours, and
 * separates the hours that are missing something from the hours that were never scheduled.
 *
 * The distinction matters more than the count: an empty hour at 3 a.m. on a dawn-chorus
 * schedule is correct behaviour, and an empty hour at dawn is a lost morning.
 */

export type Expectation =
  /** The configuration says recordings should exist in this hour. */
  | 'scheduled'
  /** The configuration says nothing should be recorded then. */
  | 'idle'
  /** Recording depends on what the device heard, so nothing can be predicted. */
  | 'unpredictable'
  /** Outside the deployment window, or no configuration to judge against. */
  | 'unknown';

export interface CoverageHour {
  /** Local date, `YYYY-MM-DD`, in the deployment's timezone. */
  date: string;
  /** Local hour, 0-23. */
  hour: number;
  /** Start of this hour as an ISO instant. */
  startsAt: string;
  clips: number;
  bytes: number;
  expectation: Expectation;
  /**
   * A scheduled hour, inside the recorded span, holding nothing.
   *
   * Decided here rather than by whoever draws the grid, so the picture and the count can
   * never disagree — an hour after the last recording is the deployment ending, not a
   * gap, and colouring it red while reporting no gaps is its own kind of wrong.
   */
  isGap: boolean;
  /** After the last recording. The deployment had ended by this point. */
  afterEnd: boolean;
}

export interface CoverageGrid {
  /** Local dates covered, in order. */
  dates: string[];
  /** Indexed `[date][hour]`, always 24 wide. */
  hours: CoverageHour[][];
  totalClips: number;
  totalBytes: number;
  /**
   * Scheduled hours between the first and last recording that hold nothing.
   *
   * Interior only, and deliberately so. A device configured to run until its battery
   * dies carries an end date years away; counting everything after it stopped as a gap
   * turns one fact — recording ended — into tens of thousands of them, and buries the
   * real interruptions in the middle.
   */
  gaps: CoverageHour[];
  /** Longest run of consecutive scheduled-but-empty hours within that span. */
  longestGapHours: number;
  /** True when nothing can be judged because the card carries no configuration. */
  expectationsUnknown: boolean;

  firstRecordingAt: string | null;
  lastRecordingAt: string | null;
  /**
   * Set when recording stopped before the configured end.
   *
   * Reported as the single event it is, and without judgement: setting an end date far
   * in the future so a device runs until its battery gives out is an ordinary way to
   * work, and the reason it stopped is on the card's device info, not inferable here.
   */
  stoppedEarly: { configuredEnd: string; shortBySeconds: number } | null;
  /** Days omitted because the span was implausibly long. Normally zero. */
  omittedDays: number;
}

/**
 * Days the grid will draw before giving up.
 *
 * A year of rows is already more than anyone reads, and each row is 24 cells. Beyond
 * this the span is a symptom of something odd rather than a deployment to inspect.
 */
const MAX_DAYS = 366;

export interface CoverageInput {
  /** Corrected instants and sizes for every audio recording. */
  recordings: Array<{ at: string | null; sizeBytes: number }>;
  /** The configuration found on the card, if any. */
  config: DeploymentConfig | null;
  /** IANA zone the schedule is expressed in. */
  timezone: string;
}

export function buildCoverage(input: CoverageInput): CoverageGrid {
  const { recordings, config, timezone } = input;
  const dated = recordings.filter((recording) => recording.at);

  const empty: CoverageGrid = {
    dates: [],
    hours: [],
    totalClips: 0,
    totalBytes: 0,
    gaps: [],
    longestGapHours: 0,
    expectationsUnknown: !config,
    firstRecordingAt: null,
    lastRecordingAt: null,
    stoppedEarly: null,
    omittedDays: 0,
  };
  if (dated.length === 0) return empty;

  // Bucketed by LOCAL hour, because the schedule is expressed in local time. A grid in
  // UTC would smear a dawn window across two rows for anyone not on UTC.
  const buckets = new Map<string, { clips: number; bytes: number }>();
  let earliest = Infinity;
  let latest = -Infinity;

  for (const recording of dated) {
    const instant = Date.parse(recording.at!);
    if (!Number.isFinite(instant)) continue;
    earliest = Math.min(earliest, instant);
    latest = Math.max(latest, instant);

    const key = localHourKey(recording.at!, timezone);
    const bucket = buckets.get(key) ?? { clips: 0, bytes: 0 };
    bucket.clips++;
    bucket.bytes += recording.sizeBytes;
    buckets.set(key, bucket);
  }
  if (!Number.isFinite(earliest)) return empty;

  // The grid spans what was recorded, extended back to a configured start so a late
  // beginning still shows. It deliberately does NOT run to a configured end: that date
  // is often years out by design, and drawing to it fills the screen with rows that only
  // restate "it stopped".
  const from = config?.startTime ? Math.min(earliest, Date.parse(config.startTime)) : earliest;
  const to = latest;

  const configuredEnd = config?.endTime ? Date.parse(config.endTime) : null;
  const stoppedEarly =
    configuredEnd && latest < configuredEnd - 3_600_000
      ? { configuredEnd: config!.endTime, shortBySeconds: Math.round((configuredEnd - latest) / 1000) }
      : null;

  const dates: string[] = [];
  const hours: CoverageHour[][] = [];
  const gaps: CoverageHour[] = [];
  let totalClips = 0;
  let totalBytes = 0;
  let longestGapHours = 0;
  let runningGap = 0;

  let omittedDays = 0;
  for (let day = startOfLocalDay(from, timezone); day <= to; day += 86_400_000) {
    const date = localDate(new Date(day).toISOString(), timezone);
    if (dates.includes(date)) continue;
    if (dates.length >= MAX_DAYS) {
      omittedDays++;
      continue;
    }
    dates.push(date);

    const row: CoverageHour[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const startsAt = localHourInstant(date, hour, timezone);
      const bucket = buckets.get(`${date}T${String(hour).padStart(2, '0')}`);
      const expectation = expectationFor(startsAt, config, timezone);

      const clips = bucket?.clips ?? 0;
      const afterEnd = Date.parse(startsAt) > latest;
      const cell: CoverageHour = {
        date,
        hour,
        startsAt,
        clips,
        bytes: bucket?.bytes ?? 0,
        expectation,
        isGap: expectation === 'scheduled' && clips === 0 && !afterEnd,
        afterEnd,
      };
      row.push(cell);
      totalClips += cell.clips;
      totalBytes += cell.bytes;

      if (cell.isGap) {
        gaps.push(cell);
        runningGap++;
        longestGapHours = Math.max(longestGapHours, runningGap);
      } else {
        runningGap = 0;
      }
    }
    hours.push(row);
  }

  return {
    dates,
    hours,
    totalClips,
    totalBytes,
    gaps,
    longestGapHours,
    expectationsUnknown: !config,
    firstRecordingAt: new Date(earliest).toISOString(),
    lastRecordingAt: new Date(latest).toISOString(),
    stoppedEarly,
    omittedDays,
  };
}

/**
 * Whether recordings should exist in the hour beginning at this instant.
 *
 * Amplitude-triggered recording is deliberately reported as unpredictable rather than
 * guessed at. Whether a clip exists depends on what the microphone heard, so calling a
 * quiet hour a gap would raise an alarm about a device behaving exactly as configured.
 */
export function expectationFor(
  startsAt: string,
  config: DeploymentConfig | null,
  timezone: string,
): Expectation {
  if (!config) return 'unknown';

  const instant = Date.parse(startsAt);
  if (instant < Date.parse(config.startTime) || instant >= Date.parse(config.endTime)) return 'unknown';

  const phase = phaseAt(config, instant);
  if (!phase) return 'unknown';

  switch (phase.audioRecordingMode) {
    case 'CONTINUOUS':
    case 'INTERVAL':
      return 'scheduled';
    case 'AMPLITUDE':
      return 'unpredictable';
    case 'SCHEDULED': {
      if (phase.audioTriggerTimes.length === 0) return 'idle';
      // Windows are seconds past LOCAL midnight, so the comparison has to be too.
      const hourStart = secondsPastLocalMidnight(timezone, startsAt);
      const hourEnd = hourStart + 3600;
      return phase.audioTriggerTimes.some(
        (window) => window.startSecond < hourEnd && window.endSecond > hourStart,
      )
        ? 'scheduled'
        : 'idle';
    }
    default:
      return 'unknown';
  }
}

function phaseAt(config: DeploymentConfig, instant: number): PhaseConfig | null {
  if (!config.isPhased) return config.phases[0] ?? null;
  for (const phase of config.phases) {
    const start = phase.startTime ? Date.parse(phase.startTime) : Date.parse(config.startTime);
    const end = phase.endTime ? Date.parse(phase.endTime) : Date.parse(config.endTime);
    if (instant >= start && instant < end) return phase;
  }
  return null;
}

// ---------------------------------------------------------------------------

const PARTS_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = PARTS_CACHE.get(timezone);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  PARTS_CACHE.set(timezone, made);
  return made;
}

/** `YYYY-MM-DD` in the given zone. */
export function localDate(isoInstant: string, timezone: string): string {
  const parts = formatter(timezone).formatToParts(new Date(isoInstant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function localHourKey(isoInstant: string, timezone: string): string {
  const parts = formatter(timezone).formatToParts(new Date(isoInstant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  // Intl renders midnight as "24" in some environments; both mean hour zero.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}`;
}

function localHourInstant(date: string, hour: number, timezone: string): string {
  // Guessed from UTC then corrected by the zone's offset at that moment, which keeps
  // this right across a daylight-saving change rather than only on one side of it.
  const guess = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  const offset = utcOffsetSecondsAt(timezone, new Date(guess).toISOString());
  return new Date(guess - offset * 1000).toISOString();
}

function startOfLocalDay(instant: number, timezone: string): number {
  return Date.parse(localHourInstant(localDate(new Date(instant).toISOString(), timezone), 0, timezone));
}
