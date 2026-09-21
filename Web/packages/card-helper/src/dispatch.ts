import {
  judgeCardFormat,
  validateFormatRequest,
  type CardGeometry,
} from '@a3em/config-schema';
import { ChallengeStore } from './challenge.js';
import { assertWritable, isEligible, RefusedError } from './safety.js';
import {
  NotImplementedOnPlatform,
  PlatformCommandError,
  type Platform,
  type RawDevice,
} from './platform/types.js';
import { implementedOperations } from './platform/index.js';
import { HEARTBEAT_INTERVAL_MS, type DeviceSummary, type ProgressMessage, type Reply, type Request, type RequestOp } from './protocol.js';

export const HELPER_VERSION = '0.1.0';

/**
 * Turns a request into a response, refusing whatever should not happen.
 *
 * Every decision about what may be acted on lives here or in `safety.ts`, never in a
 * platform implementation — so the refusals are identical on three operating systems and
 * testable on one. A platform's job is to enumerate, read, and act; deciding whether it
 * *should* is settled before it is called.
 *
 * Errors become responses rather than exceptions. A native messaging host that throws
 * dies, taking the port with it, and the extension sees a disconnect instead of a
 * message — which surfaces in the page as "the helper is not installed" when what
 * actually happened is that a card was pulled out mid-scan.
 */
export class Dispatcher {
  private readonly challenges: ChallengeStore;

  constructor(
    private readonly platform: Platform,
    private readonly onProgress: (message: ProgressMessage) => void,
    challenges = new ChallengeStore(),
  ) {
    this.challenges = challenges;
  }

  async handle(request: Request): Promise<Reply> {
    try {
      return await this.route(request);
    } catch (error) {
      return this.asFailure(request.id, error);
    }
  }

  private async route(request: Request): Promise<Reply> {
    switch (request.op) {
      case 'hello':
        return {
          id: request.id,
          ok: true,
          op: 'hello',
          version: HELPER_VERSION,
          platform: this.platform.id,
          implemented: implementedOperations(this.platform),
        };

      case 'listDevices': {
        const devices = await this.eligibleDevices();
        return {
          id: request.id,
          ok: true,
          op: 'listDevices',
          devices: await Promise.all(devices.map((device) => this.summarise(device))),
        };
      }

      case 'identify': {
        // The probe name is used to build a path inside the platform implementation, so
        // it is constrained to the shape this protocol generates rather than trusted.
        if (!/^\.a3em-probe-[0-9a-f-]{36}$/.test(request.probe)) {
          throw new RefusedError('That is not a probe file name this helper issued.', 'no-probe-match');
        }
        const matches = await this.platform.findProbe(request.probe);
        if (matches.length === 0) {
          throw new RefusedError(
            'No connected card carries that marker. It may have been ejected.',
            'no-probe-match',
          );
        }
        if (matches.length > 1) {
          // Never guess. Six identical cards is the normal case in batch preparation, and
          // picking one at random is how the wrong card gets erased.
          throw new RefusedError(
            `${matches.length} cards carry that marker, so the right one cannot be identified. Disconnect the others.`,
            'ambiguous-probe',
          );
        }
        const volume = matches[0]!;
        const device = await this.deviceHolding(volume);
        return { id: request.id, ok: true, op: 'identify', volume, device: device.id };
      }

      case 'inspect': {
        const geometry = await this.platform.inspect(request.volume);
        return {
          id: request.id,
          ok: true,
          op: 'inspect',
          geometry,
          compatibility: judgeCardFormat(geometry, request.recommendedAllocationUnitBytes ?? null),
        };
      }

      case 'mount':
        await this.deviceHolding(request.volume); // eligibility, before touching anything
        await this.platform.mount(request.volume);
        return { id: request.id, ok: true, op: 'mount' };

      case 'unmount':
        await this.deviceHolding(request.volume);
        await this.platform.unmount(request.volume);
        return { id: request.id, ok: true, op: 'unmount' };

      case 'eject': {
        const device = await this.requireWritable(request.device);
        await this.platform.eject(device.id);
        return { id: request.id, ok: true, op: 'eject' };
      }

      case 'diagnose': {
        await this.deviceHolding(request.volume);
        const report = await this.withHeartbeat(
          request.id,
          'diagnose',
          'Checking the filesystem. On a damaged card this can take several minutes.',
          () => this.platform.diagnose(request.volume),
        );
        return { id: request.id, ok: true, op: 'diagnose', report };
      }

      case 'challenge': {
        const device = await this.requireWritable(request.device);
        const challenge = this.challenges.issue(device, request.operation);
        return {
          id: request.id,
          ok: true,
          op: 'challenge',
          token: challenge.token,
          description: challenge.description,
          expiresAt: challenge.expiresAt,
        };
      }

      case 'image': {
        const device = await this.requireWritable(request.device);
        // Imaging only reads the card, so it needs no grant — the destination is a file
        // the operator chose and the card is untouched. It is the safety measure, not a
        // risk to guard against.
        const startedAt = Date.now();
        const report = await this.platform.image(device.id, request.destination, (progress) =>
          this.onProgress({
            id: request.id,
            progress: {
              op: 'image',
              note: 'Copying the card sector by sector.',
              bytesCopied: progress.bytesCopied,
              totalBytes: progress.totalBytes,
              badSectors: progress.badSectors,
              elapsedMs: Date.now() - startedAt,
            },
          }),
        );
        return { id: request.id, ok: true, op: 'image', report };
      }

      case 'repair': {
        const device = await this.requireWritable(request.device);
        this.challenges.redeem(request.grant, 'repair', device);
        const report = await this.withHeartbeat(
          request.id,
          'repair',
          'Repairing the filesystem. Do not disconnect the card.',
          () => this.platform.repair(request.volume),
        );
        return { id: request.id, ok: true, op: 'repair', report };
      }

      case 'format': {
        const device = await this.requireWritable(request.device);
        const problems = validateFormatRequest({
          device: request.device,
          allocationUnitBytes: request.allocationUnitBytes,
          label: request.label,
        });
        if (problems.length) {
          throw new RefusedError(problems.join(' '), 'unknown-device');
        }
        this.challenges.redeem(request.grant, 'format', device);
        const geometry = await this.withHeartbeat(
          request.id,
          'format',
          'Formatting the card. Do not disconnect it.',
          () => this.platform.format(device.id, request.allocationUnitBytes, request.label.trim()),
        );
        return { id: request.id, ok: true, op: 'format', geometry };
      }

      default: {
        const unreachable: never = request;
        void unreachable;
        throw new RefusedError('Unknown operation.', 'unknown-device');
      }
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Runs a long operation while emitting a heartbeat, and always stops the heartbeat.
   *
   * `fsck` on a damaged card, a format, and an image all run for minutes with nothing to
   * report in between. Without this the page has no way to distinguish "working" from
   * "hung", and no way to set a sensible deadline — which is why the client times out on
   * silence rather than on elapsed time.
   */
  private async withHeartbeat<T>(
    id: string,
    op: RequestOp,
    note: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    this.onProgress({ id, progress: { op, note, elapsedMs: 0 } });
    const timer = setInterval(() => {
      this.onProgress({ id, progress: { op, note, elapsedMs: Date.now() - startedAt } });
    }, HEARTBEAT_INTERVAL_MS);
    // unref so a pending heartbeat can never hold the process open past its work.
    timer.unref?.();
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  /** Removable media only. Anything else is invisible to the page, not merely refused. */
  private async eligibleDevices(): Promise<RawDevice[]> {
    const devices = await this.platform.listDevices();
    // Wrapped rather than passed by reference: `filter` supplies the index as a second
    // argument, which would land in `allowVirtual` and be truthy for every device after
    // the first — turning the disk-image filter off exactly where it matters.
    return devices.filter((device) => isEligible(device));
  }

  private async requireWritable(deviceId: string): Promise<RawDevice> {
    const devices = await this.platform.listDevices();
    const device = devices.find((candidate) => candidate.id === deviceId);
    assertWritable(device, deviceId);
    return device;
  }

  /** The eligible device carrying this volume, or a refusal. */
  private async deviceHolding(volumeId: string): Promise<RawDevice> {
    const devices = await this.platform.listDevices();
    const device = devices.find((candidate) =>
      candidate.volumes.some((volume) => volume.id === volumeId),
    );
    if (!device) {
      throw new RefusedError(`No connected card holds a volume called ${volumeId}.`, 'unknown-device');
    }
    assertWritable(device, device.id);
    return device;
  }

  /**
   * A device plus its firmware verdict.
   *
   * The verdict is computed here rather than in the page so there is one implementation
   * of the firmware contract, and so a card that would be destroyed on insertion is
   * flagged even by a caller that did not think to ask.
   */
  private async summarise(device: RawDevice): Promise<DeviceSummary> {
    let compatibility: DeviceSummary['compatibility'] = null;
    const first = device.volumes[0];
    const geometry: CardGeometry = {
      partitionScheme: device.partitionScheme,
      filesystem: first?.filesystem ?? null,
      bytesPerSector: null,
      allocationUnitBytes: first?.allocationUnitBytes ?? null,
      mountable: first?.mountable ?? false,
    };
    try {
      compatibility = judgeCardFormat(geometry);
    } catch {
      compatibility = null;
    }

    return {
      id: device.id,
      node: device.node,
      sizeBytes: device.sizeBytes,
      bus: device.bus,
      partitionScheme: device.partitionScheme,
      volumes: device.volumes.map((volume) => ({
        id: volume.id,
        label: volume.label,
        filesystem: volume.filesystem,
        sizeBytes: volume.sizeBytes,
        mountPoint: volume.mountPoint,
        allocationUnitBytes: volume.allocationUnitBytes,
        mountable: volume.mountable,
      })),
      compatibility,
    };
  }

  private asFailure(id: string, error: unknown): Reply {
    if (error instanceof RefusedError) {
      return { id, ok: false, error: error.message, code: error.code };
    }
    if (error instanceof NotImplementedOnPlatform) {
      return {
        id,
        ok: false,
        error: `${error.operation} is not available on ${error.platform} yet.`,
        code: 'not-implemented',
        detail: error.plannedCommand,
      };
    }
    if (error instanceof PlatformCommandError) {
      return {
        id,
        ok: false,
        error: error.message,
        code: 'platform-error',
        detail: error.output.slice(0, 4000),
      };
    }
    return {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'unexpected',
    };
  }
}
