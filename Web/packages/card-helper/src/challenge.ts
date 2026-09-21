import { randomUUID, timingSafeEqual } from 'node:crypto';
import { RefusedError } from './safety.js';
import { formatSize } from './safety.js';
import type { RawDevice } from './platform/types.js';

/**
 * Two-step confirmation for anything that destroys data.
 *
 * The page asks to format or repair; the host replies with its own description of what it
 * is about to act on and a token. The operator confirms against *that* description, and
 * the page returns the token.
 *
 * Two things this buys, neither achievable in the page alone:
 *
 *  - **The text the operator confirms comes from the process that will do the erasing.**
 *    A page describing the card from its own stale idea of it can be wrong in exactly the
 *    case that matters.
 *  - **A card swapped between the decision and the act is caught.** The grant records the
 *    device's identity at issue time and it is re-checked before use, so a token minted
 *    for a card that has since been pulled out does not apply to whatever replaced it.
 */

/** Long enough to read a dialog, short enough that a forgotten window is not a loaded gun. */
export const CHALLENGE_TTL_MS = 60_000;

export interface Challenge {
  token: string;
  operation: 'format' | 'repair';
  deviceId: string;
  /** The host's own description, which is what the operator is shown. */
  description: string;
  expiresAt: number;
  /** Identity of the device at issue time, re-checked at redemption. */
  fingerprint: string;
}

/**
 * What makes this the *same* card later.
 *
 * Size and bus rather than volume label: a format changes the label, a repair may change
 * it, and six identical cards in a batch share it. Size and bus survive both operations
 * and distinguish a card from the archive drive someone plugged in meanwhile.
 */
export function fingerprint(device: RawDevice): string {
  return `${device.id}:${device.sizeBytes}:${device.bus}`;
}

export function describe(device: RawDevice, operation: 'format' | 'repair'): string {
  const volumes = device.volumes
    .map((volume) => volume.label ?? volume.filesystem ?? 'unnamed volume')
    .join(', ');
  const what = operation === 'format' ? 'Erase and reformat' : 'Attempt to repair the filesystem on';
  return (
    `${what} ${device.node} — ${formatSize(device.sizeBytes)}, ${device.bus}` +
    (volumes ? `, containing ${volumes}` : ', containing no readable volume') +
    '.'
  );
}

export class ChallengeStore {
  private readonly outstanding = new Map<string, Challenge>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(device: RawDevice, operation: 'format' | 'repair'): Challenge {
    this.sweep();
    const challenge: Challenge = {
      token: randomUUID(),
      operation,
      deviceId: device.id,
      description: describe(device, operation),
      expiresAt: this.now() + CHALLENGE_TTL_MS,
      fingerprint: fingerprint(device),
    };
    this.outstanding.set(challenge.token, challenge);
    return challenge;
  }

  /**
   * Consumes a grant, or throws.
   *
   * Single-use: redeemed tokens are removed whether or not the operation that follows
   * succeeds, so a failed format cannot be retried without a fresh confirmation. That is
   * deliberate — a format failing is one of the situations where the operator should look
   * at the card again rather than click through.
   */
  redeem(token: string, operation: 'format' | 'repair', device: RawDevice): Challenge {
    this.sweep();
    const challenge = token ? this.outstanding.get(token) : undefined;
    if (!challenge || !constantTimeEquals(challenge.token, token)) {
      throw new RefusedError('That confirmation is not valid. Ask again and confirm.', 'bad-grant');
    }
    this.outstanding.delete(token);

    if (challenge.operation !== operation) {
      throw new RefusedError('That confirmation was for a different operation.', 'bad-grant');
    }
    if (challenge.deviceId !== device.id || challenge.fingerprint !== fingerprint(device)) {
      throw new RefusedError(
        'The card changed since you confirmed. Check which card is connected and try again.',
        'bad-grant',
      );
    }
    return challenge;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, challenge] of this.outstanding) {
      if (challenge.expiresAt <= now) this.outstanding.delete(token);
    }
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
