import { useMemo, useState } from 'react';
import {
  fromZonedInput,
  toZonedInput,
  applyProtocol,
  defaultConfig,
  AUDIO_MAX_CLIP_LENGTH_SECONDS,
  AUDIO_MIN_CLIP_LENGTH_SECONDS,
  AUDIO_RECORDING_MODES,
  AUDIO_SAMPLE_RATES_HZ,
  BATTERY_CUTOFF_MAX_MV,
  LEDS_MAX_ACTIVE_SECONDS,
  MAGNET_VALIDATION_MAX_MS,
  MAGNET_VALIDATION_MIN_MS,
  achievableSampleRate,
  inexactRates,
  maxFrequencyCeilingHz,
  DEVICE_LABEL_MAX_LEN,
  IMU_MOTION_THRESHOLD_MAX_MG,
  IMU_MOTION_THRESHOLD_MIN_MG,
  IMU_RECORDING_MODES,
  IMU_SAMPLE_RATES_HZ,
  MIC_AMPLIFICATION_DIGITAL_STEP_DB,
  MIC_AMPLIFICATION_MIN_DB,
  micAmplificationMaxDb,
  MIC_TYPES,
  AUDIO_SCHEDULE_TYPES,
  MAX_AUDIO_TRIGGER_TIMES,
  TIME_SCALES,
  type AudioScheduleType,
  TIME_SCALE_SECONDS,
  VHF_MODES,
  describeThreshold,
  wiperToStoredFraction,
  forecast,
  formatAllocationUnit,
  formatCommandFor,
  recommendAllocationUnit,
  serializeConfig,
  summariseAudio,
  summariseDevice,
  summariseMotion,
  summariseSchedule,
  extendClipApplies,
  validateConfig,
  type DeploymentConfig,
  type PhaseConfig,
  type ValidationIssue,
} from '@a3em/config-schema';
import { downloadConfig, writeConfig, CARD_ACCESS_SUPPORTED } from '../lib/card';
import { RecordingPeriods, SolarRecordingPeriods } from '../components/RecordingPeriods';
import { AudioFilter, SilenceDetection } from '../components/SilenceDetection';
import { PhaseTimeline } from '../components/PhaseTimeline';
import { TimezoneField } from '../components/TimezoneField';
import type { useCard } from '../lib/useCard';
import type { useDeploymentDraft } from '../lib/useDraft';
import type { useProtocols } from '../lib/useProtocols';
import { ProtocolLibrary } from '../components/ProtocolLibrary';
import { ProtocolSave } from '../components/ProtocolSave';
import { Pane } from '../components/Pane';

type Card = ReturnType<typeof useCard>;

/**
 * The deployment editor.
 *
 * Terminology is technical rather than conversational, per the ecologist feedback:
 * practitioners already share a vocabulary with other acoustic loggers, and inventing a
 * friendlier one makes the tool harder to talk about, not easier. Every field carries
 * help text explaining what changing it does.
 */
export function DeploymentEditor({
  card,
  config,
  onChange: setConfig,
  selectedPhase,
  onSelectPhase: setSelectedPhase,
  draft,
  library,
}: Readonly<{
  card: Card;
  config: DeploymentConfig;
  onChange: (config: DeploymentConfig) => void;
  selectedPhase: number;
  onSelectPhase: (index: number) => void;
  draft: ReturnType<typeof useDeploymentDraft>;
  library: ReturnType<typeof useProtocols>;
}>) {
  // Transient, so it belongs here rather than being hoisted with the draft.
  const [writeState, setWriteState] = useState<'idle' | 'writing' | 'written' | 'error'>('idle');
  const [writeError, setWriteError] = useState<string | null>(null);

  const phaseIndex = Math.min(selectedPhase, config.phases.length - 1);
  const phase = config.phases[phaseIndex];
  const issues = useMemo(() => validateConfig(config, card.targetFirmware), [config, card.targetFirmware]);
  /*
    The card and battery the forecast is run against.

    Not part of the deployment configuration — the device is never told either — but they
    change every number in the panel, so they belong to the person reading it rather than
    being fixed at the one combination we happened to assume.
  */
  const [sdCardCapacityGb, setSdCardCapacityGb] = useState(128);
  const [customCard, setCustomCard] = useState(false);
  const [batteryCapacityMah, setBatteryCapacityMah] = useState(7000);
  const plan = useMemo(
    () => forecast({ config, firmware: card.targetFirmware, sdCardCapacityGb, batteryCapacityMah }),
    [config, card.targetFirmware, sdCardCapacityGb, batteryCapacityMah],
  );
  /**
   * Which allocation unit this deployment wants, and whether the connected card has it.
   *
   * Weighted by the clips each phase contributes, because a card has one cluster size but
   * a deployment can write six different file sizes into it. The capacity matches the
   * forecast's assumption so the two panels do not disagree about the card.
   */
  const allocation = useMemo(
    () =>
      recommendAllocationUnit({
        config,
        clipsPerPhase: plan.perPhase.map((phase) => phase.clipsPerDay),
        cardCapacityBytes: card.deviceInfo?.cardCapacityBytes ?? 128 * 1024 ** 3,
        actualUnitBytes: card.deviceInfo?.cardAllocationUnitBytes ?? null,
      }),
    [config, plan, card.deviceInfo],
  );
  const blocking = issues.filter((issue) => issue.severity === 'error');

  // Recomputed per render because it depends on the microphone as well as the rate.
  const clock = achievableSampleRate(phase.audioSampleRateHz, config.micType);
  const inexact = useMemo(() => inexactRates(AUDIO_SAMPLE_RATES_HZ, config.micType), [config.micType]);

  const update = (patch: Partial<DeploymentConfig>) => setConfig({ ...config, ...patch });
  const updatePhase = (patch: Partial<typeof phase>) =>
    setConfig({
      ...config,
      phases: config.phases.map((existing, index) =>
        index === phaseIndex ? { ...existing, ...patch } : existing,
      ),
    });

  // Issues are reported against a phase index, so only the ones for the phase on screen
  // should mark its fields.
  // Errors only. A warning is advice about a valid setting, and painting the field red for
  // one made a deliberate choice — a zero battery cutoff, say — look like a mistake.
  const issueFor = (field: string) =>
    issues.some(
      (issue) => issue.path === `phases.${phaseIndex}.${field}` && issue.severity === 'error',
    );

  const loadFromCard = () => {
    if (card.existingConfig) setConfig(card.existingConfig);
  };

  const write = async () => {
    setWriteState('writing');
    setWriteError(null);
    try {
      const text = serializeConfig(config);
      if (card.handle) {
        await writeConfig(card.handle, text);
      } else {
        downloadConfig(text);
      }
      setWriteState('written');
    } catch (error) {
      setWriteState('error');
      setWriteError(error instanceof Error ? error.message : String(error));
    }
  };

  const useProtocol = (protocol: Parameters<typeof library.update>[0]) => {
    setConfig(applyProtocol(config, protocol));
    draft.noteBasis(protocol);
  };

  return (
    <div className="editor-layout">
      <div className="stack">
        {/*
          Ahead of the protocol picker deliberately. Applying a protocol replaces every
          recording setting, so an offer to load what the card already holds is worth
          seeing BEFORE the thing that would overwrite it, not after.
        */}
        {card.existingConfig ? (
          <div className="banner">
            <strong>This card already holds a configuration</strong>
            <button className="btn" style={{ marginTop: 8 }} onClick={loadFromCard}>
              Load it into the editor
            </button>
          </div>
        ) : null}

        <ProtocolLibrary
          config={config}
          protocols={library.protocols}
          basedOn={draft.basedOn}
          onApply={useProtocol}
          onDetach={draft.clearBasis}
          onStartBlank={() => {
            setConfig(blankConfig(config));
            draft.clearBasis();
          }}
          onRemove={(id) => {
            library.remove(id);
            // The deployment keeps its settings; only the claim to be "based on"
            // something that no longer exists is dropped.
            if (draft.basedOn?.protocolId === id) draft.clearBasis();
          }}
        />

        <Pane id="device-details" title="Device details" note={summariseDevice(config)}>
          {card.deviceInfo ? (
            <p className="hint">
              Connected device reports firmware <strong>{card.deviceInfo.firmwareVersion}</strong>.
            </p>
          ) : null}

          <div className="field">
            <label htmlFor="label">Device label</label>
            <input
              id="label"
              value={config.deviceLabel}
              maxLength={DEVICE_LABEL_MAX_LEN}
              aria-invalid={issues.some((issue) => issue.path === 'deviceLabel' && issue.severity === 'error')}
              onChange={(event) => update({ deviceLabel: event.target.value })}
            />
            <p className="help">Up to {DEVICE_LABEL_MAX_LEN} characters with no slashes or colons.</p>
          </div>

          <div className="row">
            <div className="field">
              <label htmlFor="mic">Microphone type</label>
              <select id="mic" value={config.micType} onChange={(event) => update({ micType: event.target.value as never })}>
                {Object.entries(MIC_TYPES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="help">Only analog microphones support amplitude-threshold recording.</p>
            </div>
            <div className="field">
              <label htmlFor="gain">Gain (dB)</label>
              <input
                id="gain"
                type="number"
                min={MIC_AMPLIFICATION_MIN_DB}
                max={micAmplificationMaxDb(config.micType)}
                step={config.micType === 'DIGITAL' ? MIC_AMPLIFICATION_DIGITAL_STEP_DB : 0.5}
                value={config.micAmplificationDb}
                aria-invalid={issues.some(
                  (issue) => issue.path === 'micAmplificationDb' && issue.severity === 'error',
                )}
                onChange={(event) => update({ micAmplificationDb: Number(event.target.value) })}
              />
              <p className="help">Higher settings raise faint calls and the noise floor together.</p>
            </div>
          </div>

          <div className="row">
            <div className="field">
              <label htmlFor="leds">Indicator LEDs</label>
              <select
                id="leds"
                value={config.ledsEnabled ? 'on' : 'off'}
                onChange={(event) => update({ ledsEnabled: event.target.value === 'on' })}
              >
                <option value="on">Enabled</option>
                <option value="off">Disabled</option>
              </select>
              <p className="help">
                {config.ledsEnabled
                  ? 'The device visually signals activation, audio clip recording progress, and errors.'
                  : 'The device provides no visual feedback at all.'}
              </p>
            </div>
            {config.ledsEnabled ? (
              <div className="field">
                <label htmlFor="leds-seconds">LEDs stay active for (s)</label>
                <input
                  id="leds-seconds"
                  type="number"
                  min={0}
                  max={LEDS_MAX_ACTIVE_SECONDS}
                  step={30}
                  value={config.ledsActiveSeconds}
                  aria-invalid={issues.some((issue) => issue.path === 'ledsActiveSeconds' && issue.severity === 'error')}
                  onChange={(event) => update({ ledsActiveSeconds: Number(event.target.value) })}
                />
                <p className="help">
                  Counted from activation. After this, the LEDs go dark for the rest of the
                  deployment, so they draw neither attention nor power.
                </p>
              </div>
            ) : null}
          </div>

          <div className="row">
            <div className="field">
              <label htmlFor="magnet-validation">Magnet hold time (ms)</label>
              <input
                id="magnet-validation"
                type="number"
                min={MAGNET_VALIDATION_MIN_MS}
                max={MAGNET_VALIDATION_MAX_MS}
                step={500}
                value={config.magnetValidationMs}
                aria-invalid={issues.some((issue) => issue.path === 'magnetValidationMs' && issue.severity === 'error')}
                onChange={(event) => update({ magnetValidationMs: Number(event.target.value) })}
              />
              <p className="help">
                How long the magnet must be held before the device accepts it. Longer settings make an
                accidental activation or shutdown in transit less likely.
              </p>
            </div>
            <div className="field">
              <label htmlFor="battery-cutoff">Low-battery cutoff (mV)</label>
            <input
              id="battery-cutoff"
              type="number"
              min={0}
              max={BATTERY_CUTOFF_MAX_MV}
              step={50}
              value={config.batteryLowMv}
              aria-invalid={issues.some((issue) => issue.path === 'batteryLowMv' && issue.severity === 'error')}
              onChange={(event) => update({ batteryLowMv: Number(event.target.value) })}
            />
            <p className="help">
              {config.batteryLowMv === 0 ? (
                <>
                  Disabled — the device will record until the battery cannot power it, and the final
                  clip will be cut off whenever that happens.
                </>
              ) : (
                <>
                  The deployment ends gracefully once the battery drops below this value. Set to 0 to
                  record to exhaustion.
                </>
              )}
              </p>
            </div>
          </div>
        </Pane>
        <Pane id="schedule" title="Schedule" note={summariseSchedule(config)}>
          <div className="row">
            <TimezoneField value={config.timezone} onChange={(timezone) => update({ timezone })} />
            <div className="field">
              <label htmlFor="start">Start</label>
              <input
                id="start"
                type="datetime-local"
                value={toZonedInput(config.startTime, config.timezone)}
                onChange={(event) => update({ startTime: fromZonedInput(event.target.value, config.timezone) })}
              />
              <p className="help">Deployment local time.</p>
            </div>
            <div className="field">
              <label htmlFor="end">End</label>
              <input
                id="end"
                type="datetime-local"
                value={toZonedInput(config.endTime, config.timezone)}
                aria-invalid={issues.some((issue) => issue.path === 'endTime' && issue.severity === 'error')}
                onChange={(event) => update({ endTime: fromZonedInput(event.target.value, config.timezone) })}
              />
              <p className="help">Deployment local time.</p>
            </div>
          </div>

          <div className="field">
            <label htmlFor="vhf">VHF beacon</label>
            <select id="vhf" value={config.vhfMode} onChange={(event) => update({ vhfMode: event.target.value as never })}>
              {Object.entries(VHF_MODES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="help">{VHF_HELP[config.vhfMode]}</p>
          </div>

          {/*
            SCHEDULED writes VHF_RADIO_START_TIME from this field. Without it the mode was
            selectable but had no time to act on, so the beacon silently took the
            deployment end — the same as the mode beside it.
          */}
          {config.vhfMode === 'SCHEDULED' ? (
            <div className="field">
              <label htmlFor="vhf-start">Beacon starts at</label>
              <input
                id="vhf-start"
                type="datetime-local"
                value={toZonedInput(config.vhfStartTime, config.timezone)}
                onChange={(event) =>
                  update({ vhfStartTime: fromZonedInput(event.target.value, config.timezone) })
                }
              />
              <p className="help">Deployment local time.</p>
            </div>
          ) : null}
        </Pane>
        <PhaseTimeline
          config={config}
          selectedIndex={phaseIndex}
          onSelect={setSelectedPhase}
          onChange={setConfig}
        />
        {/*
          One selector for everything below it, rather than a copy inside each pane.
          Placed directly under the phase list it refers to and styled as a band rather
          than a card, so it reads as a heading over the panes that follow instead of as
          another setting of its own.
        */}
        {config.isPhased && config.phases.length > 1 ? (
          <div className="phase-scope">
            <label htmlFor="phase-scope">Editing phase</label>
            <select
              id="phase-scope"
              value={phaseIndex}
              onChange={(event) => setSelectedPhase(Number(event.target.value))}
            >
              {config.phases.map((entry, index) => (
                <option key={`${entry.name}-${index}`} value={index}>
                  {entry.name || `Phase ${index + 1}`}
                </option>
              ))}
            </select>
            <span>Every setting below belongs to this phase alone.</span>
          </div>
        ) : null}
        <Pane
          id="audio-details"
          title={`Audio recording details${config.isPhased ? ` — ${phase.name}` : ''}`}
          note={summariseAudio(phase)}
        >
          <div className="row">
            <div className="field">
              <label htmlFor="mode">Recording mode</label>
              <select
                id="mode"
                value={phase.audioRecordingMode}
                aria-invalid={issueFor('audioRecordingMode')}
                onChange={(event) => updatePhase({ audioRecordingMode: event.target.value as never })}
              >
                {Object.entries(AUDIO_RECORDING_MODES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="help">{MODE_HELP[phase.audioRecordingMode]}</p>
            </div>
            <div className="field">
              <label htmlFor="rate">Sample rate (kHz)</label>
              <select
                id="rate"
                value={phase.audioSampleRateHz}
                disabled={phase.useOpusEncoding}
                onChange={(event) => {
                  const nextRate = Number(event.target.value);
                  const wasCeiling = maxFrequencyCeilingHz(phase.audioSampleRateHz);
                  const nowCeiling = maxFrequencyCeilingHz(nextRate);
                  /*
                    Carry the frequency ceilings down with the rate when they were never
                    chosen — a value still sitting exactly on the old rate's ceiling IS the
                    ceiling, not a preference. Without this, dropping to 8 kHz warned that
                    a number the user had never typed no longer fit. A deliberately chosen
                    value is left alone and still warns, with its one-click fix.
                  */
                  updatePhase({
                    audioSampleRateHz: nextRate,
                    ...(phase.maxFrequencyHz === wasCeiling ? { maxFrequencyHz: nowCeiling } : {}),
                    ...(phase.audioFilterHighHz === wasCeiling ? { audioFilterHighHz: nowCeiling } : {}),
                  });
                }}
              >
                {AUDIO_SAMPLE_RATES_HZ.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate / 1000}
                    {inexact.has(rate) ? ' (approximate)' : ''}
                  </option>
                ))}
              </select>
              <p className="help">
                {phase.useOpusEncoding
                  ? 'Opus recording always runs at 48 kHz.'
                  : `Records frequencies up to ${phase.audioSampleRateHz / 2000} kHz.`}
              </p>
              {!phase.useOpusEncoding && !clock.exact && clock.reachable ? (
                // Which rates a device can hit exactly depends on which microphone it
                // has, so this is answered for the microphone actually chosen rather
                // than as a fixed list.
                <p className="help">
                  This microphone cannot produce exactly {phase.audioSampleRateHz / 1000} kHz. It will
                  record at <strong>{clock.actualHz.toLocaleString()} Hz</strong> —{' '}
                  {Math.abs(clock.errorFraction * 100).toFixed(2)}%{' '}
                  {clock.errorFraction > 0 ? 'fast' : 'slow'} — and label the files with that rate, so
                  nothing is mislabelled. Choose another rate if the exact figure matters to your analysis.
                </p>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="clip">Clip length (s)</label>
              <input
                id="clip"
                type="number"
                min={AUDIO_MIN_CLIP_LENGTH_SECONDS}
                max={AUDIO_MAX_CLIP_LENGTH_SECONDS}
                value={phase.audioClipLengthSeconds}
                aria-invalid={issueFor('audioClipLengthSeconds')}
                onChange={(event) => updatePhase({ audioClipLengthSeconds: Number(event.target.value) })}
              />
              <p className="help">Each clip becomes one file on the card.</p>
            </div>
          </div>

          {phase.audioRecordingMode === 'AMPLITUDE' ? (
            <div className="row">
              <div className="field">
                <label htmlFor="threshold">Amplitude threshold</label>
                <input
                  id="threshold"
                  type="range"
                  min={1}
                  max={255}
                  value={Math.max(1, describeThreshold(phase.audioTriggerThreshold).wiper)}
                  onChange={(event) =>
                    // wiperToStoredFraction, not the arithmetic inline: at the top of the
                    // range (255 + 0.5) / 255 is 1.002, which the validator rejects as
                    // "not a fraction of full scale" — so the loudest setting the slider
                    // offers reported an error. The helper clamps the top step to 1.
                    updatePhase({ audioTriggerThreshold: wiperToStoredFraction(Number(event.target.value)) })
                  }
                />
                <p className="help">
                  The minimum amplitude to trigger a recording: {describeThreshold(phase.audioTriggerThreshold).label}
                </p>
              </div>
              <div className="field">
                <label htmlFor="cap">Maximum clips</label>
                <input
                  id="cap"
                  type="number"
                  min={0}
                  value={phase.maxAudioClips}
                  aria-invalid={issueFor('maxAudioClips')}
                  onChange={(event) => updatePhase({ maxAudioClips: Number(event.target.value) })}
                />
                <p className="help">Per hour. Zero means no limit.</p>
              </div>
            </div>
          ) : null}

          {phase.audioRecordingMode === 'INTERVAL' ? (
            <div className="row">
              <div className="field">
                <label htmlFor="interval">Record one clip every</label>
                <input
                  id="interval"
                  type="number"
                  min={1}
                  value={phase.audioTriggerInterval}
                  aria-invalid={issueFor('audioTriggerInterval')}
                  onChange={(event) => updatePhase({ audioTriggerInterval: Number(event.target.value) })}
                />
                <p className="help">
                  {Math.max(
                    0,
                    phase.audioTriggerInterval * (TIME_SCALE_SECONDS[phase.audioTriggerIntervalTimeScale] ?? 1) -
                      phase.audioClipLengthSeconds,
                  )}
                  s of sleep between clips.
                </p>
              </div>
              <div className="field">
                <label htmlFor="interval-scale">Units</label>
                <select
                  id="interval-scale"
                  value={phase.audioTriggerIntervalTimeScale}
                  onChange={(event) => updatePhase({ audioTriggerIntervalTimeScale: event.target.value as never })}
                >
                  {Object.entries(TIME_SCALES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}s
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {phase.audioRecordingMode === 'SCHEDULED' ? (
            <>
              {/*
                Clock or sun, chosen before anything below it.

                They are genuinely different settings rather than two spellings of one — a clock
                schedule is fixed for the deployment, a solar schedule is recomputed by the device
                every day and needs a position — so only the controls belonging to the chosen one
                are shown. Offering both at once was what made this pane hard to read.
              */}
              <div className="field">
                <label htmlFor="schedule-type">Recording periods based on</label>
                <select
                  id="schedule-type"
                  value={phase.audioScheduleType}
                  onChange={(event) =>
                    updatePhase({ audioScheduleType: event.target.value as AudioScheduleType })
                  }
                >
                  {Object.entries(AUDIO_SCHEDULE_TYPES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <p className="help">
                  {phase.audioScheduleType === 'SOLAR'
                    ? 'The device recomputes sunrise and sunset every day from its position, so the windows follow the season.'
                    : 'Records at fixed times of day every day.'}
                </p>
              </div>

              {phase.audioScheduleType === 'SOLAR' ? (
                <SolarRecordingPeriods
                  windows={phase.audioSolarWindows}
                  onChange={(audioSolarWindows) => updatePhase({ audioSolarWindows })}
                  latitude={config.latitude}
                  longitude={config.longitude}
                  onPositionChange={(position) => setConfig({ ...config, ...position })}
                  timezone={config.timezone}
                  startTime={config.startTime}
                  endTime={config.endTime}
                  invalidLatitude={issues.some((issue) => issue.path === 'latitude')}
                  invalidLongitude={issues.some((issue) => issue.path === 'longitude')}
                />
              ) : null}

              <RecordingPeriods
                windows={phase.audioTriggerTimes}
                invalid={issueFor('audioTriggerTimes')}
                timezone={config.timezone}
                label={phase.audioScheduleType === 'SOLAR' ? 'Fallback recording periods' : 'Recording periods'}
                help={
                  phase.audioScheduleType === 'SOLAR'
                    ? `Used only on days the sun gives no usable window, such as an Arctic summer. At most ${MAX_AUDIO_TRIGGER_TIMES}.`
                    : undefined
                }
                emptyMessage={
                  phase.audioScheduleType === 'SOLAR'
                    ? 'No fallback recording periods scheduled.'
                    : undefined
                }
                onChange={(audioTriggerTimes) => updatePhase({ audioTriggerTimes })}
              />
            </>
          ) : null}

          {extendClipApplies(phase) ? (
            <div className="field inline">
              <input
                id="extend-clip"
                type="checkbox"
                checked={phase.extendClipIfContinuousAudio}
                style={{ width: 'auto' }}
                aria-invalid={issueFor('extendClipIfContinuousAudio')}
                onChange={(event) =>
                  updatePhase({ extendClipIfContinuousAudio: event.target.checked })
                }
              />
              <label htmlFor="extend-clip">
                Continue recording while the sound lasts
              </label>
              <p className="help">{describeExtension(phase)}</p>
            </div>
          ) : null}

          <div className="field inline">
            <input
              id="opus"
              type="checkbox"
              checked={phase.useOpusEncoding}
              style={{ width: 'auto' }}
              onChange={(event) => updatePhase({ useOpusEncoding: event.target.checked })}
            />
            <label htmlFor="opus">Opus compression</label>
            <p className="help">Roughly eight times smaller than WAV.</p>
          </div>
        </Pane>
        <Pane
          id="motion-details"
          title={`Motion recording details${config.isPhased ? ` — ${phase.name}` : ''}`}
          note={summariseMotion(phase)}
        >
          <div className="row">
            <div className="field">
              <label htmlFor="imu-mode">IMU mode</label>
              <select
                id="imu-mode"
                value={phase.imuRecordingMode}
                onChange={(event) => updatePhase({ imuRecordingMode: event.target.value as never })}
              >
                {Object.entries(IMU_RECORDING_MODES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="help">{IMU_MODE_HELP[phase.imuRecordingMode]}</p>
            </div>
            {phase.imuRecordingMode === 'NONE' ? null : (
              <div className="field">
                <label htmlFor="imu-rate">IMU sample rate (Hz)</label>
                <select
                  id="imu-rate"
                  value={phase.imuSampleRateHz}
                  onChange={(event) => updatePhase({ imuSampleRateHz: Number(event.target.value) })}
                >
                  {IMU_SAMPLE_RATES_HZ.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {phase.imuRecordingMode === 'ACTIVITY' ? (
              <div className="field">
                <label htmlFor="imu-threshold">Motion threshold (mg)</label>
                <input
                  id="imu-threshold"
                  type="number"
                  min={Math.ceil(IMU_MOTION_THRESHOLD_MIN_MG)}
                  max={IMU_MOTION_THRESHOLD_MAX_MG}
                  value={phase.imuTriggerThresholdMg}
                  aria-invalid={issueFor('imuTriggerThresholdMg')}
                  onChange={(event) => updatePhase({ imuTriggerThresholdMg: Number(event.target.value) })}
                />
                <p className="help">
                  The device rounds this to the nearest 7.8 mg step.
                </p>
              </div>
            ) : null}
          </div>
        </Pane>
        <AudioFilter
          phase={phase}
          effectiveSampleRateHz={phase.useOpusEncoding ? 48000 : phase.audioSampleRateHz}
          onChange={updatePhase}
          invalidLow={issueFor('audioFilterLowHz')}
          phaseName={config.isPhased ? phase.name : null}
        />

        <SilenceDetection
          phase={phase}
          effectiveSampleRateHz={phase.useOpusEncoding ? 48000 : phase.audioSampleRateHz}
          onChange={updatePhase}
          invalidMin={issueFor('minFrequencyHz')}
          invalidMax={issueFor('maxFrequencyHz')}
          phaseName={config.isPhased ? phase.name : null}
        />


      </div>

      <Forecast
        plan={plan}
        allocation={allocation}
        sdCardCapacityGb={sdCardCapacityGb}
        onSdCardCapacityChange={setSdCardCapacityGb}
        customCard={customCard}
        onCustomCardChange={setCustomCard}
        batteryCapacityMah={batteryCapacityMah}
        onBatteryCapacityChange={setBatteryCapacityMah}
        issues={issues}
        blocking={blocking.length}
        onWrite={write}
        writeState={writeState}
        writeError={writeError}
        hasCard={Boolean(card.handle)}
        protocolPanel={
          <ProtocolSave
            config={config}
            protocols={library.protocols}
            basedOn={draft.basedOn}
            onSaveNew={(name, description) => draft.noteBasis(library.save(config, { name, description }))}
            onSaveOver={(protocol) => draft.noteBasis(library.update(protocol, config))}
          />
        }
      />
    </div>
  );
}

const IMU_MODE_HELP: Record<string, string> = {
  NONE: 'No motion data is recorded.',
  ACTIVITY: 'Records motion whenever the device is disturbed.',
  AUDIO: 'Records motion alongside every audio clip.',
};

/**
 * Both halves of "used / total" in the same unit.
 *
 * The numerator was always rendered in GB, so a 1 TB card read "337 / 1 TB" — two numbers
 * that cannot be compared by eye, which is the entire job of that line.
 */
function formatCapacity(gb: number): string {
  return gb >= 1024 ? `${(gb / 1024).toFixed(gb % 1024 === 0 ? 0 : 1)} TB` : `${gb} GB`;
}

function formatCapacityValue(usedGb: number, totalGb: number): string {
  if (totalGb < 1024) return usedGb.toFixed(0);
  const tb = usedGb / 1024;
  // Below a tenth of a terabyte a single decimal reads as zero, so give it two.
  return tb.toFixed(tb < 0.1 ? 2 : 1);
}

/** Card sizes people actually deploy; anything else goes in the custom box. */
const SD_CARD_SIZES_GB = [32, 64, 128, 256, 512, 1024];

/**
 * Says, in the user's own numbers, how long an extended recording can actually run.
 *
 * The bound is not a separate setting: each further clip length spends one clip from the
 * allowance above, so "60 clips of 10 s per hour" means at most 600 s of audio per hour
 * however it ends up divided. Showing that arithmetic is the difference between a checkbox
 * that reads as "record indefinitely" and one that reads as what it does.
 */
/**
 * What actually ends an extended clip.
 *
 * FIRMWARE: `audio_sound_continues()` checks the silence filter FIRST and returns on it,
 * so once a silence threshold is set the trigger level plays no part in deciding whether
 * to keep going — the band does. Reasonable to expect the slider directly above to govern
 * this, so the wording says outright which one is in charge.
 */

function describeExtension(phase: PhaseConfig): string {
  const usesSilence = phase.silenceThreshold > 0;
  const stops = usesSilence
    ? `once the ${phase.minFrequencyHz}–${phase.maxFrequencyHz} Hz silence detection band falls quiet`
    : 'once the sound drops back below the trigger level';
  const precedence = usesSilence
    ? ' When silence detection is used, it takes precedence over the amplitude trigger level as a ' +
      'stop condition.'
    : '';
  if (phase.maxAudioClips <= 1) {
    return (
      `The recording stops ${stops}.${precedence} With an allowance of one clip there is nothing ` +
      `to extend into, so recordings stop at ${phase.audioClipLengthSeconds} s regardless.`
    );
  }
  return `Recording continues in ${phase.audioClipLengthSeconds} s steps and stops ${stops}.${precedence}`;
}

const VHF_HELP: Record<string, string> = {
  NEVER: 'A VHF beacon is not configured for this deployment.',
  END: 'Starts when the deployment ends and runs continuously until the battery is exhausted.',
  SCHEDULED: 'Starts at the time set below and runs continuously until the battery is exhausted.',
};

const MODE_HELP: Record<string, string> = {
  AMPLITUDE: 'Records only when sound crosses a threshold. Requires an analog microphone.',
  SCHEDULED: 'Records during set periods of the day, repeating daily.',
  INTERVAL: 'Alternates sleeping and recording. The clip length is the recording duration.',
  CONTINUOUS: 'Records without stopping, segmented into clips.',
};

function Forecast({
  plan,
  issues,
  sdCardCapacityGb,
  onSdCardCapacityChange,
  customCard,
  onCustomCardChange,
  batteryCapacityMah,
  onBatteryCapacityChange,
  blocking,
  onWrite,
  allocation,
  writeState,
  writeError,
  hasCard,
  protocolPanel,
}: Readonly<{
  plan: ReturnType<typeof forecast>;
  allocation: ReturnType<typeof recommendAllocationUnit>;
  issues: ValidationIssue[];
  sdCardCapacityGb: number;
  onSdCardCapacityChange: (gb: number) => void;
  customCard: boolean;
  onCustomCardChange: (custom: boolean) => void;
  batteryCapacityMah: number;
  onBatteryCapacityChange: (mah: number) => void;
  blocking: number;
  onWrite: () => void;
  writeState: string;
  writeError: string | null;
  hasCard: boolean;
  /** Saving lives here so it stays on screen beside the action that ends the task. */
  protocolPanel: React.ReactNode;
}>) {
  const usedPercent = Math.min(100, plan.cardUsedFraction * 100);
  const fillsEarly = plan.cardFullAt !== null;

  return (
    <div className="stack" style={{ position: 'sticky', top: 'calc(var(--topbar-h, 57px) + var(--content-top, 26px))' }}>
      <Pane
        id="forecast"
        title="Deployment forecast"
        // The two things this panel is consulted for. Both turn amber when they run out
        // before the deployment does, so a shut pane still shows a problem.
        note={
          <>
            <span className={fillsEarly ? 'warn' : undefined}>
              {(plan.totalBytes / 1024 ** 3).toFixed(0)}/{sdCardCapacityGb} GB
            </span>
            {' · '}
            <span className={plan.batteryDays < plan.deploymentDays ? 'warn' : undefined}>
              {Number.isFinite(plan.batteryDays) ? `${plan.batteryDays.toFixed(0)} d battery` : 'no drain'}
            </span>
          </>
        }
      >
        <p className="hint">Select the SD card and battery you intend to deploy</p>
        <div className="row forecast-hardware">
          <div className="field">
            <label htmlFor="forecast-card">SD card</label>
            <select
              id="forecast-card"
              value={customCard ? 'custom' : String(sdCardCapacityGb)}
              onChange={(event) => {
                const custom = event.target.value === 'custom';
                onCustomCardChange(custom);
                if (!custom) onSdCardCapacityChange(Number(event.target.value));
              }}
            >
              {SD_CARD_SIZES_GB.map((size) => (
                <option key={size} value={size}>
                  {size >= 1024 ? `${size / 1024} TB` : `${size} GB`}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </div>
          {customCard ? (
            <div className="field">
              <label htmlFor="forecast-card-gb">Card size (GB)</label>
              <input
                id="forecast-card-gb"
                type="number"
                min={1}
                step={1}
                value={sdCardCapacityGb}
                onChange={(event) => onSdCardCapacityChange(Math.max(1, Number(event.target.value)))}
              />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="forecast-battery">Battery (mAh)</label>
            <input
              id="forecast-battery"
              type="number"
              min={100}
              step={100}
              value={batteryCapacityMah}
              onChange={(event) => onBatteryCapacityChange(Math.max(100, Number(event.target.value)))}
            />
          </div>
        </div>

        {/* Per-day framing first, as other loggers present it — it is the figure people
            actually reason with when choosing a card size or a battery pack.

            With phases there is no such thing as a typical day, so the sentence says
            plainly that it is an average. Every figure here is weighted by how much of
            the deployment each phase covers, which is why a short heavy phase moves the
            average only a little. The per-phase figures behind it are on `plan.perPhase`
            if this ever wants to break them out. */}
        <p className="daily-summary">
          {plan.perPhase.length > 1 ? 'Averaged across all phases, each day produces ' : 'Each day produces '}
          <strong>{Math.round(plan.clipsPerDay).toLocaleString()}</strong> audio clips, totalling{' '}
          <strong>{formatBytes(plan.bytesPerDay)}</strong>. Daily energy consumption will be
          approximately <strong>{(plan.averageCurrentMa * 24).toFixed(0)} mAh</strong>.
        </p>

        <div className="stat-label">Card usage</div>
        <div className="stat-value">
          {formatCapacityValue(plan.totalBytes / 1024 ** 3, sdCardCapacityGb)}
          <span className="muted" style={{ fontSize: '0.6em' }}>
            {' '}
            / {formatCapacity(sdCardCapacityGb)}
          </span>
        </div>
        <div className="meter">
          <i style={{ width: `${usedPercent}%`, background: fillsEarly ? 'var(--warn)' : 'var(--ok)' }} />
        </div>
        <div className="stat-note">
          {fillsEarly
            ? `Will fill on ${plan.cardFullAt!.slice(0, 10)}, before the end date`
            : `Lasts the full ${plan.deploymentDays.toFixed(0)} days`}
        </div>

        <div className="stat-label" style={{ marginTop: 16 }}>Battery</div>
        <div className="stat-value">
          {Number.isFinite(plan.batteryDays) ? plan.batteryDays.toFixed(0) : '—'}
          <span className="muted" style={{ fontSize: '0.6em' }}> days</span>
        </div>
        <div className="stat-note">
          Deployment is {plan.deploymentDays.toFixed(0)} days · {plan.averageCurrentMa.toFixed(2)} mA average
        </div>

        <div className="stat-label" style={{ marginTop: 16 }}>Expected clips</div>
        <div className="stat-value">{plan.totalClips.toLocaleString()}</div>
        <div className="stat-note">
          ≈ {plan.totalAudioHours.toFixed(0)} hours of audio
          {plan.totalAudioHours >= 24 ? ` · about ${(plan.totalAudioHours / 24).toFixed(1)} days` : ''}
          {/* Counted phase by phase, and stopped where the card does — otherwise this
              total would describe more recording than the meter above says fits. */}
          {fillsEarly ? ' · counted only up to the day the card fills' : ''}
        </div>

        <div className="stat-label" style={{ marginTop: 16 }}>Recommended card format</div>
        <div className="stat-value">{formatAllocationUnit(allocation.recommendedBytes)} exFAT</div>
        <div className="stat-note">
          {allocation.summary}
          {allocation.verdict === 'wasteful' || allocation.actualBytes === null ? (
            // Its own line: a shell command run out of a sentence is easy to mis-copy.
            <code style={{ display: 'block', marginTop: 6 }}>
              {formatCommandFor(allocation.recommendedBytes)}
            </code>
          ) : null}
        </div>
        <div className="stat-note" style={{ marginTop: 6 }}>
          {allocation.recommended.writeTransactionsPerClip.toFixed(0)} card writes per clip
          {allocation.recommended.slackFraction > 0
            ? ` · ${(allocation.recommended.slackFraction * 100).toFixed(1)}% of the card lost to underfull blocks`
            : null}
        </div>

        {plan.confidence !== 'measured' ? (
          <p className="stat-note" style={{ marginTop: 14, color: 'var(--warn)' }}>
            These figures rest on values that have not been measured on hardware. Treat them as a guide, not
            a guarantee.
          </p>
        ) : null}
      </Pane>

      {/* Saving is a thing you do with a good configuration, so it sits above the list
          of what is still wrong with it. */}
      {protocolPanel}

      {issues.length ? (
        <div className="card">
          <h2>Readiness</h2>
          <div className="issue-list">
            {issues.map((issue) => (
              <div className={`issue ${issue.severity}`} key={`${issue.path}:${issue.message}`}>
                <span className="marker">{issue.severity === 'error' ? '✕' : '!'}</span>
                <span>
                  {issue.message}
                  {issue.details?.length ? (
                    <ul className="issue-details">
                      {issue.details.map((detail) => (
                        <li key={detail}>{detail}</li>
                      ))}
                    </ul>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="card">
          <h2>Readiness</h2>
          <div className="issue-list">
            <div className="issue" style={{ background: 'var(--ok-wash)', borderColor: 'var(--ok)', color: 'var(--ok)' }}>
              <span className="marker">✓</span>
              <span>Ready to write</span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={blocking > 0 || writeState === 'writing'} onClick={onWrite}>
          {writeState === 'writing' ? 'Writing…' : hasCard ? 'Write to card' : 'Download configuration'}
        </button>
        {blocking > 0 ? (
          <p className="stat-note" style={{ textAlign: 'center', marginTop: 7 }}>
            Fix {blocking} {blocking === 1 ? 'error' : 'errors'} to continue
          </p>
        ) : null}
        {writeState === 'written' ? (
          <p className="stat-note" style={{ textAlign: 'center', marginTop: 7, color: 'var(--ok)' }}>
            {hasCard ? 'Written to the card.' : 'Downloaded — copy it to the card root.'}
          </p>
        ) : null}
        {writeError ? (
          <p className="stat-note" style={{ textAlign: 'center', marginTop: 7, color: 'var(--crit)' }}>{writeError}</p>
        ) : null}
        {!hasCard && CARD_ACCESS_SUPPORTED ? (
          <p className="stat-note" style={{ textAlign: 'center', marginTop: 7 }}>
            Connect a card to write directly.
          </p>
        ) : null}
      </div>

    </div>
  );
}

/**
 * The plain defaults, keeping what belongs to this deployment.
 *
 * Same rule as applying a protocol: the label, dates, and timezone already entered are
 * the user's work and survive, while every recording setting goes back to its default.
 */
function blankConfig(config: DeploymentConfig): DeploymentConfig {
  return {
    ...defaultConfig(config.timezone),
    deviceLabel: config.deviceLabel,
    startTime: config.startTime,
    endTime: config.endTime,
    vhfStartTime: config.vhfStartTime,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} kB`;
}

/** ISO instant to the local wall-clock string a datetime-local input expects. */
