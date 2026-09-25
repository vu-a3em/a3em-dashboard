import { lazy, Suspense, useState, type Dispatch, type SetStateAction } from 'react';
import {
  CONFIG_FILE_NAME,
  DEVICE_LABEL_MAX_LEN,
  deviceLabelProblems,
  serializeConfig,
  summarizeAudio,
  summarizeMotion,
  summarizeSchedule,
  validateConfig,
  type DeploymentConfig,
  type ProtocolProvenance,
} from '@a3em/config-schema';
import { CARD_ACCESS_SUPPORTED, downloadConfig, pickCard, writeConfig } from '../lib/card';
import { quickCardChecks } from '../lib/cardChecks';
import { buildZip, downloadBlob } from '../lib/zip';
import type { useCard } from '../lib/useCard';
import type { Helper } from '../lib/useHelper';
import type { CardDevice } from '../lib/useCardDevice';
import type { PreparedUnit } from '../components/ConnectedCards';
import { TabLink, WithTabLinks } from '../components/TabLink';
import { loadConnectedCards } from '../lib/helperViews';
import { batchSettings, listLabels, writtenUnits, type BatchUnit } from '../lib/batch';

type Card = ReturnType<typeof useCard>;

/** Only with the card helper, so loaded separately: see `helperViews`. */
const ConnectedCards = lazy(() => loadConnectedCards().then((module) => ({ default: module.ConnectedCards })));

export type { BatchUnit } from '../lib/batch';

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
  helper,
  config,
  basedOn,
  units,
  onUnitsChange,
  onEditConfiguration,
  onRecover,
  cardDevice,
}: Readonly<{
  card: Card;
  /** Which card the open folder is on, so preparing that card can let go of what was read from it. */
  cardDevice?: CardDevice;
  /** The card helper; its panel appears when it is installed. */
  helper: Helper;
  config: DeploymentConfig;
  /** The protocol the configuration came from, to say what is being written. */
  basedOn: ProtocolProvenance | null;
  units: BatchUnit[];
  /**
   * Takes an update as well as a list: cards are prepared one after another within a single
   * action, and each result must land on the list as the one before left it.
   */
  onUnitsChange: Dispatch<SetStateAction<BatchUnit[]>>;
  onEditConfiguration: () => void;
  /** Opens the recovery screen, for a connected card that cannot be opened. */
  onRecover: () => void;
}>) {
  const [prefix, setPrefix] = useState('');
  const [count, setCount] = useState(6);
  const [busy, setBusy] = useState(false);

  const issues = validateConfig(config, card.targetFirmware, { now: Date.now() });
  // Label problems are per-unit here, so they are not a reason to block the batch.
  const blocking = issues.filter(
    (issue) => issue.severity === 'error' && issue.path !== 'deviceLabel',
  );

  const build = () => {
    const base = prefix.trim() || config.deviceLabel.trim() || 'A3EM';
    onUnitsChange(
      Array.from({ length: count }, (_, index) => {
        // The PREFIX is shortened to make room, never the number. Cutting the whole label to
        // length took the number off the end, so a long prefix gave every unit the same label.
        const suffix = `_${String(index + 1).padStart(2, '0')}`;
        return {
          label: `${base.slice(0, DEVICE_LABEL_MAX_LEN - suffix.length)}${suffix}`,
          status: 'pending' as const,
          cardName: null,
          error: null,
          note: null,
          settings: null,
        };
      }),
    );
  };

  /*
    What is wrong with each unit's label, by index.

    The same rules the editor applies to one label, plus the one only a batch can break: two
    units with the same label. Compared without case, because the card's file system is
    case-insensitive and "Owl_01" and "owl_01" are the same folder to anyone reading the data.
  */
  const labelCounts = new Map<string, number>();
  for (const unit of units) {
    const key = unit.label.trim().toLowerCase();
    if (key) labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  const labelProblems = units.map((unit) => {
    const problems = deviceLabelProblems(unit.label);
    if ((labelCounts.get(unit.label.trim().toLowerCase()) ?? 0) > 1) {
      problems.push('Another unit in this batch has the same label.');
    }
    return problems;
  });

  const setUnit = (index: number, patch: Partial<BatchUnit>) =>
    onUnitsChange((current) => current.map((unit, i) => (i === index ? { ...unit, ...patch } : unit)));

  const writeUnit = async (index: number) => {
    const unit = units[index];
    setBusy(true);
    setUnit(index, { status: 'writing', error: null, note: null });
    try {
      // Each unit gets its own card, so the picker opens per unit rather than reusing
      // whatever is currently connected.
      const root = await pickCard();
      // A quick look at the top of the folder first: a device folder chosen by mistake is
      // refused, and a card still holding an earlier deployment is noted but written.
      const checks = await quickCardChecks(root);
      const refused = checks.find((check) => check.severity === 'error');
      if (refused) {
        setUnit(index, { status: 'error', cardName: root.name, error: refused.message, note: null });
        return;
      }
      const text = serializeConfig({ ...config, deviceLabel: unit.label });
      await writeConfig(root, text);
      setUnit(index, {
        status: 'written',
        cardName: root.name,
        error: null,
        note: checks.map((check) => check.message).join(' ') || null,
        settings: batchSettings(config),
      });
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

  /*
    Downloads, for browsers that cannot write to a card.

    Named exactly `_a3em.cfg`, because that is the only name the device reads — the old
    `LABEL_a3em.cfg` had to be renamed by hand, and nothing said so. A browser saving the same
    name twice renames the second copy, so a whole batch goes as one archive instead, with a
    folder per unit.
  */
  const downloadUnit = (index: number) => {
    const unit = units[index];
    downloadConfig(serializeConfig({ ...config, deviceLabel: unit.label }), CONFIG_FILE_NAME);
    setUnit(index, { status: 'written', cardName: 'downloaded', error: null, settings: batchSettings(config) });
  };
  const downloadAll = () => {
    const ready = units.filter((_, index) => labelProblems[index].length === 0);
    const settings = batchSettings(config);
    downloadBlob(
      buildZip(ready.map((unit) => ({ path: `${unit.label}/${CONFIG_FILE_NAME}`, text: serializeConfig({ ...config, deviceLabel: unit.label }) }))),
      `${(prefix.trim() || config.deviceLabel.trim() || 'A3EM').slice(0, 40)}-configurations.zip`,
    );
    onUnitsChange(
      units.map((unit, index) =>
        labelProblems[index].length === 0 ? { ...unit, status: 'written', cardName: 'downloaded', error: null, settings } : unit,
      ),
    );
  };

  /*
    Cards prepared through the helper, recorded against their units by label. The helper
    wrote the configuration itself, onto the freshly formatted card.

    Applied to the list as it is by then, not as it was when the preparation started: erasing
    some cards and then writing settings to others reports twice within one action, and the
    second report must not put back what the first recorded.
  */
  const recordPrepared = (prepared: PreparedUnit[]) => {
    // The card open in the dashboard, if it was one of these: what was read from it is out of date.
    const open = cardDevice?.device ?? null;
    const opened = open ? prepared.find((entry) => entry.device === open.id) : undefined;
    if (opened?.erased) {
      void card.erased(`${card.name ?? 'The card'} was erased to prepare it as ${opened.label}`);
    } else if (opened?.ok && !opened.found) {
      void card.rescan();
    }
    const settings = batchSettings(config);
    onUnitsChange((current) =>
      current.map((unit) => {
        const match = prepared.find((entry) => entry.label === unit.label);
        if (!match) return unit;
        return match.ok
          ? { ...unit, status: 'written', cardName: match.node, error: null, note: null, settings }
          : { ...unit, status: 'error', cardName: match.node, error: match.note, note: null };
      }),
    );
  };

  // Cards are written through the helper's list above, rather than one by one through the picker.
  const direct = helper.status === 'ready' && blocking.length === 0;

  /*
    The units as they are shown: one whose card was written before the settings changed on
    Configure has no card for this batch any more, as far as anyone preparing it can tell, so it
    is back to "No card yet", and says why.
  */
  const { outdated } = writtenUnits(units, config);
  const shown = units.map((unit): BatchUnit => {
    if (!outdated.includes(unit)) return unit;
    const downloaded = unit.cardName === 'downloaded';
    const was = downloaded ? 'Its settings were downloaded' : `Its card${unit.cardName ? ` (${unit.cardName})` : ''} was written`;
    const again = downloaded || !CARD_ACCESS_SUPPORTED ? 'Download them again' : direct ? 'Prepare it again' : 'Write it again';
    return {
      ...unit,
      status: 'pending',
      cardName: null,
      error: null,
      note: `${was} before the settings changed on “Configure”, so it would record differently from units prepared now. ${again}, or change the settings back.`,
    };
  });

  const waiting = shown
    .filter((unit, index) => unit.status !== 'written' && labelProblems[index].length === 0)
    .map((unit) => unit.label);

  const written = shown.filter((unit) => unit.status === 'written').length;
  const nextPending = shown.findIndex((unit) => unit.status === 'pending' || unit.status === 'error');

  return (
    <>
      {blocking.length ? (
        <div className="banner crit">
          <strong>The configuration is not ready to write</strong>
          <ul className="banner-list">
            {blocking.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
          <button className="btn small" style={{ marginTop: 8 }} onClick={onEditConfiguration}>
            Fix these on Configure
          </button>
        </div>
      ) : null}

      {outdated.length ? (
        <div className="banner warn">
          <strong>
            {outdated.length === 1 ? 'One card was' : `${outdated.length} cards were`} written with settings that have since changed
          </strong>
          The settings changed on <TabLink to="configure" /> after {listLabels(outdated.map((unit) => unit.label))}{' '}
          {outdated.length === 1 ? 'was' : 'were'} written, so {outdated.length === 1 ? 'that unit' : 'those units'} would
          record differently from units prepared with the settings as they are now. {outdated.length === 1 ? 'It is' : 'They are'} back to “No card yet”
          below: {direct ? 'prepare' : 'write'} {outdated.length === 1 ? 'its card' : 'their cards'} again, or change the settings back.
        </div>
      ) : null}

      {/* What every card in this batch will carry, so it can be checked before the first one. */}
      <div className="card">
        <h2>What each card will contain</h2>
        <p className="hint">
          The settings from <TabLink to="configure" />, with each unit's own label.
        </p>
        <ul className="batch-summary">
          <li>
            <strong>{basedOn ? `${basedOn.name} v${basedOn.version}` : 'No protocol'}</strong>
            {' · '}
            {summarizeSchedule(config)}
            {config.isPhased && config.phases.length > 1 ? ` · ${config.phases.length} phases` : ''}
          </li>
          {(config.isPhased ? config.phases : config.phases.slice(0, 1)).map((phase, index) => (
            <li key={`${phase.name}-${index}`}>
              {config.isPhased ? <strong>{phase.name}: </strong> : null}
              {/* Each half labeled: "Synchronized with audio" on its own did not say it was about
                  the motion sensor at all. */}
              Audio: {summarizeAudio(phase)} · Motion data: {summarizeMotion(phase)}
            </li>
          ))}
          <li>
            {config.micType === 'DIGITAL' ? 'Digital' : 'Analog'} microphone at {config.micAmplificationDb} dB · LEDs{' '}
            {config.ledsEnabled ? 'on' : 'off'} · clock {config.setRtcAtMagnetDetect ? 'set to the start time at activation' : 'left as it is'}
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>
          Devices in this batch
          {units.length ? (
            <span className="batch-count">
              {' '}
              — {written} of {units.length} {units.length === 1 ? 'card' : 'cards'} written
            </span>
          ) : null}
        </h2>
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
            <p className="help">
              Labels are up to {DEVICE_LABEL_MAX_LEN} characters. A longer prefix is shortened so every unit
              keeps its number.
            </p>
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

        {units.length ? (
          <div className="batch-units">
            {/*
              With the card helper, cards are written from the pane above, where each one is
              listed by the helper, so no row here needs a button of its own: a second way to
              write the same card, through the folder picker, only made the two panes look like
              rivals.
            */}
            <p className="hint">
              {direct
                ? 'Each unit starts as “No card yet”. It changes to “Card written” when you use “Prepare this card” on a card assigned to it in the “Cards connected to this computer” pane below.'
                : CARD_ACCESS_SUPPORTED
                  ? 'Insert a unit’s card and press “Write card”, then choose the card itself when the folder picker opens, so each unit’s settings go onto its own card.'
                  : `This browser cannot write to a card directly. Download the batch as one archive, then copy each unit's ${CONFIG_FILE_NAME} to the top level of its card.`}
            </p>
            {!CARD_ACCESS_SUPPORTED ? (
              <button className="btn primary" style={{ marginBottom: 14 }} onClick={downloadAll}>
                Download all as a zip
              </button>
            ) : null}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {shown.map((unit, index) => (
                <div
                  key={index}
                  className="period-row"
                  style={{
                    borderLeft: `3px solid ${STATUS_COLOR[unit.status]}`,
                    background: index === nextPending ? 'var(--surface-2)' : 'var(--surface)',
                  }}
                >
                  <input
                    className="batch-label"
                    value={unit.label}
                    maxLength={DEVICE_LABEL_MAX_LEN}
                    aria-label={`Label for unit ${index + 1}`}
                    aria-invalid={labelProblems[index].length > 0}
                    onChange={(event) => setUnit(index, { label: event.target.value })}
                  />
                  <span className={`chip ${STATUS_CHIP[unit.status]}`}>
                    {unit.status === 'written' && unit.cardName === 'downloaded' ? 'Downloaded' : STATUS_TEXT[unit.status]}
                  </span>
                  {unit.cardName && unit.cardName !== 'downloaded' ? (
                    <span className="muted mono">{unit.cardName}</span>
                  ) : null}
                  {unit.error ? <span className="muted" style={{ color: 'var(--crit)' }}>{unit.error}</span> : null}
                  {labelProblems[index].length ? (
                    <span className="batch-label-problem">{labelProblems[index].join(' ')}</span>
                  ) : null}
                  {unit.note ? (
                    <span className="batch-label-note">
                      <WithTabLinks text={unit.note} />
                    </span>
                  ) : null}
                  {direct ? null : (
                    <button
                      className={`btn ${index === nextPending ? 'primary' : ''}`}
                      style={{ marginLeft: 'auto', padding: '4px 12px' }}
                      disabled={busy || blocking.length > 0 || labelProblems[index].length > 0}
                      onClick={() => (CARD_ACCESS_SUPPORTED ? void writeUnit(index) : downloadUnit(index))}
                    >
                      {!CARD_ACCESS_SUPPORTED ? 'Download' : unit.status === 'written' ? 'Write again…' : 'Write card…'}
                    </button>
                  )}
                </div>
              ))}
            </div>

            {written === units.length ? (
              <div className="banner ok" style={{ marginTop: 16, marginBottom: 0 }}>
                <strong>{units.length === 1 ? 'The unit is prepared' : `All ${units.length} units prepared`}</strong>
                {units.length === 1 ? 'Its card has its own label.' : 'Each card has its own label.'}{' '}
                {config.ledsEnabled
                  ? `The device runs its self-test at activation, so check the LED before sealing ${units.length === 1 ? 'the' : 'each'} unit.`
                  : 'The LEDs are off in this configuration, so a unit gives no visible sign that it activated or passed its self-test.'}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* The cards, after the units they are prepared as: a card is prepared as one of the batch's units. */}
      {helper.status === 'ready' && blocking.length === 0 ? (
        <Suspense fallback={null}>
          <ConnectedCards
            helper={helper}
            config={config}
            firmware={card.targetFirmware}
            labels={waiting}
            known={units.map((unit) => unit.label)}
            onPrepared={recordPrepared}
            onRecover={onRecover}
          />
        </Suspense>
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
  pending: 'No card yet',
  writing: 'Writing…',
  written: 'Card written',
  error: 'Failed',
};
