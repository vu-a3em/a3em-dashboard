#!/usr/bin/env node
import { Dispatcher, HELPER_VERSION } from './dispatch.js';
import { platformFor } from './platform/index.js';
import { encodeMessage, MessageReader, MessageTooLargeError, type Request, type Response } from './protocol.js';

export * from './protocol.js';
export * from './platform/index.js';
export * from './safety.js';
export * from './challenge.js';
export { Dispatcher, HELPER_VERSION } from './dispatch.js';

/**
 * The native messaging host.
 *
 * Chrome spawns this with the calling extension's origin as `argv[2]`, writes
 * length-prefixed JSON to stdin, and reads the same from stdout. It lives as long as the
 * port the extension opened, and dies with the browser — which is most of why this design
 * was chosen over a daemon: there is nothing to autostart, nothing listening on a port,
 * and no lifetime to manage.
 *
 * **stdout is the wire.** Anything else written there corrupts the stream and desyncs the
 * framing, so diagnostics go to stderr, which Chrome captures into the extension's
 * console. `console.log` in this process is a protocol bug, not a debugging aid.
 */

function main(): void {
  const platform = platformFor();
  const reader = new MessageReader();

  const send = (message: Response): void => {
    try {
      process.stdout.write(encodeMessage(message));
    } catch (error) {
      if (error instanceof MessageTooLargeError && 'id' in message) {
        process.stdout.write(
          encodeMessage({
            id: (message as { id: string }).id,
            ok: false,
            error: error.message,
            code: 'response-too-large',
          }),
        );
        return;
      }
      process.stderr.write(`a3em-card-helper: could not send response: ${String(error)}\n`);
    }
  };

  const dispatcher = new Dispatcher(platform, send);

  process.stdin.on('data', (chunk: Buffer) => {
    let requests: unknown[];
    try {
      requests = reader.push(chunk);
    } catch (error) {
      // A framing error is unrecoverable: the stream position is unknown, so there is no
      // way to resynchronise. Report and exit rather than act on misparsed input.
      process.stderr.write(`a3em-card-helper: ${String(error)}\n`);
      process.exit(1);
    }

    for (const raw of requests) {
      const request = raw as Request;
      if (!request || typeof request !== 'object' || typeof request.id !== 'string') {
        send({ id: 'unknown', ok: false, error: 'Malformed request.', code: 'malformed' });
        continue;
      }
      void dispatcher.handle(request).then(send);
    }
  });

  // Chrome closes stdin when the port closes. Exiting on end is what keeps a helper from
  // outliving the page that opened it.
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write(`a3em-card-helper ${HELPER_VERSION} ready on ${platform.id}\n`);
}

// Only run the message loop when executed directly. Importing this module from a test or
// from the installer's self-check must not start reading stdin.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) main();
