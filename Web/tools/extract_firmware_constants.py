#!/usr/bin/env python3
"""Reduce the A3EM firmware source to a diffable JSON snapshot.

WHY THIS EXISTS
---------------
`packages/config-schema/src/firmware-constants.ts` hand-transcribes limits, enums,
and config keys out of the firmware. Hand-transcribed constants rot silently: the
firmware gains a key or shrinks an array, nobody updates the web app, and the
dashboard starts writing cards the device reads differently than intended.

This script extracts those values straight from the C source into
`reference/firmware-snapshot.json`. A test then asserts the TypeScript agrees with
the snapshot. So a firmware change surfaces as a failing test naming the exact
constant that moved, rather than as a mystery in the field.

USAGE
-----
    python3 tools/extract_firmware_constants.py                 # rewrite snapshot
    python3 tools/extract_firmware_constants.py --check         # CI: fail on drift
    python3 tools/extract_firmware_constants.py --firmware PATH # non-default checkout

The firmware location resolves in this order:
    1. --firmware PATH
    2. $A3EM_FIRMWARE_PATH
    3. the `a3em-firmware` git submodule at the a3em-dashboard repo root
    4. ../a3em-firmware, a sibling checkout (legacy layout, pre-submodule)

Normally none of these need setting: the submodule pins the exact firmware commit this
snapshot was generated from, so a fresh `git clone --recurse-submodules` reproduces it
byte for byte. If the submodule is not initialized, run:

    git submodule update --init a3em-firmware
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent          # .../a3em-dashboard/Web
DASHBOARD_ROOT = REPO_ROOT.parent                            # .../a3em-dashboard
SNAPSHOT = REPO_ROOT / "reference" / "firmware-snapshot.json"

# Preferred first: the submodule pins the exact commit this snapshot came from.
SUBMODULE_FIRMWARE = DASHBOARD_ROOT / "a3em-firmware"
SIBLING_FIRMWARE = DASHBOARD_ROOT.parent / "a3em-firmware"

STATIC_CONFIG_H = "app/static_config.h"
RUNTIME_CONFIG_H = "app/runtime_config.h"
RUNTIME_CONFIG_C = "app/runtime_config.c"
DIGIPOT_C = "peripherals/src/digipot.c"
ACTIVE_MAIN_C = "app/active_main.c"
MAIN_C = "app/main.c"
AUDIO_C = "peripherals/src/audio.c"
# The self-test moved into the system peripheral; its constants and events live there now.
SELF_TEST_C = "peripherals/src/system.c"


def resolve_firmware(explicit: Path | None) -> Path:
    """First location that actually contains firmware source."""
    candidates = []
    if explicit:
        candidates.append(explicit)
    if os.environ.get("A3EM_FIRMWARE_PATH"):
        candidates.append(Path(os.environ["A3EM_FIRMWARE_PATH"]))
    candidates += [SUBMODULE_FIRMWARE, SIBLING_FIRMWARE]

    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if (resolved / "src").is_dir():
            return resolved

    raise SystemExit(
        "ERROR: could not find the firmware source. Tried:\n"
        + "\n".join(f"  {c.expanduser()}" for c in candidates)
        + "\n\nIf the submodule is not checked out yet:\n"
        "  git submodule update --init a3em-firmware"
    )

# Numeric #defines worth tracking, with the header they live in.
NUMERIC_DEFINES = {
    STATIC_CONFIG_H: [
        "DEVICE_ID_LEN",
        "MAX_DEVICE_LABEL_LEN",
        "MAX_AUDIO_TRIGGER_TIMES",
        "MAX_NUM_DEPLOYMENT_PHASES",
        "MAX_CFG_FILE_LINE_LENGTH",
        "MIN_LOG_DATA_INTERVAL_SECONDS",
        "NUM_HOURS_PER_AUDIO_DIRECTORY",
        "AUDIO_BUFFER_MAX_SIZE",
        "AUDIO_NUM_CHANNELS",
        "AUDIO_DEFAULT_SAMPLING_RATE_HZ",
        "AUDIO_BUFFER_MAX_SAMPLES",
        "AUDIO_DEFAULT_CLIP_LENGTH_SECONDS",
        # Bounds the firmware CLAMPS against, in runtime_config.c and audio.c both. A
        # dashboard that does not mirror them lets a deployment be written with a clip
        # length the device will silently replace.
        "AUDIO_MIN_CLIP_LENGTH_SECONDS",
        "AUDIO_MAX_CLIP_LENGTH_SECONDS",
        "AUDIO_MIN_SAMPLING_RATE_HZ",
        "AUDIO_MAX_SAMPLING_RATE_HZ",
        "WAV_STAGING_BUFFER_SIZE",
        "SD_CARD_ALLOCATION_UNIT_BYTES",
        "OPUS_REQUIRED_SAMPLE_RATE_HZ",
        "OPUS_MAX_ENCODING_BITRATE",
        "OPUS_DEFAULT_ENCODING_BITRATE",
        "OPUS_MS_PER_FRAME",
        "BATTERY_DEFAULT_LOW_LEVEL_MV",
        "IMU_DEFAULT_SAMPLING_RATE_HZ",
        "IMU_BUFFER_MAX_SAMPLES",
        "MAGNET_FIELD_DEFAULT_VALIDATION_LENGTH_MS",
    ],
}

STRING_DEFINES = {
    STATIC_CONFIG_H: ["CONFIG_FILE_NAME", "LEGACY_CONFIG_FILE_NAME", "LOG_FILE_NAME"],
}

# C enums whose ORDER matters, because the .cfg stores the names and the firmware
# compares against them.
ENUMS = {
    RUNTIME_CONFIG_H: [
        "audio_mic_type_t",
        "audio_recording_mode_t",
        "imu_recording_mode_t",
        "time_scale_t",
    ],
}


def read(firmware: Path, relative: str) -> str:
    path = firmware / "src" / relative
    if not path.is_file():
        raise SystemExit(f"ERROR: expected firmware file not found: {path}")
    return path.read_text(encoding="utf-8", errors="replace")


def extract_numeric_defines(source: str, names: list[str]) -> dict[str, int]:
    """Pull `#define NAME <int expr>`, resolving references to already-seen names."""
    resolved: dict[str, int] = {}
    # Collect every simple define first so expressions can reference them.
    every: dict[str, str] = {}
    for match in re.finditer(r"^\s*#define\s+(\w+)\s+(.+?)\s*$", source, re.MULTILINE):
        every[match.group(1)] = match.group(2)

    def evaluate(expr: str, depth: int = 0) -> int | None:
        if depth > 8:
            return None
        expr = re.sub(r"/\*.*?\*/", "", expr).split("//")[0].strip()
        # Substitute known identifiers.
        for identifier in sorted(set(re.findall(r"[A-Za-z_]\w*", expr)), key=len, reverse=True):
            if identifier in every:
                inner = evaluate(every[identifier], depth + 1)
                if inner is None:
                    return None
                expr = re.sub(rf"\b{re.escape(identifier)}\b", f"({inner})", expr)
        if re.search(r"[A-Za-z_]", expr):
            return None
        if not re.fullmatch(r"[\d\s()+\-*/]+", expr):
            return None
        try:
            value = eval(expr, {"__builtins__": {}}, {})  # noqa: S307 - arithmetic only
        except Exception:
            return None
        return int(value) if isinstance(value, (int, float)) and value == int(value) else None

    for name in names:
        if name not in every:
            raise SystemExit(f"ERROR: #define {name} not found in firmware")
        value = evaluate(every[name])
        if value is None:
            raise SystemExit(f"ERROR: could not evaluate #define {name} = {every[name]!r}")
        resolved[name] = value
    return resolved


def extract_string_defines(source: str, names: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for name in names:
        match = re.search(rf'^\s*#define\s+{re.escape(name)}\s+"([^"]*)"', source, re.MULTILINE)
        if not match:
            raise SystemExit(f"ERROR: string #define {name} not found in firmware")
        out[name] = match.group(1)
    return out


def extract_enums(source: str, names: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for name in names:
        # `[^{}]*` rather than `.*?` — several of these enums sit on consecutive
        # lines, and a DOTALL wildcard body swallows the ones before the named type.
        match = re.search(rf"typedef\s+enum\s*\{{([^{{}}]*)\}}\s*{re.escape(name)}\s*;", source)
        if not match:
            raise SystemExit(f"ERROR: enum {name} not found in firmware")
        body = re.sub(r"/\*.*?\*/", "", match.group(1))
        members = [m.strip().split("=")[0].strip() for m in body.split(",") if m.strip()]
        out[name] = members
    return out


def extract_config_keys(source: str) -> list[str]:
    """Config keys compared in `parse_line()`, in the order the firmware tests them.

    Order is load-bearing: matching is by prefix via
    `memcmp(key, "NAME", sizeof("NAME")-1)`, so a key that is a prefix of a later
    key must be tested first or it swallows the longer one.
    """
    # The parser is split in two: parse_line() tests the device-scoped keys and then
    # delegates anything it does not recognize to parse_phase_setting(). Both have to be
    # scanned, in that order, or the phase keys silently drop out of drift detection.
    device_start = source.find("static void parse_line(")
    if device_start < 0:
        raise SystemExit("ERROR: parse_line() not found in runtime_config.c")
    device_end = source.find("\n// Public API Functions", device_start)
    device_body = source[device_start : device_end if device_end > 0 else len(source)]

    phase_start = source.find("static bool parse_phase_setting(")
    if phase_start < 0:
        raise SystemExit(
            "ERROR: parse_phase_setting() not found in runtime_config.c. "
            "If the phase keys moved again, update this extractor to follow them."
        )
    phase_body = source[phase_start:device_start] if phase_start < device_start else source[phase_start:]

    pattern = r'memcmp\(key,\s*"([^"]+)"'
    keys = [m.group(1) for m in re.finditer(pattern, device_body)]
    keys += [m.group(1) for m in re.finditer(pattern, phase_body)]
    if not keys:
        raise SystemExit("ERROR: no config keys found in the configuration parser")
    # Drop the [PHASE] section marker; it is structural, not a key/value pair.
    return [k for k in keys if k != "[PHASE]"]


def extract_max_frequency_headroom(source: str) -> int:
    """The 200 Hz the firmware subtracts when clamping MAX_FREQUENCY."""
    match = re.search(r"audio_sampling_rate\s*/\s*2\)\s*-\s*(\d+)", source)
    if not match:
        raise SystemExit("ERROR: max-frequency clamp not found in runtime_config.c")
    return int(match.group(1))


def extract_digipot_steps(source: str) -> int:
    """The digipot scale factor that quantizes the audio trigger threshold."""
    match = re.search(r"wiper_value\s*=\s*\(uint8_t\)\(\s*(\d+)\s*\*\s*percent\s*\)", source)
    if not match:
        raise SystemExit("ERROR: digipot wiper scaling not found in digipot.c")
    return int(match.group(1))


def extract_reset_reasons(source: str) -> dict[str, object]:
    """The reset reason strings and which of them the firmware calls a failure.

    The dashboard maps these to plain-language explanations and decides which restarts
    to flag. Both live in `reset_reason_name()` and `reset_reason_is_error()`, neither of
    which is an enum, so nothing else here would notice a reason being added -- which is
    exactly what happened when CYCLE appeared and silently read as UNKNOWN.
    """
    names = re.findall(r'case\s+(RESET_REASON_\w+)\s*:\s*return\s+"([A-Z-]+)"', source)
    if not names:
        raise SystemExit("ERROR: reset_reason_name() not found in system.c")
    by_code = {code: text for code, text in names}

    match = re.search(r"bool\s+reset_reason_is_error\([^)]*\)\s*\{(.*?)\n\}", source, re.S)
    if not match:
        raise SystemExit("ERROR: reset_reason_is_error() not found in system.c")
    # Only the cases before `return true` count as failures.
    head = match.group(1).split("return true")[0]
    faults = sorted({by_code[c] for c in re.findall(r"case\s+(RESET_REASON_\w+)\s*:", head) if c in by_code})

    return {"all": sorted(set(by_code.values())), "faults": faults}


def extract_log_events(sources: dict[str, str]) -> dict[str, list[str]]:
    """Machine-readable log events and their field keys.

    Every `log_event("CODE", "k=%..,k=%..")` call in the firmware. These codes and keys
    are the contract the dashboard's log parser is written against -- deliberately, so
    that reworded prose cannot break parsing. Drift here therefore has to be visible.
    """
    events: dict[str, list[str]] = {}
    for source in sources.values():
        # The format string may be split across adjacent literals, which C concatenates.
        for match in re.finditer(r'log_event\(\s*"([A-Z_]+)"\s*,\s*((?:"[^"]*"\s*)+)', source):
            code = match.group(1)
            fmt = "".join(re.findall(r'"([^"]*)"', match.group(2)))
            # Field names may contain digits (scratch0, scratch1). An [a-z_]+ pattern
            # matches nothing at all for those, because the character before "=" is the
            # digit -- so they were silently absent from the contract.
            keys = re.findall(r"\b([a-z_][a-z0-9_]*)=", fmt)
            # A code can be emitted from several sites with DIFFERENT field sets -- the
            # same event reporting a configuration in one place and a measurement in
            # another. Keeping only the longest set silently hid the other shape, and
            # with it a parser bug where the second shape overwrote the first with
            # zeros. Take the union, in first-seen order.
            existing = events.setdefault(code, [])
            for key in keys:
                if key not in existing:
                    existing.append(key)
    if not events:
        raise SystemExit("ERROR: no log_event() calls found in the firmware")
    return {code: events[code] for code in sorted(events)}


def build_snapshot(firmware: Path) -> dict:
    static_config = read(firmware, STATIC_CONFIG_H)
    runtime_config_h = read(firmware, RUNTIME_CONFIG_H)
    runtime_config_c = read(firmware, RUNTIME_CONFIG_C)
    digipot_c = read(firmware, DIGIPOT_C)
    active_main_c = read(firmware, ACTIVE_MAIN_C)
    main_c = read(firmware, MAIN_C)
    audio_c = read(firmware, AUDIO_C)
    self_test_c = read(firmware, SELF_TEST_C)

    numeric: dict[str, int] = {}
    for relative, names in NUMERIC_DEFINES.items():
        numeric.update(extract_numeric_defines(read(firmware, relative), names))

    strings: dict[str, str] = {}
    for relative, names in STRING_DEFINES.items():
        strings.update(extract_string_defines(read(firmware, relative), names))

    enums: dict[str, list[str]] = {}
    for relative, names in ENUMS.items():
        enums.update(extract_enums(read(firmware, relative), names))

    # Every function the firmware defines, so prose and comments naming one can be checked
    # against reality. A sentence that describes device behavior goes stale silently: no
    # constant moves, no grammar changes, and the claim just stops being true.
    # FatFs, Opus and SEGGER RTT are vendored but comments cite their functions (f_open,
    # f_mkdir, opus_encode, SEGGER_RTT_Init, ...) as the authority for how the device
    # behaves, so those stay in scope. The Ambiq SDK and the ML support libraries
    # (flatbuffers/gemmlowp/ruy/tflite-micro) are excluded: nothing here reasons about
    # their internals, and their generic, thousands-strong symbol tables would swamp the
    # firmware's own functions in this contract.
    EXCLUDED_EXTERNAL_DIRS = {"flatbuffers", "gemmlowp", "ruy", "tflite-micro"}
    symbols: set[str] = set()
    for path in sorted((firmware / "src").rglob("*.[ch]")):
        parts = path.parts
        if "AmbiqSDK" in parts:
            continue
        if "external" in parts:
            external_idx = parts.index("external")
            if external_idx + 1 < len(parts) and parts[external_idx + 1] in EXCLUDED_EXTERNAL_DIRS:
                continue
        text = path.read_text(encoding="utf-8", errors="replace")
        symbols.update(re.findall(r"^[A-Za-z_][\w \t*]*?\b(\w+)\s*\([^;]*?\)\s*\{", text, re.MULTILINE))

    # The Python dashboard this package replaces. Comments cite it as the authority for
    # rules carried over, and those citations rot the same way firmware ones do.
    desktop: set[str] = set()
    python_root = DASHBOARD_ROOT / "Python" / "dashboard"
    if python_root.is_dir():
        for path in sorted(python_root.glob("*.py")):
            desktop.update(re.findall(r"^\s*def\s+(\w+)", path.read_text(encoding="utf-8", errors="replace"), re.MULTILINE))

    requested = {
        "numericDefines": sorted(n for names in NUMERIC_DEFINES.values() for n in names),
        "stringDefines": sorted(n for names in STRING_DEFINES.values() for n in names),
        "enums": sorted(n for names in ENUMS.values() for n in names),
    }

    return {
        "_comment": (
            "GENERATED by tools/extract_firmware_constants.py from the A3EM firmware "
            "source. Do not edit by hand. Regenerate after any firmware change, then "
            "run the config-schema tests to see what needs updating in TypeScript."
        ),
        "_requested": requested,
        "firmwareFunctions": sorted(symbols),
        "desktopFunctions": sorted(desktop),
        "numericDefines": numeric,
        "stringDefines": strings,
        "enums": enums,
        "configKeyOrder": extract_config_keys(runtime_config_c),
        "maxFrequencyHeadroomHz": extract_max_frequency_headroom(runtime_config_c),
        "triggerDigipotSteps": extract_digipot_steps(digipot_c),
        "logEvents": extract_log_events(
            {
                ACTIVE_MAIN_C: active_main_c,
                MAIN_C: main_c,
                AUDIO_C: audio_c,
                SELF_TEST_C: self_test_c,
            }
        ),
        "resetReasons": extract_reset_reasons(self_test_c),
        "_sourceFiles": sorted(
            {
                STATIC_CONFIG_H: len(static_config),
                RUNTIME_CONFIG_H: len(runtime_config_h),
                RUNTIME_CONFIG_C: len(runtime_config_c),
                DIGIPOT_C: len(digipot_c),
                ACTIVE_MAIN_C: len(active_main_c),
            }
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--firmware", type=Path, help="path to the a3em-firmware checkout")
    parser.add_argument("--check", action="store_true", help="exit non-zero if the snapshot is stale")
    args = parser.parse_args()

    firmware = resolve_firmware(args.firmware)

    snapshot = build_snapshot(firmware)
    rendered = json.dumps(snapshot, indent=2, sort_keys=True) + "\n"

    if args.check:
        if not SNAPSHOT.is_file():
            print(f"FAIL: {SNAPSHOT.relative_to(REPO_ROOT)} does not exist yet.", file=sys.stderr)
            return 1
        if SNAPSHOT.read_text(encoding="utf-8") != rendered:
            print(
                f"FAIL: {SNAPSHOT.relative_to(REPO_ROOT)} is out of date with {firmware}.\n"
                f"Run: python3 tools/extract_firmware_constants.py",
                file=sys.stderr,
            )
            return 1
        print(f"OK: snapshot matches {firmware}")
        return 0

    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    existed = SNAPSHOT.is_file()
    previous = SNAPSHOT.read_text(encoding="utf-8") if existed else ""
    SNAPSHOT.write_text(rendered, encoding="utf-8")

    if not existed:
        print(f"Created {SNAPSHOT.relative_to(REPO_ROOT)} from {firmware}")
    elif previous == rendered:
        print(f"No change: {SNAPSHOT.relative_to(REPO_ROOT)} already matches {firmware}")
    else:
        print(f"Updated {SNAPSHOT.relative_to(REPO_ROOT)} from {firmware}")
        print("Now run the config-schema tests; failures name what to change in TypeScript.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
