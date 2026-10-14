#!/usr/bin/env python3
"""
Records a Nordic PPK2 capture of the power characterization firmware and cuts it into steps.

    python3 tools/power/ppk2_capture.py capture --out captures/core_room [--mode source --mv 3600]
    python3 tools/power/ppk2_capture.py capture --out captures/batt_freezer --mode ampere
    python3 tools/power/ppk2_capture.py analyze export.csv --out captures/core_room   # nRF Connect CSV export
    python3 tools/power/ppk2_capture.py sweep --out captures/brownout_room [--start-mv 3600 --step-mv 25]
    python3 tools/power/ppk2_capture.py self-test

The firmware marks every measurement window on the external I2C test points (see
a3em-firmware/src/peripherals/include/power_marker.h): eight short CLK low pulses carry a step
code on DATA, the window opens when the frame ends, and one long CLK pulse closes it. Wire CLK
to PPK2 logic input D0 and DATA to D1 (or say otherwise with --clk/--data), and the logic port's
VCC to the same rail the test-point pull-ups go to.

Decoding happens as samples arrive, so an hour at 100 kS/s never has to be held in memory. What
is written:

    <out>.windows.json   every window and point found, with full-rate statistics for each window
    <out>.trace.npz      a 10 ms decimated trace (mean and max current, both marker lines), for
                         looking at what happened between and inside windows
    <out>.raw.npz        only with --raw: every sample, for re-analysis

Requires numpy, and for live capture the ppk2-api package (pip install ppk2-api numpy).
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

SAMPLE_RATE_HZ = 100_000
SHORT_PULSE_MAX_S = 500e-6        # data bits are 100 us; the closing pulse is 1 ms
FRAME_GAP_S = 2e-3                # a partial frame left this long is a glitch, not a frame
TRACE_BIN_S = 10e-3
DONE_CODE = 0x00
POINT_CODES = {0xE0: "HEARTBEAT_OK", 0xE1: "HEARTBEAT_FAULT", 0xF0: "BOOT", 0xF1: "PHASE_START",
               0xF2: "PHASE_END", 0xF3: "SELF_TEST_START", 0xF4: "SELF_TEST_END", 0xF5: "POWER_OFF"}
POWER_OFF_CODE = 0xF5


@dataclass
class Window:
    code: int
    start: int                     # sample index of the first sample inside the window
    end: int = -1                  # sample index one past the last
    n: int = 0
    total: float = 0.0             # sum of microamps
    total_sq: float = 0.0
    minimum: float = float("inf")
    maximum: float = float("-inf")
    retimed_at_power_off: bool = False

    def add(self, current: np.ndarray) -> None:
        if current.size:
            self.n += int(current.size)
            self.total += float(current.sum())
            self.total_sq += float(np.square(current, dtype=np.float64).sum())
            self.minimum = min(self.minimum, float(current.min()))
            self.maximum = max(self.maximum, float(current.max()))

    def restart(self, start: int) -> None:
        self.start, self.n, self.total, self.total_sq = start, 0, 0.0, 0.0
        self.minimum, self.maximum = float("inf"), float("-inf")
        self.retimed_at_power_off = True

    def summary(self) -> dict:
        mean = self.total / self.n if self.n else None
        variance = (self.total_sq / self.n - mean * mean) if self.n else None
        return {
            "code": f"0x{self.code:02X}",
            "startS": self.start / SAMPLE_RATE_HZ,
            "durationS": self.n / SAMPLE_RATE_HZ,
            "spanS": (self.end - self.start) / SAMPLE_RATE_HZ,
            "samples": self.n,
            "meanUa": mean,
            "stdUa": float(np.sqrt(max(variance, 0.0))) if variance is not None else None,
            "minUa": self.minimum if self.n else None,
            "maxUa": self.maximum if self.n else None,
            "chargeUc": self.total / SAMPLE_RATE_HZ,
            "retimedAtPowerOff": self.retimed_at_power_off,
        }


@dataclass
class Decoder:
    """Streaming marker decoder and window integrator."""
    index: int = 0                 # global index of the next sample
    clk: int = 1
    data: int = 1
    low_start: int | None = None
    bits: list[int] = field(default_factory=list)
    last_rise: int = 0
    window: Window | None = None
    windows: list[Window] = field(default_factory=list)
    points: list[dict] = field(default_factory=list)
    unclosed: list[dict] = field(default_factory=list)
    glitches: int = 0
    done_at: int | None = None
    # Decimated trace
    _bin_sum: float = 0.0
    _bin_max: float = float("-inf")
    _bin_n: int = 0
    _bin_clk: int = 1
    _bin_data: int = 1
    trace_mean: list[float] = field(default_factory=list)
    trace_max: list[float] = field(default_factory=list)
    trace_clk: list[int] = field(default_factory=list)
    trace_data: list[int] = field(default_factory=list)

    def feed(self, current: np.ndarray, clk: np.ndarray, data: np.ndarray) -> None:
        current = np.asarray(current, dtype=np.float64)
        clk = np.asarray(clk, dtype=np.int8)
        data = np.asarray(data, dtype=np.int8)
        self._trace(current, clk, data)
        edges = np.flatnonzero(np.diff(np.concatenate(([self.clk], clk)).astype(np.int8)))
        cursor = 0
        for edge in edges:
            self._segment(current[cursor:edge], high=bool(self.clk))
            data_before_edge = int(data[edge - 1]) if edge > 0 else self.data
            self._edge(self.index + int(edge), rising=bool(clk[edge]), data_bit=data_before_edge)
            self.clk = int(clk[edge])
            cursor = int(edge)
        self._segment(current[cursor:], high=bool(self.clk))
        self.index += int(current.size)
        if clk.size:
            self.data = int(data[-1])
        # A partial frame that went quiet was noise on the line
        if self.bits and self.clk and (self.index - self.last_rise) > FRAME_GAP_S * SAMPLE_RATE_HZ:
            self.glitches += 1
            self.bits = []

    def _segment(self, current: np.ndarray, high: bool) -> None:
        # Only samples with CLK released belong to a window; low samples are the markers themselves
        if self.window is not None and high and not self.bits:
            self.window.add(current)

    def _edge(self, at: int, rising: bool, data_bit: int) -> None:
        if not rising:
            # A partial frame followed by a long quiet gap was noise on the line, not the start of this frame
            if self.bits and (at - self.last_rise) > FRAME_GAP_S * SAMPLE_RATE_HZ:
                self.glitches += 1
                self.bits = []
            self.low_start = at
            return
        if self.low_start is None:
            return
        width = (at - self.low_start) / SAMPLE_RATE_HZ
        if width > SHORT_PULSE_MAX_S:
            # The closing pulse ends the open window where the pulse began
            self.bits = []
            if self.window is not None:
                self.window.end = self.low_start
                self.windows.append(self.window)
                self.window = None
            else:
                self.unclosed.append({"kind": "end-without-window", "atS": self.low_start / SAMPLE_RATE_HZ})
        else:
            self.bits.append(data_bit)
            self.last_rise = at
            if len(self.bits) == 8:
                code = int("".join(str(b) for b in self.bits), 2)
                self.bits = []
                self._frame(code, at)
        self.low_start = None

    def _frame(self, code: int, at: int) -> None:
        if code == DONE_CODE:
            self.done_at = at
            self.points.append({"code": "0x00", "name": "SUITE_DONE", "atS": at / SAMPLE_RATE_HZ})
            return
        if code in POINT_CODES:
            self.points.append({"code": f"0x{code:02X}", "name": POINT_CODES[code], "atS": at / SAMPLE_RATE_HZ})
            # A power-off step's own frame comes before the firmware's teardown; its window really starts here
            if code == POWER_OFF_CODE and self.window is not None:
                self.window.restart(at)
            return
        if self.window is not None:
            self.unclosed.append({"kind": "window-never-closed", "code": f"0x{self.window.code:02X}",
                                  "startS": self.window.start / SAMPLE_RATE_HZ})
        self.window = Window(code=code, start=at)

    def _trace(self, current: np.ndarray, clk: np.ndarray, data: np.ndarray) -> None:
        per_bin = int(TRACE_BIN_S * SAMPLE_RATE_HZ)
        i = 0
        while i < current.size:
            take = min(per_bin - self._bin_n, current.size - i)
            chunk = current[i:i + take]
            self._bin_sum += float(chunk.sum())
            self._bin_max = max(self._bin_max, float(chunk.max()))
            self._bin_clk = min(self._bin_clk, int(clk[i:i + take].min()))
            self._bin_data = min(self._bin_data, int(data[i:i + take].min()))
            self._bin_n += take
            i += take
            if self._bin_n == per_bin:
                self.trace_mean.append(self._bin_sum / per_bin)
                self.trace_max.append(self._bin_max)
                self.trace_clk.append(self._bin_clk)
                self.trace_data.append(self._bin_data)
                self._bin_sum, self._bin_max, self._bin_n, self._bin_clk, self._bin_data = 0.0, float("-inf"), 0, 1, 1

    def result(self) -> dict:
        unclosed = list(self.unclosed)
        if self.window is not None:
            unclosed.append({"kind": "window-open-at-end", "code": f"0x{self.window.code:02X}",
                             "startS": self.window.start / SAMPLE_RATE_HZ})
        return {
            "sampleRateHz": SAMPLE_RATE_HZ,
            "samples": self.index,
            "durationS": self.index / SAMPLE_RATE_HZ,
            "windows": [w.summary() for w in self.windows],
            "points": self.points,
            "problems": unclosed,
            "glitches": self.glitches,
            "suiteDone": self.done_at is not None,
        }


def segments(decoder: Decoder) -> list[dict]:
    """Charge between each pair of consecutive point markers, from the 10 ms trace.

    This is what validates a whole deployment: each PHASE_START to PHASE_END is a phase to set against the
    forecast, and each PHASE_END to the next PHASE_START is the cost of a phase transition. Heartbeats are left out.
    """
    marks = [p for p in decoder.points if not p["name"].startswith("HEARTBEAT")]
    trace = np.asarray(decoder.trace_mean, dtype=np.float64)
    result = []
    for first, second in zip(marks, marks[1:] + [{"name": "END_OF_CAPTURE", "atS": len(trace) * TRACE_BIN_S}]):
        lo, hi = int(first["atS"] / TRACE_BIN_S), int(second["atS"] / TRACE_BIN_S)
        if hi <= lo:
            continue
        charge = float(trace[lo:hi].sum()) * TRACE_BIN_S
        duration = (hi - lo) * TRACE_BIN_S
        result.append({"from": first["name"], "to": second["name"], "startS": lo * TRACE_BIN_S, "durationS": duration,
                       "chargeUc": charge, "meanUa": charge / duration})
    return result


def write_outputs(decoder: Decoder, out: Path, meta: dict, raw: tuple[list, list] | None) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    trace_path = out.with_suffix(".trace.npz")
    np.savez_compressed(trace_path, bin_s=TRACE_BIN_S, mean_ua=np.asarray(decoder.trace_mean, np.float32),
                        max_ua=np.asarray(decoder.trace_max, np.float32), clk=np.asarray(decoder.trace_clk, np.int8),
                        data=np.asarray(decoder.trace_data, np.int8))
    files = {"trace": trace_path.name}
    if raw is not None:
        raw_path = out.with_suffix(".raw.npz")
        np.savez_compressed(raw_path, current_ua=np.concatenate(raw[0]) if raw[0] else np.zeros(0, np.float32),
                            digital=np.concatenate(raw[1]) if raw[1] else np.zeros(0, np.uint8))
        files["raw"] = raw_path.name
    hashes = {name: hashlib.sha256((out.parent / file).read_bytes()).hexdigest() for name, file in files.items()}
    document = {**meta, **decoder.result(), "segments": segments(decoder), "files": files, "sha256": hashes}
    windows_path = out.with_suffix(".windows.json")
    windows_path.write_text(json.dumps(document, indent=2) + "\n")
    print(f"\n{len(decoder.windows)} windows, {len(decoder.points)} points, {decoder.glitches} glitches"
          f"{'' if decoder.done_at is not None else ', suite NOT finished'} -> {windows_path}")
    for problem in document["problems"]:
        print(f"  problem: {problem}")


# Live capture -----------------------------------------------------------------------------------------------------

def capture(args: argparse.Namespace) -> int:
    try:
        from ppk2_api.ppk2_api import PPK2_API
    except ImportError:
        print("ERROR: live capture needs the ppk2-api package (pip install ppk2-api)", file=sys.stderr)
        return 2

    devices = PPK2_API.list_devices()
    if not devices:
        print("ERROR: no PPK2 found", file=sys.stderr)
        return 2
    port = devices[0][0] if isinstance(devices[0], (tuple, list)) else devices[0]
    ppk2 = PPK2_API(port, timeout=1, write_timeout=1, exclusive=True)
    ppk2.get_modifiers()
    if args.mode == "source":
        ppk2.use_source_meter()
        ppk2.set_source_voltage(args.mv)
    else:
        ppk2.use_ampere_meter()

    decoder = Decoder()
    raw: tuple[list, list] | None = ([], []) if args.raw else None
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGINT, stop)

    started = dt.datetime.now(dt.timezone.utc)
    if args.mode == "source":
        ppk2.toggle_DUT_power("ON")
    ppk2.start_measuring()
    deadline = time.monotonic() + args.max_hours * 3600
    last_report = 0.0
    print(f"Capturing from {port} in {args.mode} mode; Ctrl-C to stop early.")
    try:
        while not stopping and time.monotonic() < deadline:
            data = ppk2.get_data()
            if not data:
                time.sleep(0.001)
                continue
            result = ppk2.get_samples(data)
            samples, digital = result if isinstance(result, tuple) else (result, None)
            if digital is None:
                print("ERROR: this ppk2-api version returns no logic data; upgrade it", file=sys.stderr)
                return 2
            current = np.asarray(samples, dtype=np.float64)
            bits = np.asarray(digital, dtype=np.uint8)
            decoder.feed(current, (bits >> args.clk) & 1, (bits >> args.data) & 1)
            if raw is not None:
                raw[0].append(current.astype(np.float32))
                raw[1].append(bits)
            if decoder.done_at is not None and decoder.index - decoder.done_at > 2 * SAMPLE_RATE_HZ:
                break
            if time.monotonic() - last_report > 10:
                last_report = time.monotonic()
                open_code = f"0x{decoder.window.code:02X}" if decoder.window else "-"
                print(f"  {decoder.index / SAMPLE_RATE_HZ:8.0f} s  windows {len(decoder.windows):3d}  open {open_code}",
                      flush=True)
    finally:
        ppk2.stop_measuring()
        if args.mode == "source" and args.power_off_at_end:
            ppk2.toggle_DUT_power("OFF")

    meta = {"tool": "ppk2_capture.py", "source": "ppk2-live", "port": str(port), "mode": args.mode,
            "supplyMv": args.mv if args.mode == "source" else None, "startedAt": started.isoformat(),
            "clkChannel": args.clk, "dataChannel": args.data}
    write_outputs(decoder, Path(args.out), meta, raw)
    return 0


# Supply sweep for the brownout suite -----------------------------------------------------------------------------

def sweep(args: argparse.Namespace) -> int:
    """Lowers the source-meter supply in steps until the heaviest load stops completing.

    The brownout firmware marks every completed cycle with a heartbeat, a fault heartbeat if any write failed. A level
    passes when it saw at least one good heartbeat, no fault, and no silence longer than the timeout.
    """
    try:
        from ppk2_api.ppk2_api import PPK2_API
    except ImportError:
        print("ERROR: the sweep needs the ppk2-api package (pip install ppk2-api)", file=sys.stderr)
        return 2
    devices = PPK2_API.list_devices()
    if not devices:
        print("ERROR: no PPK2 found", file=sys.stderr)
        return 2
    port = devices[0][0] if isinstance(devices[0], (tuple, list)) else devices[0]
    ppk2 = PPK2_API(port, timeout=1, write_timeout=1, exclusive=True)
    ppk2.get_modifiers()
    ppk2.use_source_meter()
    ppk2.set_source_voltage(args.start_mv)

    decoder = Decoder()
    levels: list[dict] = []
    level_mv, level_start, level_sum, level_n = args.start_mv, 0, 0.0, 0
    seen_points, last_beat, warmed_up, failure = 0, None, False, None
    started = dt.datetime.now(dt.timezone.utc)
    ppk2.toggle_DUT_power("ON")
    ppk2.start_measuring()
    print(f"Warming up at {args.start_mv} mV until the first heartbeat...")
    try:
        while True:
            data = ppk2.get_data()
            if not data:
                time.sleep(0.001)
                continue
            result = ppk2.get_samples(data)
            samples, digital = result if isinstance(result, tuple) else (result, None)
            if digital is None:
                print("ERROR: this ppk2-api version returns no logic data; upgrade it", file=sys.stderr)
                return 2
            current = np.asarray(samples, dtype=np.float64)
            bits = np.asarray(digital, dtype=np.uint8)
            decoder.feed(current, (bits >> args.clk) & 1, (bits >> args.data) & 1)
            level_sum += float(current.sum())
            level_n += int(current.size)
            now = decoder.index

            # Count the heartbeats that arrived in this chunk
            ok = fault = 0
            for point in decoder.points[seen_points:]:
                if point["name"] == "HEARTBEAT_OK":
                    ok += 1
                elif point["name"] == "HEARTBEAT_FAULT":
                    fault += 1
                if point["name"].startswith("HEARTBEAT"):
                    last_beat = int(point["atS"] * SAMPLE_RATE_HZ)
            seen_points = len(decoder.points)
            if not warmed_up:
                # Hold the starting voltage until the device has booted, mounted, and run for the warm-up
                if last_beat is not None and decoder.index / SAMPLE_RATE_HZ >= args.warmup_s:
                    warmed_up, level_start, level_sum, level_n = True, now, 0.0, 0
                    levels.append({"mv": level_mv, "ok": 0, "fault": 0})
                    print(f"  descending from {level_mv} mV")
                elif decoder.index / SAMPLE_RATE_HZ > args.warmup_s * 4:
                    print("ERROR: no heartbeat at the starting voltage; is the brownout suite on the card?", file=sys.stderr)
                    return 1
                continue
            levels[-1]["ok"] += ok
            levels[-1]["fault"] += fault
            silent_s = (now - (last_beat if last_beat is not None else level_start)) / SAMPLE_RATE_HZ
            if fault or silent_s > args.timeout_s:
                failure = {"mv": level_mv, "reason": "write failure" if fault else f"no heartbeat for {silent_s:.1f} s"}
                levels[-1]["meanUa"] = level_sum / level_n if level_n else None
                break
            if (now - level_start) / SAMPLE_RATE_HZ >= args.dwell_s:
                levels[-1]["meanUa"] = level_sum / level_n if level_n else None
                print(f"  {level_mv} mV  {levels[-1]['ok']} heartbeats  {levels[-1]['meanUa'] / 1000:.2f} mA mean")
                if levels[-1]["ok"] == 0:
                    failure = {"mv": level_mv, "reason": "no heartbeat during the dwell"}
                    break
                level_mv -= args.step_mv
                if level_mv < args.floor_mv:
                    break
                ppk2.set_source_voltage(level_mv)
                levels.append({"mv": level_mv, "ok": 0, "fault": 0})
                level_start, level_sum, level_n = now, 0.0, 0
    finally:
        ppk2.stop_measuring()
        ppk2.toggle_DUT_power("OFF")

    passed = [level["mv"] for level in levels if level.get("ok") and not level.get("fault") and level["mv"] != (failure or {}).get("mv")]
    document = {
        "tool": "ppk2_capture.py", "source": "ppk2-sweep", "port": str(port), "startedAt": started.isoformat(),
        "startMv": args.start_mv, "stepMv": args.step_mv, "dwellS": args.dwell_s, "timeoutS": args.timeout_s,
        "levels": levels, "lowestPassingMv": min(passed) if passed else None, "failure": failure,
        "note": "The minimum operating voltage under this load lies between lowestPassingMv and the failure level.",
    }
    out = Path(args.out).with_suffix(".sweep.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(document, indent=2) + "\n")
    print(f"\nlowest passing {document['lowestPassingMv']} mV; failure {failure} -> {out}")
    return 0


# Offline analysis of an nRF Connect Power Profiler export -----------------------------------------------------------

def analyze(args: argparse.Namespace) -> int:
    path = Path(args.csv)
    decoder = Decoder()
    with path.open(newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        current_col = next((i for i, h in enumerate(header) if "current" in h.lower()), None)
        logic_col = next((i for i, h in enumerate(header) if h.strip().upper().startswith("D0")), None)
        if current_col is None or logic_col is None:
            print(f"ERROR: expected a current column and a D0-D7 logic column, found {header}", file=sys.stderr)
            return 2
        chunk_current, chunk_logic = [], []

        def flush():
            if not chunk_current:
                return
            logic = np.asarray(chunk_logic, dtype=np.uint8)
            decoder.feed(np.asarray(chunk_current, dtype=np.float64), (logic >> args.clk) & 1, (logic >> args.data) & 1)
            chunk_current.clear()
            chunk_logic.clear()

        for row in reader:
            if len(row) <= max(current_col, logic_col):
                continue
            chunk_current.append(float(row[current_col]))
            text = row[logic_col].strip()
            # The export writes the eight lines as a string of digits, D0 first unless told otherwise
            bits = text if args.digital_order == "d0-first" else text[::-1]
            chunk_logic.append(sum((1 << i) for i, ch in enumerate(bits[:8]) if ch == "1"))
            if len(chunk_current) >= 200_000:
                flush()
        flush()

    meta = {"tool": "ppk2_capture.py", "source": "nrf-connect-csv", "csv": path.name,
            "csvSha256": hashlib.sha256(path.read_bytes()).hexdigest(), "mode": args.mode,
            "supplyMv": args.mv if args.mode == "source" else None, "clkChannel": args.clk, "dataChannel": args.data,
            "digitalOrder": args.digital_order}
    write_outputs(decoder, Path(args.out), meta, None)
    if not decoder.windows:
        print("No windows decoded. Check the CLK/DATA channels, and try --digital-order d7-first.")
    return 0


# Self-test against a synthetic capture ----------------------------------------------------------------------------

class Synth:
    """Builds current and marker lines the way the firmware drives them."""

    def __init__(self) -> None:
        self.current: list[float] = []
        self.clk: list[int] = []
        self.data: list[int] = []

    def hold(self, seconds: float, ua: float, clk: int = 1, data: int = 1) -> "Synth":
        n = int(round(seconds * SAMPLE_RATE_HZ))
        self.current += [ua] * n
        self.clk += [clk] * n
        self.data += [data] * n
        return self

    def frame(self, code: int) -> "Synth":
        for bit in range(7, -1, -1):
            value = (code >> bit) & 1
            self.hold(100e-6, 500.0, 1, value).hold(100e-6, 900.0, 0, value)
        return self

    def end(self) -> "Synth":
        return self.hold(1000e-6, 700.0, 0, 1)

    def arrays(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        return np.asarray(self.current), np.asarray(self.clk, np.int8), np.asarray(self.data, np.int8)


def self_test(_: argparse.Namespace) -> int:
    synth = (Synth()
             .hold(1.0, 50.0)
             .frame(0x01).hold(2.0, 3.0).end()                       # a state window
             .hold(0.5, 40.0)
             .hold(100e-6, 40.0, clk=0).hold(0.01, 40.0)             # a stray pulse just before a frame
             .frame(0x25).hold(1.5, 1200.0).end()                    # an event window
             .hold(0.2, 40.0)
             .frame(0x12).hold(0.05, 900.0)                          # power-off: step frame, then teardown,
             .frame(POWER_OFF_CODE).hold(1.0, 2.0).end()             # then the firmware's own point opens it
             .frame(DONE_CODE).hold(0.1, 3.0))
    current, clk, data = synth.arrays()

    # Fed in an awkward chunk size, so that edges and frames straddle chunk boundaries
    decoder = Decoder()
    step = 7919
    for start in range(0, current.size, step):
        decoder.feed(current[start:start + step], clk[start:start + step], data[start:start + step])
    result = decoder.result()
    windows = {w["code"]: w for w in result["windows"]}
    checks = [
        ("three windows", len(result["windows"]) == 3),
        ("floor window mean", "0x01" in windows and abs(windows["0x01"]["meanUa"] - 3.0) < 1e-9),
        ("floor window duration", "0x01" in windows and abs(windows["0x01"]["durationS"] - 2.0) < 1e-4),
        ("event window charge", "0x25" in windows and abs(windows["0x25"]["chargeUc"] - 1200.0 * 1.5) < 1e-6),
        ("power-off window retimed", "0x12" in windows and windows["0x12"]["retimedAtPowerOff"]),
        ("power-off window excludes teardown", "0x12" in windows and abs(windows["0x12"]["meanUa"] - 2.0) < 1e-9),
        ("power-off point seen", any(p["name"] == "POWER_OFF" for p in result["points"])),
        ("suite done seen", result["suiteDone"]),
        ("stray pulse discarded", result["glitches"] == 1),
        ("no problems", not result["problems"]),
    ]
    for name, ok in checks:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
    if not all(ok for _, ok in checks):
        print(json.dumps(result, indent=2))
    return 0 if all(ok for _, ok in checks) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("capture", "analyze"):
        p = sub.add_parser(name)
        if name == "analyze":
            p.add_argument("csv")
            p.add_argument("--digital-order", choices=("d0-first", "d7-first"), default="d0-first")
        else:
            p.add_argument("--max-hours", type=float, default=12.0)
            p.add_argument("--raw", action="store_true", help="also keep every sample (large)")
            p.add_argument("--power-off-at-end", action="store_true")
        p.add_argument("--out", required=True, help="output path stem, such as captures/core_room")
        p.add_argument("--mode", choices=("source", "ampere"), default="source")
        p.add_argument("--mv", type=int, default=3600, help="source-meter supply in millivolts")
        p.add_argument("--clk", type=int, default=0, help="logic input wired to the CLK test point")
        p.add_argument("--data", type=int, default=1, help="logic input wired to the DATA test point")
    p = sub.add_parser("sweep")
    p.add_argument("--out", required=True, help="output path stem, such as captures/brownout_room")
    p.add_argument("--start-mv", type=int, default=3600)
    p.add_argument("--step-mv", type=int, default=25)
    p.add_argument("--floor-mv", type=int, default=2000)
    p.add_argument("--dwell-s", type=float, default=20.0)
    p.add_argument("--warmup-s", type=float, default=30.0)
    p.add_argument("--timeout-s", type=float, default=5.0)
    p.add_argument("--clk", type=int, default=0)
    p.add_argument("--data", type=int, default=1)
    sub.add_parser("self-test")
    args = parser.parse_args()
    return {"capture": capture, "analyze": analyze, "sweep": sweep, "self-test": self_test}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
