import { useId } from 'react';

/**
 * The A3EM wordmark.
 *
 * Drawn geometry rather than type: A, E, and M are strokes, the 3 is an outline converted
 * from Manrope SemiBold, and one amplitude trace runs the full width — faint everywhere,
 * at full strength between the A's two legs, where it serves as the letter's crossbar.
 * Both passes render the SAME path so they cannot drift apart, and the strong pass fades
 * in and out inside the leg strokes so the change of colour is never an abrupt edge.
 *
 * Nothing here depends on a font being available.
 */
const TRACE = 'M-2 40 L10 40 L14 34 L18 46 L22 32 L26 45 L30 36 L35 43 L40 40 L52 40 L56 37 L60 43 L64 40 L92 40 L96 36 L100 44 L104 40 L134 40 L138 34 L142 46 L146 40 L154 40 L158 37 L162 43 L166 40 L186 40';
const THREE = 'M69.62 64.50Q65.27 64.50 61.41 62.81Q57.55 61.12 54.72 58.02Q51.88 54.93 50.63 50.71L60.01 48.17Q61.01 51.63 63.69 53.50Q66.36 55.37 69.58 55.33Q72.43 55.33 74.69 54Q76.94 52.68 78.22 50.40Q79.51 48.13 79.51 45.32Q79.51 41.01 76.74 38.12Q73.96 35.22 69.58 35.22Q68.25 35.22 66.98 35.58Q65.72 35.95 64.55 36.59L60.13 28.95L79.59 12.30L80.44 14.63L52.89 14.63L52.89 5.50L88.40 5.50L88.40 14.67L72.75 29.71L72.67 26.86Q77.94 27.22 81.66 29.79Q85.38 32.37 87.37 36.43Q89.37 40.49 89.37 45.32Q89.37 50.79 86.69 55.13Q84.02 59.47 79.53 61.99Q75.05 64.50 69.62 64.50';

export function Wordmark({ height = 26, title = 'A3EM' }: Readonly<{ height?: number; title?: string }>) {
  // Gradient ids are document-global, so two marks on one page would otherwise share one.
  const gradient = useId();
  const width = (height * 188) / 70;
  /*
    Below about 80px wide the faint pass stops reading as a waveform and becomes a smudge
    across the letters — it loses legibility well before the letterforms do. The strong
    pass over the A survives much smaller, so only the background one is dropped.
  */
  const showFaintPass = width >= 80;
  return (
    <svg
      viewBox="-2 0 188 70"
      height={height}
      width={width}
      fill="none"
      role="img"
      aria-label={title}
    >
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="38" y2="0">
          <stop offset="0" stopColor="var(--mark-signal)" stopOpacity="0" />
          <stop offset="0.19" stopColor="var(--mark-signal)" stopOpacity="1" />
          <stop offset="0.8" stopColor="var(--mark-signal)" stopOpacity="1" />
          <stop offset="1" stopColor="var(--mark-signal)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {showFaintPass ? (
        <path d={TRACE} stroke="var(--primary-wash)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      <g stroke="var(--primary)" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 60 L22 10 L40 60" />
        <path d="M100 10 L100 60 M100 10 L128 10 M100 60 L128 60" />
        <path d="M100 40 L122 40" />
        <path d="M143 60 L143 10 L161 42 L179 10 L179 60" />
      </g>
      <path d={THREE} fill="var(--primary)" />
      <path d={TRACE} stroke={`url(#${gradient})`} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
