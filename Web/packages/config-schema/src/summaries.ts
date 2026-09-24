import { AUDIO_RECORDING_MODES, AUDIO_FILTER_TYPES, IMU_RECORDING_MODES, MIC_TYPES } from './firmware-constants.js';
import type { DeploymentConfig, PhaseConfig } from './types.js';

/**
 * One-line summaries of what a pane is set to.
 *
 * These exist so a collapsed pane still answers its own question. A pane that shuts to a
 * bare title has only hidden something; one that shuts to "Continuous · 16 kHz · 10 s
 * clips" has summarized it, which is what makes collapsing a long configuration page into
 * an overview worth doing at all.
 *
 * Rules they all follow, because a column of summaries only reads as a column if they
 * agree: the most identifying value first, at most three of them, separated by "·", no
 * sentence case and no trailing stop. They name the same things the pane's own controls
 * name — "Continuous" is the word in the mode select, not a paraphrase of it — so that
 * reading one and opening the other is not a translation exercise.
 *
 * They live here rather than in the app because they are the same kind of thing as
 * `describeThreshold` and `formatAllocationUnit`, and because the app has no test runner.
 */

/** Hz where that is what the control shows, kHz once the number gets long. */
function frequency(hz: number): string {
  if (hz < 1000) return `${hz} Hz`;
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

/**
 * The label, the microphone and its gain, and the battery cutoff when there is one.
 *
 * The cutoff is omitted at zero rather than reported as "0 mV": zero does not mean a
 * cutoff of nothing, it means the device records to exhaustion, and a summary is the
 * wrong place to explain that. The pane's own help text does.
 */
export function summarizeDevice(config: DeploymentConfig): string {
  const label = config.deviceLabel.trim() || 'No label';
  const mic = (MIC_TYPES[config.micType] ?? config.micType).toLowerCase();
  const parts = [label, `${mic} mic at ${config.micAmplificationDb} dB`];
  if (config.batteryLowMv > 0) parts.push(`cutoff ${(config.batteryLowMv / 1000).toFixed(2)} V`);
  return parts.join(' · ');
}

/** How long it runs and where, which is what the dates in the pane work out to. */
export function summarizeSchedule(config: DeploymentConfig): string {
  const days = (Date.parse(config.endTime) - Date.parse(config.startTime)) / 86_400_000;
  const length = Number.isFinite(days) && days > 0 ? `${days < 1 ? days.toFixed(1) : Math.round(days)} days` : 'No span';
  return `${length} · ${config.timezone.replace(/_/g, ' ')}`;
}

export function summarizePhases(config: DeploymentConfig): string {
  if (!config.isPhased || config.phases.length <= 1) return 'Single phase';
  return `${config.phases.length} phases`;
}

/** Mode, rate, clip length — the three settings that decide what the files look like. */
export function summarizeAudio(phase: PhaseConfig): string {
  const mode = AUDIO_RECORDING_MODES[phase.audioRecordingMode] ?? phase.audioRecordingMode;
  const parts = [mode, frequency(phase.audioSampleRateHz), `${phase.audioClipLengthSeconds} s clips`];
  if (phase.useOpusEncoding) parts.push('Opus');
  return parts.join(' · ');
}

export function summarizeMotion(phase: PhaseConfig): string {
  const mode = IMU_RECORDING_MODES[phase.imuRecordingMode] ?? phase.imuRecordingMode;
  if (phase.imuRecordingMode === 'NONE') return mode;
  return `${mode} · ${phase.imuSampleRateHz} Hz`;
}

/** Which corners are in force, named the way the filter-type select names them. */
export function summarizeFilter(phase: PhaseConfig): string {
  switch (phase.audioFilterType) {
    case 'NONE':
      return AUDIO_FILTER_TYPES.NONE;
    case 'HIGH':
      return `High-pass ${frequency(phase.audioFilterLowHz)}`;
    case 'LOW':
      return `Low-pass ${frequency(phase.audioFilterHighHz)}`;
    case 'BAND':
      return `Band ${frequency(phase.audioFilterLowHz)} – ${frequency(phase.audioFilterHighHz)}`;
  }
}

/**
 * The threshold first, because it is what switches the feature on — the band below it is
 * inert at zero and the pane hides it there, so the summary does not mention it either.
 */
export function summarizeSilence(phase: PhaseConfig): string {
  if (phase.silenceThreshold <= 0) return 'Off';
  return `${Math.round(phase.silenceThreshold * 100)}% · ${frequency(phase.minFrequencyHz)} – ${frequency(
    phase.maxFrequencyHz,
  )}`;
}

/** Errors before warnings, because only one of the two stops a write. */
export function summarizeReadiness(counts: { errors: number; warnings: number }): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (counts.errors) {
    return counts.warnings
      ? `${plural(counts.errors, 'error')} · ${plural(counts.warnings, 'warning')}`
      : plural(counts.errors, 'error');
  }
  if (counts.warnings) return plural(counts.warnings, 'warning');
  return 'Ready to write';
}

/**
 * A list of items as prose, with the serial (Oxford) comma: "A, B, and C".
 *
 * English rules regardless of the browser's locale, since every other word on the page is
 * English. `or` for alternatives, `and` for everything else.
 */
export function formatList(items: readonly string[], joiner: 'and' | 'or' = 'and'): string {
  return new Intl.ListFormat('en', { style: 'long', type: joiner === 'or' ? 'disjunction' : 'conjunction' }).format(items);
}
