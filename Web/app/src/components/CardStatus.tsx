import type { useCard } from '../lib/useCard';

type Card = ReturnType<typeof useCard>;

/**
 * The card connection, as a persistent element in the header.
 *
 * Browser capability is stated up front rather than discovered at the moment someone
 * tries to write a card — that is a difference people need to plan around, not find out
 * about at six in the morning before heading to a site.
 */
export function CardStatus({ card }: Readonly<{ card: Card }>) {
  if (card.status === 'unsupported') {
    return (
      <span className="chip warn" title="Chromium-based browsers only">
        <span className="dot" />
        No direct card access in this browser
      </span>
    );
  }

  if (card.status === 'scanning') {
    return (
      <span className="chip">
        <span className="dot" />
        Reading card… {card.progress ? `${card.progress.filesSeen.toLocaleString()} files` : ''}
      </span>
    );
  }

  if (card.status === 'ready') {
    const free = card.log?.telemetry.at(-1)?.sdFreeMb;
    return (
      <>
        <span className="chip ok">
          <span className="dot" />
          {card.name}
          {free != null ? ` · ${(free / 1024).toFixed(1)} GB free` : ''}
        </span>
        <button className="btn" onClick={() => void card.rescan()}>
          Rescan
        </button>
        <button className="btn" onClick={() => void card.disconnect()}>
          Disconnect
        </button>
      </>
    );
  }

  if (card.status === 'reconnectable') {
    return (
      <>
        <span className="chip">
          <span className="dot" />
          {card.name}
        </span>
        <button className="btn primary" onClick={() => void card.reconnect()}>
          Reconnect
        </button>
      </>
    );
  }

  return (
    <>
      {card.status === 'error' && card.error ? <span className="chip crit">{card.error}</span> : null}
      <button className="btn primary" onClick={() => void card.connect()}>
        Connect SD card
      </button>
    </>
  );
}
