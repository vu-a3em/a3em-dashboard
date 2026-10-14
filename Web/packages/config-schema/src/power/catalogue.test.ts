import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadFirmwareSnapshot, loadReference, readWebFile } from '../snapshots.js';
import {
  type BatteryProfile,
  type PowerCatalogue,
  type PowerComponents,
  validateBatteryProfile,
  validateCatalogue,
} from './catalogue.js';

const snapshot = loadFirmwareSnapshot();
const catalogue = loadReference<PowerCatalogue>('power/measurements.json');
const components = loadReference<PowerComponents>('power/components.json');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('power measurement catalogue', () => {
  it('describes exactly the steps the characterization firmware runs', () => {
    assert.deepEqual(validateCatalogue(catalogue, components, snapshot.powerSteps), []);
  });

  it('notices a step renumbered in the firmware', () => {
    // The code is what the marker frame carries; a silent renumbering would file every later
    // capture of that step under the wrong quantity.
    const steps = copy(snapshot.powerSteps);
    steps.find((s) => s.name === 'SLEEP_FLOOR')!.code = 0x7f;
    assert.ok(validateCatalogue(catalogue, components, steps).some((p) => p.includes('SLEEP_FLOOR is 0x7F')));
  });

  it('notices an event rebased onto a different state', () => {
    const steps = copy(snapshot.powerSteps);
    const floor = steps.find((s) => s.name === 'SLEEP_FLOOR')!;
    steps.find((s) => s.name === 'EVT_WAKE')!.baseline = floor.code;
    assert.ok(validateCatalogue(catalogue, components, steps).some((p) => p.includes('EVT_WAKE is charged against SLEEP_FLOOR')));
  });

  it('refuses a card-dependent measurement that does not say which card', () => {
    const edited = copy(catalogue);
    edited.quantities.find((q) => q.id === 'SD_IDLE')!.measurements.push({
      id: 'abc', value: 120, temperature: 'room', dieTemperatureC: 22, components: {}, supplyMv: 3600,
      mode: 'source', firmware: null, label: null, run: 1, capturedAt: null, raw: {},
      capture: { file: 'x.windows.json', sha256: 'a'.repeat(64) }, results: null,
    });
    assert.ok(validateCatalogue(edited, components, snapshot.powerSteps).some((p) => p.includes('does not say which card')));
  });

  it('refuses an event value with no record of the baseline it came from', () => {
    const edited = copy(catalogue);
    edited.quantities.find((q) => q.id === 'EVT_WAKE')!.measurements.push({
      id: 'def', value: 0.8, temperature: 'room', dieTemperatureC: 22, components: {}, supplyMv: 3600,
      mode: 'source', firmware: null, label: null, run: 1, capturedAt: null, raw: {},
      capture: { file: 'x.windows.json', sha256: 'b'.repeat(64) }, results: null,
    });
    assert.ok(validateCatalogue(edited, components, snapshot.powerSteps).some((p) => p.includes('does not record which SLEEP_TIMER_XT')));
  });

  it('keeps every step code clear of the marker codes the deployment firmware sends', () => {
    const marks = new Set(Object.values(snapshot.powerMarks));
    for (const step of snapshot.powerSteps) assert.ok(!marks.has(step.code), `${step.name} collides with a point marker`);
  });

  it('decodes every point marker the firmware can send', () => {
    // The capture tool keeps its own table of point codes. One the firmware sends but the tool
    // does not know would be decoded as a step code and open a window that never closes.
    const tool = readWebFile('tools/power/ppk2_capture.py');
    const table = /POINT_CODES = \{([^}]*)\}/.exec(tool)?.[1] ?? '';
    const known = new Map([...table.matchAll(/0x([0-9A-Fa-f]{2}): "(\w+)"/g)].map((m) => [parseInt(m[1], 16), m[2]]));
    for (const [name, code] of Object.entries(snapshot.powerMarks)) {
      assert.equal(known.get(code), name, `ppk2_capture.py does not decode ${name} (0x${code.toString(16)})`);
    }
  });

  it('has a profile on file for every battery it lists', () => {
    for (const battery of components.batteries) {
      const profile = loadReference<BatteryProfile>(`power/${battery.profile}`);
      assert.equal(profile.id, battery.id);
      assert.deepEqual(validateBatteryProfile(profile), [], battery.id);
    }
  });

  it('holds a battery profile to its own datasheet arithmetic', () => {
    const profile = copy(loadReference<BatteryProfile>('power/batteries/tadiran-tl-2100.json'));
    profile.dischargeAt25C.points[0].currentMa = 160;
    assert.ok(validateBatteryProfile(profile).some((p) => p.includes('200 ohm discharge says 160 mA')));
  });
});
