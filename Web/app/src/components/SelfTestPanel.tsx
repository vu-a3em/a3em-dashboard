import { useEffect, useRef, useState } from 'react';
import type { ClockCorrection, SelfTestResults, SelfTestRun } from '@a3em/config-schema';
import { deviceTime } from '../lib/cardTime';
import { Pane } from './Pane';

/**
 * What the hardware check found, subsystem by subsystem.
 *
 * A pass/fail banner answers "can I deploy this", which is the first question but not
 * the only one. The measurements behind the verdict answer the second: a microphone that
 * passes at an RMS of 4 and one that passes at 400 are both working, and only one of
 * them is worth redeploying without a look.
 *
 * The results file at the card root carries the latest run in full. The log carries
 * every run, which is what shows a subsystem drifting between deployments.
 */
export function SelfTestPanel({
  results,
  history,
  clip,
  correction,
  timezone,
  deploymentSpan,
}: Readonly<{
  results: SelfTestResults | null;
  history: SelfTestRun[];
  correction: ClockCorrection | null;
  timezone: string;
  /** First and last recording, for judging whether the test's own stamp is plausible. */
  deploymentSpan: { from: string | null; to: string | null };
  /** The capture the microphone check was judged from, when the card still carries it. */
  clip: { path: string; sizeBytes: number; handle: FileSystemFileHandle } | null;
}>) {
  /**
   * The recording the microphone verdict was made from.
   *
   * RMS and peak say the path was working; they cannot say whether it was working on the
   * animal's call or on a loose connector buzzing. Thirty seconds of listening settles
   * that, and this is the only place on the card the capture appears.
   */
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  const objectUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );
  const playClip = async () => {
    if (!clip) return;
    setClipError(null);
    try {
      const file = await clip.handle.getFile();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(file);
      setClipUrl(objectUrl.current);
    } catch (error) {
      setClipError(error instanceof Error ? error.message : String(error));
    }
  };

  /** True when the test's own stamp falls outside the span the recordings cover. */
  const testedOutsideDeployment = Boolean(
    results?.testedAt &&
      deploymentSpan.from &&
      deploymentSpan.to &&
      (Date.parse(results.testedAt) < Date.parse(deploymentSpan.from) - 3_600_000 ||
        Date.parse(results.testedAt) > Date.parse(deploymentSpan.to) + 3_600_000),
  );

  if (!results && history.length === 0) return null;

  /*
    A self-test that passed is the expected outcome, and its four PASS rows were the
    largest block on the page saying nothing was wrong. It collapses to its heading, with
    the verdict still on the summary line; a failure stays open, where it belongs.
  */
  const clear = results ? results.passed : true;

  return (
    // A panel with nothing to report stays shut until asked.
    <Pane
      id="self-test"
      title="Hardware self-test"
      defaultOpen={!clear}
      note={results ? (results.passed ? 'all checks passed' : `failed — ${results.failedSubsystem}`) : 'no results on this card'}
    >

      {results ? (
        <>
          <p className="hint">
            Ran at activation {results.activationNumber}
            {results.testedAt ? ` on ${deviceTime(results.testedAt, correction, timezone)}` : ''} · firmware{' '}
            <span className="mono">{results.firmwareVersion}</span>
          </p>
          {/*
            The stamp is whatever the device's clock read when the test ran, and that is not
            always the clock the recordings are on: the test happens on the boot right after
            activation, and if the clock had to be rebuilt on that boot it can come back
            holding a time recovered from files already on the card. Saying so is better than
            presenting a date that plainly contradicts the deployment beside it.
          */}
          {testedOutsideDeployment ? (
            <p className="help" style={{ marginTop: -8, marginBottom: 14, color: 'var(--warn)' }}>
              That is outside this deployment's own recordings, so the device's clock was not yet on
              the deployment's time when the test ran. Treat it as the order of events, not the time.
            </p>
          ) : null}

          <div className={`banner ${results.passed ? 'ok' : 'crit'}`} style={{ marginTop: 0, marginBottom: 14 }}>
            <strong>{results.passed ? 'All checks passed' : `FAILED — ${results.failedSubsystem}`}</strong>
            {results.passed
              ? 'Storage, motion, power, and the microphone path were all verified before this deployment began.'
              : 'This unit reported a fault before recording started. The measurements below say which.'}
          </div>

          {clip ? (
            <div className="test-clip">
              {clipUrl ? (
                <audio controls autoPlay src={clipUrl} style={{ width: '100%', maxWidth: 420 }} />
              ) : (
                <button className="btn small" onClick={() => void playClip()}>
                  Listen to the test recording
                </button>
              )}
              <span className="hint" style={{ margin: 0 }}>
                {(clip.sizeBytes / 1024 ** 2).toFixed(1)} MB · recorded during the microphone self-check
              </span>
              {clipError ? <span className="chip crit">{clipError}</span> : null}
            </div>
          ) : null}

          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Result</th>
                  <th>What was measured</th>
                </tr>
              </thead>
              <tbody>
                <Row
                  check="Microphone"
                  result={results.microphone.result}
                  ok={results.microphone.result !== 'FAIL'}
                  detail={
                    <>
                      {results.microphone.type.toLowerCase()} · RMS{' '}
                      <span className="mono">{results.microphone.rms.toLocaleString()}</span> over{' '}
                      {results.microphone.rmsSamples.toLocaleString()} samples · peak{' '}
                      <span className="mono">{results.microphone.peak.toLocaleString()}</span> · range{' '}
                      <span className="mono">
                        {results.microphone.min.toLocaleString()} to {results.microphone.max.toLocaleString()}
                      </span>
                      {results.microphone.constantOutput ? ' · CONSTANT OUTPUT — nothing reached the recorder' : ''}
                      {results.microphone.result === 'PASS_SILENT'
                        ? ' · the path works but the room was quiet, which is not a fault'
                        : ''}
                    </>
                  }
                />
                <Row
                  check="Storage"
                  result={results.storage.result}
                  ok={results.storage.result === 'PASS'}
                  detail={
                    <>
                      {results.storage.bytesVerified.toLocaleString()} bytes written and read back ·{' '}
                      {(results.storage.freeMb / 1024).toFixed(1)} GB free
                    </>
                  }
                />
                <Row
                  check="Motion sensor"
                  result={results.imu.result}
                  ok={results.imu.result === 'PASS'}
                  detail={
                    <>
                      reads <span className="mono">{results.imu.magnitudeMg.toLocaleString()} mg</span>; a
                      stationary device should read about 1000
                    </>
                  }
                />
                <Row
                  check="Power and clock"
                  result={results.power.rtcValid ? 'PASS' : 'CLOCK INVALID'}
                  ok={results.power.rtcValid}
                  detail={
                    <>
                      {(results.power.batteryMv / 1000).toFixed(2)} V at{' '}
                      {results.power.temperatureC.toFixed(1)} °C
                      {results.power.rtcValid ? '' : ' · the real-time clock was not running'}
                    </>
                  }
                />
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {history.length > 1 ? (
        // More than one run means the unit has been activated repeatedly. Comparing the
        // measurements across them is how a microphone or card degrading shows up.
        <>
          <p className="help" style={{ marginTop: 14 }}>
            {history.length} self-tests recorded in the log. Earlier runs are shown so a subsystem
            drifting between deployments is visible, not just its state now.
          </p>
          <div className="scroll-x">
            <table className="data">
              <tbody>
                {history.map((run, index) => (
                  <tr key={`${run.timestamp}:${index}`}>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                      {deviceTime(run.timestamp, correction, timezone)}
                    </td>
                    <td style={run.passed === false ? { color: 'var(--crit)' } : undefined}>
                      {run.passed === null ? 'did not finish' : run.passed ? 'passed' : 'FAILED'}
                    </td>
                    <td>
                      {run.checks
                        .filter((c) => c.detail.length)
                        .map((c) => `${c.check.toLowerCase()}: ${c.detail.map((d) => `${d.key}=${d.value}`).join(' ')}`)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Pane>
  );
}

function Row({
  check,
  result,
  ok,
  detail,
}: Readonly<{ check: string; result: string; ok: boolean; detail: React.ReactNode }>) {
  return (
    <tr>
      <td style={{ whiteSpace: 'nowrap' }}>{check}</td>
      <td>
        <span className={`chip ${ok ? 'ok' : 'crit'}`}>{result}</span>
      </td>
      <td>{detail}</td>
    </tr>
  );
}
