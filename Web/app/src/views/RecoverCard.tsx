import { useEffect, useState } from 'react';
import { ejectDevice, HelperError, mountVolume, type HelperDevice } from '../lib/helper';
import { cardCondition, type CardCondition } from '../lib/cardCondition';
import { checkCardFilesystem, copyCardToImage } from '../lib/cardImage';
import { useKept } from '../lib/keptState';
import { useDeviceWatch, type Helper } from '../lib/useHelper';
import { Activity, useCardLogs, without, type CardLogs } from '../components/CardActivity';
import { RepairDialog, useCardRepair } from '../components/CardRepair';
import { FsckResult, ImageResult, type Found } from '../components/PhysicalCard';
import { InstallGuideDialog } from '../components/HelperStatus';
import { TabLink } from '../components/TabLink';

/**
 * Recovering a card that will not open.
 *
 * A card whose filesystem is damaged never reaches the folder picker, so nothing else in the
 * dashboard can see it. The card helper still can, so this screen is driven by the helper's
 * list of cards rather than by a folder anyone picked — and lists only the cards that do not
 * open. One that opens is checked, copied and repaired under "Review card", like any other; a
 * card recovered here stays listed until it is taken out, so its recovery is not hidden the
 * moment it works.
 *
 * The order is the point. A card that gets here may hold a deployment that cannot be
 * recorded again, and a repair rewrites the card's structures in place: where it guesses
 * wrong, what it overwrote is gone. So the card is copied, sector by sector, to an image file
 * first, while everything still readable is still there; then checked, which changes nothing;
 * then repaired, behind a confirmation in the helper's own words; then opened, at which point
 * the rest of the dashboard — Review, Listen, Check & copy — works on it as on any card.
 *
 * Where there is nothing to repair — no partitions at all — it says so and stops, with the
 * image as the thing to take to a recovery tool, rather than attempting something that could
 * make matters worse.
 */

function size(bytes: number): string {
  return bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

function message(error: unknown): string {
  if (error instanceof HelperError && error.code === 'cancelled') return 'Administrator access was not given, so nothing was done.';
  return error instanceof Error ? error.message : String(error);
}

export function RecoverCard({ helper, onConnect }: Readonly<{ helper: Helper; onConnect: () => void }>) {
  const logs = useCardLogs('recover');
  const [found, setFound] = useKept<Record<string, Found>>('recover:found', {});
  const [showGuide, setShowGuide] = useState(false);
  const busy = helper.task !== null || logs.working !== null;
  useDeviceWatch(helper, !busy);

  const devices = helper.devices;
  const { prune } = logs;
  // A card taken out takes what was found with it: one put back in may be a different card.
  useEffect(() => {
    const present = devices.map((device) => device.id);
    setFound((previous) => {
      const gone = Object.keys(previous).filter((id) => !present.includes(id));
      return gone.length ? without(previous, gone) : previous;
    });
    prune(present);
  }, [devices, prune, setFound]);

  const record = (id: string, patch: Found) => setFound((previous) => ({ ...previous, [id]: { ...previous[id], ...patch } }));
  const repair = useCardRepair(helper, logs, (device, report) => record(device.id, { repaired: report }));

  // Only cards that do not open — and any worked on here, until they are taken out.
  const listed = devices.filter((device) => cardCondition(device).kind !== 'open' || found[device.id] || logs.logs[device.id]);

  const copyToImage = async (device: HelperDevice) => {
    const image = await copyCardToImage(device, helper, logs);
    if (image) record(device.id, { image });
  };

  const check = async (device: HelperDevice, volume: string) => {
    const fsck = await checkCardFilesystem(device, volume, helper, logs);
    if (fsck) record(device.id, { fsck, repaired: undefined });
  };

  const open = async (device: HelperDevice, volume: string) => {
    logs.begin([device.id], 'Asking the system to open the card.');
    try {
      await mountVolume(volume);
      await helper.rescan();
      logs.finish([device.id]);
    } catch (failure) {
      logs.finish([device.id], `The system could not open the card (${message(failure)}). Recover it with the steps below.`);
    }
  };

  const eject = async (device: HelperDevice) => {
    logs.begin([device.id], 'Ejecting the card.');
    try {
      await ejectDevice(device.id);
      logs.forget([device.id]);
      await helper.rescan();
    } catch (failure) {
      logs.finish([device.id], message(failure));
    }
  };

  if (helper.status !== 'ready') {
    return (
      <div className="card">
        <h2>Recovering a card needs the card helper</h2>
        <p className="hint">
          A card whose filesystem is damaged may not appear in the card picker dialog box, so the dashboard can reach it
          only through the A3EM Card Helper, a small program with a browser extension. When installed, you can use this
          screen to repair a broken card.
        </p>
        {helper.status === 'unsupported' ? (
          <p className="hint">This browser cannot use the card helper. It needs Chrome, Edge, Brave, Vivaldi, Arc, or Opera.</p>
        ) : helper.status === 'checking' ? (
          <p className="muted">Looking for the card helper…</p>
        ) : helper.status === 'incomplete' ? (
          <p className="hint">The card helper cannot do this on {helper.identity?.platform} yet.</p>
        ) : (
          <button className="btn primary" onClick={() => setShowGuide(true)}>
            {helper.status === 'outdated' ? 'Update the card helper…' : 'Enable card tools…'}
          </button>
        )}
        {showGuide ? <InstallGuideDialog outdated={helper.status === 'outdated'} onClose={() => setShowGuide(false)} /> : null}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Cards that will not open</h2>
        <button className="btn small" disabled={busy} onClick={() => void helper.rescan()}>
          Rescan
        </button>
      </div>
      <p className="hint">
        A card whose filesystem is damaged may not appear in the card picker dialog box, so “Connect SD card” cannot open
        it. However, the card may still be recoverable using the tools on this page. Only cards that are corrupted,
        unmountable, or unreadable will be shown; a card that opens normally is checked and repaired under{' '}
        <TabLink to="review" />.
      </p>
      {listed.length === 0 ? (
        <p className="muted">
          {devices.length === 0 ? (
            'No cards are connected. Insert the card; it appears here within a few seconds if it will not open.'
          ) : (
            <>
              {devices.length === 1 ? 'The connected card opens' : `All ${devices.length} connected cards open`} normally,
              so there is nothing to recover here. Use “Connect SD card”, then <TabLink to="review" />.
            </>
          )}
        </p>
      ) : (
        <div className="connected-cards">
          {listed.map((device) => (
            <RecoveryCard
              key={device.id}
              device={device}
              condition={cardCondition(device)}
              found={found[device.id] ?? {}}
              logs={logs}
              busy={busy}
              onImage={() => void copyToImage(device)}
              onCheck={(volume) => void check(device, volume)}
              onRepair={(volume) => void repair.ask(device, volume)}
              onOpen={(volume) => void open(device, volume)}
              onEject={() => void eject(device)}
              onConnect={onConnect}
            />
          ))}
        </div>
      )}
      <p className="card-help">
        These functions read the card directly, so your computer may ask for an administrator password. “Copy to an
        image file…” asks where to save the image, and says before it starts if the image will not fit there.
      </p>
      {repair.pending ? (
        <RepairDialog
          description={repair.pending.description}
          imaged={Boolean(found[repair.pending.device.id]?.image)}
          ours={found[repair.pending.device.id]?.fsck?.fixableHere ?? false}
          onCancel={repair.cancel}
          onConfirm={() => void repair.confirm()}
        />
      ) : null}
    </div>
  );
}

function RecoveryCard({
  device,
  condition,
  found,
  logs,
  busy,
  onImage,
  onCheck,
  onRepair,
  onOpen,
  onEject,
  onConnect,
}: Readonly<{
  device: HelperDevice;
  condition: CardCondition;
  found: Found;
  logs: CardLogs;
  busy: boolean;
  onImage: () => void;
  onCheck: (volume: string) => void;
  onRepair: (volume: string) => void;
  onOpen: (volume: string) => void;
  onEject: () => void;
  onConnect: () => void;
}>) {
  const log = logs.logs[device.id];
  const running = logs.isWorking(device.id);
  const volume = condition.kind === 'blank' ? null : condition.volume;
  const chip =
    condition.kind === 'open'
      ? { tone: 'ok', text: 'Opens now' }
      : condition.kind === 'closed'
        ? { tone: 'warn', text: 'Not open' }
        : condition.kind === 'unreadable'
          ? { tone: 'crit', text: 'Cannot be opened' }
          : { tone: 'warn', text: 'No partitions' };
  const imageButton = (
    <button className="btn small" disabled={busy} onClick={onImage}>
      {found.image ? 'Copy to an image file again…' : 'Copy to an image file…'}
    </button>
  );

  return (
    <div className="connected-card" data-device={device.id}>
      <div className="connected-card-head">
        <div>
          <strong>{volume?.label ?? 'No readable volume'}</strong>{' '}
          <span className="muted mono">
            {device.node} · {size(device.sizeBytes)} · {device.bus}
          </span>
          <span className={`chip ${chip.tone}`}>{chip.text}</span>
          {device.writeProtected ? <span className="chip crit">Locked</span> : null}
        </div>
        <div className="connected-card-actions">
          <button className="btn small" disabled={busy} onClick={onEject}>
            Eject
          </button>
        </div>
      </div>

      {condition.kind === 'open' ? (
        // Recovered here: it is an ordinary card again, and the rest of the dashboard can have it.
        <>
          <p className="card-help">
            It opens now, at <span className="mono">{condition.mountPoint}</span>. Use “Connect SD card” and choose it
            to review, listen to, or copy what it holds.
          </p>
          <div className="recovery-actions">
            <button className="btn small primary" onClick={onConnect}>
              Connect it
            </button>
          </div>
        </>
      ) : condition.kind === 'blank' ? (
        <>
          <p className="card-help">
            The card has no partitions, so there is no filesystem to check or repair. If it held recordings, copy it to
            an image file and take the image to a recovery tool such as PhotoRec, which finds files by their contents
            rather than through the filesystem. If it did not, prepare it under <TabLink to="batch" />.
          </p>
          <div className="recovery-actions">{imageButton}</div>
        </>
      ) : (
        <>
          {condition.kind === 'closed' ? (
            <>
              <p className="card-help">
                The system recognizes its filesystem, but the card is not open. Opening it is often all it needs. If
                it will not open, recover it with the steps below.
              </p>
              <div className="recovery-actions">
                <button className="btn small primary" disabled={busy} onClick={() => onOpen(condition.volume.id)}>
                  Open it
                </button>
              </div>
            </>
          ) : (
            <p className="card-help">
              The system cannot read this card’s filesystem. It may be damaged, or formatted for another kind of
              device. Recover it in this order:
            </p>
          )}
          <ol className="recovery-steps">
            <li className={found.image ? 'done' : ''}>
              <strong>Copy the whole card to an image file.</strong> Do this first. A repair changes the card in place,
              and an image keeps everything still readable on it, whatever happens next.
              <div className="recovery-actions">{imageButton}</div>
            </li>
            <li className={found.fsck ? 'done' : ''}>
              <strong>Check the filesystem.</strong> Reads the card and reports what is wrong with it, changing nothing.
              <div className="recovery-actions">
                <button className="btn small" disabled={busy} onClick={() => onCheck(condition.volume.id)}>
                  Check the filesystem
                </button>
              </div>
            </li>
            <li className={found.repaired ? 'done' : ''}>
              <strong>Repair it.</strong> Rewrites the damaged parts of the filesystem, on the card itself.
              <div className="recovery-actions">
                <button className="btn small" disabled={busy || device.writeProtected} onClick={() => onRepair(condition.volume.id)}>
                  Repair…
                </button>
              </div>
            </li>
            <li>
              <strong>Open it.</strong> Once it is repaired, the system can open it, and so can the rest of the dashboard.
              <div className="recovery-actions">
                <button className="btn small" disabled={busy} onClick={() => onOpen(condition.volume.id)}>
                  Open it
                </button>
              </div>
            </li>
          </ol>
        </>
      )}

      {log ? (
        <Activity log={log} running={running} now={logs.now} onStop={logs.canStop(device.id) ? () => logs.stop(device.id) : undefined} />
      ) : null}
      {!running && found.image ? <ImageResult report={found.image} /> : null}
      {!running && found.repaired ? <FsckResult report={found.repaired} /> : !running && found.fsck ? <FsckResult report={found.fsck} /> : null}
    </div>
  );
}
