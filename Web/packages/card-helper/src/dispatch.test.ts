import assert from 'node:assert/strict';
import test from 'node:test';
import type { CardGeometry } from '@a3em/config-schema';
import { Dispatcher } from './dispatch.js';
import { ChallengeStore } from './challenge.js';
import type {
  FsckReport,
  ImageProgress,
  ImageReport,
  Platform,
  RawDevice,
} from './platform/types.js';
import type { ProgressMessage, Reply, Request } from './protocol.js';

/**
 * The refusals, the challenge handshake, and the probe rules.
 *
 * All of it runs against a fake platform rather than a disk, which is the point of the
 * `Platform` seam: these are the rules that must hold identically on three operating
 * systems, and they are tested once, here, on whichever one happens to be running. A
 * Windows or Linux implementation inherits every one of these without re-proving them.
 */

function card(overrides: Partial<RawDevice> = {}): RawDevice {
  return {
    id: 'disk4',
    node: '/dev/disk4',
    sizeBytes: 128 * 1024 ** 3,
    removable: true,
    internal: false,
    bus: 'USB',
    isBootDevice: false,
    virtual: false,
    partitionScheme: 'mbr',
    volumes: [
      {
        id: 'disk4s1',
        node: '/dev/disk4s1',
        label: 'A3EM',
        filesystem: 'exfat',
        sizeBytes: 128 * 1024 ** 3,
        mountPoint: '/Volumes/A3EM',
        allocationUnitBytes: 32768,
        mountable: true,
      },
    ],
    ...overrides,
  };
}

class FakePlatform implements Platform {
  readonly id = 'darwin' as const;
  formatted: Array<{ device: string; unit: number; label: string }> = [];
  repaired: string[] = [];
  probeMatches: string[] = [];

  constructor(public devices: RawDevice[] = [card()]) {}

  listDevices(): Promise<RawDevice[]> {
    return Promise.resolve(this.devices);
  }
  inspect(): Promise<CardGeometry> {
    return Promise.resolve({
      partitionScheme: 'mbr',
      filesystem: 'exfat',
      bytesPerSector: 512,
      allocationUnitBytes: 32768,
      mountable: true,
    });
  }
  findProbe(): Promise<string[]> {
    return Promise.resolve(this.probeMatches);
  }
  mount(): Promise<void> {
    return Promise.resolve();
  }
  unmount(): Promise<void> {
    return Promise.resolve();
  }
  eject(): Promise<void> {
    return Promise.resolve();
  }
  diagnose(): Promise<FsckReport> {
    return Promise.resolve({ clean: true, modified: false, output: '', exitCode: 0 });
  }
  repair(volumeId: string): Promise<FsckReport> {
    this.repaired.push(volumeId);
    return Promise.resolve({ clean: true, modified: true, output: '', exitCode: 0 });
  }
  image(
    _deviceId: string,
    destinationPath: string,
    onProgress: (progress: ImageProgress) => void,
  ): Promise<ImageReport> {
    onProgress({ bytesCopied: 512, totalBytes: 2048, badSectors: 3 });
    return Promise.resolve({ destinationPath, bytesCopied: 2048, badSectors: 3, complete: false });
  }
  format(deviceId: string, allocationUnitBytes: number, label: string): Promise<CardGeometry> {
    this.formatted.push({ device: deviceId, unit: allocationUnitBytes, label });
    return Promise.resolve({
      partitionScheme: 'mbr',
      filesystem: 'exfat',
      bytesPerSector: 512,
      allocationUnitBytes,
      mountable: true,
    });
  }
}

function dispatcherFor(platform: Platform, now = () => 1_000_000): Dispatcher {
  return new Dispatcher(platform, () => {}, new ChallengeStore(now));
}

async function send(dispatcher: Dispatcher, request: Request): Promise<Reply> {
  return dispatcher.handle(request);
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('the boot disk is refused even when it looks removable', async () => {
  const platform = new FakePlatform([card({ isBootDevice: true })]);
  const response = await send(dispatcherFor(platform), {
    id: '1',
    op: 'challenge',
    device: 'disk4',
    operation: 'format',
  });
  assert.equal(response.ok, false);
  assert.equal((response as { code: string }).code, 'boot-device');
});

test('an internal disk is refused', async () => {
  const platform = new FakePlatform([card({ internal: true })]);
  const response = await send(dispatcherFor(platform), {
    id: '1',
    op: 'challenge',
    device: 'disk4',
    operation: 'format',
  });
  assert.equal((response as { code: string }).code, 'internal-device');
});

test('a device far larger than any card is refused, in case it is an archive drive', async () => {
  const platform = new FakePlatform([card({ sizeBytes: 8 * 1024 ** 4 })]);
  const response = await send(dispatcherFor(platform), {
    id: '1',
    op: 'challenge',
    device: 'disk4',
    operation: 'format',
  });
  assert.equal((response as { code: string }).code, 'implausible-size');
});

test('devices that are not eligible never appear in the listing at all', async () => {
  const platform = new FakePlatform([card({ internal: true }), card({ id: 'disk9', virtual: true })]);
  const response = await send(dispatcherFor(platform), { id: '1', op: 'listDevices' });
  assert.equal(response.ok, true);
  assert.deepEqual((response as { devices: unknown[] }).devices, []);
});

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

test('a probe matching two cards is refused rather than guessing', async () => {
  // Six identical cards is the normal case in batch preparation, so picking one at
  // random is how the wrong card gets erased.
  const platform = new FakePlatform();
  platform.probeMatches = ['disk4s1', 'disk7s1'];
  const response = await send(dispatcherFor(platform), {
    id: '1',
    op: 'identify',
    probe: `.a3em-probe-${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
  });
  assert.equal((response as { code: string }).code, 'ambiguous-probe');
});

test('a probe matching nothing is refused', async () => {
  const platform = new FakePlatform();
  platform.probeMatches = [];
  const response = await send(dispatcherFor(platform), {
    id: '1',
    op: 'identify',
    probe: `.a3em-probe-${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
  });
  assert.equal((response as { code: string }).code, 'no-probe-match');
});

test('a probe name this helper did not issue is rejected before it reaches the filesystem', async () => {
  const platform = new FakePlatform();
  const response = await send(dispatcherFor(platform), {
    id: '1',
    op: 'identify',
    probe: '../../../etc/passwd',
  });
  assert.equal((response as { code: string }).code, 'no-probe-match');
});

// ---------------------------------------------------------------------------
// Challenge and grant
// ---------------------------------------------------------------------------

test('formatting without a grant is refused', async () => {
  const platform = new FakePlatform();
  const response = await send(dispatcherFor(platform), {
    id: '1',
    op: 'format',
    device: 'disk4',
    allocationUnitBytes: 65536,
    label: 'A3EM',
    grant: '',
  });
  assert.equal((response as { code: string }).code, 'bad-grant');
  assert.deepEqual(platform.formatted, []);
});

test('a grant issued for this card formats it', async () => {
  const platform = new FakePlatform();
  const dispatcher = dispatcherFor(platform);
  const challenge = (await send(dispatcher, {
    id: '1',
    op: 'challenge',
    device: 'disk4',
    operation: 'format',
  })) as { token: string; description: string };

  assert.match(challenge.description, /Erase and reformat \/dev\/disk4/);

  const response = await send(dispatcher, {
    id: '2',
    op: 'format',
    device: 'disk4',
    allocationUnitBytes: 65536,
    label: 'A3EM',
    grant: challenge.token,
  });
  assert.equal(response.ok, true);
  assert.deepEqual(platform.formatted, [{ device: 'disk4', unit: 65536, label: 'A3EM' }]);
});

test('a grant is single use', async () => {
  const platform = new FakePlatform();
  const dispatcher = dispatcherFor(platform);
  const challenge = (await send(dispatcher, {
    id: '1',
    op: 'challenge',
    device: 'disk4',
    operation: 'format',
  })) as { token: string };

  const request: Request = {
    id: '2',
    op: 'format',
    device: 'disk4',
    allocationUnitBytes: 65536,
    label: 'A3EM',
    grant: challenge.token,
  };
  assert.equal((await send(dispatcher, request)).ok, true);
  assert.equal((await send(dispatcher, { ...request, id: '3' })).ok, false);
  assert.equal(platform.formatted.length, 1);
});

test('a grant for a format cannot be spent on a repair', async () => {
  const platform = new FakePlatform();
  const dispatcher = dispatcherFor(platform);
  const challenge = (await send(dispatcher, {
    id: '1',
    op: 'challenge',
    device: 'disk4',
    operation: 'format',
  })) as { token: string };

  const response = await send(dispatcher, {
    id: '2',
    op: 'repair',
    device: 'disk4',
    volume: 'disk4s1',
    grant: challenge.token,
  });
  assert.equal((response as { code: string }).code, 'bad-grant');
  assert.deepEqual(platform.repaired, []);
});

test('a card swapped after confirmation invalidates the grant', async () => {
  // The whole reason the grant records a fingerprint: confirming against one card and
  // erasing another is the failure this design exists to prevent.
  const platform = new FakePlatform();
  const dispatcher = dispatcherFor(platform);
  const challenge = (await send(dispatcher, {
    id: '1',
    op: 'challenge',
    device: 'disk4',
    operation: 'format',
  })) as { token: string };

  platform.devices = [card({ sizeBytes: 64 * 1024 ** 3 })];

  const response = await send(dispatcher, {
    id: '2',
    op: 'format',
    device: 'disk4',
    allocationUnitBytes: 65536,
    label: 'A3EM',
    grant: challenge.token,
  });
  assert.equal((response as { code: string }).code, 'bad-grant');
  assert.match((response as { error: string }).error, /changed since you confirmed/);
  assert.deepEqual(platform.formatted, []);
});

test('a grant expires', async () => {
  const platform = new FakePlatform();
  let now = 1_000_000;
  const dispatcher = dispatcherFor(platform, () => now);
  const challenge = (await send(dispatcher, {
    id: '1',
    op: 'challenge',
    device: 'disk4',
    operation: 'format',
  })) as { token: string };

  now += 61_000;

  const response = await send(dispatcher, {
    id: '2',
    op: 'format',
    device: 'disk4',
    allocationUnitBytes: 65536,
    label: 'A3EM',
    grant: challenge.token,
  });
  assert.equal((response as { code: string }).code, 'bad-grant');
  assert.deepEqual(platform.formatted, []);
});

// ---------------------------------------------------------------------------
// Format request validation
// ---------------------------------------------------------------------------

test('an allocation unit outside the offered set is refused after the grant is spent', async () => {
  const platform = new FakePlatform();
  const dispatcher = dispatcherFor(platform);
  const challenge = (await send(dispatcher, {
    id: '1',
    op: 'challenge',
    device: 'disk4',
    operation: 'format',
  })) as { token: string };

  const response = await send(dispatcher, {
    id: '2',
    op: 'format',
    device: 'disk4',
    allocationUnitBytes: 1234,
    label: 'A3EM',
    grant: challenge.token,
  });
  assert.equal(response.ok, false);
  assert.deepEqual(platform.formatted, []);
});

test('a label carrying shell metacharacters is refused', async () => {
  const platform = new FakePlatform();
  const dispatcher = dispatcherFor(platform);
  const challenge = (await send(dispatcher, {
    id: '1',
    op: 'challenge',
    device: 'disk4',
    operation: 'format',
  })) as { token: string };

  const response = await send(dispatcher, {
    id: '2',
    op: 'format',
    device: 'disk4',
    allocationUnitBytes: 65536,
    label: 'A3EM; rm -rf /',
    grant: challenge.token,
  });
  assert.equal(response.ok, false);
  assert.deepEqual(platform.formatted, []);
});

// ---------------------------------------------------------------------------
// Imaging
// ---------------------------------------------------------------------------

test('imaging needs no grant, because it only reads', async () => {
  const platform = new FakePlatform();
  const response = await send(dispatcherFor(platform), {
    id: '1',
    op: 'image',
    device: 'disk4',
    destination: '/tmp/card.img',
  });
  assert.equal(response.ok, true);
});

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

test('a long operation emits a heartbeat before it starts, so the UI is never blank', async () => {
  // fsck reports nothing until it finishes and can run for many minutes. Without a
  // heartbeat carrying a phrase, a page has no way to distinguish working from hung.
  const platform = new FakePlatform();
  const seen: ProgressMessage[] = [];
  const dispatcher = new Dispatcher(platform, (message) => seen.push(message));

  await dispatcher.handle({ id: 'x', op: 'diagnose', volume: 'disk4s1' });

  assert.ok(seen.length >= 1);
  assert.equal(seen[0]!.progress.op, 'diagnose');
  assert.match(seen[0]!.progress.note, /Checking the filesystem/);
  assert.equal(seen[0]!.id, 'x');
});

test('a format heartbeats too, and stops when the work does', async () => {
  const platform = new FakePlatform();
  const seen: ProgressMessage[] = [];
  const dispatcher = new Dispatcher(platform, (message) => seen.push(message), new ChallengeStore());
  const challenge = (await dispatcher.handle({
    id: '1',
    op: 'challenge',
    device: 'disk4',
    operation: 'format',
  })) as { token: string };

  await dispatcher.handle({
    id: '2',
    op: 'format',
    device: 'disk4',
    allocationUnitBytes: 65536,
    label: 'A3EM',
    grant: challenge.token,
  });

  const formatBeats = seen.filter((message) => message.progress.op === 'format');
  assert.ok(formatBeats.length >= 1);

  // The interval must not outlive the operation: a heartbeat arriving after the reply
  // would re-arm the client's silence timer on a request that is already finished.
  const before = seen.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(seen.length, before);
});

test('imaging reports bytes and bad sectors, not just a pulse', async () => {
  // Imaging is the one long operation that knows its own extent, so it must carry the
  // numbers through rather than degrading to a heartbeat like fsck does.
  const platform = new FakePlatform();
  const seen: ProgressMessage[] = [];
  const dispatcher = new Dispatcher(platform, (message) => seen.push(message));

  await dispatcher.handle({ id: 'x', op: 'image', device: 'disk4', destination: '/tmp/c.img' });

  const update = seen.find((message) => message.progress.bytesCopied !== undefined);
  assert.ok(update, 'expected a progress message carrying byte counts');
  assert.equal(update!.progress.op, 'image');
  assert.equal(update!.progress.bytesCopied, 512);
  assert.equal(update!.progress.totalBytes, 2048);
  assert.equal(update!.progress.badSectors, 3);
});
