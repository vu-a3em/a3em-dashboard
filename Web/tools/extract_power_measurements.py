#!/usr/bin/env python3
"""Reduce the A3EM Deployment Planner spreadsheet to a diffable JSON snapshot.

WHY THIS EXISTS
---------------
The power model in `packages/config-schema/src/power/` is a port of
"A3EM Deployment Planner.xlsx". An .xlsx is opaque to git: you cannot see what a
new revision changed, and nothing stops the TypeScript from drifting away from it.

This script extracts the constants AND the spreadsheet's own computed outputs into
`reference/planner-snapshot.json`. Tests then assert two things:

  1. `power/measurements.ts` still carries the same constants as the sheet.
  2. `power/forecast.ts` still reproduces the sheet's own average-current, storage,
     and battery-life figures.

So a spreadsheet revision shows up as a readable JSON diff plus failing tests that
name exactly which numbers moved.

USAGE
-----
    python3 tools/extract_power_measurements.py                # rewrite snapshot
    python3 tools/extract_power_measurements.py --check        # CI: fail on drift
    python3 tools/extract_power_measurements.py --xlsx PATH    # a spreadsheet elsewhere

WHERE THE SPREADSHEET LIVES
---------------------------
`Web/reference/A3EM Deployment Planner.xlsx`, versioned in this repo alongside the
code that depends on it. To update the power model, replace that file and rerun this
script. Resolution order:
    1. --xlsx PATH
    2. $A3EM_PLANNER_XLSX
    3. reference/A3EM Deployment Planner.xlsx
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_XLSX = REPO_ROOT / "reference" / "A3EM Deployment Planner.xlsx"
SNAPSHOT = REPO_ROOT / "reference" / "planner-snapshot.json"

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


class Workbook:
    """A minimal read-only .xlsx reader. Values only, no formula evaluation.

    Deliberately stdlib-only (zipfile + ElementTree) so this tool needs no install
    step and cannot break because of a dependency upgrade.
    """

    def __init__(self, path: Path):
        self.sheets: dict[str, dict[str, str]] = {}
        with zipfile.ZipFile(path) as archive:
            shared = self._read_shared_strings(archive)
            names = self._read_sheet_names(archive)
            for index, name in enumerate(names, start=1):
                member = f"xl/worksheets/sheet{index}.xml"
                if member not in archive.namelist():
                    continue
                self.sheets[name] = self._read_sheet(archive, member, shared)

    @staticmethod
    def _read_shared_strings(archive: zipfile.ZipFile) -> list[str]:
        if "xl/sharedStrings.xml" not in archive.namelist():
            return []
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        return ["".join(t.text or "" for t in si.iter(f"{NS}t")) for si in root]

    @staticmethod
    def _read_sheet_names(archive: zipfile.ZipFile) -> list[str]:
        root = ET.fromstring(archive.read("xl/workbook.xml"))
        return [s.get("name", "") for s in root.iter(f"{NS}sheet")]

    @staticmethod
    def _read_sheet(archive: zipfile.ZipFile, member: str, shared: list[str]) -> dict[str, str]:
        cells: dict[str, str] = {}
        root = ET.fromstring(archive.read(member))
        for cell in root.iter(f"{NS}c"):
            ref = cell.get("r")
            if not ref:
                continue
            value = cell.find(f"{NS}v")
            if value is None or value.text is None:
                continue
            if cell.get("t") == "s":
                cells[ref] = shared[int(value.text)]
            else:
                cells[ref] = value.text
        return cells

    def number(self, sheet: str, ref: str) -> float:
        raw = self._require(sheet, ref)
        try:
            return float(raw)
        except ValueError as exc:
            raise SystemExit(f"ERROR: {sheet}!{ref} is not numeric: {raw!r}") from exc

    def text(self, sheet: str, ref: str) -> str:
        return self._require(sheet, ref)

    def optional_number(self, sheet: str, ref: str) -> float | None:
        cells = self.sheets.get(sheet)
        if not cells or ref not in cells:
            return None
        try:
            return float(cells[ref])
        except ValueError:
            return None

    def _require(self, sheet: str, ref: str) -> str:
        if sheet not in self.sheets:
            raise SystemExit(
                f"ERROR: sheet {sheet!r} not found. Present: {sorted(self.sheets)}"
            )
        if ref not in self.sheets[sheet]:
            raise SystemExit(f"ERROR: {sheet}!{ref} is empty")
        return self.sheets[sheet][ref]

    def lookup_table(self, sheet: str, key_col: str, value_col: str, first_row: int) -> list[list]:
        """Reads a two-column lookup table downward until the key column runs out."""
        rows: list[list] = []
        row = first_row
        while True:
            key = self.sheets.get(sheet, {}).get(f"{key_col}{row}")
            if key is None:
                break
            value = self.sheets[sheet].get(f"{value_col}{row}")
            if value is None:
                break
            try:
                key_out: object = float(key) if re.fullmatch(r"-?\d+(\.\d+)?", key) else key
            except ValueError:
                key_out = key
            if isinstance(key_out, float) and key_out.is_integer():
                key_out = int(key_out)
            rows.append([key_out, float(value)])
            row += 1
        if not rows:
            raise SystemExit(f"ERROR: no lookup rows found at {sheet}!{key_col}{first_row}")
        return rows


def build_snapshot(book: Workbook) -> dict:
    # --- Calculations!E18:E31 — the shared model constants ------------------
    calculations = {
        "audioDmaBufferSamples": book.number("Calculations", "E18"),
        "sdAudioCacheBytes": book.number("Calculations", "E19"),
        "sdImuCacheSamples": book.number("Calculations", "E20"),
        "imuFifoSamples": book.number("Calculations", "E21"),
        "sdWriteMsPerByte": book.number("Calculations", "E22"),
        "sdWriteCurrentMa": book.number("Calculations", "E23"),
        "sdActivationCurrentMa": book.number("Calculations", "E24"),
        "sdSleepCurrentMa": book.number("Calculations", "E25"),
        "sdActivationDurationMs": book.number("Calculations", "E26"),
        "mcuIdleCurrentMa": book.number("Calculations", "E27"),
        "mcuActiveCurrentMa": book.number("Calculations", "E28"),
        "magnetActiveWindowMs": book.number("Calculations", "E29"),
        "magnetSleepWindowMs": book.number("Calculations", "E30"),
        "sdFatMaintenanceMs": book.number("Calculations", "E31"),
    }

    # --- MagPower ----------------------------------------------------------
    magnet = {
        "measurementDurationMs": book.number("MagPower", "E2"),
        "measurementCurrentMa": book.number("MagPower", "E3"),
        "idleCurrentMa": book.number("MagPower", "E4"),
        "sleepCurrentMa": book.number("MagPower", "E5"),
        "totalAverageCurrentMa": book.number("MagPower", "E6"),
    }

    # --- Planner inputs, D19:D23 -------------------------------------------
    planner_inputs = {
        "microphone": book.text("Planner", "D18"),
        "storedClipLengthSeconds": book.number("Planner", "D19"),
        "imuSampleRateHz": book.number("Planner", "D20"),
        "sdCardCapacityGb": book.number("Planner", "D21"),
        "batteryCapacityMah": book.number("Planner", "D22"),
        "sdSpeedClass": book.text("Planner", "D23"),
    }

    # --- Golden outputs. These become the port's test vectors. -------------
    # Planner rows 4-8 are uncompressed WAV; rows 12-16 are Ogg Opus at 48 kHz.
    wav_rows = []
    for row in range(4, 9):
        wav_rows.append(
            {
                "sampleRateHz": int(book.number("Planner", f"B{row}")),
                "processingMsPerInterval": book.number("Planner", f"I{row}"),
                "averageCurrentMa": book.number("Planner", f"L{row}"),
                "storageDays": int(book.number("Planner", f"M{row}")),
                "batteryDays": int(book.number("Planner", f"N{row}")),
            }
        )

    opus_rows = []
    for row in range(12, 17):
        opus_rows.append(
            {
                "sampleRateHz": int(book.number("Planner", f"B{row}")),
                "bitrateKbps": int(book.number("Planner", f"C{row}")),
                "encodeMsPerInterval": book.number("Planner", f"I{row}"),
                "averageCurrentMa": book.number("Planner", f"L{row}"),
                "storageDays": int(book.number("Planner", f"M{row}")),
                "batteryDays": int(book.number("Planner", f"N{row}")),
            }
        )

    return {
        "_comment": (
            "GENERATED by tools/extract_power_measurements.py from "
            "reference/A3EM Deployment Planner.xlsx. Do not edit by hand. Replace the "
            "spreadsheet and rerun the script; the config-schema tests will then name "
            "exactly which numbers changed."
        ),
        "calculations": calculations,
        "magnet": magnet,
        "plannerInputs": planner_inputs,
        "microphoneCurrentMa": book.lookup_table("MicPower", "B", "C", 3),
        "imuCurrentMa": book.lookup_table("ImuPower", "B", "C", 3),
        "sdSpeedClassMbPerS": book.lookup_table("SdSpeeds", "B", "C", 3),
        "goldenWav": wav_rows,
        "goldenOpus": opus_rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--xlsx", type=Path, help="path to the planner spreadsheet")
    parser.add_argument("--check", action="store_true", help="exit non-zero if the snapshot is stale")
    args = parser.parse_args()

    xlsx = args.xlsx or Path(os.environ.get("A3EM_PLANNER_XLSX", DEFAULT_XLSX))
    xlsx = xlsx.expanduser()
    if not xlsx.is_file():
        raise SystemExit(
            f"ERROR: spreadsheet not found at {xlsx}\n"
            f"Place it at {DEFAULT_XLSX.relative_to(REPO_ROOT)}, "
            f"or pass --xlsx PATH, or set A3EM_PLANNER_XLSX."
        )

    snapshot = build_snapshot(Workbook(xlsx))
    rendered = json.dumps(snapshot, indent=2, sort_keys=True) + "\n"

    if args.check:
        if not SNAPSHOT.is_file():
            print(f"FAIL: {SNAPSHOT.relative_to(REPO_ROOT)} does not exist yet.", file=sys.stderr)
            return 1
        if SNAPSHOT.read_text(encoding="utf-8") != rendered:
            print(
                f"FAIL: {SNAPSHOT.relative_to(REPO_ROOT)} is out of date with {xlsx.name}.\n"
                f"Run: python3 tools/extract_power_measurements.py",
                file=sys.stderr,
            )
            return 1
        print(f"OK: snapshot matches {xlsx.name}")
        return 0

    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    existed = SNAPSHOT.is_file()
    previous = SNAPSHOT.read_text(encoding="utf-8") if existed else ""
    SNAPSHOT.write_text(rendered, encoding="utf-8")

    if not existed:
        print(f"Created {SNAPSHOT.relative_to(REPO_ROOT)} from {xlsx.name}")
    elif previous == rendered:
        print(f"No change: {SNAPSHOT.relative_to(REPO_ROOT)} already matches {xlsx.name}")
    else:
        print(f"Updated {SNAPSHOT.relative_to(REPO_ROOT)} from {xlsx.name}")
        print("Now run the config-schema tests; failures name what to change in TypeScript.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
