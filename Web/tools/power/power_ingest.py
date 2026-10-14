#!/usr/bin/env python3
"""
Adds a characterization run to the power measurement catalogue.

    python3 tools/power/power_ingest.py run --results _power.results --windows captures/core_room.windows.json
    python3 tools/power/power_ingest.py sweep --sweep captures/brownout_room.sweep.json --temperature room --card adata --microphone SPH18R1LM4H-1
    python3 tools/power/power_ingest.py recompute
    python3 tools/power/power_ingest.py status

`run` pairs the windows a capture decoded with the STEP lines the firmware wrote to _power.results, in order, and
appends one measurement per step to reference/power/measurements.json. Temperature and parts come from the RUN line,
which copies them from _power.cfg; they have to name a temperature and parts the catalogue knows.

Every measurement keeps its raw window statistics alongside the value derived from them. A state's value is its
mean current. An event's value is its charge in excess of its baseline state, per event, using the baseline measured
in the same capture if there is one, and otherwise the most recent one taken at the same temperature with the same
parts. A value whose baseline has not been measured yet is left pending; `recompute` fills those in later and
re-derives the rest.

Nothing here edits a measurement by hand, and re-ingesting the same capture is a no-op.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timedelta
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parents[2]
# Overridable so the tool can be exercised against a scratch copy of the catalogue
POWER_DIR = Path(os.environ.get("A3EM_POWER_DIR", WEB_ROOT / "reference" / "power"))
CATALOGUE = POWER_DIR / "measurements.json"
COMPONENTS = POWER_DIR / "components.json"
FIELD = re.compile(r"(\w+)=([^,]*)")


def archive(files: list[Path], name: str, dry_run: bool) -> dict[str, str]:
    """Copies a run's evidence into reference/power/captures/<name>/, returning each file's path relative to POWER_DIR.

    The windows, the decimated trace and the results file are small and are what every value can be re-derived
    from, so they live beside the catalogue. Raw full-rate dumps do not; keep those wherever captures are taken.
    """
    folder = POWER_DIR / "captures" / name
    paths = {}
    for file in files:
        if not dry_run:
            folder.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, folder / file.name)
        paths[file.name] = str((folder / file.name).relative_to(POWER_DIR))
    return paths


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def save(catalogue: dict) -> None:
    CATALOGUE.write_text(json.dumps(catalogue, indent=2, ensure_ascii=False) + "\n")


def parse_results(path: Path) -> list[dict]:
    """Splits _power.results into runs, each a RUN header and the STEP lines that follow it."""
    runs: list[dict] = []
    for line in path.read_text(errors="replace").splitlines():
        kind, _, rest = line.partition("|")
        fields = dict(FIELD.findall(rest))
        if kind == "RUN":
            runs.append({"header": fields, "steps": [], "done": False})
        elif kind == "STEP" and runs:
            runs[-1]["steps"].append(fields)
        elif kind == "DONE" and runs:
            runs[-1]["done"] = True
    return runs


def component_ids(components: dict, header: dict) -> dict[str, str | None]:
    """Resolves the free-text parts on the RUN line to catalogue ids, case-insensitively by id or name."""
    resolved: dict[str, str | None] = {}
    for key, group, field in (("card", "cards", "card"), ("microphone", "microphones", "mic"), ("battery", "batteries", "battery")):
        text = (header.get(field) or "").strip().lower()
        match = next((c["id"] for c in components[group] if text and text in (c["id"].lower(), c.get("name", "").lower())), None)
        if text and not match:
            raise SystemExit(f"ERROR: {field}='{header.get(field)}' is not in components.json; add it there first")
        resolved[key] = match
    return resolved


def quantities_by_id(catalogue: dict) -> dict[str, dict]:
    return {q["id"]: q for q in catalogue["quantities"]}


def same_conditions(quantity: dict, a: dict, b: dict) -> bool:
    """Whether two measurements were taken at the same temperature with the same parts, as far as `quantity` cares."""
    if a["temperature"] != b["temperature"]:
        return False
    return all(a["components"].get(part) == b["components"].get(part) for part in quantity["dependsOn"])


def find_baseline(catalogue: dict, baseline_id: str, measurement: dict) -> dict | None:
    """The baseline from the same capture if present, otherwise the latest one taken under the same conditions."""
    baseline = quantities_by_id(catalogue)[baseline_id]
    candidates = [m for m in baseline["measurements"] if same_conditions(baseline, m, measurement)]
    same_capture = [m for m in candidates if m["capture"]["sha256"] == measurement["capture"]["sha256"] and m["run"] == measurement["run"]]
    pool = same_capture or candidates
    return max(pool, key=lambda m: m["capturedAt"]) if pool else None


def derive(catalogue: dict, quantity: dict, measurement: dict) -> None:
    """Fills in a measurement's value from its raw statistics and, for events, its baselines."""
    raw = measurement["raw"]
    measurement.pop("pending", None)
    measurement["baselines"] = {}
    if quantity["kind"] == "state":
        measurement["value"] = raw["meanUa"]
        return
    if quantity["kind"] == "limit":
        measurement["value"] = raw["lowestPassingMv"]
        return
    if not raw.get("events"):
        measurement["value"] = None
        measurement["pending"] = "the window recorded no events"
        return
    on = find_baseline(catalogue, quantity["baseline"], measurement)
    if on is None or on.get("value") is None:
        measurement["value"] = None
        measurement["pending"] = f"no {quantity['baseline']} measurement at {measurement['temperature']} with the same parts"
        return
    measurement["baselines"][quantity["baseline"]] = on["id"]
    excess = raw["chargeUc"]
    if quantity["kind"] == "cycle":
        off = find_baseline(catalogue, quantity["offBaseline"], measurement)
        if off is None or off.get("value") is None:
            measurement["value"] = None
            measurement["pending"] = f"no {quantity['offBaseline']} measurement at {measurement['temperature']}"
            return
        measurement["baselines"][quantity["offBaseline"]] = off["id"]
        on_s = raw["onS"]
        excess -= on["value"] * on_s + off["value"] * (raw["durationS"] - on_s)
    else:
        excess -= on["value"] * raw["durationS"]
    measurement["value"] = excess / raw["events"]


def append(catalogue: dict, quantity: dict, measurement: dict) -> bool:
    if any(m["id"] == measurement["id"] for m in quantity["measurements"]):
        return False
    quantity["measurements"].append(measurement)
    return True


def recompute_all(catalogue: dict) -> tuple[int, int]:
    # States and limits first, so events derive from current baselines
    order = sorted(catalogue["quantities"], key=lambda q: q["kind"] not in ("state", "limit"))
    derived = pending = 0
    for quantity in order:
        for measurement in quantity["measurements"]:
            derive(catalogue, quantity, measurement)
            derived += 1
            pending += 1 if measurement.get("pending") else 0
    return derived, pending


def ingest_run(args: argparse.Namespace) -> int:
    catalogue, components = load(CATALOGUE), load(COMPONENTS)
    by_code = {int(q["code"], 16): q for q in catalogue["quantities"]}
    results_path, windows_path = Path(args.results), Path(args.windows)
    capture = load(windows_path)
    window_codes = [int(w["code"], 16) for w in capture["windows"]]

    # The run whose step sequence the capture's windows match, latest first
    run = None
    for candidate in reversed(parse_results(results_path)):
        step_codes = [int(s["code"], 16) for s in candidate["steps"]]
        common = min(len(step_codes), len(window_codes))
        if common and step_codes[:common] == window_codes[:common]:
            run = candidate
            break
    if run is None:
        print("ERROR: no RUN in the results file matches the capture's window sequence", file=sys.stderr)
        return 1
    header = run["header"]
    temperature = (header.get("temperature") or "").strip().lower()
    if temperature not in catalogue["conditions"]["temperatures"]:
        print(f"ERROR: TEMPERATURE='{header.get('temperature')}' must be one of {list(catalogue['conditions']['temperatures'])}", file=sys.stderr)
        return 1
    parts = component_ids(components, header)
    if len(run["steps"]) != len(window_codes):
        print(f"WARNING: {len(run['steps'])} steps recorded but {len(window_codes)} windows captured; pairing the first "
              f"{min(len(run['steps']), len(window_codes))}")

    capture_sha, results_sha = sha256(windows_path), sha256(results_path)
    started = datetime.fromisoformat(capture["startedAt"]) if capture.get("startedAt") else None
    evidence = [windows_path, results_path]
    trace = windows_path.parent / capture.get("files", {}).get("trace", "")
    if capture.get("files", {}).get("trace") and trace.is_file():
        evidence.append(trace)
    stem = windows_path.name.removesuffix(".windows.json")
    archived = archive(evidence, f"{(started or datetime.now()).date().isoformat()}_{stem}_{capture_sha[:8]}", args.dry_run)
    added = skipped = 0
    for step, window in zip(run["steps"], capture["windows"]):
        quantity = by_code.get(int(step["code"], 16))
        if quantity is None:
            print(f"  skip {step['code']} {step.get('name')}: not in the catalogue (regenerate the snapshot?)")
            skipped += 1
            continue
        if step.get("setup") != "OK" or int(step.get("hal_failures", "0")):
            print(f"  skip {quantity['id']}: setup={step.get('setup')} hal_failures={step.get('hal_failures')}")
            skipped += 1
            continue
        missing = [part for part in quantity["dependsOn"] if not parts.get(part)]
        if missing:
            print(f"  skip {quantity['id']}: the RUN line does not say which {', '.join(missing)} was fitted")
            skipped += 1
            continue
        captured_at = (started + timedelta(seconds=window["startS"])).isoformat() if started else step.get("t")
        measurement = {
            "id": hashlib.sha256(f"{capture_sha}:{header.get('t')}:{step['run']}:{step['code']}".encode()).hexdigest()[:16],
            "value": None,
            "temperature": temperature,
            "dieTemperatureC": float(step["temp_c"]) if step.get("temp_c") else None,
            "components": {part: parts[part] for part in ("card", "microphone", "battery") if parts.get(part)},
            "supplyMv": capture.get("supplyMv"),
            "mode": capture.get("mode"),
            "firmware": header.get("fw"),
            "label": header.get("label") or None,
            "run": int(step["run"]),
            "capturedAt": captured_at,
            "raw": {
                "meanUa": window["meanUa"], "stdUa": window["stdUa"], "minUa": window["minUa"], "maxUa": window["maxUa"],
                "chargeUc": window["chargeUc"], "durationS": window["durationS"],
                "events": int(step["events"]), "onS": int(step["on_ms"]) / 1000.0,
                "firmwareWindowS": int(step["window_ms"]) / 1000.0, "awakeS": int(step["awake_ms"]) / 1000.0,
                "deepSleeps": int(step["sleeps"]), "cardWakes": int(step["card_wakes"]), "sdWrites": int(step["sd_writes"]),
                "sdKb": int(step["sd_kb"]), "micStarts": int(step["mic_starts"]), "audioBuffers": int(step["audio_buffers"]),
                "samplesPerDma": int(step["samples_per_dma"]), "imuSamples": int(step["imu_samples"]),
                "magnetChanges": int(step["magnet_changes"]), "vbatRestMv": int(step["vbat_rest_mv"]),
                "vbatLoadedMv": int(step["vbat_loaded_mv"]), "vbatMinMv": int(step["vbat_min_mv"]) or None,
                "retimedAtPowerOff": window.get("retimedAtPowerOff", False),
            },
            "capture": {"file": archived[windows_path.name], "sha256": capture_sha},
            "results": {"file": archived[results_path.name], "sha256": results_sha},
        }
        # The PPK2 and the firmware time the same window independently; a large disagreement means a mis-paired step
        if abs(measurement["raw"]["durationS"] - measurement["raw"]["firmwareWindowS"]) > 2.0 and not window.get("retimedAtPowerOff"):
            print(f"  WARNING {quantity['id']}: capture window {window['durationS']:.1f} s vs firmware {measurement['raw']['firmwareWindowS']:.1f} s")
        if append(catalogue, quantity, measurement):
            added += 1
        else:
            skipped += 1
    _, pending = recompute_all(catalogue)
    if not args.dry_run:
        save(catalogue)
    print(f"{added} measurements added, {skipped} skipped, {pending} pending a baseline{' (dry run)' if args.dry_run else ''}")
    return 0


def ingest_sweep(args: argparse.Namespace) -> int:
    catalogue, components = load(CATALOGUE), load(COMPONENTS)
    quantity = quantities_by_id(catalogue)["BROWNOUT_HEAVY"]
    path = Path(args.sweep)
    sweep = load(path)
    if args.temperature not in catalogue["conditions"]["temperatures"]:
        print(f"ERROR: --temperature must be one of {list(catalogue['conditions']['temperatures'])}", file=sys.stderr)
        return 1
    parts = component_ids(components, {"card": args.card, "mic": args.microphone, "battery": None})
    digest = sha256(path)
    archived = archive([path], f"{sweep['startedAt'][:10]}_{path.name.removesuffix('.sweep.json')}_{digest[:8]}", args.dry_run)
    measurement = {
        "id": digest[:16], "value": None, "temperature": args.temperature, "dieTemperatureC": None,
        "components": {part: parts[part] for part in ("card", "microphone") if parts.get(part)},
        "supplyMv": None, "mode": "source", "firmware": args.firmware, "label": args.label, "run": 1,
        "capturedAt": sweep["startedAt"],
        "raw": {"lowestPassingMv": sweep["lowestPassingMv"], "failure": sweep["failure"], "stepMv": sweep["stepMv"],
                "levels": sweep["levels"]},
        "capture": {"file": archived[path.name], "sha256": digest}, "results": None,
    }
    added = append(catalogue, quantity, measurement)
    recompute_all(catalogue)
    if not args.dry_run:
        save(catalogue)
    print("1 measurement added" if added else "already ingested")
    return 0


def recompute(args: argparse.Namespace) -> int:
    catalogue = load(CATALOGUE)
    derived, pending = recompute_all(catalogue)
    if not args.dry_run:
        save(catalogue)
    print(f"{derived} measurements re-derived, {pending} still pending a baseline")
    return 0


def status(_: argparse.Namespace) -> int:
    """What has been measured, at which temperatures, and what is still missing."""
    catalogue = load(CATALOGUE)
    temperatures = list(catalogue["conditions"]["temperatures"])
    print(f"{'quantity':26} {'unit':4} " + " ".join(f"{t:>9}" for t in temperatures))
    missing = 0
    for q in catalogue["quantities"]:
        cells = []
        for t in temperatures:
            values = [m["value"] for m in q["measurements"] if m["temperature"] == t and m.get("value") is not None]
            pending = any(m["temperature"] == t and m.get("pending") for m in q["measurements"])
            cells.append(f"{len(values)} meas" if values else ("pending" if pending else "-"))
            missing += 0 if values else 1
        print(f"{q['id']:26} {q['unit']:4} " + " ".join(f"{c:>9}" for c in cells))
    print(f"\n{missing} quantity-temperature cells still unmeasured")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run")
    p.add_argument("--results", required=True, help="_power.results copied from the card")
    p.add_argument("--windows", required=True, help="the .windows.json written by ppk2_capture.py")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("sweep")
    p.add_argument("--sweep", required=True, help="the .sweep.json written by ppk2_capture.py sweep")
    p.add_argument("--temperature", required=True)
    p.add_argument("--card", required=True)
    p.add_argument("--microphone", required=True)
    p.add_argument("--firmware", default=None, help="the fw= value from the card's _power.results")
    p.add_argument("--label", default=None)
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("recompute")
    p.add_argument("--dry-run", action="store_true")
    sub.add_parser("status")
    args = parser.parse_args()
    return {"run": ingest_run, "sweep": ingest_sweep, "recompute": recompute, "status": status}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
