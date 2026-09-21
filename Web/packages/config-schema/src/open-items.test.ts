import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPEN_ITEMS, registeredMeasurementKeys, unresolvedItems } from './open-items.js';
import {
  IDLE_STATE,
  LED,
  MCU,
  MICROPHONE_CURRENT_MA,
  SD_CARD,
  VHF,
  type Measurement,
} from './power/measurements.js';

/**
 * The enforcement half of the open-items registry: a placeholder cannot be added to
 * the power model without being registered, so nothing quietly becomes load-bearing.
 */

/** Every measurement in the model, flattened to `GROUP.key` paths. */
function allMeasurements(): Array<[string, Measurement]> {
  const groups: Record<string, Record<string, Measurement>> = {
    MCU,
    SD_CARD,
    IDLE_STATE,
    LED,
    VHF,
    MICROPHONE_CURRENT_MA,
  };
  const out: Array<[string, Measurement]> = [];
  for (const [groupName, group] of Object.entries(groups)) {
    for (const [key, measurement] of Object.entries(group)) {
      out.push([`${groupName}.${key}`, measurement]);
    }
  }
  return out;
}

describe('open-items registry', () => {
  it('gives every item a unique id', () => {
    const ids = OPEN_ITEMS.map((item) => item.id);
    assert.deepEqual(ids, [...new Set(ids)], 'duplicate open-item ids');
  });

  it('says what each unresolved item blocks and what it needs', () => {
    for (const item of unresolvedItems()) {
      assert.ok(item.blocks.trim().length > 20, `${item.id} does not say what it blocks`);
      assert.ok(item.needed.trim().length > 20, `${item.id} does not say what is needed`);
      assert.ok(
        item.currentBehavior.trim().length > 20,
        `${item.id} does not say what is assumed in the meantime`,
      );
    }
  });

  it('requires a note on anything marked resolved', () => {
    for (const item of OPEN_ITEMS.filter((i) => i.status === 'resolved')) {
      assert.ok(item.resolvedNote, `${item.id} is resolved but has no resolvedNote`);
    }
  });

  it('registers every unmeasured constant in the power model', () => {
    // The point of the whole file: adding a guess to measurements.ts without an
    // open-item entry fails here.
    const registered = registeredMeasurementKeys();
    const unregistered: string[] = [];

    for (const [path, measurement] of allMeasurements()) {
      if (measurement.confidence === 'measured' || measurement.confidence === 'datasheet') continue;
      const group = path.split('.')[0];
      if (!registered.has(path) && !registered.has(group)) unregistered.push(path);
    }

    assert.deepEqual(
      unregistered,
      [],
      'these values are estimates or extrapolations with no entry in open-items.ts:\n  ' +
        unregistered.join('\n  '),
    );
  });

  it('does not mark an item resolved while its measurements are still guesses', () => {
    const byPath = new Map(allMeasurements());
    for (const item of OPEN_ITEMS.filter((i) => i.status === 'resolved')) {
      for (const key of item.measurementKeys ?? []) {
        const measurement = byPath.get(key);
        if (!measurement) continue;
        assert.ok(
          measurement.confidence === 'measured' || measurement.confidence === 'datasheet',
          `${item.id} is marked resolved but ${key} is still '${measurement.confidence}'`,
        );
      }
    }
  });
});
