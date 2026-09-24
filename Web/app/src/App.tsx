import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CorrectionMethod } from '@a3em/config-schema';
import { useCard } from './lib/useCard';
import { useDeploymentDraft } from './lib/useDraft';
import { useProtocols } from './lib/useProtocols';
import { ActivationPicker } from './components/ActivationPicker';
import { CardLoading } from './components/CardLoading';
import { Wordmark } from './components/Wordmark';
import { CardStatus } from './components/CardStatus';
import { HelperRailStatus, HelperTaskChip } from './components/HelperStatus';
import { AccountButton } from './components/Account';

/** Loaded the first time someone opens it: most visits never do. */
const AccountDialog = lazy(() => import('./components/AccountDialog').then((module) => ({ default: module.AccountDialog })));
import { BatchPrepare, type BatchUnit } from './views/BatchPrepare';
import { CardOverview } from './views/CardOverview';
import { DeploymentEditor } from './views/DeploymentEditor';
import { ClipBrowser } from './views/ClipBrowser';
import { OffloadCard } from './views/OffloadCard';
import { useOffloadTask } from './lib/useOffloadTask';
import { useHelper } from './lib/useHelper';
import { useCardDevice } from './lib/useCardDevice';
import { loadRecoverCard, preloadHelperViews } from './lib/helperViews';

/** Only with the card helper, so loaded separately: see `helperViews`. */
const RecoverCard = lazy(() => loadRecoverCard().then((module) => ({ default: module.RecoverCard })));
import { useAccount } from './lib/useAccount';

type View = 'configure' | 'batch' | 'review' | 'clips' | 'offload' | 'recover';

export interface CorrectionState {
  /** Null until the user overrides whichever method the card supports. */
  method: CorrectionMethod | null;
  enteredTime: string;
  manualOffset: string;
}

// Ordered by the workflow: plan a deployment, prepare the units, then review and
// offload what comes back — and, last, rescue a card that will not open at all.
const VIEWS: Array<{ id: View; label: string; title: string }> = [
  { id: 'configure', label: 'Configure', title: 'Configure a deployment' },
  { id: 'batch', label: 'Prepare devices', title: 'Prepare a batch of devices' },
  { id: 'review', label: 'Review card', title: 'Review a retrieved card' },
  { id: 'clips', label: 'Listen', title: 'Listen to what was recorded' },
  { id: 'offload', label: 'Check & copy', title: 'Check and copy a card' },
  { id: 'recover', label: 'Recover card', title: 'Recover a card that will not open' },
];

export default function App() {
  const [view, setView] = useState<View>('configure');
  const card = useCard();
  /**
   * The optional native card helper.
   *
   * Held here rather than in a view for the same reason the offload task is: a format or
   * a repair runs for minutes and must keep reporting while the operator looks at
   * something else.
   */
  const helper = useHelper();
  /** Which physical card the open folder is on, where the helper can tell. */
  const cardDevice = useCardDevice(card, helper);
  const active = VIEWS.find((entry) => entry.id === view)!;
  const recover = () => setView('recover');
  useEffect(() => {
    if (helper.status === 'ready') preloadHelperViews();
  }, [helper.status]);

  /**
   * Every tab starts at the top.
   *
   * The window carries the scroll, not the panes, so switching from halfway down a long
   * Review page landed the next tab at that same offset — which on a short page is a
   * blank screen, and on a long one is the middle of something.
   */
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  /**
   * Publish the pinned top bar's height so anything else that pins can clear it.
   *
   * Measured rather than assumed: the bar wraps to a second row on a narrow window, and a
   * hard-coded offset would leave the forecast panel tucked underneath it there.
   */
  const topbar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const bar = topbar.current;
    if (!bar) return;
    const publish = () =>
      document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  // Both views keep their state here. React unmounts whichever is not showing, so
  // anything held inside them is discarded the moment you look at the other one.
  const draft = useDeploymentDraft();
  /** Optional sign-in, which moves the protocol library into the person's account. */
  const account = useAccount();
  const library = useProtocols(account);
  const [selectedPhase, setSelectedPhase] = useState(0);
  /**
   * Which activation the review and listen views are looking at, null for all of them.
   *
   * Held here so both views agree: a clip opened in Listen and the coverage grid in
   * Review must be describing the same run, or the times shown mean different things in
   * each place.
   */
  const [activation, setActivation] = useState<number | null>(null);
  const [correction, setCorrection] = useState<CorrectionState>({
    method: null,
    enteredTime: '',
    manualOffset: '',
  });
  const [batch, setBatch] = useState<BatchUnit[]>([]);

  // A card check or copy runs for minutes and must outlive the view that started it
  const offload = useOffloadTask();

  return (
    <div className="shell">
      <nav className="rail" aria-label="Sections">
        <div className="brand">
          <Wordmark height={30} />
          <small>Management Dashboard</small>
        </div>
        <div className="rail-links">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              className="rail-link"
              aria-current={view === entry.id ? 'page' : undefined}
              onClick={() => setView(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {/*
          Ambient state, labeled.

          The firmware version used to render as a bare `fw 1.4.2`, which says nothing
          about whose firmware it is or where the number came from — it is read from
          `_a3em.dev`, so it is the firmware of the device that last wrote this card, not
          of anything currently attached over USB. Card tools sit below it because they
          are an app capability rather than a property of the device, and because the
          bottom-most slot is the right amount of attention for something optional.
        */}
        <div className="rail-foot">
          <div className="rail-foot-row">
            <span className="rail-foot-label">Device firmware</span>
            {card.deviceInfo ? (
              <span className="rail-foot-value" title="Read from _a3em.dev on the connected card">
                {card.deviceInfo.firmwareVersion}
              </span>
            ) : (
              <span className="rail-foot-value muted">no card connected</span>
            )}
          </div>
          <HelperRailStatus helper={helper} />
          {/* A new tab, so a card operation or an unsaved edit in this one is never interrupted. */}
          <a className="rail-foot-link" href="privacy.html" target="_blank" rel="noopener">
            Privacy policy
          </a>
        </div>
        {account.dialogOpen ? (
          <Suspense fallback={null}>
            <AccountDialog account={account} protocolCount={library.saved.length} />
          </Suspense>
        ) : null}
      </nav>

      <div className="main">
        <header className="topbar" ref={topbar}>
          <h1>{active.title}</h1>
          <span className="spacer" />
          <CardStatus card={card} cardDevice={cardDevice} />
          <HelperTaskChip helper={helper} />
          <AccountButton account={account} />
        </header>
        <main className="content">
          {card.status === 'scanning' ? <CardLoading progress={card.progress} /> : null}
          {/*
            One picker for the whole app rather than one per tab.

            Review and Listen both read a single activation, and a copy on each page would
            look like two independent controls for what is really one choice. Sitting above
            the content, in the same place on either tab, it reads as what it is: the run
            everything below is describing.
          */}
          {(view === 'review' || view === 'clips') && card.contents ? (
            <ActivationPicker
              layout={card.contents.layout}
              selected={activation}
              onSelect={setActivation}
              overlapping={card.existingConfig?.setRtcAtMagnetDetect ?? false}
            />
          ) : null}
          {view === 'configure' ? (
            <DeploymentEditor
              card={card}
              config={draft.config}
              onChange={draft.setConfig}
              selectedPhase={selectedPhase}
              onSelectPhase={setSelectedPhase}
              draft={draft}
              library={library}
              cardDevice={cardDevice}
              onPrepareDevices={() => setView('batch')}
            />
          ) : null}
          {view === 'batch' ? (
            <BatchPrepare
              card={card}
              helper={helper}
              config={draft.config}
              basedOn={draft.basedOn}
              units={batch}
              onUnitsChange={setBatch}
              onEditConfiguration={() => setView('configure')}
              onRecover={recover}
            />
          ) : null}
          {view === 'review' ? (
            <CardOverview
              card={card}
              correction={correction}
              onCorrectionChange={setCorrection}
              activation={activation}
              helper={helper}
              cardDevice={cardDevice}
              onRecover={recover}
            />
          ) : null}
          {view === 'clips' ? (
            <ClipBrowser
              card={card}
              correction={correction}
              activation={activation}
              recoverable={helper.status === 'ready'}
              onRecover={recover}
            />
          ) : null}
          {view === 'offload' ? (
            <OffloadCard card={card} task={offload} correction={correction} cardDevice={cardDevice} onRecover={recover} />
          ) : null}
          {view === 'recover' ? (
            <Suspense fallback={null}>
              <RecoverCard helper={helper} onConnect={() => void card.connect()} />
            </Suspense>
          ) : null}
        </main>
      </div>
    </div>
  );
}
