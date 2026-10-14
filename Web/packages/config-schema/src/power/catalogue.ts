/**
 * The power measurement catalogue: `reference/power/measurements.json`, its parts list, and the
 * battery profiles beside it.
 *
 * The catalogue is the source of truth for every measured quantity the forecaster uses. Each
 * quantity is one step of the power characterization firmware, keyed by that step's name and the
 * code its marker frame carries, and each measurement of it keeps the raw window statistics it was
 * derived from, the conditions it was taken under, and hashes of the capture and results files.
 *
 * Everything here is structural: the types, and a validator that holds the catalogue to the
 * firmware's step table and to itself. Measurements are only ever added by
 * `tools/power/power_ingest.py`.
 */

import type { PowerStep } from '../snapshots.js';

export type QuantityKind = 'state' | 'event' | 'cycle' | 'limit';
export type QuantityUnit = 'uA' | 'uC' | 'mV';
export type Part = 'card' | 'microphone' | 'battery';

/** The unit each kind of quantity is measured in: mean current, charge per event, or a supply voltage. */
export const UNIT_FOR_KIND: Record<QuantityKind, QuantityUnit> = {
  state: 'uA',
  event: 'uC',
  cycle: 'uC',
  limit: 'mV',
};

/** Marker codes the steps may not use: 0x00 ends a suite, and everything from 0xE0 up marks a point in time. */
export const RESERVED_MARKER_CODES = { suiteDone: 0x00, firstPointCode: 0xe0 } as const;

export interface PowerPrior {
  value: number;
  unit: QuantityUnit;
  /** Whether the prior is the whole board's draw or only this quantity's increment over the floor. */
  basis: 'absolute' | 'increment';
  source: string;
  note?: string;
}

export interface PowerMeasurement {
  id: string;
  /** Null until it can be derived, with `pending` saying what it is waiting for. */
  value: number | null;
  pending?: string;
  temperature: string;
  dieTemperatureC: number | null;
  components: Partial<Record<Part, string>>;
  supplyMv: number | null;
  mode: 'source' | 'ampere' | null;
  firmware: string | null;
  label: string | null;
  run: number;
  capturedAt: string | null;
  /** The window statistics and firmware counters the value was derived from. */
  raw: Record<string, unknown>;
  /** The baseline measurements an event value was derived against, by quantity id. */
  baselines?: Record<string, string>;
  capture: { file: string; sha256: string };
  results: { file: string; sha256: string } | null;
}

export interface PowerQuantity {
  id: string;
  /** The step's marker code, as two hex digits such as `0x1A`. */
  code: string;
  suite: string;
  kind: QuantityKind;
  unit: QuantityUnit;
  /** For an event or cycle, the state it is charged against. */
  baseline: string | null;
  /** For a cycle, the state it is charged against while off. */
  offBaseline?: string;
  /** For an event or cycle, what one event is. */
  event?: string;
  /** Parts whose model changes the value, so each measurement has to say which was fitted. */
  dependsOn: Part[];
  description: string;
  forecastRole: string;
  /** What the spreadsheet assumed, kept for comparison until measurements replace it. */
  prior: PowerPrior | null;
  measurements: PowerMeasurement[];
}

export interface PowerCatalogue {
  schemaVersion: 1;
  units: Record<QuantityUnit, string>;
  conditions: { temperatures: Record<string, string>; supply: string };
  quantities: PowerQuantity[];
}

export interface PowerComponents {
  cards: Array<{ id: string; name: string; notes?: string }>;
  microphones: Array<{ id: string; type: 'digital' | 'analog'; spreadsheetKey?: string; notes?: string }>;
  batteries: Array<{ id: string; profile: string }>;
}

/** A curve as `[x, y]` points, such as `[currentMa, capacityAh]`, at one temperature. */
export interface TemperatureSeries {
  temperatureC: number;
  points: Array<[number, number]>;
}

export interface BatteryProfile {
  id: string;
  name: string;
  chemistry: string;
  size: string;
  source: { document: string; url: string | null; sha256: string; retrieved: string };
  ratings: {
    nominalVoltageV: number;
    nominalCapacityAh: number;
    nominalCapacityConditions: string;
    maxContinuousCurrentMa: number;
    maxPulseCurrentMa: number;
    operatingTemperatureC: [number, number];
    massG: number;
    volumeCc: number;
    lithiumContentG: number | null;
  };
  dischargeAt25C: {
    cutoffV: number;
    note: string;
    points: Array<{ loadOhm: number; currentMa: number; capacityAh: number; plateauV: number }>;
  };
  capacityVsCurrent: { digitized: boolean; uncertaintyAh: number; note: string; series: TemperatureSeries[] };
  loadedVoltageVsTemperature: { digitized: boolean; uncertaintyV: number; note: string; series: TemperatureSeries[] };
  voltageDelay: { note: string; points: Array<Record<string, number | string>> } | null;
  storage: { maxTemperatureC: number; maxRelativeHumidityPercent: number } | null;
  openQuestions: string[];
}

const hex = (code: number) => `0x${code.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * Everything wrong with the catalogue, as sentences. Empty when it agrees with the firmware's
 * step table, with its parts list, and with itself.
 */
export function validateCatalogue(catalogue: PowerCatalogue, components: PowerComponents, steps: PowerStep[]): string[] {
  const problems: string[] = [];
  const quantities = new Map(catalogue.quantities.map((q) => [q.id, q]));
  const stepByCode = new Map(steps.map((s) => [s.code, s]));
  const partIds: Record<Part, Set<string>> = {
    card: new Set(components.cards.map((c) => c.id)),
    microphone: new Set(components.microphones.map((m) => m.id)),
    battery: new Set(components.batteries.map((b) => b.id)),
  };
  const temperatures = new Set(Object.keys(catalogue.conditions.temperatures));

  if (quantities.size !== catalogue.quantities.length) problems.push('Two quantities share an id.');

  // The firmware's step table and the catalogue describe the same steps
  for (const step of steps) {
    const quantity = quantities.get(step.name);
    if (!quantity) {
      problems.push(`Step ${step.name} (${hex(step.code)}) has no quantity in the catalogue.`);
      continue;
    }
    if (quantity.code !== hex(step.code)) problems.push(`${step.name} is ${hex(step.code)} in the firmware but ${quantity.code} in the catalogue.`);
    if (quantity.suite !== step.suite) problems.push(`${step.name} is in suite ${step.suite} in the firmware but ${quantity.suite} in the catalogue.`);
    if (quantity.kind !== step.kind) problems.push(`${step.name} is a ${step.kind} in the firmware but a ${quantity.kind} in the catalogue.`);
    const baselineName = step.baseline === null ? null : stepByCode.get(step.baseline)?.name ?? `unknown ${hex(step.baseline)}`;
    if (quantity.baseline !== baselineName) problems.push(`${step.name} is charged against ${baselineName} in the firmware but ${quantity.baseline} in the catalogue.`);
    if (step.code === RESERVED_MARKER_CODES.suiteDone || step.code >= RESERVED_MARKER_CODES.firstPointCode) {
      problems.push(`${step.name} uses ${hex(step.code)}, which is reserved for a marker point.`);
    }
  }
  for (const quantity of catalogue.quantities) {
    if (!steps.some((s) => s.name === quantity.id)) problems.push(`Quantity ${quantity.id} has no step in the firmware.`);
  }

  for (const quantity of catalogue.quantities) {
    const where = quantity.id;
    if (quantity.unit !== UNIT_FOR_KIND[quantity.kind]) problems.push(`${where} is a ${quantity.kind} but is in ${quantity.unit}.`);
    const needsBaseline = quantity.kind === 'event' || quantity.kind === 'cycle';
    for (const [field, name] of [['baseline', quantity.baseline], ['offBaseline', quantity.offBaseline]] as const) {
      if (!name) continue;
      const target = quantities.get(name);
      if (!target) problems.push(`${where}'s ${field} ${name} is not a quantity.`);
      else if (target.kind !== 'state') problems.push(`${where}'s ${field} ${name} is not a state.`);
    }
    if (needsBaseline && !quantity.baseline) problems.push(`${where} is a ${quantity.kind} with no baseline.`);
    if (!needsBaseline && quantity.baseline) problems.push(`${where} is a ${quantity.kind} but names a baseline.`);
    if (quantity.kind === 'cycle' && !quantity.offBaseline) problems.push(`${where} is a cycle with no off baseline.`);
    if (needsBaseline && !quantity.event) problems.push(`${where} does not say what one event is.`);
    for (const part of quantity.dependsOn) {
      if (!(part in partIds)) problems.push(`${where} depends on an unknown part kind "${part}".`);
    }
    if (quantity.prior && quantity.prior.unit !== quantity.unit) {
      problems.push(`${where}'s prior is in ${quantity.prior.unit}, not ${quantity.unit}.`);
    }

    const ids = new Set<string>();
    for (const measurement of quantity.measurements) {
      const label = `${where} measurement ${measurement.id}`;
      if (ids.has(measurement.id)) problems.push(`${label} appears twice.`);
      ids.add(measurement.id);
      if (!temperatures.has(measurement.temperature)) problems.push(`${label} is at an unknown temperature "${measurement.temperature}".`);
      for (const part of quantity.dependsOn) {
        const id = measurement.components[part];
        if (!id) problems.push(`${label} does not say which ${part} it was taken with.`);
        else if (!partIds[part]?.has(id)) problems.push(`${label} names ${part} "${id}", which is not in components.json.`);
      }
      if (measurement.value === null && !measurement.pending) problems.push(`${label} has no value and does not say why.`);
      if (measurement.value !== null && !Number.isFinite(measurement.value)) problems.push(`${label} has a value that is not a number.`);
      if (needsBaseline && measurement.value !== null) {
        for (const name of [quantity.baseline, quantity.offBaseline].filter((n): n is string => !!n)) {
          const used = measurement.baselines?.[name];
          if (!used) problems.push(`${label} does not record which ${name} measurement it was derived against.`);
          else if (!quantities.get(name)?.measurements.some((m) => m.id === used)) {
            problems.push(`${label} was derived against ${name} measurement ${used}, which is not in the catalogue.`);
          }
        }
      }
      if (!/^[0-9a-f]{64}$/.test(measurement.capture.sha256)) problems.push(`${label} has no capture hash.`);
    }
  }
  return problems;
}

/** Everything implausible in a battery profile, as sentences. */
export function validateBatteryProfile(profile: BatteryProfile): string[] {
  const problems: string[] = [];
  const nominal = profile.ratings.nominalCapacityAh;
  const checkSeries = (name: string, series: TemperatureSeries[], low: number, high: number) => {
    for (const curve of series) {
      const xs = curve.points.map(([x]) => x);
      if (xs.some((x, i) => i > 0 && x <= xs[i - 1])) problems.push(`${name} at ${curve.temperatureC} C is not in increasing current order.`);
      for (const [x, y] of curve.points) {
        if (!(x > 0)) problems.push(`${name} at ${curve.temperatureC} C has a non-positive current ${x}.`);
        if (y < low || y > high) problems.push(`${name} at ${curve.temperatureC} C has ${y}, outside ${low}-${high}.`);
      }
    }
  };
  checkSeries('Capacity', profile.capacityVsCurrent.series, 0, nominal * 1.2);
  checkSeries('Loaded voltage', profile.loadedVoltageVsTemperature.series, 2.0, 4.0);
  for (const point of profile.dischargeAt25C.points) {
    if (point.capacityAh > nominal * 1.2) problems.push(`The ${point.loadOhm} ohm discharge gives more than the nominal capacity.`);
    // Ohm's law holds the printed current and load together, to the precision the datasheet prints
    const implied = (point.plateauV / point.loadOhm) * 1000;
    if (Math.abs(implied - point.currentMa) / point.currentMa > 0.35) {
      problems.push(`The ${point.loadOhm} ohm discharge says ${point.currentMa} mA, but ${point.plateauV} V across it is ${implied.toFixed(3)} mA.`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(profile.source.sha256)) problems.push('The datasheet has no hash.');
  return problems;
}
