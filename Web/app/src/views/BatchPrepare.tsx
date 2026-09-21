import { useState } from 'react';
import { DEVICE_LABEL_MAX_LEN, serializeConfig, validateConfig, type DeploymentConfig } from '@a3em/config-schema';
import { CARD_ACCESS_SUPPORTED, downloadConfig, pickCard, writeConfig } from '../lib/card';
import type { useCard } from '../lib/useCard';

type Card = ReturnType<typeof useCard>;

export interface BatchUnit {
  label: string;
  status: 'pending' | 'writing' | 'written' | 'error';
  cardName: string | null;
  error: string | null;
}

/**
 * Preparing a set of devices from one configuration.
 *
 * A deployment is assembled as a set — six elephant units built in one sitting, by one
 * person — so this is the primary workflow rather than a convenience. The desktop tool
 * required re-entering the whole configuration once per card; here the settings are
 * fixed and only the label changes, so what remains is swapping cards and clicking.
 *
 * Each card is written independently. A failure on one is recorded against that unit
 * and the queue continues, because the alternative is discovering at the end that a
 * batch stopped silently at the second unit.
 */
export function BatchPrepare({
  card,
  config,
  units,
  onUnitsChange,
}: Readonly<{
  card: Card;
  config: DeploymentConfig;
  units: BatchUnit[];
  onUnitsChange: (units: BatchUnit[]) => void;
}>) {
  const [prefix, setPrefix] = useState('');
  const [count, setCount] = useState(6);
  const [busy, setBusy] = useState(false);

  const issues = validateConfig(config, card.targetFirmware);
  // Label problems are per-unit here, so they are not a reason to block the batch.
  const blocking = issues.filter(
    (issue) => issue.severity === 'error' && issue.path !== 'deviceLabel',
  );

  const build = () => {
    const base = prefix.trim() || config.deviceLabel.trim() || 'A3EM';
    onUnitsChange(
      Array.from({ length: count }, (_, index) => ({
        label: `${base}_${String(index + 1).padStart(2, '0')}`.slice(0, DEVICE_LABEL_MAX_LEN),
        status: 'pending' as const,
        cardName: null,
        error: null,
      })),
    );
  };

  const setUnit = (index: number, patch: Partial<BatchUnit>) =>
    onUnitsChange(units.map((unit, i) => (i === index ? { ...unit, ...patch } : unit)));

  const writeUnit = async (index: number) => {
    const unit = units[index];
    setBusy(true);
    setUnit(index, { status: 'writing', error: null });
    try {
      // Each unit gets its own card, so the picker opens per unit rather than reusing
      // whatever is currently connected.
      const root = await pickCard();
      const text = serializeConfig({ ...config, deviceLabel: unit.label });
      await writeConfig(root, text);
      setUnit(index, { status: 'written', cardName: root.name, error: null });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setUnit(index, { status: 'pending' });
      } else {
        setUnit(index, { status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      setBusy(false);
    }
  };

  const downloadUnit = (index: number) => {
    const unit = units[index];
    downloadConfig(serializeConfig({ ...config, deviceLabel: unit.label }), `${unit.label}_a3em.cfg`);
    setUnit(index, { status: 'written', cardName: 'downloaded', error: null });
  };

  const written = units.filter((unit) => unit.status === 'written').length;
  const nextPending = units.findIndex((unit) => unit.status === 'pending' || unit.status === 'error');

  return (
    <>
      {blocking.length ? (
        <div className="banner crit">
          <strong>The configuration is not ready to write</strong>
          Fix {blocking.length} {blocking.length === 1 ? 'problem' : 'problems'} on the Configure tab first.
        </div>
      ) : null}

      <div className="card">
        <h2>Devices in this batch</h2>
        <p className="hint">
          Every unit gets the same settings with its own label. Labels are numbered from the prefix.
        </p>
        <div className="row">
          <div className="field">
            <label htmlFor="prefix">Label prefix</label>
            <input
              id="prefix"
              value={prefix}
              placeholder={config.deviceLabel || 'A3EM'}
              onChange={(event) => setPrefix(event.target.value)}
            />
            <p className="help">Up to {DEVICE_LABEL_MAX_LEN} characters including the number.</p>
          </div>
          <div className="field">
            <label htmlFor="count">How many</label>
            <input
              id="count"
              type="number"
              min={1}
              max={50}
              value={count}
              onChange={(event) => setCount(Math.max(1, Math.min(50, Number(event.target.value))))}
            />
          </div>
          <div className="field">
            {/* An empty label so the button lines up with the inputs beside it. Aligning
                to the bottom of the row instead dropped it below them, because the prefix
                field is taller by its help text. */}
            <label aria-hidden="true">&nbsp;</label>
            <button className="btn" onClick={build}>
              {units.length ? 'Rebuild list' : 'Create batch'}
            </button>
          </div>
        </div>
      </div>

      {units.length ? (
        <div className="card">
          <h2>Preparation — {written} of {units.length} written</h2>
          <p className="hint">
            {CARD_ACCESS_SUPPORTED
              ? 'Insert the card for a unit, then write it. The device selector opens each time, so each configuration writes to its own card.'
              : 'This browser cannot write to a card directly, so each configuration downloads instead.'}
          </p>

          <div className="meter" style={{ marginBottom: 16 }}>
            <i style={{ width: `${(written / units.length) * 100}%`, background: 'var(--ok)' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {units.map((unit, index) => (
              <div
                key={index}
                className="period-row"
                style={{
                  borderLeft: `3px solid ${STATUS_COLOR[unit.status]}`,
                  background: index === nextPending ? 'var(--surface-2)' : 'var(--surface)',
                }}
              >
                <input
                  value={unit.label}
                  maxLength={DEVICE_LABEL_MAX_LEN}
                  aria-label={`Label for unit ${index + 1}`}
                  style={{ width: '13rem' }}
                  onChange={(event) => setUnit(index, { label: event.target.value })}
                />
                <span className={`chip ${STATUS_CHIP[unit.status]}`}>{STATUS_TEXT[unit.status]}</span>
                {unit.cardName && unit.cardName !== 'downloaded' ? (
                  <span className="muted mono">{unit.cardName}</span>
                ) : null}
                {unit.error ? <span className="muted" style={{ color: 'var(--crit)' }}>{unit.error}</span> : null}
                <button
                  className={`btn ${index === nextPending ? 'primary' : ''}`}
                  style={{ marginLeft: 'auto', padding: '4px 12px' }}
                  disabled={busy || blocking.length > 0 || !unit.label.trim()}
                  onClick={() => (CARD_ACCESS_SUPPORTED ? void writeUnit(index) : downloadUnit(index))}
                >
                  {unit.status === 'written' ? 'Write again' : CARD_ACCESS_SUPPORTED ? 'Write card' : 'Download'}
                </button>
              </div>
            ))}
          </div>

          {written === units.length ? (
            <div className="banner ok" style={{ marginTop: 16, marginBottom: 0 }}>
              <strong>All {units.length} units prepared</strong>
              Each card carries its own label. The device runs its self-test at activation, so check the
              LED before sealing each unit.
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

const STATUS_COLOR: Record<BatchUnit['status'], string> = {
  pending: 'var(--line-2)',
  writing: 'var(--warn)',
  written: 'var(--ok)',
  error: 'var(--crit)',
};

const STATUS_CHIP: Record<BatchUnit['status'], string> = {
  pending: '',
  writing: 'warn',
  written: 'ok',
  error: 'crit',
};

const STATUS_TEXT: Record<BatchUnit['status'], string> = {
  pending: 'Not written',
  writing: 'Writing…',
  written: 'Written',
  error: 'Failed',
};
