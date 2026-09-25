import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardReadinessReport, DeploymentConfig, FirmwareProfile } from '@a3em/config-schema';
import { helperRenames, HelperError, renameMovesFolder, requestChallenge, type HelperDevice } from '../lib/helper';
import { eraseAndPrepare, judgeCard, planFor, readCards, renameFor, settingsSummary, summarize, writeUnitSettings } from '../lib/cardPreparation';
import { useConfigurePrepared } from '../lib/configurePrepared';
import type { Helper } from '../lib/useHelper';
import { Activity, useCardLogs } from './CardActivity';
import { ConfirmDialog, type Confirmation } from './EraseConfirm';

/**
 * "Configure SD Card" on Configure: the card that is open, prepared with the settings on screen.
 *
 * Writing only the configuration, as Configure did before, could leave a card the recorder would
 * erase at start, or one too slow, or not the size it claims, looking ready. So with the card
 * helper this runs what "Prepare this card" runs on Prepare devices (`lib/cardPreparation`): the
 * card checked, then the least that makes it ready — the settings and the card's name, or,
 * confirmed first, the card erased and set up again — for the device the configuration names.
 *
 * Erasing takes the folder open on the card with it, and so does renaming it where the card is
 * mounted under its name, so the dashboard lets go of the folder (`onErased`, `onRenamed`), and
 * the outcome is kept here to be read after it has gone.
 */

function message(error: unknown): string {
  if (error instanceof HelperError && error.code === 'cancelled') return 'Administrator access was not given, so nothing was changed.';
  return error instanceof Error ? error.message : String(error);
}

export function PrepareFromConfigure({
  helper,
  device,
  cardName,
  config,
  firmware,
  disabled,
  onSettingsWritten,
  onErased,
  onRenamed,
}: Readonly<{
  helper: Helper;
  device: HelperDevice;
  cardName: string | null;
  config: DeploymentConfig;
  firmware: FirmwareProfile;
  /** Set while the configuration has errors, which nothing should be written with. */
  disabled: boolean;
  onSettingsWritten: () => void;
  onErased: (label: string) => void;
  onRenamed: (label: string) => void;
}>) {
  const logs = useCardLogs('configure');
  const { begin, note, follow, finish, forget } = logs;
  const [confirming, setConfirming] = useState<Confirmation[] | null>(null);
  const [, setPrepared] = useConfigurePrepared();
  const awaiting = useRef(false);
  const label = config.deviceLabel.trim();
  const name = cardName ?? 'the card';
  const plan = useMemo(() => planFor(config, firmware, device.sizeBytes), [config, firmware, device.sizeBytes]);
  const busy = helper.task !== null || logs.working !== null;
  const id = device.id;

  // The settings, the card's name, or both; `write` false when the settings are already right.
  const settings = async (read: CardReadinessReport, rename: string | null, write: boolean) => {
    note([id], write ? `Writing ${label}’s settings to the card${rename ? `, and naming it ${rename}` : ''}.` : `Naming the card ${rename}.`);
    const written = await writeUnitSettings(device, config, label, read, follow([id]), rename, write);
    const closed = written.renamed && renameMovesFolder(helper.identity);
    setPrepared({ kind: 'settings', card: name, label, summary: settingsSummary(written, rename, write) });
    finish([id]);
    if (closed) onRenamed(rename!);
    else onSettingsWritten();
  };

  const prepare = async () => {
    setPrepared(null);
    begin([id], 'Checking the card first, to see what it needs.');
    try {
      const [read] = await readCards(helper, [id], follow([id]));
      if (!read) throw new Error('The A3EM Card Helper gave no reading of the card.');
      const { verdict, plan: preparation } = judgeCard(config, plan, read, label);
      const rename = renameFor(read, label, helperRenames(helper.identity));
      if (preparation.kind === 'blocked') {
        finish([id], `It cannot be configured. ${preparation.reason}`);
      } else if (preparation.kind === 'none' && !rename) {
        note([id], verdict.status === 'ready' ? `Nothing to configure: it is ready for ${label}.` : 'Nothing to configure: configuring it would not change anything.');
        finish([id]);
      } else if (preparation.kind === 'settings' || preparation.kind === 'none') {
        await settings(read, rename, preparation.kind === 'settings');
      } else {
        note([id], 'Asking the A3EM Card Helper to describe the card, so you can confirm it before anything is erased.');
        const challenge = await requestChallenge(id, 'prepare');
        note([id], 'Waiting for you to confirm.');
        awaiting.current = true;
        setConfirming([{ device: id, label, fixes: preparation.fixes, description: challenge.description, confirmed: false }]);
      }
    } catch (failure) {
      finish([id], message(failure));
    }
  };

  // Stable, because the dialog listens for its own closing with it. Nothing was done, so there
  // is nothing to keep a log of.
  const cancel = useCallback(() => {
    setConfirming(null);
    if (awaiting.current) forget([id]);
    awaiting.current = false;
  }, [forget, id]);
  useEffect(() => () => {
    if (awaiting.current) forget([id]);
  }, [forget, id]);

  const erase = async (entries: Confirmation[]) => {
    awaiting.current = false;
    setConfirming(null);
    note([id], 'Checking that nothing has changed since you confirmed.');
    try {
      const { results } = await eraseAndPrepare(helper, entries, config, { [id]: plan }, follow([id]));
      const result = results.find((candidate) => candidate.device === id);
      if (!result || result.error) {
        finish([id], result?.error ?? 'The A3EM Card Helper gave no result for the card.');
        return;
      }
      setPrepared({ kind: 'prepared', card: name, label, summary: summarize(result) });
      // What was done is kept above; the log would otherwise greet the next card in this reader.
      forget([id]);
      onErased(label);
    } catch (failure) {
      finish([id], message(failure));
    }
  };

  const log = logs.logs[id];
  return (
    <>
      <button
        className="btn primary"
        style={{ width: '100%', justifyContent: 'center' }}
        disabled={disabled || busy || !label}
        title="Checks the card, then does only what it needs: this device’s settings and name, or, confirmed first, erasing the card and setting it up again."
        onClick={() => void prepare()}
      >
        {logs.isWorking(id) ? 'Configuring…' : 'Configure SD Card'}
      </button>
      {log ? <Activity log={log} running={logs.isWorking(id)} now={logs.now} /> : null}
      {confirming ? <ConfirmDialog entries={confirming} onChange={setConfirming} onCancel={cancel} onConfirm={(entries) => void erase(entries)} /> : null}
    </>
  );
}
