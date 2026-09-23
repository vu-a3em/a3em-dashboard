/**
 * The registry of everything still unresolved: unmeasured constants, firmware
 * behaviors not yet implemented, and data we have not been given.
 *
 * This exists so placeholders never quietly become load-bearing. Three properties
 * are enforced by tests:
 *
 *   1. Every `estimated` or `extrapolated` measurement in `power/measurements.ts`
 *      has an entry here. You cannot add a guess without registering it.
 *   2. Every entry names what it blocks and how it gets resolved.
 *   3. Nothing here is `resolved` while its underlying value is still a guess.
 *
 * `npm run open-items` prints the current state as a checklist.
 *
 * WORKFLOW when an answer arrives: update the underlying value (usually in
 * `measurements.ts` or `firmware-profile.ts`), then set `status: 'resolved'` here
 * with a `resolvedNote`. Leave the entry in place — the history is useful.
 */

export type OpenItemStatus = 'blocked' | 'placeholder' | 'assumed' | 'resolved';

export type OpenItemArea = 'power' | 'firmware' | 'data' | 'design';

export interface OpenItem {
  /** Stable identifier; referenced from code comments and docs. */
  id: string;
  area: OpenItemArea;
  status: OpenItemStatus;
  title: string;
  /** What is currently assumed, and why that assumption is the safe one. */
  currentBehavior: string;
  /** What breaks or stays imprecise until this is answered. */
  blocks: string;
  /** The specific thing needed, and from whom. */
  needed: string;
  /** Keys in `measurements.ts` this item covers, if any. */
  measurementKeys?: string[];
  /** Set when status becomes 'resolved'. */
  resolvedNote?: string;
}

export const OPEN_ITEMS: OpenItem[] = [
  // ---------------------------------------------------------------- power ---
  {
    id: 'power.idle-armed',
    area: 'power',
    status: 'placeholder',
    title: 'Current while armed but not recording',
    currentBehavior:
      'Assumed equal to MCU idle + SD sleep, plus a 0.05 mA guess for the analog ' +
      'comparator when amplitude triggering is active.',
    blocks:
      'Every battery estimate for scheduled, interval, and threshold deployments — ' +
      'which is most real deployments. The planner spreadsheet models continuous ' +
      'recording only, so this whole regime is unmeasured.',
    needed:
      'Bench measurement of quiescent current in the armed state, separately for the ' +
      'analog comparator path and the timer path. From the firmware team.',
    measurementKeys: ['IDLE_STATE.mcuCurrentMa', 'IDLE_STATE.sdCurrentMa', 'IDLE_STATE.comparatorCurrentMa'],
  },
  {
    id: 'power.mcu-currents',
    area: 'power',
    status: 'placeholder',
    title: 'MCU idle and active current',
    currentBehavior: 'Using 0.52 mA idle and 2.82 mA active from the spreadsheet.',
    blocks:
      'Every result including continuous recording. These two dominate the model, and ' +
      'the spreadsheet itself flags both cells "<- Measure".',
    needed: 'Bench measurement. From the firmware team.',
    measurementKeys: ['MCU.idleCurrentMa', 'MCU.activeCurrentMa'],
  },
  {
    id: 'power.led-vhf',
    area: 'power',
    status: 'placeholder',
    title: 'LED current',
    currentBehavior:
      'LED 1.5 mA average during its active window. The VHF beacon has its own battery, so it is ' +
      'charged nothing against the A3EM pack.',
    blocks: 'Battery estimates for deployments with LEDs left on for long.',
    needed: 'Bench measurement. From the firmware team.',
    measurementKeys: ['LED.averageCurrentMa'],
  },
  {
    id: 'power.microphone-currents',
    area: 'power',
    status: 'placeholder',
    title: 'Per-microphone steady-state current',
    currentBehavior: 'Using the MicPower table, every row of which is marked "Measure" in the sheet.',
    blocks:
      'Comparing battery life across microphone choices, which is one of the decisions ' +
      'made earliest in deployment planning.',
    needed: 'Bench measurement per part number. From the firmware team.',
    measurementKeys: ['MICROPHONE_CURRENT_MA'],
  },
  {
    id: 'power.motion-duty',
    area: 'power',
    status: 'assumed',
    title: 'How often a deployed device is physically disturbed',
    currentBehavior: 'Motion-triggered IMU storage assumes the device is in motion 5% of the time.',
    blocks: 'Storage estimates for ACTIVITY-mode IMU recording. Unknowable in advance by nature.',
    needed:
      'Empirical distribution from retrieved deployments — the review workspace can ' +
      'measure it once it can read .imu files at scale, then feed it back.',
  },
  {
    id: 'power.calibration',
    area: 'power',
    status: 'blocked',
    title: 'Model has never been checked against a real deployment',
    currentBehavior:
      'The port reproduces the spreadsheet exactly, but the spreadsheet itself has not ' +
      'been validated against field outcomes. The ecologist responses report "too wide a ' +
      'range of durations to use an exact calculation".',
    blocks:
      'Presenting the forecast as a single confident number. Until calibrated it should ' +
      'be shown as a range with its assumptions inspectable.',
    needed:
      'For a handful of completed deployments: configuration, battery capacity, and ' +
      'observed end-of-life. The review workspace can capture this automatically going forward.',
  },

  // ------------------------------------------------------------- firmware ---
  {
    id: 'firmware.version-reporting',
    area: 'firmware',
    status: 'resolved',
    title: 'Device firmware version is not discoverable from a card',
    currentBehavior:
      'The current firmware stamps _FW_VERSION from the Makefile into the log and into ' +
      '_a3em.dev at the card root, alongside the hardware UID and last-known state.',
    blocks: 'Nothing. Legacy cards without the file still fall back to the legacy profile.',
    needed: 'Nothing further.',
    resolvedNote:
      'Implemented in firmware d997aaf. FW_VERSION is bumped by hand per release with the ' +
      'git hash appended automatically; firmwareProfileById() matches on the part before "+".',
  },
  {
    id: 'firmware.motion-threshold',
    area: 'firmware',
    status: 'resolved',
    title: 'IMU motion threshold is not implemented on device',
    currentBehavior:
      'In the current firmware the configured value reaches the sensor as a fraction of the ' +
      'accelerometer full scale. Still gated per profile, so the control stays hidden ' +
      'for legacy devices where it would do nothing.',
    blocks: 'Nothing.',
    needed: 'Nothing further.',
    resolvedNote:
      'Implemented in firmware d997aaf. Fraction of full scale, scaled to the LIS2DU12 ' +
      'wake-up threshold; about 7.8 mg resolution at the +/-2 g setting.',
  },
  {
    id: 'firmware.release-id',
    area: 'firmware',
    status: 'resolved',
    title: 'Release identifier for the findings-1/2/9 fixes',
    currentBehavior: "The release reports '<version>+<githash>' and the profile matches it.",
    blocks: 'Nothing.',
    needed: 'Nothing further.',
    resolvedNote: 'Set as FW_VERSION in the firmware Makefile, stamped with the git hash at build time.',
  },

  // ----------------------------------------------------------------- data ---
  {
    id: 'data.corrupt-file-samples',
    area: 'data',
    status: 'resolved',
    title: 'No examples of the corrupt files that cause real data loss',
    currentBehavior:
      'A full 250 GB image of SAM_elephant_08 was analysed: 419,761 files, 194.72 GB. ' +
      'Three distinct failure modes appeared, and the checker classified all of them ' +
      'correctly without being changed to fit.',
    blocks: 'Nothing.',
    needed: 'Nothing further.',
    resolvedNote:
      'Observed on the image, in order of how much they cost: (1) FOUR files reporting ' +
      'EINVAL at offset zero while their directory entries claim the usual 960,044 ' +
      'bytes -- metadata intact, data gone, and consecutive minutes (05:14-05:17 on ' +
      '2026-06-24), so a contiguous bad region rather than scattered damage. These are ' +
      'the files that stop a bulk copy. (2) ONE unfinalized clip carrying riff=36 and ' +
      'data=16, exactly the placeholders storage_write_wav_header() writes, with 313 kB ' +
      'of intact audio behind them -- recoverable, and predicted from reading the ' +
      'firmware before any such file had been seen. (3) SEVEN zero-byte files. ' +
      'Everything else -- 419,745 recordings -- was sound. ' +
      'The most useful finding is what is NOT there: the 8.3 MB log records none of it. ' +
      'Six warnings, all routine power-offs, no SD errors at all. The firmware had no ' +
      'visibility into its own data loss, which is what the health counters and ' +
      'per-directory logs exist to fix.',
  },
  {
    id: 'data.imu-format',
    area: 'data',
    status: 'resolved',
    title: 'IMU header size was ambiguous',
    currentBehavior:
      'Readers detect the header from the file size: 8 bytes from the current firmware, ' +
      '12 bytes before that. The two are never ambiguous because they differ by 4, ' +
      'which is not a multiple of the 12-byte sample.',
    blocks: 'Nothing.',
    needed: 'Nothing further.',
    resolvedNote:
      'Measured against 2679 real files: bytes 8-11 are always zero and reading from ' +
      'offset 12 gives gravity on the first sample. processing.py, which assumes 8, has ' +
      'been misreading every file. Firmware now writes an explicit uint32 timestamp.',
  },
  {
    id: 'data.gps-log-sample',
    area: 'data',
    status: 'assumed',
    title: 'No log containing a GPS fix or a low-battery event',
    currentBehavior:
      'The parser is written against the printf format strings in active_main.c. The ' +
      'sample log has GPS disabled, so every Location reads [0, 0, 0].',
    blocks:
      'Confidence in the GPS track and low-battery detection paths. Note that [0,0,0] ' +
      'must be treated as "no fix" rather than as a real position.',
    needed: 'A log from a GPS-equipped deployment, or one that ran to battery exhaustion.',
  },
];

/** Everything not yet resolved. */
export const unresolvedItems = (): OpenItem[] =>
  OPEN_ITEMS.filter((item) => item.status !== 'resolved');

export const itemsByArea = (area: OpenItemArea): OpenItem[] =>
  OPEN_ITEMS.filter((item) => item.area === area);

export const findOpenItem = (id: string): OpenItem | undefined =>
  OPEN_ITEMS.find((item) => item.id === id);

/** Measurement keys covered by at least one unresolved item. */
export const registeredMeasurementKeys = (): Set<string> => {
  const keys = new Set<string>();
  for (const item of unresolvedItems()) {
    for (const key of item.measurementKeys ?? []) keys.add(key);
  }
  return keys;
};
