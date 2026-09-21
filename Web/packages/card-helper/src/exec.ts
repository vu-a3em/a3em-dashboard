import { execFile } from 'node:child_process';
import { PlatformCommandError } from './platform/types.js';

/**
 * Running platform tools.
 *
 * `execFile` throughout, never `exec` and never a shell string. Every argument here
 * eventually derives from something a web page sent, and a volume label reaching a shell
 * is the one bug in this program that would be unforgivable. `@a3em/config-schema`'s
 * `validateFormatRequest` restricts labels as well, so this is the second of two locks.
 */

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RunOptions {
  /** Milliseconds before the child is killed. Formatting a large card is slow. */
  timeoutMs?: number;
  /** Treat these exit codes as success. `fsck` uses non-zero to mean "found things". */
  okExitCodes?: number[];
  /** Bytes of output to retain. Tool output crosses a 1 MB message boundary. */
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, okExitCodes = [0], maxBuffer = DEFAULT_MAX_BUFFER } = options;

  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer, encoding: 'utf8' },
      (error, stdout, stderr) => {
        // execFile reports a non-zero exit as `error.code` when the child ran, and a
        // string code (ENOENT, ETIMEDOUT) when it did not — so a numeric code is the only
        // one that means "the tool ran and said no".
        let exitCode: number | null = 0;
        if (error) {
          const raw: unknown = (error as NodeJS.ErrnoException).code;
          exitCode = typeof raw === 'number' ? raw : null;
        }

        if (error && !okExitCodes.includes(exitCode ?? -1)) {
          reject(
            new PlatformCommandError(
              `${command} failed: ${stderr.trim() || stdout.trim() || error.message}`,
              `${command} ${args.join(' ')}`,
              exitCode,
              `${stdout}${stderr}`.trim(),
            ),
          );
          return;
        }
        resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
      },
    );
  });
}

/** Whether a tool exists on this machine, for capability reporting rather than for control flow. */
export async function toolExists(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await run(probe, [command], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}
