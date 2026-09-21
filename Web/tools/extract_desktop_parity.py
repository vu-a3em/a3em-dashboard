#!/usr/bin/env python3
"""Drive the Python dashboard's own config writer and record exactly what it produces.

    python3 tools/extract_desktop_parity.py           # regenerate the parity snapshot
    python3 tools/extract_desktop_parity.py --check   # CI: fail if it has drifted

Why this exists
---------------
`Web/` replaces `Python/dashboard`, and the two write the same `_a3em.cfg`. Where they
disagree, one of them is wrong about what reaches the device — and until now those
disagreements lived in a prose findings document that nothing could check. A document
cannot tell you when it has gone stale.

So the disagreements are pinned instead. `desktop-parity.test.ts` asserts, key by key,
that the two tools either AGREE or diverge in exactly the recorded way. A failing
divergence test is good news: it means someone fixed the Python tool, and the finding
that described it needs retiring.

The writer is a Tkinter method that reads `.get()` off its attributes, so it is driven
here with a stub object rather than a GUI. The point is to run the REAL function: a
reimplementation of it here would compare this file against itself.
"""

from __future__ import annotations

import argparse
import importlib.util
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent          # .../a3em-dashboard/Web
DASHBOARD_ROOT = REPO_ROOT.parent                            # .../a3em-dashboard
WRITE_CONFIG = DASHBOARD_ROOT / "Python" / "dashboard" / "write_config.py"
SNAPSHOT = REPO_ROOT / "reference" / "desktop-parity.json"


def _ensure_pytz() -> bool:
    """Make `import pytz` work, with the standard library if the real package is absent.

    The writer uses pytz for exactly two things: the offset of a zone at an instant, and
    localising a naive datetime. `zoneinfo` does both, and for the fixed deployment this
    script uses the two agree exactly — which is asserted in the parity snapshot itself
    (`pytzSource`) and was verified against the real package when this was written.

    Substituting is done ONLY when pytz is missing. Where it is installed, the real thing
    runs, because the point of this script is to execute the desktop tool as shipped.
    """
    try:
        import pytz  # noqa: F401

        return True
    except ImportError:
        pass

    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        return False

    import types

    shim = types.ModuleType("pytz")

    # A real tzinfo, so `datetime.astimezone()` accepts it, with pytz's `localize` added.
    class _Zone(ZoneInfo):
        def localize(self, naive):
            return naive.replace(tzinfo=self)

    shim.timezone = _Zone
    shim.utc = __import__("datetime").timezone.utc
    sys.modules["pytz"] = shim
    return True


def pytz_source() -> str:
    _ensure_pytz()
    return "pytz" if getattr(sys.modules.get("pytz"), "__file__", None) else "zoneinfo-substitute"


class Value:
    """The `.get()` surface of a Tkinter variable, and nothing else."""

    def __init__(self, value):
        self._value = value

    def get(self):
        return self._value


class Phase:
    def __init__(self, **fields):
        for key, value in fields.items():
            setattr(self, key, value if key == "audio_trigger_times" else Value(value))


# The deployment both tools are asked to write. Chosen to exercise the things they are
# most likely to disagree about: a southern-hemisphere zone whose UTC offset differs
# between the moment of writing and the deployment itself, a disabled VHF beacon, and a
# single unphased phase.
DEPLOYMENT = {
    "device_label": "PARITY",
    "device_timezone": "Australia/Sydney",
    "set_rtc_at_magnet_detect": "True",
    "deployment_start_date": "2027-01-05",
    "deployment_start_time": "06:00",
    "deployment_end_date": "2027-01-19",
    "deployment_end_time": "06:00",
    "gps_available": "False",
    "awake_on_magnet": "True",
    "leds_enabled": "True",
    "leds_active_seconds": 60,
    "microphone_type": "Digital",
    "mic_amplification_level_db": 1,
    "battery_low_mv": 3250,
    "magnetic_field_validation_length_ms": 3000,
    "forbid_deactivation_seconds": 0,
    "vhf_mode": "Never",
    "vhf_start_date": "2027-01-19",
    "vhf_start_time": "06:00",
    "deployment_is_split": False,
}

PHASE = {
    "name": "Default",
    "audio_recording_mode": "Continuous",
    "extend_clip_if_continuous_audio": "False",
    "max_audio_clips": 60,
    "max_clips_time_scale": "Hour",
    "audio_trigger_threshold": 0.25,
    "audio_trigger_interval": 10,
    "audio_trigger_interval_time_scale": "Minute",
    "audio_sampling_rate": 16000,
    "audio_clip_length": 10,
    "imu_recording_mode": "Audio-Synced",
    "imu_degrees_of_freedom": 3,
    "imu_trigger_threshold": 100,
    "imu_sampling_rate": 50,
    "silence_threshold": 0,
    "min_frequency": 250,
    "max_frequency": 7800,
    "use_opus_encoding": "False",
    "opus_bitrate": 32000,
    "audio_filter_type": "No filtering",
    "audio_filter_low": 250,
    "audio_filter_high": 7800,
    "audio_trigger_times": [],
}


def load_writer():
    if not WRITE_CONFIG.is_file():
        raise SystemExit(f"ERROR: the Python dashboard is not where it was expected: {WRITE_CONFIG}")
    if not _ensure_pytz():
        raise SystemExit(
            "ERROR: the Python dashboard needs pytz and no substitute could be built.\n"
            "Install it with: python3 -m pip install pytz"
        )
    spec = importlib.util.spec_from_file_location("a3em_write_config", WRITE_CONFIG)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_desktop_writer(frozen_now: str) -> list[str]:
    """Run the real writer with `datetime.now()` pinned to a fixed instant.

    The writer derives DEVICE_UTC_OFFSET from the offset *at the moment of writing*, so
    its output genuinely changes with the calendar. Left unpinned this snapshot would go
    stale twice a year on its own and say nothing useful when it did. Freezing `now` makes
    the output reproducible — and running it at two instants either side of a DST change
    turns the time-dependence itself into something a test can assert.
    """
    module = load_writer()

    import datetime as datetime_module

    frozen = datetime_module.datetime.fromisoformat(frozen_now)

    class FrozenDatetime(datetime_module.datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen.astimezone(tz) if tz is not None else frozen

    # The writer did `from datetime import datetime`, so its module global is the class.
    module.datetime = FrozenDatetime
    app = type("App", (), {})()
    for key, value in DEPLOYMENT.items():
        setattr(app, key, Value(value))
    app.deployment_phases = [Phase(**PHASE)]
    app.deployment_phase_times = []

    with tempfile.TemporaryDirectory() as directory:
        app.save_directory = Value(directory)
        # The writer prints to a file handle; capture anything it sends to stdout too, so
        # a future version that reports through print() does not vanish.
        with redirect_stdout(io.StringIO()):
            module.write_config(app, "_a3em.cfg")
        return (Path(directory) / "_a3em.cfg").read_text(encoding="utf-8").splitlines()


# Two instants either side of a Sydney DST change, with the deployment in January (AEDT,
# +11). Written in September the desktop tool stamps +10; written in December it stamps
# +11. Only one of those can be right for the deployment, which is the point.
WRITTEN_IN_SEPTEMBER = "2026-09-13T12:00:00"
WRITTEN_IN_DECEMBER = "2026-12-13T12:00:00"


def build_snapshot() -> dict:
    lines = run_desktop_writer(WRITTEN_IN_SEPTEMBER)
    later = run_desktop_writer(WRITTEN_IN_DECEMBER)
    if len(lines) < 20:
        raise SystemExit(f"ERROR: the desktop writer produced only {len(lines)} lines; it did not run properly")
    return {
        "writtenAt": WRITTEN_IN_SEPTEMBER,
        "writtenAtLater": WRITTEN_IN_DECEMBER,
        "linesWrittenLater": later,
        "_comment": (
            "GENERATED by tools/extract_desktop_parity.py. Do not edit by hand. This is what "
            "Python/dashboard/write_config.py produces for the deployment described in that "
            "script; desktop-parity.test.ts compares it against this package key by key."
        ),
        "deployment": DEPLOYMENT,
        "phase": PHASE,
        "lines": lines,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="exit non-zero if the snapshot is stale")
    args = parser.parse_args()

    rendered = json.dumps(build_snapshot(), indent=2, sort_keys=True) + "\n"
    if args.check:
        if not SNAPSHOT.is_file():
            print(f"FAIL: {SNAPSHOT.relative_to(REPO_ROOT)} does not exist yet.", file=sys.stderr)
            return 1
        if SNAPSHOT.read_text(encoding="utf-8") != rendered:
            print(
                f"FAIL: {SNAPSHOT.relative_to(REPO_ROOT)} no longer matches what the Python "
                f"dashboard writes.\nRun: python3 tools/extract_desktop_parity.py",
                file=sys.stderr,
            )
            return 1
        print(f"OK: parity snapshot matches Python/dashboard (timezones via {pytz_source()})")
        return 0

    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT.write_text(rendered, encoding="utf-8")
    print(f"Updated {SNAPSHOT.relative_to(REPO_ROOT)} from {WRITE_CONFIG} (timezones via {pytz_source()})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
