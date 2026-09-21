import type { CardGeometry } from '@a3em/config-schema';
import {
  NotImplementedOnPlatform,
  type FsckReport,
  type ImageProgress,
  type ImageReport,
  type Platform,
  type RawDevice,
} from './types.js';

/**
 * Windows. **Not implemented — every method throws.**
 *
 * This file is a specification, not a placeholder. Each method carries the command it is
 * expected to run, and each throws `NotImplementedOnPlatform` naming that command, so a
 * Windows operator running the helper today gets "format is not implemented on win32 yet.
 * Planned implementation: Format-Volume -FileSystem exFAT …" rather than a bare failure.
 *
 * ## Filling this in
 *
 * Everything above the `Platform` interface — refusals, challenge/grant, the firmware
 * verdict, the message loop, the extension — is platform-independent and already tested.
 * Implementing Windows means producing `RawDevice`, `CardGeometry`, `FsckReport`, and
 * `ImageReport` from Windows tools and nothing else. Do not add policy here: what is
 * *allowed* is decided in `safety.ts` before these are called, and duplicating that
 * judgement would make it untestable on the other platforms.
 *
 * Two things `darwin.ts` learned the hard way that are worth checking for here:
 *
 *  1. **Verify the result, do not trust the exit code.** `newfs_exfat` exits 0 while
 *     declining to reformat. Check whether `Format-Volume` can do anything equivalent —
 *     re-read the allocation unit with `Get-Volume` and compare, as `verifyGeometry` does.
 *  2. **Do not take the cluster size from an API that reports an I/O size.** On macOS
 *     `statfs` reports 1 MiB for exFAT. `GetDiskFreeSpace` (sectors-per-cluster ×
 *     bytes-per-sector) or `Get-Volume`'s `AllocationUnitSize` is the right source.
 *
 * ## Elevation
 *
 * `Format-Volume`, `Initialize-Disk`, and `chkdsk /f` all require an elevated session.
 * The route is to relaunch the worker with `ShellExecute` `runas`, which raises the
 * standard UAC prompt. Mount and eject may not need it — worth measuring rather than
 * assuming, the way the macOS privilege question is still open.
 *
 * ## Identifier shape
 *
 * `RawDevice.id` should be the disk number as a string (`"2"`), and `node`
 * `\\.\PHYSICALDRIVE2`. `RawVolume.id` should be the drive letter with colon (`"E:"`).
 * Nothing above this file parses these, so any stable choice works — but keep `id`
 * usable as an argument to the tools, because that is what the challenge description
 * shows the operator.
 */

const PLATFORM = 'win32';

export class Win32Platform implements Platform {
  readonly id = 'win32' as const;

  listDevices(): Promise<RawDevice[]> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'listDevices',
      'Get-Disk | Get-Partition | Get-Volume via PowerShell -NoProfile -OutputFormat ... | ConvertTo-Json; ' +
        'BusType "USB"/"SD" and IsBoot/IsSystem map to RawDevice.bus and isBootDevice, ' +
        'PartitionStyle "MBR"/"GPT" to partitionScheme',
    );
  }

  inspect(_volumeId: string): Promise<CardGeometry> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'inspect',
      'Get-Volume -DriveLetter <L> | Select-Object FileSystemType, AllocationUnitSize; ' +
        'Get-Partition/Get-Disk for PartitionStyle; Get-Disk for LogicalSectorSize',
    );
  }

  findProbe(_fileName: string): Promise<string[]> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'findProbe',
      'Test-Path over the root of each removable volume — stat one known name per volume, never enumerate',
    );
  }

  mount(_volumeId: string): Promise<void> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'mount',
      'Add-PartitionAccessPath -DiskNumber <n> -PartitionNumber <p> -AssignDriveLetter',
    );
  }

  unmount(_volumeId: string): Promise<void> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'unmount',
      'Remove-PartitionAccessPath -DiskNumber <n> -PartitionNumber <p> -AccessPath <L>:\\',
    );
  }

  eject(_deviceId: string): Promise<void> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'eject',
      'Shell.Application NameSpace(17) InvokeVerb("Eject"), or PnPUtil, for true safe-removal power-down',
    );
  }

  diagnose(_volumeId: string): Promise<FsckReport> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'diagnose',
      'chkdsk <L>: with NO /f — read-only by default. Exit 0 clean, 2 needs repair. ' +
        'Must not write: this is the pre-image diagnosis step',
    );
  }

  repair(_volumeId: string): Promise<FsckReport> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'repair',
      'chkdsk <L>: /f (elevated). Only after imaging — see Part 5 of NATIVE-HELPER-PLAN.md',
    );
  }

  image(
    _deviceId: string,
    _destinationPath: string,
    _onProgress: (progress: ImageProgress) => void,
  ): Promise<ImageReport> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'image',
      'Open \\\\.\\PHYSICALDRIVE<n> with FILE_FLAG_NO_BUFFERING and read sector-aligned chunks, ' +
        'zero-filling unreadable sectors and counting them — mirror imageWithReadLoop in darwin.ts. ' +
        'ddrescue is not available; the read loop is the primary path here, not the fallback',
    );
  }

  format(_deviceId: string, _allocationUnitBytes: number, _label: string): Promise<CardGeometry> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'format',
      'Clear-Disk -RemoveData; Initialize-Disk -PartitionStyle MBR; New-Partition -UseMaximumSize -AssignDriveLetter; ' +
        'Format-Volume -FileSystem exFAT -AllocationUnitSize <bytes> -NewFileSystemLabel <label> (all elevated). ' +
        'Then RE-READ AllocationUnitSize and fail if it differs — do not trust success',
    );
  }
}
