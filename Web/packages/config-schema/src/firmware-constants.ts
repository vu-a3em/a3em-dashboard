/**
 * Constants transcribed directly from the A3EM production firmware.
 *
 * SINGLE SOURCE OF TRUTH. Every value below carries the firmware file and symbol
 * it came from. When the firmware changes, update this file and nothing else —
 * the schema, validators, and serializer all read from here.
 *
 * Firmware reference: a3em-firmware/src/app/static_config.h
 *                     a3em-firmware/src/app/runtime_config.c
 */

/** Bump when the on-card config format changes in a way the app must migrate. */
export const CONFIG_SCHEMA_VERSION = 2;

/** Firmware release this file was transcribed from. Shown in the app's compat matrix. */
export const TRANSCRIBED_FROM_FIRMWARE = 'a3em-firmware @ src/app/static_config.h (read 2026-08)';

export const CONFIG_FILE_NAME = '_a3em.cfg'; // static_config.h: CONFIG_FILE_NAME
export const LOG_FILE_NAME = 'a3em.log'; // static_config.h: LOG_FILE_NAME

// ---------------------------------------------------------------------------
// Hard firmware limits. Exceeding these is a memory-safety issue on device,
// not merely a validation nicety — see notes on each.
// ---------------------------------------------------------------------------

/**
 * static_config.h: MAX_NUM_DEPLOYMENT_PHASES = 20
 *
 * Raised from 6 so a deployment can carry the extra phases that daylight-saving changes
 * are split into (see `schedule.ts`). Each phase costs 248 bytes of TCM. Current firmware
 * bounds-checks the array and ignores extra `[PHASE]` sections; legacy firmware wrote past
 * the end of it, which is why this is still treated as a HARD CAP.
 */
export const MAX_DEPLOYMENT_PHASES = 20;

/**
 * static_config.h: MAX_AUDIO_TRIGGER_TIMES = 12
 *
 * Same story: `audio_trigger_times[...num_audio_trigger_times++]` is unchecked.
 * A 13th AUDIO_TRIGGER_SCHEDULE line overflows the phase struct. HARD CAP.
 */
export const MAX_AUDIO_TRIGGER_TIMES = 12;

/**
 * static_config.h: MAX_CFG_FILE_LINE_LENGTH = 80
 *
 * storage.c `storage_read_line()` reads at most 80 bytes and searches for '\n'.
 * If no newline is found within those 80 bytes it returns -1, and
 * `fetch_runtime_configuration()`'s `while (... >= 0)` loop TERMINATES — silently
 * discarding the entire remainder of the config. An over-long line does not fail
 * loudly; it truncates the deployment. HARD CAP, enforced per emitted line.
 */
export const MAX_CFG_LINE_LENGTH = 80;

/**
 * The longest line the device can actually READ, which is one less than the buffer.
 *
 * `storage_read_line()` reads 80 bytes and then scans those same 80 bytes for '\n'. A line
 * of exactly 80 characters puts its newline at offset 80 — one past what was read — so the
 * scan fails and the whole remainder of the file is discarded. 79 is therefore the real
 * ceiling, and it is what every emitted line is checked against.
 */
export const MAX_CFG_LINE_CONTENT_LENGTH = MAX_CFG_LINE_LENGTH - 1;

/**
 * Firmware buffer is `char device_label[1 + MAX_DEVICE_LABEL_LEN]` with
 * MAX_DEVICE_LABEL_LEN = 31 (static_config.h), so the device tolerates 31 chars.
 *
 * 15 was inherited from the desktop dashboard, not from the hardware. Raised to the
 * firmware's own ceiling, which every device already in the field accepts.
 *
 * Going further needs a firmware change AND a second limit respected: the configuration
 * line `DEVICE_LABEL = "<label>"` costs 17 characters of overhead, and a line may carry
 * at most MAX_CFG_LINE_LENGTH - 1 bytes, so the absolute ceiling for a label is 62.
 */
export const DEVICE_LABEL_MAX_LEN = 31;
export const DEVICE_LABEL_FIRMWARE_MAX_LEN = 31;

/**
 * Longest phase name that still fits on a readable config line.
 *
 * The firmware has no PHASE_NAME branch at all, so nothing on the device constrains this —
 * but the line still has to be READ, and a line the reader gives up on takes the rest of the
 * file with it. `PHASE_NAME = ""` costs 15 characters, leaving 64.
 */
export const PHASE_NAME_MAX_LEN = MAX_CFG_LINE_CONTENT_LENGTH - 'PHASE_NAME = ""'.length;

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/** Rates the dashboard offers. Firmware itself does not enumerate a whitelist. */
export const AUDIO_SAMPLE_RATES_HZ = [8000, 16000, 24000, 32000, 48000] as const;

// Clock sources and divider limits for the two microphone paths, from static_config.h and
// audio.c. These decide which of the rates above the hardware can actually produce; see
// audio-clock.ts, which reproduces the firmware's arithmetic including its truncation.
export const AUDADC_SOURCE_CLOCK_HZ = 12_000_000; // audio.c repeat-trigger timer
export const AUDADC_TIMER_COUNT_MAX = 1023; // AUDADC_TIMER_COUNT_MAX_LIMIT, audio.c
export const PDM_NOMINAL_CLOCK_HZ = 24_000_000; // static_config.h
// The microphone clock has to stay inside the band a PDM microphone will track.
export const PDM_MIN_CKO_HZ = 700_000; // static_config.h
export const PDM_MAX_CKO_HZ = 3_072_000; // static_config.h
export const PDM_MIN_DIVMCLKQ = 1; // static_config.h
export const PDM_MAX_DIVMCLKQ = 3; // static_config.h
export const PDM_MAX_MCLKDIV = 15; // audio.c divider search
export const PDM_MIN_SINCRATE = 16; // static_config.h
export const PDM_MAX_SINCRATE = 64; // static_config.h
// One decimation rate above the normal ceiling that the part also supports.
export const PDM_ALT_SINCRATE = 96; // static_config.h
// Rates within this much of the request count as close enough, at which point the
// firmware prefers the fastest microphone clock rather than the smallest error.
export const PDM_RATE_TOLERANCE_PERMILLE = 5; // static_config.h

export const AUDIO_DEFAULT_SAMPLE_RATE_HZ = 16000; // static_config.h
export const AUDIO_DEFAULT_CLIP_LENGTH_SECONDS = 10; // static_config.h

/**
 * Clip length the firmware will actually accept.
 *
 * runtime_config.c and audio.c both CLAMP against these, so a value outside the range
 * never reaches the card as written — the device substitutes its own and the deployment
 * runs at a length nobody chose.
 */
export const AUDIO_MIN_CLIP_LENGTH_SECONDS = 1; // static_config.h
export const AUDIO_MAX_CLIP_LENGTH_SECONDS = 3600; // static_config.h

/** Sampling rates the firmware accepts, either side of the offered list. */
export const AUDIO_MIN_SAMPLING_RATE_HZ = 4000; // static_config.h
export const AUDIO_MAX_SAMPLING_RATE_HZ = 48000; // static_config.h
export const AUDIO_NUM_CHANNELS = 1; // static_config.h
export const AUDIO_BYTES_PER_SAMPLE = 2; // int16 PCM, storage.c WAV header
// Halved from 96000 by the firmware to reclaim SRAM. IMU_BUFFER_MAX_SAMPLES is derived
// from it, so both moved together.
export const AUDIO_BUFFER_MAX_SAMPLES = 48000; // static_config.h
export const AUDIO_BUFFER_MAX_SIZE_BYTES = 65536; // static_config.h (SD cache) — also the Opus staging buffer

/**
 * static_config.h: WAV_STAGING_BUFFER_SIZE = 512 kB
 *
 * How much WAV audio the firmware accumulates before handing it to FatFs. Each flush is one SD power-up, so this sets
 * how many times per clip the card has to wake. Shares storage with the Opus buffer above — a recording is one format
 * or the other, never both.
 */
export const WAV_STAGING_BUFFER_SIZE_BYTES = 512 * 1024;

/**
 * static_config.h: SD_CARD_ALLOCATION_UNIT_BYTES = 32 kB
 *
 * Cluster size used when the DEVICE formats a card. A card formatted anywhere else keeps its own unit — macOS and
 * Windows both pick 4 kB for exFAT at these capacities — so this is a default, not a guarantee. What a given card
 * actually has is reported in `_a3em.dev` as CARD_ALLOCATION_UNIT_BYTES.
 */
export const SD_CARD_ALLOCATION_UNIT_BYTES = 32 * 1024;


/** runtime_config.c clamps sample rate to this whenever USE_OPUS is True. */
export const OPUS_REQUIRED_SAMPLE_RATE_HZ = 48000; // static_config.h
export const OPUS_DEFAULT_BITRATE = 32000; // static_config.h
export const OPUS_MAX_BITRATE = 128000; // static_config.h
export const OPUS_MIN_BITRATE = 5000; // dashboard-enforced; firmware has no floor
export const OPUS_MS_PER_FRAME = 20; // static_config.h

/**
 * runtime_config.c, end of `fetch_runtime_configuration()`:
 *   if (!max_frequency || max_frequency > ((sampling_rate / 2) - 200))
 *       max_frequency = (sampling_rate / 2) - 200;
 *
 * The desktop dashboard permits up to sampling_rate/2, so any value in the top
 * 200 Hz is silently rewritten by the device. We clamp in the app instead, so
 * what the user sees is what the device runs.
 */
export const MAX_FREQUENCY_HEADROOM_HZ = 200;
export const maxFrequencyCeilingHz = (sampleRateHz: number): number =>
  Math.floor(sampleRateHz / 2) - MAX_FREQUENCY_HEADROOM_HZ;

// ---------------------------------------------------------------------------
// IMU — LIS2DU12, 3-axis accelerometer only
// ---------------------------------------------------------------------------

/**
 * The rates the sensor reproduces exactly AND the .imu header can state.
 *
 * imu.c snaps whatever it is handed onto the LIS2DU12's ODR ladder
 * (1.6, 3, 6, 12.5, 25, 50, 100, 200, 400, 800 Hz), while storage.c writes the CONFIGURED
 * rate into the file header as a uint32 — which is what a reader uses to place samples in
 * time. The two non-integer rungs therefore cannot be described honestly: asking for 12 Hz
 * ran the part at 12.5 and labelled the file 12, a 4% error that grows across the file.
 * runtime_config.c now snaps to this same list and says so when it does.
 */
export const IMU_SAMPLE_RATES_HZ = [3, 6, 25, 50, 100, 200, 400, 800] as const;

/**
 * Motion-detection threshold, in ABSOLUTE MILLI-G.
 *
 * The LIS2DU12 runs at +/-2 g for motion detection, and its wake-up threshold is 8 bits
 * across that range — so the hardware resolves about 7.8 mg and cannot go finer.
 * A threshold control should step in these units rather than offering false precision.
 *
 * Firmware before 2026.08.1 ignored this value entirely, so there is no older meaning
 * to migrate from: any value already on a card was inert.
 */
export const IMU_MOTION_FULL_SCALE_MG = 2000;
export const IMU_MOTION_THRESHOLD_STEPS = 255;
export const IMU_MOTION_THRESHOLD_STEP_MG = IMU_MOTION_FULL_SCALE_MG / IMU_MOTION_THRESHOLD_STEPS;
export const IMU_MOTION_THRESHOLD_MIN_MG = IMU_MOTION_THRESHOLD_STEP_MG;
export const IMU_MOTION_THRESHOLD_MAX_MG = IMU_MOTION_FULL_SCALE_MG;

/** Snaps a milli-g threshold to what the sensor can actually resolve. */
export const quantizeMotionThresholdMg = (mg: number): number => {
  const steps = Math.round(mg / IMU_MOTION_THRESHOLD_STEP_MG);
  const clamped = Math.min(IMU_MOTION_THRESHOLD_STEPS, Math.max(1, steps));
  return clamped * IMU_MOTION_THRESHOLD_STEP_MG;
};
export const IMU_DEFAULT_SAMPLE_RATE_HZ = 25; // static_config.h
export const IMU_DEGREES_OF_FREEDOM = [3] as const; // LIS2DU12 is accel-only
export const IMU_BYTES_PER_SAMPLE = 12; // 3 axes x float32, storage.c
/**
 * static_config.h: IMU_BUFFER_MAX_SAMPLES = 3000
 *
 * No longer derived from the audio buffer. It was grown from 700 so that one buffer spans a whole 60 s clip at 50 Hz,
 * which lets the IMU flush ride along with an audio flush instead of waking the card on its own.
 */
export const IMU_BUFFER_MAX_SAMPLES = 3000;
export const IMU_FIFO_SAMPLES = 127; // spreadsheet Calculations!E21

// ---------------------------------------------------------------------------
// Device behavior
// ---------------------------------------------------------------------------

export const BATTERY_DEFAULT_LOW_MV = 3250; // static_config.h

/**
 * Bounds on the low-battery cutoff the dashboard will let you set.
 *
 * Zero is separately allowed and means "no cutoff" -- battery.c returns early on a zero
 * threshold, so the deployment runs until the hardware stops. That is a legitimate choice
 * for a device being retrieved regardless, at the cost of the last clip being truncated
 * wherever the power happens to fail.
 *
 * The floor is where the device stops being able to write reliably: static_config.h uses
 * 2500 mV as the self-test's lower bound (SELF_TEST_BATTERY_MIN_MV), and a cutoff beneath
 * it would never fire before the card writes started failing. The ceiling is a full cell --
 * a cutoff above it is satisfied the moment the deployment starts.
 */
export const BATTERY_CUTOFF_MIN_MV = 2500; // static_config.h: SELF_TEST_BATTERY_MIN_MV
export const BATTERY_CUTOFF_MAX_MV = 4200; // a fully charged lithium cell
/** Below this the cutoff is legal but leaves little margin for the write-failure retries. */
export const BATTERY_CUTOFF_ADVISED_MIN_MV = 3000;
export const MAGNET_DEFAULT_VALIDATION_MS = 5000; // static_config.h

/**
 * How long the LEDs stay responsive after activation, by default.
 *
 * Not a firmware default -- runtime_config.c starts from zero and relies on the config file
 * to say. A minute is long enough to watch the activation sequence through and confirm the
 * device is recording, without leaving an attractant lit in the field.
 */
export const LEDS_DEFAULT_ACTIVE_SECONDS = 60;
/** An upper bound offered in the UI; the firmware itself imposes none. */
export const LEDS_MAX_ACTIVE_SECONDS = 86400;
export const MAGNET_VALIDATION_MIN_MS = 1000; // dashboard-enforced
export const MAGNET_VALIDATION_MAX_MS = 30000; // dashboard-enforced
export const MIN_LOG_DATA_INTERVAL_SECONDS = 300; // static_config.h — telemetry cadence
export const NUM_HOURS_PER_AUDIO_DIRECTORY = 4; // static_config.h

export const MIC_DEFAULT_AMPLIFICATION_DB = 35.0; // runtime_config.c default

/**
 * The gain range each microphone can actually realize, in dB.
 *
 * Both paths in audio.c clamp, at different ceilings, and neither reports having done so.
 * `audio_analog_init()` holds the value to [0, 45] before programming the AUDADC PGA, which
 * is continuous over that span. `audio_digital_init()` instead picks a PDM gain constant from
 * a ladder in 1.5 dB steps whose top rung is +34.5 dB, so a digital mic cannot be asked for
 * more than that and anything in between lands on the nearest step.
 *
 * runtime_config.c does no range checking of its own, so these are the only limits there are.
 */
export const MIC_AMPLIFICATION_MIN_DB = 0;
export const MIC_AMPLIFICATION_MAX_DB_ANALOG = 45;
export const MIC_AMPLIFICATION_MAX_DB_DIGITAL = 34.5;
/** PDM gain is chosen from a ladder of these steps; the analog PGA is continuous. */
export const MIC_AMPLIFICATION_DIGITAL_STEP_DB = 1.5;

/** The ceiling that applies to the microphone actually fitted. */
export function micAmplificationMaxDb(micType: MicType): number {
  return micType === 'ANALOG' ? MIC_AMPLIFICATION_MAX_DB_ANALOG : MIC_AMPLIFICATION_MAX_DB_DIGITAL;
}

/**
 * The gain a digital microphone will really run at, given a requested one.
 *
 * audio.c walks an if/else ladder whose thresholds sit at the midpoints between steps
 * (0.75, 2.25, 3.75 ...), which is round-to-nearest on a 1.5 dB grid.
 */
export function snapDigitalGainDb(db: number): number {
  const clamped = Math.min(Math.max(db, MIC_AMPLIFICATION_MIN_DB), MIC_AMPLIFICATION_MAX_DB_DIGITAL);
  return (
    Math.round(clamped / MIC_AMPLIFICATION_DIGITAL_STEP_DB) * MIC_AMPLIFICATION_DIGITAL_STEP_DB
  );
}
export const MIC_MIN_AMPLIFICATION_DB = 0.0;
export const MIC_MAX_AMPLIFICATION_DB = 35.0;

// ---------------------------------------------------------------------------
// Enumerations. Left side = value written to the .cfg, exactly as the firmware
// compares it in runtime_config.c. Right side = the label an ecologist reads.
// ---------------------------------------------------------------------------

// Labels follow the vocabulary of the AudioMoth configuration app, which acoustic
// ecologists already share. A friendlier invented vocabulary makes the tool harder to
// talk about, not easier -- the practitioner feedback was explicit on this point.
export const AUDIO_RECORDING_MODES = {
  AMPLITUDE: 'Amplitude threshold',
  SCHEDULED: 'Scheduled recording periods',
  INTERVAL: 'Sleep/record cycle',
  CONTINUOUS: 'Continuous',
} as const;

/**
 * How a SCHEDULED phase decides when to listen.
 *
 * Labels rather than jargon on the right, because these are the two things a user is really
 * choosing between: times they pick, or times the device works out. The device recomputes a
 * solar schedule every local day, so it tracks the season instead of drifting away from it.
 */
export const AUDIO_SCHEDULE_TYPES = {
  CLOCK: 'Clock time',
  SOLAR: 'Solar time',
} as const;

export type AudioScheduleType = keyof typeof AUDIO_SCHEDULE_TYPES;

/**
 * The solar events a window can hang off. Spelled exactly as `solar.c` parses them.
 *
 * DAWN and DUSK are CIVIL twilight — the sun 6 degrees below the horizon — not first light in
 * any looser sense. The chorus is already under way by sunrise, so a window opened at sunrise
 * misses its beginning, which is usually the part worth having.
 */
export const SOLAR_ANCHORS = {
  DAWN: 'Civil dawn',
  SUNRISE: 'Sunrise',
  SUNSET: 'Sunset',
  DUSK: 'Civil dusk',
} as const;

export type SolarAnchor = keyof typeof SOLAR_ANCHORS;

/**
 * runtime_config.c stores a solar offset in an int16, and REFUSES an entry outside this
 * range rather than clamping it — a clamped window would run the deployment on times nobody
 * chose. About nine hours, which no dawn or dusk window comes close to needing.
 */
export const SOLAR_OFFSET_MIN_SECONDS = -32768;
export const SOLAR_OFFSET_MAX_SECONDS = 32767;

/** Bounds on a position, matching `solar_position_valid()`. */
export const LATITUDE_MIN_DEG = -90;
export const LATITUDE_MAX_DEG = 90;
export const LONGITUDE_MIN_DEG = -180;
export const LONGITUDE_MAX_DEG = 180;

export const IMU_RECORDING_MODES = {
  NONE: 'Disabled',
  ACTIVITY: 'Motion-triggered',
  AUDIO: 'Synchronised with audio',
} as const;

export const VHF_MODES = {
  NEVER: 'Disabled',
  END: 'At end of deployment',
  SCHEDULED: 'At a scheduled time',
} as const;

/**
 * Band-limiting applied to the recorded audio, matching what other acoustic loggers
 * offer. Separate from the silence-detection band, which only decides whether a clip is
 * kept — these answer different questions.
 */
export const AUDIO_FILTER_TYPES = {
  NONE: 'No filtering',
  LOW: 'Low-pass',
  BAND: 'Band-pass',
  HIGH: 'High-pass',
} as const;

export type AudioFilterType = keyof typeof AUDIO_FILTER_TYPES;

export const MIC_TYPES = {
  ANALOG: 'Analog',
  DIGITAL: 'Digital',
} as const;

export const TIME_SCALES = {
  SECONDS: 'Second',
  MINUTES: 'Minute',
  HOURS: 'Hour',
  DAYS: 'Day',
} as const;

/** active_main.c maps the max-clips time scale to a window length in seconds. */
export const TIME_SCALE_SECONDS = {
  SECONDS: 1,
  MINUTES: 60,
  HOURS: 3600,
  DAYS: 86400,
} as const;

export type AudioRecordingMode = keyof typeof AUDIO_RECORDING_MODES;
export type ImuRecordingMode = keyof typeof IMU_RECORDING_MODES;
export type VhfMode = keyof typeof VHF_MODES;
export type MicType = keyof typeof MIC_TYPES;
export type TimeScale = keyof typeof TIME_SCALES;

// ---------------------------------------------------------------------------
// On-card layout, from storage.c. Drives the review workspace's file discovery
// and the clock-drift relabel tool.
// ---------------------------------------------------------------------------

/**
 * `{DEVICE_LABEL}/Activation_%04u/{YYYY-MM-DD}/{HH}/{YYYY-MM-DD HH-MM-SS}.{ext}`
 *
 * All timestamps are UTC — storage.c uses gmtime(), not localtime().
 * `HH` is floor(hour / 4) * 4, zero-padded (NUM_HOURS_PER_AUDIO_DIRECTORY).
 */
export const AUDIO_FILE_EXTENSIONS = ['.wav', '.opus'] as const;
export const IMU_FILE_EXTENSION = '.imu';
export const FILE_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH-mm-ss';

/**
 * IMU file header, storage.c `storage_open_imu_file()`:
 *
 *   offset 0  uint32   sample rate, Hz
 *   offset 4  time_t   first-sample timestamp, UTC epoch seconds
 *   offset 12 float32[3] repeating, x/y/z in milli-g
 *
 * The timestamp is when the first sample was taken, which the file name only matches when
 * the sensor could be started with the microphone — see `ImuFile.startTime`.
 *
 * The header writes `sizeof(time_t)`, and on this toolchain that is EIGHT bytes,
 * making the header 12 bytes rather than 8.
 *
 * This was measured, not assumed. Across all 2679 .imu files on the reference card:
 *   - (size - 12) % 12 == 0 for every file; (size - 8) % 12 == 4 for every file
 *   - bytes 8..11 are always 00 00 00 00 — the high word of a little-endian uint64
 *   - reading triples from offset 12 gives ~978 mg on the first sample, i.e. gravity
 *     on a stationary device; reading from offset 8 gives misaligned nonsense
 *
 * CONSEQUENCE: `Python/dashboard/processing.py` reads from offset 8 and is therefore
 * misreading every IMU file — each triple straddles two samples, so the axes are
 * permuted and mixed. Magnitudes look plausible, which is why it went unnoticed.
 */
export const IMU_HEADER_SAMPLE_RATE_BYTES = 4;
export const IMU_HEADER_TIMESTAMP_BYTES = 8;
export const IMU_HEADER_BYTES = IMU_HEADER_SAMPLE_RATE_BYTES + IMU_HEADER_TIMESTAMP_BYTES;

/**
 * Config timestamps are a separate matter and ARE 32-bit: `runtime_config.c` stores
 * them in `uint32_t` fields via `strtoul`, regardless of the toolchain's `time_t`.
 * So the 2038 rollover constrains deployment and VHF times even though the IMU
 * header does not suffer from it.
 */
export const CONFIG_TIMESTAMP_BITS = 32;
export const MAX_REPRESENTABLE_EPOCH_SECONDS = 2 ** 31 - 1; // 2038-01-19T03:14:07Z

// ---------------------------------------------------------------------------
// Analog front end. Drives the trigger-threshold UI.
// ---------------------------------------------------------------------------

/**
 * The AUDADC is 12-bit signed: codes run -2048..2047 (confirmed by the firmware
 * team, 2026-08). Full-scale amplitude is therefore 2047 codes.
 */
export const ADC_BITS = 12;
export const ADC_CODE_MIN = -2048;
export const ADC_CODE_MAX = 2047;

/**
 * The amplitude trigger is NOT compared in the digital domain. audio.c passes the
 * threshold to `comparator_init(false, 0, percent, true)`, which calls
 * `digipot_set_percent_output(percent)` — and that writes an 8-bit wiper:
 *
 *   uint8_t wiper_value = (uint8_t)(255 * percent);
 *
 * So the threshold has only 256 achievable settings, evenly spaced in *voltage*
 * and therefore very unevenly spaced in dB. See `audio-threshold.ts`.
 */
export const TRIGGER_DIGIPOT_STEPS = 255;
