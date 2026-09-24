import { IS_BRAVE } from '../lib/card';
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
  if (card.status === 'unsupported' && IS_BRAVE) {
    return (
      <span
        className="chip warn"
        title="Brave turns off the folder access this needs. Open brave://flags/#file-system-access-api, set it to Enabled, and restart Brave."
      >
        <span className="dot" />
        Card access is off in Brave: enable brave://flags/#file-system-access-api
      </span>
    );
  }

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

  /*
    A card used before, offered back beside the ordinary way in rather than instead of it.

    After a reload the browser forgets its permission to the card's folder, though the dashboard
    remembers which folder it was. Reopening asks for that permission again, which saves a trip
    through the folder picker; Connect opens the picker for any card. With only Reopen on offer,
    reaching a different card meant reopening the old one first, only to disconnect it.
  */
  if (card.status === 'reconnectable') {
    return (
      <>
        {card.error ? (
          <span className="chip warn" title="Insert it and choose Reopen, or connect a different card.">
            {card.error}
          </span>
        ) : null}
        <button
          className="btn"
          title={`Open ${card.name} again, the card you used last time, without choosing it from the folder picker`}
          onClick={() => void card.reconnect()}
        >
          Reopen {card.name}
        </button>
        <button className="btn primary" onClick={() => void card.connect()}>
          Connect SD card
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
