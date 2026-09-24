import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads the generated JSON snapshots of the two external sources of truth.
 *
 * `reference/firmware-snapshot.json`  <- tools/extract_firmware_constants.py
 * `reference/planner-snapshot.json`   <- tools/extract_power_measurements.py
 *
 * Test-time only — nothing in the shipped browser bundle reads these. They exist so
 * a firmware change or a spreadsheet revision surfaces as a failing test naming the
 * constant that moved, rather than as silent drift.
 */

export interface FirmwareSnapshot {
  /**
   * What the extractor SET OUT to pull, beside what it produced.
   *
   * The two agree unless the request list itself was narrowed, which is the one way a
   * quietly smaller snapshot can pass `sync:check` — the check re-runs the extractor and
   * diffs, so both sides move together. See the floors in snapshot-sync.test.ts.
   */
  _requested: { numericDefines: string[]; stringDefines: string[]; enums: string[] };
  /** Firmware files the extractor read, so a moved file shows up as a shrinking list. */
  _sourceFiles: string[];
  /**
   * Every function the firmware defines.
   *
   * Not used by any runtime code — it exists so prose and comments that name a firmware
   * function can be checked against the firmware. A sentence describing device behavior
   * goes stale silently: no constant moves, no grammar changes, and the claim simply
   * stops being true while still reading as authoritative.
   */
  firmwareFunctions: string[];
  /**
   * Functions in the Python dashboard this package replaces.
   *
   * Comments cite it as the authority for rules carried over ("every rule the desktop
   * `validate_details()` enforced"), and those citations go stale exactly as firmware
   * ones do — more easily, since nobody is looking at that tool any more.
   */
  desktopFunctions: string[];
  numericDefines: Record<string, number>;
  stringDefines: Record<string, string>;
  enums: Record<string, string[]>;
  configKeyOrder: string[];
  maxFrequencyHeadroomHz: number;
  triggerDigipotSteps: number;
  logEvents: Record<string, string[]>;
  /**
   * Reset reason strings, and which of them the firmware itself calls a failure.
   *
   * Extracted from two C switch statements rather than an enum, because that is where
   * they live — and because nothing else in the snapshot would notice one being added.
   */
  resetReasons: { all: string[]; faults: string[] };
}

export interface PlannerGoldenWav {
  sampleRateHz: number;
  processingMsPerInterval: number;
  averageCurrentMa: number;
  storageDays: number;
  batteryDays: number;
}

export interface PlannerGoldenOpus {
  sampleRateHz: number;
  bitrateKbps: number;
  encodeMsPerInterval: number;
  averageCurrentMa: number;
  storageDays: number;
  batteryDays: number;
}

export interface PlannerSnapshot {
  calculations: Record<string, number>;
  magnet: Record<string, number>;
  plannerInputs: {
    microphone: string;
    storedClipLengthSeconds: number;
    imuSampleRateHz: number;
    sdCardCapacityGb: number;
    batteryCapacityMah: number;
    sdSpeedClass: string;
  };
  microphoneCurrentMa: Array<[string, number]>;
  imuCurrentMa: Array<[number, number]>;
  sdSpeedClassMbPerS: Array<[string, number]>;
  goldenWav: PlannerGoldenWav[];
  goldenOpus: PlannerGoldenOpus[];
}

/** Walks up from this module to the `Web/` directory that holds `reference/`. */
function referenceDir(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    // `Web/packages/config-schema/{src,dist}` -> up three is `Web`
    const candidate = resolve(current, 'reference');
    try {
      readFileSync(join(candidate, 'firmware-snapshot.json'));
      return candidate;
    } catch {
      current = resolve(current, '..');
    }
  }
  throw new Error(
    'Could not locate Web/reference/. Generate the snapshots first:\n' +
      '  python3 tools/extract_firmware_constants.py\n' +
      '  python3 tools/extract_power_measurements.py',
  );
}

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(referenceDir(), name), 'utf8')) as T;
}

export const loadFirmwareSnapshot = (): FirmwareSnapshot =>
  load<FirmwareSnapshot>('firmware-snapshot.json');

export const loadPlannerSnapshot = (): PlannerSnapshot =>
  load<PlannerSnapshot>('planner-snapshot.json');
