/**
 * A3EM Card Helper — extension service worker.
 *
 * This file is deliberately as close to nothing as it can be, and that is a design
 * decision rather than an unfinished state.
 *
 * The extension is distributed through the Chrome Web Store, so **every line here needs a
 * review to change** — hours to weeks, unpredictable. The native host, by contrast,
 * updates by installer with no review at all. So all the logic that actually churns —
 * device enumeration, platform branching, refusals, the challenge handshake, the firmware
 * verdict — lives in the host, and this relays messages between the page and that host
 * without interpreting them. Reviewed once, then left alone.
 *
 * Consequently: **do not add features here.** If something needs doing, it almost
 * certainly belongs in the native helper, `card-helper`.
 *
 * Security note. The origin allowlist is `externally_connectable.matches` in the
 * manifest, enforced by Chrome before anything reaches this file — which is why there is
 * no origin check below and why that is not an oversight.
 */

const HOST_NAME = 'org.a3em.card_helper';

// ---------------------------------------------------------------------------
// Short operations: one message, one reply
// ---------------------------------------------------------------------------

chrome.runtime.onMessageExternal.addListener((request, _sender, sendResponse) => {
  if (!request || typeof request !== 'object' || typeof request.op !== 'string') {
    sendResponse({ ok: false, error: 'Malformed request.', code: 'malformed' });
    return false;
  }

  try {
    chrome.runtime.sendNativeMessage(HOST_NAME, request, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse(hostUnavailable(chrome.runtime.lastError.message));
        return;
      }
      sendResponse(response);
    });
  } catch (error) {
    sendResponse(hostUnavailable(String(error)));
  }

  // Keeps the message channel open for the async reply. Returning anything falsy closes
  // it immediately and the page sees `undefined` — the single most common way a native
  // messaging bridge appears to silently do nothing.
  return true;
});

// ---------------------------------------------------------------------------
// Long operations: a port, so progress can be pushed
// ---------------------------------------------------------------------------

/**
 * Relays a page-opened port to a native-host port, in both directions.
 *
 * A port rather than `sendMessage` because **an extension cannot push a message to a web
 * page**. A page has `chrome.runtime.sendMessage` and `chrome.runtime.connect`, but no
 * `onMessage` — so the only way to deliver a heartbeat is down a channel the page itself
 * opened. Formatting a card, repairing a filesystem, and imaging 128 GB all run for
 * minutes with nothing to report in between, and a page that cannot distinguish "working"
 * from "hung" will be reloaded halfway through by someone who assumes the worst.
 *
 * No timeout is imposed here. The host heartbeats every two seconds and the page times
 * out on silence rather than duration, so a deadline in this file could only ever kill
 * work that was proceeding normally.
 */
chrome.runtime.onConnectExternal.addListener((pagePort) => {
  let nativePort = null;
  let closed = false;

  const closeAll = () => {
    if (closed) return;
    closed = true;
    try {
      nativePort?.disconnect();
    } catch {
      // Already gone.
    }
    try {
      pagePort.disconnect();
    } catch {
      // Already gone.
    }
  };

  pagePort.onMessage.addListener((request) => {
    if (!request || typeof request !== 'object' || typeof request.op !== 'string') {
      safePost(pagePort, { ok: false, error: 'Malformed request.', code: 'malformed' });
      return;
    }

    if (!nativePort) {
      try {
        nativePort = chrome.runtime.connectNative(HOST_NAME);
      } catch (error) {
        safePost(pagePort, hostUnavailable(String(error)));
        closeAll();
        return;
      }

      // Everything the host says goes straight through: progress messages and the final
      // reply alike. This file does not interpret either.
      nativePort.onMessage.addListener((message) => safePost(pagePort, message));

      nativePort.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        // A disconnect before a reply is a real failure. After one it is just cleanup,
        // and the page has already resolved — posting to a closed port is harmless.
        safePost(
          pagePort,
          hostUnavailable(
            error ? error.message : 'The card helper stopped before the operation finished.',
          ),
        );
        closeAll();
      });
    }

    nativePort.postMessage(request);
  });

  // The page navigating away, or closing the port when it has its answer.
  pagePort.onDisconnect.addListener(closeAll);
});

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // The other end has gone. Never a reason to abort work the host is still doing.
  }
}

/**
 * The one error shape worth getting right.
 *
 * "Specified native messaging host not found" means the helper is not installed, which is
 * an ordinary state — most users will never install it — and the page must render the
 * no-helper tier rather than an error. Anything else is a real fault and says so.
 */
function hostUnavailable(message) {
  const notInstalled = /not found|forbidden|not registered/i.test(message ?? '');
  return {
    ok: false,
    code: notInstalled ? 'helper-not-installed' : 'helper-failed',
    error: notInstalled
      ? 'The A3EM card helper is not installed on this computer.'
      : `The card helper could not be reached: ${message}`,
  };
}
