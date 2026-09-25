import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CONFIG_FILE_NAME,
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
  formatStepsFor,
  formatZonedDate,
  forecastIssues,
  formatList,
  dstChangesAffectingSchedule,
  summarizeSchedule as summarizeScheduleLine,
  BYTES_PER_MARKETED_GB,
  recommendAllocationUnit,
  serializeConfig,
  summarizeAudio,
  summarizeDevice,
  summarizeMotion,
  summarizeSchedule,
  extendClipApplies,
  validateConfig,
  type DeploymentConfig,
  type PhaseConfig,
  type ValidationIssue,
  type OffsetChange,
} from '@a3em/config-schema';
import { downloadConfig, writeConfig, CARD_ACCESS_SUPPORTED } from '../lib/card';
import { RecordingPeriods, SolarRecordingPeriods } from '../components/RecordingPeriods';
import { AudioFilter, SilenceDetection } from '../components/SilenceDetection';
import { PhaseTimeline } from '../components/PhaseTimeline';
import { TimezoneField } from '../components/TimezoneField';
import type { useCard } from '../lib/useCard';
import type { CardDevice } from '../lib/useCardDevice';
import type { useDeploymentDraft } from '../lib/useDraft';
import type { useProtocols } from '../lib/useProtocols';
import { ProtocolLibrary } from '../components/ProtocolLibrary';
import { ProtocolSave } from '../components/ProtocolSave';
import { Pane } from '../components/Pane';
import { TabLink, WithTabLinks } from '../components/TabLink';
import { HelperOffer } from '../components/HelperOffer';
import { ZonedDateTimeInput } from '../components/ZonedDateTimeInput';
import { cardChecks as checkCard, type CardCheck } from '../lib/cardChecks';
import { detectOs } from '../lib/hostOs';
import { useConfigurePrepared, type ConfigurePrepared } from '../lib/configurePrepared';
import { loadPrepareFromConfigure } from '../lib/helperViews';
import type { Helper } from '../lib/useHelper';
import { listLabels } from '../lib/batch';

const PrepareFromConfigure = lazy(() => loadPrepareFromConfigure().then((module) => ({ default: module.PrepareFromConfigure })));

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
  cardDevice,
  helper,
  onPrepareDevices,
  batch,
}: Readonly<{
  card: Card;
  config: DeploymentConfig;
  onChange: (config: DeploymentConfig) => void;
  selectedPhase: number;
  onSelectPhase: (index: number) => void;
  draft: ReturnType<typeof useDeploymentDraft>;
  library: ReturnType<typeof useProtocols>;
  /** The physical card the open folder is on, where the card helper can tell. */
  cardDevice?: CardDevice;
  /** The card tools, which prepare the open card rather than only write its configuration. */
  helper?: Helper;
  /** Opens "Prepare devices", where the card tools format cards. */
  onPrepareDevices?: () => void;
  /** The batch on Prepare devices: the labels of its written units, by whether they have these settings. */
  batch?: { current: string[]; outdated: string[] };
}>) {
  // Transient, so it belongs here rather than being hoisted with the draft.
  const [writeState, setWriteState] = useState<'idle' | 'writing' | 'written' | 'error'>('idle');
  const [writeError, setWriteError] = useState<string | null>(null);

  const phaseIndex = Math.min(selectedPhase, config.phases.length - 1);
  const phase = config.phases[phaseIndex];
  /*
    The present, to minute resolution, for the checks that judge a deployment against it —
    an end date already behind us, a start that will stamp every recording in the past.
    Refreshed on a timer so a page left open overnight does not go on judging by yesterday.
  */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const issues = useMemo(
    () => validateConfig(config, card.targetFirmware, { now }),
    [config, card.targetFirmware, now],
  );
  /*
    The card and battery the forecast is run against.

    Not part of the deployment configuration — the device is never told either — but they
    change every number in the panel, so they belong to the person reading it rather than
    being fixed at the one combination we happened to assume.
  */
  const [sdCardCapacityGb, setSdCardCapacityGb] = useState(128);
  const [customCard, setCustomCard] = useState(false);
  const [batteryCapacityMah, setBatteryCapacityMah] = useState(7000);
  /*
    A connected card that reports its size selects the nearest standard one, once per card.

    Adjusted during render rather than in an effect, so the forecast never draws a frame
    for the wrong card. Only when the reported size changes: choosing another size by hand
    afterward is respected.
  */
  const connectedCapacity = card.deviceInfo?.cardCapacityBytes ?? null;
  const [seenCapacity, setSeenCapacity] = useState<number | null>(null);
  if (connectedCapacity !== seenCapacity) {
    setSeenCapacity(connectedCapacity);
    if (connectedCapacity) {
      const gb = connectedCapacity / BYTES_PER_MARKETED_GB;
      const nearest = SD_CARD_SIZES_GB.reduce((best, size) =>
        Math.abs(Math.log(size / gb)) < Math.abs(Math.log(best / gb)) ? size : best,
      );
      setCustomCard(false);
      setSdCardCapacityGb(nearest);
    }
  }
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
        clipsPerPhase: plan.clipWeights,
        cardCapacityBytes: sdCardCapacityGb * BYTES_PER_MARKETED_GB,
        actualUnitBytes: card.deviceInfo?.cardAllocationUnitBytes ?? null,
      }),
    [config, plan, sdCardCapacityGb, card.deviceInfo],
  );
  const blocking = issues.filter((issue) => issue.severity === 'error');
  /*
    Everything Readiness lists: the configuration's own problems, then what the forecast
    says about the card and battery. Errors lead, because only they stop a write.
  */
  const dstChanges = useMemo(() => dstChangesAffectingSchedule(config), [config]);
  const readiness = useMemo(() => {
    const all = [...issues, ...forecastIssues(plan, config.timezone)];
    return [...all.filter((issue) => issue.severity === 'error'), ...all.filter((issue) => issue.severity === 'warning')];
  }, [issues, plan, config.timezone]);
  // The label box is not painted red before anyone has had a chance to type in it.
  const [labelTouched, setLabelTouched] = useState(false);

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

  /*
    Which card a write goes to, stated rather than implied.

    Only a card scanned in this session is written to. A handle remembered from an earlier
    session made the button read "Write to card" with nothing connected, and would have
    written into whatever that folder is now.
  */
  const cardReady = card.status === 'ready' && Boolean(card.handle);
  /*
    What the card helper knows that the folder cannot say: that the recorder would erase this
    card as it is formatted, taking the configuration with it. A warning rather than a refusal,
    since the verdict is about the card, and the configuration may be meant for another one.
  */
  const erasing = cardDevice?.device?.compatibility && !cardDevice.device.compatibility.usable ? cardDevice.device.compatibility : null;
  /*
    With the card tools, and the open folder matched to its card, the card is prepared rather
    than only given its configuration: checked, then set up again where it needs to be.
  */
  const preparing = cardReady && helper?.status === 'ready' && cardDevice?.device ? cardDevice.device : null;
  const checks = useMemo(() => {
    if (!cardReady) return [];
    const found = checkCard(card.contents);
    if (erasing) {
      found.push({
        severity: 'warning',
        message: `The recorder would erase this card when it starts, configuration and all: ${erasing.issues[0]?.message ?? 'its format does not suit the firmware.'} ${
          preparing ? '“Configure SD Card” sets it up again.' : 'Prepare it under “Prepare devices” first.'
        }`,
      });
    }
    return found;
  }, [cardReady, card.contents, erasing, preparing]);
  const [prepared, setPrepared] = useConfigurePrepared();
  const [writtenSummary, setWrittenSummary] = useState<string | null>(null);

  const write = async () => {
    setWriteState('writing');
    setWriteError(null);
    try {
      const text = serializeConfig(config);
      if (cardReady && card.handle) {
        await writeConfig(card.handle, text);
        setWrittenSummary(`Wrote ${config.deviceLabel} · ${summarizeScheduleLine(config)} to ${card.name}.`);
      } else {
        downloadConfig(text);
        setWrittenSummary(null);
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
          A batch partway through. Its units are meant to record alike, and the cards already
          written keep what they got, so this is said first, before anything is changed, and
          more urgently once something has been.
        */}
        {batch?.outdated.length ? (
          <div className="banner crit">
            <strong>
              {batch.outdated.length === 1 ? 'A card' : `${batch.outdated.length} cards`} of your batch{' '}
              {batch.outdated.length === 1 ? 'was' : 'were'} written with different settings
            </strong>
            {listLabels(batch.outdated)} would record differently from devices prepared with the settings as they are now.
            On the <TabLink to="batch" /> page, {batch.outdated.length === 1 ? 'it is' : 'they are'} back to “No card yet”:
            prepare {batch.outdated.length === 1 ? 'its card' : 'their cards'} again, or change the settings back. If
            these settings are for other devices, rebuild the list there to start a new batch.
          </div>
        ) : batch?.current.length ? (
          <div className="banner warn">
            <strong>
              {batch.current.length === 1 ? 'A card' : `${batch.current.length} cards`} of your batch{' '}
              {batch.current.length === 1 ? 'has' : 'have'} been written with these settings
            </strong>
            Changing anything here now would leave {listLabels(batch.current)} recording differently from any device
            prepared afterward. If you do change something, prepare{' '}
            {batch.current.length === 1 ? 'that card' : 'those cards'} again on the <TabLink to="batch" /> page, so every
            device in the batch records the same way.
          </div>
        ) : null}

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
          sync={library.sync}
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

        <Pane id="device-details" title="Device details" note={summarizeDevice(config)}>
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
              aria-invalid={
                (labelTouched || config.deviceLabel !== '') &&
                issues.some((issue) => issue.path === 'deviceLabel' && issue.severity === 'error')
              }
              onBlur={() => setLabelTouched(true)}
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
        <Pane id="schedule" title="Schedule" note={summarizeSchedule(config)}>
          <div className="row">
            <TimezoneField value={config.timezone} onChange={(timezone) => update({ timezone })} />
            <div className="field">
              <label htmlFor="start">Start</label>
              <ZonedDateTimeInput
                id="start"
                value={config.startTime}
                timezone={config.timezone}
                aria-invalid={issues.some((issue) => issue.path === 'startTime' && issue.severity === 'error')}
                onChange={(startTime) => update({ startTime })}
              />
              <p className="help">
                {config.setRtcAtMagnetDetect
                  ? 'Deployment local time. The device sets its clock to this time when it is activated.'
                  : "Deployment local time. Recording begins at this time by the device's own clock."}
              </p>
            </div>
            <div className="field">
              <label htmlFor="end">End</label>
              <ZonedDateTimeInput
                id="end"
                value={config.endTime}
                timezone={config.timezone}
                aria-invalid={issues.some((issue) => issue.path === 'endTime' && issue.severity === 'error')}
                onChange={(endTime) => update({ endTime })}
              />
              <p className="help">Deployment local time.</p>
            </div>
          </div>

          {/*
            SET_RTC_AT_MAGNET_DETECT, surfaced because it decides what the start time MEANS.

            FIRMWARE: main.c seeds the RTC from DEPLOYMENT_START_TIME the moment the magnet
            activates the device, so with this on the start is not when recording begins — it
            is what the clock is set to, and recording begins at activation. With it off the
            device keeps whatever clock it has and waits for the start by that clock.
          */}
          <div className="field inline">
            <input
              id="rtc-at-activation"
              type="checkbox"
              checked={config.setRtcAtMagnetDetect}
              style={{ width: 'auto' }}
              onChange={(event) => update({ setRtcAtMagnetDetect: event.target.checked })}
            />
            <label htmlFor="rtc-at-activation">Set the device clock to the start time at activation</label>
            <p className="help">
              {config.setRtcAtMagnetDetect ? (
                <>
                  When the magnet activates the device, its clock is set to the start time above. Every recorded time is
                  off by however early or late it was activated. Note the exact time each device is activated, and you
                  can correct the times in the <TabLink to="review" /> tab afterward.
                </>
              ) : (
                'The device keeps the clock it already has. After activation, it records one minute for voice ' +
                  'notes, then waits for the start time before recording. Use this only when the clock is already ' +
                  'set, such as on a device with GPS.'
              )}
            </p>
          </div>

          {/*
            Offered only when it would change something: a clock-time recording period in a
            phase that runs across (or after) a change of UTC offset. Everything else — solar
            periods, intervals, continuous recording — is unaffected, so the question would
            only be noise.
          */}
          {dstChanges.length ? (
            <div className="field inline">
              <input
                id="adjust-dst"
                type="checkbox"
                checked={config.adjustForDst !== false}
                style={{ width: 'auto' }}
                onChange={(event) => update({ adjustForDst: event.target.checked })}
              />
              <label htmlFor="adjust-dst">Adjust the schedule for Daylight Saving Time</label>
              <p className="help">{describeDst(dstChanges, config)}</p>
            </div>
          ) : null}

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
              <ZonedDateTimeInput
                id="vhf-start"
                value={config.vhfStartTime}
                timezone={config.timezone}
                onChange={(vhfStartTime) => update({ vhfStartTime })}
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
          note={summarizeAudio(phase)}
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
                  nothing is mislabeled. Choose another rate if the exact figure matters to your analysis.
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
                  min={1}
                  value={phase.maxAudioClips}
                  aria-invalid={issueFor('maxAudioClips')}
                  onChange={(event) => updatePhase({ maxAudioClips: Number(event.target.value) })}
                />
                <p className="help">Per hour, at least 1. The device treats zero as one.</p>
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
                    ? 'The device recomputes sunrise and sunset every day from its position, so the recording periods follow the season.'
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
                  // Errors only, as everywhere else: a warning is advice about a value that may
                  // well be right, and painting the box red made the example coordinates look
                  // malformed when the actual problem was the timezone beside them.
                  invalidLatitude={issues.some((issue) => issue.path === 'latitude' && issue.severity === 'error')}
                  invalidLongitude={issues.some((issue) => issue.path === 'longitude' && issue.severity === 'error')}
                  positionWarning={
                    issues.find((issue) => issue.path === 'longitude' && issue.severity === 'warning')?.message ?? null
                  }
                />
              ) : null}

              <RecordingPeriods
                windows={phase.audioTriggerTimes}
                invalid={issueFor('audioTriggerTimes')}
                timezone={config.timezone}
                label={phase.audioScheduleType === 'SOLAR' ? 'Fallback recording periods' : 'Recording periods'}
                help={
                  phase.audioScheduleType === 'SOLAR'
                    ? `Used only on days the sun gives no usable period, such as an Arctic summer. At most ${MAX_AUDIO_TRIGGER_TIMES}.`
                    : undefined
                }
                emptyMessage={
                  phase.audioScheduleType === 'SOLAR'
                    ? 'No fallback recording periods. On a day the sun gives no usable period, the device would record continuously.'
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
          note={summarizeMotion(phase)}
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
        issues={readiness}
        blocking={blocking.length}
        onWrite={write}
        writeState={writeState}
        writeError={writeError}
        cardTarget={cardReady ? 'ready' : card.status === 'reconnectable' ? 'reconnectable' : 'none'}
        cardName={card.name}
        onReconnect={() => void card.reconnect()}
        cardChecks={checks}
        writtenSummary={writtenSummary}
        preparer={
          preparing && helper ? (
            <Suspense fallback={null}>
              <PrepareFromConfigure
                helper={helper}
                device={preparing}
                cardName={card.name}
                config={config}
                firmware={card.targetFirmware}
                disabled={blocking.length > 0 || checks.some((check) => check.severity === 'error')}
                onSettingsWritten={() => void card.rescan()}
                onErased={(label) => void card.erased(`${card.name ?? 'The card'} was erased and configured as ${label}`)}
                onRenamed={(label) => void card.erased(`${card.name ?? 'The card'} was renamed ${label}`)}
              />
            </Suspense>
          ) : null
        }
        prepared={prepared}
        onDismissPrepared={() => setPrepared(null)}
        helperOffer={
          helper ? (
            <HelperOffer helper={helper} as="note">
              Or let the dashboard do it: with the A3EM Card Helper, a small program with a browser extension, the{' '}
              <TabLink to="batch" /> page formats the card for you, and checks it too.
            </HelperOffer>
          ) : null
        }
        timezone={config.timezone}
        onPrepareDevices={cardDevice?.available ? onPrepareDevices : undefined}
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
      <ForecastDock
        plan={plan}
        sdCardCapacityGb={sdCardCapacityGb}
        errors={readiness.filter((issue) => issue.severity === 'error').length}
        warnings={readiness.filter((issue) => issue.severity === 'warning').length}
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
 * that cannot be compared by eye, which is the entire job of that line. Decimal, like the
 * sizes printed on cards: a 1 TB card is a thousand gigabytes, not 1024.
 */
function formatCapacity(gb: number): string {
  return gb >= 1000 ? `${(gb / 1000).toFixed(gb % 1000 === 0 ? 0 : 1)} TB` : `${gb} GB`;
}

function formatCapacityValue(usedGb: number, totalGb: number): string {
  if (totalGb < 1000) return usedGb.toFixed(0);
  const tb = usedGb / 1000;
  // Below a tenth of a terabyte a single decimal reads as zero, so give it two.
  return tb.toFixed(tb < 0.1 ? 2 : 1);
}

/** Card sizes people actually deploy; anything else goes in the custom box. */
const SD_CARD_SIZES_GB = [32, 64, 128, 256, 512, 1000];

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
  cardTarget,
  cardName,
  onReconnect,
  cardChecks,
  writtenSummary,
  timezone,
  protocolPanel,
  onPrepareDevices,
  preparer,
  prepared,
  onDismissPrepared,
  helperOffer,
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
  /** A card scanned this session, one remembered from before, or nothing. */
  cardTarget: 'ready' | 'reconnectable' | 'none';
  cardName: string | null;
  onReconnect: () => void;
  cardChecks: CardCheck[];
  writtenSummary: string | null;
  /** The deployment's zone, so every date here is the one the device will experience. */
  timezone: string;
  /** Saving lives here so it stays on screen beside the action that ends the task. */
  protocolPanel: React.ReactNode;
  /** With the card tools, where formatting is done: in their place of the manual steps. */
  onPrepareDevices?: () => void;
  /** With the card tools and the card open, "Prepare {card}…", in place of writing its configuration. */
  preparer: ReactNode;
  /** What was last done from here, which outlasts a card erased by it. */
  prepared: ConfigurePrepared | null;
  onDismissPrepared: () => void;
  /** Without the card tools: that with them, the dashboard formats the card itself. */
  helperOffer: ReactNode;
}>) {
  const usedPercent = Math.min(100, plan.cardUsedFraction * 100);
  const fillsEarly = plan.cardFullAt !== null;
  const diesEarly = plan.batteryDeadAt !== null;
  // How much of the battery the deployment would draw, on the same scale as the card meter.
  const batteryPercent = Number.isFinite(plan.batteryDays) && plan.batteryDays > 0
    ? Math.min(100, (plan.deploymentDays / plan.batteryDays) * 100)
    : 0;
  const usedGb = plan.totalBytes / BYTES_PER_MARKETED_GB;
  const formatSteps = formatStepsFor(allocation.recommendedBytes, detectOs());

  let clipsNote = '';
  if (plan.stopsEarlyBecause === 'card') clipsNote = ' · counted only up to the day the card fills';
  if (plan.stopsEarlyBecause === 'battery') clipsNote = ' · counted only up to the day the battery runs out';

  return (
    <div
      id="forecast-column"
      className="stack"
      style={{ position: 'sticky', top: 'calc(var(--topbar-h, 57px) + var(--content-top, 26px))' }}
    >
      <Pane
        id="forecast"
        title="Deployment forecast"
        // The two things this panel is consulted for. Both turn amber when they run out
        // before the deployment does, so a shut pane still shows a problem.
        note={
          <>
            <span className={fillsEarly ? 'warn' : undefined}>
              {formatCapacityValue(usedGb, sdCardCapacityGb)}/{formatCapacity(sdCardCapacityGb)}
            </span>
            {' · '}
            <span className={diesEarly ? 'warn' : undefined}>
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
                  {formatCapacity(size)}
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
            average only a little. */}
        <p className="daily-summary">
          {plan.perPhase.length > 1 ? 'Averaged across all phases, each day produces ' : 'Each day produces '}
          <strong>{Math.round(plan.clipsPerDay).toLocaleString()}</strong> audio clips, totaling{' '}
          <strong>{formatBytes(plan.bytesPerDay)}</strong>. Daily energy consumption will be
          approximately <strong>{(plan.averageCurrentMa * 24).toFixed(0)} mAh</strong>.
        </p>

        <div className="stat-label">Card usage</div>
        <div className="stat-value">
          {formatCapacityValue(usedGb, sdCardCapacityGb)}
          <span className="muted" style={{ fontSize: '0.6em' }}>
            {' '}
            / {formatCapacity(sdCardCapacityGb)}
          </span>
        </div>
        <div className="meter">
          <i style={{ width: `${usedPercent}%`, background: fillsEarly ? 'var(--warn)' : 'var(--ok)' }} />
        </div>
        <div className={`stat-note${fillsEarly ? ' warn-text' : ''}`}>
          {fillsEarly
            ? `Fills on ${formatZonedDate(plan.cardFullAt!, timezone)}, before the end date`
            : plan.stopsEarlyBecause === 'battery'
              ? 'Holds everything recorded before the battery runs out'
              : `Lasts the full ${plan.deploymentDays.toFixed(0)} days`}
        </div>
        <div className="stat-note">
          {formatBytes(plan.cardUsableBytes)} usable once formatted
          {plan.allocationUnitBytes ? ` with ${formatAllocationUnit(plan.allocationUnitBytes)} clusters` : ''}
          {plan.bytesPerDay > 0
            ? ` · each day uses ${formatBytes(plan.cardBytesPerDay)}`
            : ''}
        </div>

        <div className="stat-label" style={{ marginTop: 16 }}>Battery</div>
        <div className="stat-value">
          {Number.isFinite(plan.batteryDays) ? plan.batteryDays.toFixed(0) : '—'}
          <span className="muted" style={{ fontSize: '0.6em' }}> days</span>
        </div>
        <div className="meter">
          <i style={{ width: `${batteryPercent}%`, background: diesEarly ? 'var(--warn)' : 'var(--ok)' }} />
        </div>
        <div className={`stat-note${diesEarly ? ' warn-text' : ''}`}>
          {diesEarly
            ? plan.stopsEarlyBecause === 'battery'
              ? `Runs out on ${formatZonedDate(plan.batteryDeadAt!, timezone)}, before the end date`
              : `Would run out on ${formatZonedDate(plan.batteryDeadAt!, timezone)} if recording continued`
            : `Lasts the full ${plan.deploymentDays.toFixed(0)} days`}
        </div>
        <div className="stat-note">{plan.averageCurrentMa.toFixed(2)} mA average</div>

        <div className="stat-label" style={{ marginTop: 16 }}>Expected clips</div>
        <div className="stat-value">{plan.totalClips.toLocaleString()}</div>
        <div className="stat-note">
          ≈ {plan.totalAudioHours.toFixed(0)} hours of audio
          {plan.totalAudioHours >= 24 ? ` · about ${(plan.totalAudioHours / 24).toFixed(1)} days` : ''}
          {/* Counted phase by phase, and stopped where recording does — otherwise this
              total would describe more recording than the meters above say will happen. */}
          {clipsNote}
        </div>

        <div className="stat-label" style={{ marginTop: 16 }}>Recommended card format</div>
        <div className="stat-value">{formatAllocationUnit(allocation.recommendedBytes)} exFAT</div>
        <div className="stat-note">
          {/* With the card tools, formatting is theirs: one step, done right, instead of commands to type. */}
          {onPrepareDevices && allocation.actualBytes === null ? (
            <>
              Format the card as exFAT with {formatAllocationUnit(allocation.recommendedBytes)} clusters using the{' '}
              <TabLink to="batch" /> page.
            </>
          ) : (
            allocation.summary
          )}
          {onPrepareDevices && allocation.verdict === 'wasteful' ? (
            <>
              {' '}
              Use the <TabLink to="batch" /> page to do it.
            </>
          ) : onPrepareDevices ? null : allocation.verdict === 'wasteful' || allocation.actualBytes === null ? (
            <>
              <ol className="format-steps">
                {formatSteps.map((step) => (
                  <li key={step.detail}>
                    {step.detail}
                    {/* Its own line: a shell command run out of a sentence is easy to mis-copy. */}
                    {step.command ? <code>{step.command}</code> : null}
                  </li>
                ))}
              </ol>
              {helperOffer}
            </>
          ) : null}
        </div>
        <div className="stat-note" style={{ marginTop: 6 }}>
          {allocation.recommended.writeTransactionsPerClip.toFixed(0)} card writes per clip
          {allocation.recommended.slackFraction > 0
            ? ` · ${(allocation.recommended.slackFraction * 100).toFixed(1)}% of the card lost to underfull blocks`
            : null}
        </div>

        {plan.confidence !== 'measured' || plan.caveats.length ? (
          <div className="forecast-caveats">
            {plan.confidence !== 'measured' ? (
              <p className="stat-note warn-text">
                These figures rest on values that have not been measured on hardware. Treat them as a guide,
                not a guarantee.
              </p>
            ) : null}
            {plan.caveats.length ? (
              <ul className="stat-note">
                {plan.caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            ) : null}
          </div>
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
        {cardChecks.map((check) => (
          <p
            key={check.message}
            className="stat-note"
            style={{ marginBottom: 8, color: check.severity === 'error' ? 'var(--crit)' : 'var(--warn)' }}
          >
            <WithTabLinks text={check.message} />
          </p>
        ))}
        {cardTarget === 'reconnectable' ? (
          // The card is only known from an earlier session: reading it again comes first.
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }} onClick={onReconnect}>
            Reconnect {cardName ?? 'the card'} to write to it
          </button>
        ) : null}
        {preparer ?? (
          <button
            className={`btn ${cardTarget === 'reconnectable' ? '' : 'primary'}`}
            style={{ width: '100%', justifyContent: 'center' }}
            disabled={
              blocking > 0 ||
              writeState === 'writing' ||
              cardChecks.some((check) => check.severity === 'error')
            }
            onClick={onWrite}
          >
            {writeState === 'writing'
              ? 'Writing…'
              : cardTarget === 'ready'
                ? `Write to ${cardName ?? 'the card'}`
                : 'Download configuration'}
          </button>
        )}
        {blocking > 0 ? (
          <p className="stat-note" style={{ textAlign: 'center', marginTop: 7 }}>
            Fix {blocking} {blocking === 1 ? 'error' : 'errors'} to continue
          </p>
        ) : null}
        {writeState === 'written' && !preparer ? (
          <p className="stat-note" style={{ textAlign: 'center', marginTop: 7, color: 'var(--ok)' }}>
            {writtenSummary ?? `Downloaded — copy ${CONFIG_FILE_NAME} to the top level of the card.`}
          </p>
        ) : null}
        {prepared ? (
          <div className="banner ok" style={{ marginTop: 10, marginBottom: 0 }}>
            <strong>
              {prepared.card} configured as {prepared.label}
            </strong>
            {prepared.summary.charAt(0).toUpperCase() + prepared.summary.slice(1)}.
            {prepared.kind === 'prepared'
              ? ' Erasing it closed the folder open on it; connect it again to see it as it is now.'
              : prepared.closed
                ? ' Renaming it closed the folder open on it; connect it again to see it as it is now.'
                : ''}{' '}
            <button className="link-button" onClick={onDismissPrepared}>
              Dismiss
            </button>
          </div>
        ) : null}
        {writeError ? (
          <p className="stat-note" style={{ textAlign: 'center', marginTop: 7, color: 'var(--crit)' }}>{writeError}</p>
        ) : null}
        {cardTarget === 'none' && CARD_ACCESS_SUPPORTED ? (
          <p className="stat-note" style={{ textAlign: 'center', marginTop: 7 }}>
            Connect a card to write directly.
          </p>
        ) : null}
      </div>

    </div>
  );
}

/**
 * The forecast's two headline figures and the readiness count, pinned to the bottom of a
 * narrow window.
 *
 * Below the width where the forecast holds its own column it drops under the whole form —
 * several screens away from the fields that change it. This keeps the answer in view while
 * editing, and one tap takes you to the full panel and the write button.
 */
function ForecastDock({
  plan,
  sdCardCapacityGb,
  errors,
  warnings,
}: Readonly<{ plan: ReturnType<typeof forecast>; sdCardCapacityGb: number; errors: number; warnings: number }>) {
  const usedGb = plan.totalBytes / BYTES_PER_MARKETED_GB;
  const readinessClass = errors ? 'crit' : warnings ? 'warn' : 'ok';
  let readinessText = 'Ready to write';
  if (errors) readinessText = `${errors} ${errors === 1 ? 'error' : 'errors'}`;
  else if (warnings) readinessText = `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`;
  return (
    <div className="forecast-dock" role="region" aria-label="Forecast summary">
      <span className={plan.cardFullAt ? 'warn' : undefined}>
        Card {formatCapacityValue(usedGb, sdCardCapacityGb)}/{formatCapacity(sdCardCapacityGb)}
      </span>
      <span className={plan.batteryDeadAt ? 'warn' : undefined}>
        Battery {Number.isFinite(plan.batteryDays) ? `${plan.batteryDays.toFixed(0)} d` : '—'}
      </span>
      <span className={readinessClass}>{readinessText}</span>
      <button
        className="btn small"
        onClick={() => document.getElementById('forecast-column')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
      >
        Review and write
      </button>
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

/** Decimal units, the ones printed on the card, so the figures here can be compared with it. */
function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} kB`;
}

/** ISO instant to the local wall-clock string a datetime-local input expects. */

/**
 * What daylight saving does to this schedule, either way the checkbox is set.
 *
 * Named by date, and by direction: after an autumn change the device's unadjusted clock runs
 * an hour ahead of the local one, so its periods come an hour early; after a spring change,
 * an hour late.
 */
function describeDst(changes: OffsetChange[], config: DeploymentConfig): string {
  const dates = changes.map((change) => formatZonedDate(new Date(change.at).toISOString(), config.timezone));
  const list = formatList(dates);
  if (config.adjustForDst !== false) {
    return (
      `Recording periods keep their local times after the clock change on ${list}. The card contains a ` +
      'separate phase for each side of a change.'
    );
  }
  const first = changes[0];
  const direction = first.offsetAfterSeconds < first.offsetBeforeSeconds ? 'early' : 'late';
  return `The device stays on the clock in force at the start, so after ${list} its recording periods run an hour ${direction} by the local clock.`;
}
