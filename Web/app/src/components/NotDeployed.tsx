import { cardStage, formatZonedDisplay, type CardLayout, type DeploymentConfig } from '@a3em/config-schema';

/**
 * A card with nothing a recorder has written on it: freshly prepared, or blank.
 *
 * Said in place of the page, as "No card connected" is, rather than letting the page describe a
 * deployment that recorded nothing — a verdict with every panel empty reads as a failed one.
 */
export function isUndeployed(layout: CardLayout): boolean {
  return cardStage(layout) !== 'deployed';
}

/** Whether the configuration itself sets the schedule: without it, parsing fills in defaults. */
function setsSchedule(configText: string | null): boolean {
  return /^\s*DEPLOYMENT_START_TIME\s*=/m.test(configText ?? '') && /^\s*DEPLOYMENT_END_TIME\s*=/m.test(configText ?? '');
}

export function NotDeployed({
  name,
  layout,
  config,
  configText,
  nothing,
}: Readonly<{
  name: string | null;
  layout: CardLayout;
  config: DeploymentConfig | null;
  /** The configuration as written, to tell a schedule it sets from one parsing filled in. */
  configText: string | null;
  /** What the page would show, as in "there is nothing to listen to yet". */
  nothing: string;
}>) {
  const card = name ?? 'This card';
  if (cardStage(layout) === 'prepared') {
    return (
      <div className="card">
        <h2>Not deployed yet</h2>
        <p className="hint">
          {config?.deviceLabel ? `This card is prepared for unit ${config.deviceLabel}` : `${card} is prepared`}, and
          nothing a recorder writes is on it yet, so there is {nothing} yet.
          {config && setsSchedule(configText)
            ? ` Its deployment is set to run from ${formatZonedDisplay(config.startTime, config.timezone)} to ${formatZonedDisplay(config.endTime, config.timezone)}.`
            : ''}
        </p>
        <p className="hint">Once it has been in a unit, connect it again to see what it recorded.</p>
      </div>
    );
  }
  return (
    <div className="card">
      <h2>Nothing recorded on this card</h2>
      <p className="hint">
        {card} holds no configuration and nothing a recorder wrote, so there is {nothing}. Prepare it under “Prepare
        devices” before deploying it.
      </p>
    </div>
  );
}
