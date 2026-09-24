import { useMemo } from 'react';
import {
  fromZonedInput,
  correctionFromActivation,
  correctionFromClockSyncs,
  correctionFromDeactivation,
  correctionOptions,
  manualCorrection,
  type ClockCorrection,
} from '@a3em/config-schema';
import type { CorrectionState } from '../App';
import type { useCard } from './useCard';

/**
 * The clock correction for a retrieved card, derived once.
 *
 * Every view that shows a time from a card has to agree about what that time is — the
 * review workspace, the rename plan, and the clip browser must not each reach their own
 * conclusion about when a recording was made. Deriving it in one place is what keeps
 * them from drifting apart as any one of them changes.
 */
export function useClockCorrection(card: ReturnType<typeof useCard>, state: CorrectionState) {
  const options = useMemo(
    () =>
      correctionOptions({
        configuredStartTime: card.existingConfig?.startTime ?? null,
        setsRtcAtActivation: card.existingConfig?.setRtcAtMagnetDetect ?? false,
        stopReason: card.deviceInfo?.lastDeactivationReason ?? null,
        lastDeviceTime: card.deviceInfo?.lastTimestamp ?? card.contents?.layout.lastDeviceTime ?? null,
        gpsAvailable: card.existingConfig?.gpsAvailable ?? false,
        clockSyncs: card.log?.clockSyncs,
      }),
    [card.existingConfig, card.deviceInfo, card.contents, card.log],
  );

  // Prefer whatever the card can establish on its own. A GPS unit recorded the exact
  // correction it applied, so nothing needs to be remembered or estimated.
  const defaultMethod = options.find((option) => option.available)?.method ?? 'manual';
  const selected = options.find((option) => option.method === (state.method ?? defaultMethod)) ?? options[0];

  const correction = useMemo<ClockCorrection | null>(() => {
    if (selected.method === 'gps') {
      return correctionFromClockSyncs(card.log?.clockSyncs ?? []);
    }
    if (selected.method === 'manual') {
      const minutes = Number(state.manualOffset);
      return state.manualOffset && !Number.isNaN(minutes) ? manualCorrection(minutes * 60) : null;
    }
    if (!state.enteredTime || !selected.available || !selected.deviceReference) return null;
    /*
      The time typed here is the wall clock the person was standing in when they activated
      or collected the device — the DEPLOYMENT's zone, not the zone of the laptop reading
      the card afterward. Reading it as browser-local put the whole correction out by the
      difference between the two, which then shifted every timestamp on the card.
    */
    let entered: string;
    try {
      entered = fromZonedInput(state.enteredTime, card.existingConfig?.timezone ?? 'UTC');
    } catch {
      return null;
    }
    return selected.method === 'activation'
      ? correctionFromActivation(selected.deviceReference, entered, selected.accuracySeconds)
      : correctionFromDeactivation(selected.deviceReference, entered, selected.accuracySeconds);
  }, [selected, state.enteredTime, state.manualOffset, card.log, card.existingConfig]);

  return { options, selected, correction };
}
