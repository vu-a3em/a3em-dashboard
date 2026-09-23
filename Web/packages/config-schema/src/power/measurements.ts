/**
 * Power and storage measurements, transcribed from "A3EM Deployment Planner.xlsx".
 *
 * ============================================================================
 * THIS IS THE ONLY FILE TO EDIT WHEN NEW BENCH MEASUREMENTS ARRIVE.
 * `forecast.ts` holds the arithmetic and reads everything from here.
 * ============================================================================
 *
 * Each entry records the spreadsheet cell it came from and a `confidence`:
 *
 *   'measured'    — taken on real hardware; trust it
 *   'estimated'   — placeholder the spreadsheet flags "<- Measure"
 *   'datasheet'   — from a component datasheet, not this board
 *   'extrapolated'— not in the spreadsheet at all; derived to extend the model
 *
 * The forecast UI surfaces the WEAKEST confidence feeding any number it shows, so
 * an estimate is never presented as though it were measured.
 */

export type Confidence = 'measured' | 'estimated' | 'datasheet' | 'extrapolated';

export interface Measurement {
  value: number;
  units: string;
  confidence: Confidence;
  /** Spreadsheet cell, or a note on where an extrapolation came from. */
  source: string;
}

const m = (value: number, units: string, confidence: Confidence, source: string): Measurement => ({
  value,
  units,
  confidence,
  source,
});

export const MEASUREMENTS_REVISION = '2026-02-12 (A3EM Deployment Planner.xlsx)';

// ---------------------------------------------------------------------------
// Buffer geometry — mirrors static_config.h, reproduced here so the model is
// self-contained and diffable against the spreadsheet.
// ---------------------------------------------------------------------------

export const BUFFERS = {
  audioDmaSamples: m(96000, 'samples', 'measured', 'Calculations!E18'),
  sdAudioCacheBytes: m(65536, 'bytes', 'measured', 'Calculations!E19'),
  sdImuCacheSamples: m(1300, 'samples', 'measured', 'Calculations!E20'),
  imuFifoSamples: m(127, 'samples', 'measured', 'Calculations!E21'),
} as const;

// ---------------------------------------------------------------------------
// Currents and durations
// ---------------------------------------------------------------------------

export const SD_CARD = {
  writeCurrentMa: m(75, 'mA', 'measured', 'Calculations!E23 — varies by card'),
  activationCurrentMa: m(35, 'mA', 'measured', 'Calculations!E24 — varies by card'),
  sleepCurrentMa: m(0.6, 'mA', 'measured', 'Calculations!E25 — varies by card'),
  activationDurationMs: m(25, 'ms', 'measured', 'Calculations!E26 — varies by card'),
  fatMaintenanceMs: m(5, 'ms', 'measured', 'Calculations!E31'),
} as const;

export const MCU = {
  /** Flagged "<- Measure" in the spreadsheet. Dominates long idle deployments. */
  idleCurrentMa: m(0.52, 'mA', 'estimated', 'Calculations!E27 — marked "<- Measure"'),
  /** Flagged "<- Measure". Dominates Opus deployments, which are encode-bound. */
  activeCurrentMa: m(2.82, 'mA', 'estimated', 'Calculations!E28 — marked "<- Measure"'),
} as const;

export const MAGNET = {
  measurementDurationMs: m(0.011, 'ms', 'measured', 'MagPower!E2'),
  measurementCurrentMa: m(3.5, 'mA', 'measured', 'MagPower!E3 @ 1.8 V'),
  idleCurrentMa: m(0.6, 'mA', 'measured', 'MagPower!E4 @ 1.8 V'),
  sleepCurrentMa: m(0.00005, 'mA', 'measured', 'MagPower!E5 @ 1.8 V'),
  activeWindowMs: m(0.015, 'ms', 'measured', 'Calculations!E29'),
  sleepWindowMs: m(90, 'ms', 'measured', 'Calculations!E30'),
} as const;

/** Steady-state listening current by microphone part number. MicPower!B3:C10. */
export const MICROPHONE_CURRENT_MA: Record<string, Measurement> = {
  Analog: m(0.3, 'mA', 'estimated', 'MicPower!C3 — marked "Measure"'),
  CMM4030DT: m(0.54, 'mA', 'estimated', 'MicPower!C4 — marked "Measure"'),
  'DMM3526-4-B': m(0.95, 'mA', 'estimated', 'MicPower!C5 — marked "Measure"'),
  IM72D128V: m(1.12, 'mA', 'estimated', 'MicPower!C6 — marked "Measure"'),
  MMICT5838: m(0.34, 'mA', 'estimated', 'MicPower!C7 — marked "Measure"'),
  MP34DT05: m(0.65, 'mA', 'estimated', 'MicPower!C8 — marked "Measure"'),
  SPH18R1LM4H: m(0.48, 'mA', 'estimated', 'MicPower!C9 — marked "Measure"'),
  SPH0141L: m(0.7, 'mA', 'estimated', 'MicPower!C10 — marked "Measure"'),
};

export const DEFAULT_MICROPHONE = 'SPH18R1LM4H'; // Planner!D18

/** Steady-state current by IMU sample rate. ImuPower!B3:C12. Flat above 6 Hz. */
export const IMU_CURRENT_MA: Record<number, Measurement> = {
  0: m(0, 'mA', 'measured', 'ImuPower!C3'),
  3: m(0.00047, 'mA', 'datasheet', 'ImuPower!C4'),
  6: m(0.0061, 'mA', 'datasheet', 'ImuPower!C5'),
  12: m(0.0061, 'mA', 'datasheet', 'ImuPower!C6'),
  25: m(0.0061, 'mA', 'datasheet', 'ImuPower!C7'),
  50: m(0.0061, 'mA', 'datasheet', 'ImuPower!C8'),
  100: m(0.0061, 'mA', 'datasheet', 'ImuPower!C9'),
  200: m(0.0061, 'mA', 'datasheet', 'ImuPower!C10'),
  400: m(0.0061, 'mA', 'datasheet', 'ImuPower!C11'),
  800: m(0.0061, 'mA', 'datasheet', 'ImuPower!C12'),
};

/** Sustained sequential write throughput by SD speed class. SdSpeeds!B3:C12. */
export const SD_SPEED_CLASS_MB_PER_S: Record<string, number> = {
  C2: 2,
  C4: 4,
  C6: 6,
  U1: 10,
  U3: 30,
  V6: 6,
  V10: 10,
  V30: 30,
  V60: 60,
  V90: 90,
};

export const DEFAULT_SD_SPEED_CLASS = 'U1'; // Planner!D23

/** SDIO bus ceiling; Calculations!E22 caps effective throughput here. */
export const SD_BUS_CEILING_MB_PER_S = 24;

// ---------------------------------------------------------------------------
// Opus encode cost. Planner!I12:I16 — measured per audio processing interval,
// which is 2 s at 48 kHz. Interpolated linearly between listed bitrates.
// ---------------------------------------------------------------------------

export const OPUS_ENCODE_MS_BY_BITRATE: Array<{ bitrate: number; encodeMs: number }> = [
  { bitrate: 16000, encodeMs: 521 },
  { bitrate: 32000, encodeMs: 684 },
  { bitrate: 64000, encodeMs: 813 },
  { bitrate: 96000, encodeMs: 876 },
  { bitrate: 128000, encodeMs: 895 },
];

/** WAV path does no encoding; Planner!I4:I8 is a flat 25 ms of framing work. */
export const WAV_PROCESSING_MS_PER_INTERVAL = m(25, 'ms', 'measured', 'Planner!I4:I8');

// ---------------------------------------------------------------------------
// EXTRAPOLATED — not present in the spreadsheet.
//
// The spreadsheet models continuous recording only: every row assumes the device
// records 100% of the time. Scheduled, interval, and threshold deployments spend
// most of their life in a low-power armed state, and nothing below was measured.
// These are the highest-priority values to replace with real numbers.
// ---------------------------------------------------------------------------

export const IDLE_STATE = {
  /** Armed but not recording: MCU asleep, SD asleep, comparator or timer live. */
  mcuCurrentMa: m(0.52, 'mA', 'extrapolated', 'assumed equal to MCU idle, Calculations!E27'),
  sdCurrentMa: m(0.6, 'mA', 'extrapolated', 'assumed SD sleep, Calculations!E25'),
  /**
   * Analog amplitude triggering keeps the comparator biased continuously.
   * No measurement exists for this path.
   */
  comparatorCurrentMa: m(0.05, 'mA', 'extrapolated', 'placeholder — not measured'),
} as const;

export const LED = {
  /** Average during the LEDS_ACTIVE_SECONDS window; blink duty already folded in. */
  averageCurrentMa: m(1.5, 'mA', 'extrapolated', 'placeholder — not measured'),
} as const;

export const VHF = {
  /**
   * Zero: the beacon carries its own battery, so it draws nothing from the A3EM pack. Kept
   * as a measurement rather than deleted so the forecast still has the one place to change
   * should a beacon ever be powered from the unit.
   */
  activeCurrentMa: m(0, 'mA', 'datasheet', 'the VHF beacon has its own battery'),
} as const;

// ---------------------------------------------------------------------------
// Deployment defaults, Planner!D19:D23
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  batteryCapacityMah: 7000, // Planner!D22
  sdCardCapacityGb: 128, // Planner!D21
  storedClipLengthSeconds: 60, // Planner!D19
  imuSampleRateHz: 50, // Planner!D20
} as const;

/** Lowest confidence among the given measurements — drives the UI's caveat. */
export function weakestConfidence(...items: Measurement[]): Confidence {
  const rank: Record<Confidence, number> = {
    extrapolated: 0,
    estimated: 1,
    datasheet: 2,
    measured: 3,
  };
  return items.reduce<Confidence>(
    (weakest, item) => (rank[item.confidence] < rank[weakest] ? item.confidence : weakest),
    'measured',
  );
}
