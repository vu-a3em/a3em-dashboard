import type { ScanProgress } from '../lib/card';

/**
 * What the app is doing while a card opens.
 *
 * A full 512 GB card holds hundreds of thousands of files and a log of several megabytes.
 * Walking it takes tens of seconds, and parsing the log blocks the main thread outright —
 * so without something on screen the page looks like it has hung. This says which of the
 * three stages is running and how far it has got, and it names the stage that freezes the
 * page so a still cursor reads as work rather than a crash.
 */
export function CardLoading({ progress }: Readonly<{ progress: ScanProgress | null }>) {
  const phase = progress?.phase ?? 'scanning';
  const megabytes = progress?.logBytes ? (progress.logBytes / 1024 ** 2).toFixed(1) : null;

  const heading =
    phase === 'scanning'
      ? 'Reading the card'
      : phase === 'reading'
        ? 'Collecting the device logs'
        : 'Working through the device log';

  const detail =
    phase === 'scanning'
      ? `${(progress?.filesSeen ?? 0).toLocaleString()} files so far${
          progress?.currentDirectory ? ` · ${progress.currentDirectory}` : ''
        }`
      : phase === 'reading'
        ? `log ${(progress?.logsRead ?? 0).toLocaleString()} of ${(progress?.logsTotal ?? 0).toLocaleString()}${
            megabytes ? ` · ${megabytes} MB read` : ''
          }`
        : `${megabytes ?? '0'} MB to work through — the page will not respond until this finishes`;

  return (
    <div className="card loading-card">
      <h2>
        <span className="dot" /> {heading}
      </h2>
      <p className="hint">{detail}</p>
      <div className="loading-track" aria-hidden="true">
        <i />
      </div>
      <p className="help">
        Large cards take awhile to read. Nothing is written to the card while it is being read.
      </p>
    </div>
  );
}
