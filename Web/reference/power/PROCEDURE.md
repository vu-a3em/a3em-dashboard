# Taking power measurements

The bench procedure behind `measurements.json`.

**Equipment**
- A Nordic PPK2.
- A card reader.
- Somewhere to put the board at room temperature, in a refrigerator, and in a freezer.

**Software**
- The tools need `pip install ppk2-api numpy`.
- Flashing needs the J-Link and the usual firmware toolchain.

## Wiring

| PPK2 | Board |
|---|---|
| VOUT | Battery + input |
| GND | Battery − / ground |
| Logic D0 | External I2C **SCL** test point (pin 0, marker CLK) |
| Logic D1 | External I2C **SDA** test point (pin 1, marker DATA) |
| Logic GND | Ground |
| Logic VCC | The rail the external I2C pull-ups go to |

Always connect the PPK2 at the battery input, never at a regulated rail. Every number in the
catalogue is current at the battery terminal.

While measuring:

- **J-Link:** disconnect it, because its lines can back-power and leak.
- **GPS/tracker board:** leave it off. The markers borrow its I2C lines.
- **SD card:** keep one inserted for every run. Results are written to it, and the card is
  powered down inside every window that is not measuring it.

### Battery runs

For battery runs, put the cell in series: cell + to PPK2 VIN, PPK2 VOUT to battery +, and the
cell's − to ground. In this mode the PPK2 measures current but does not supply it.

### The marker lines

The marker lines idle released and cost nothing. During a frame they sink current through their
pull-ups, but frames only fall between measurement windows, never inside one.

## Characterization runs

Each run is one suite at one temperature with one set of parts.

1. **Build and flash the characterization firmware.** Run `cd a3em-firmware/tests && make power`.
   It builds without the debug console and at deployment optimization, then flashes.
2. **Write the run's settings.** Run
   `node tools/power/make-power-configs.mjs suite --suite <suite> --temperature <room|fridge|freezer> [--card ID] [--microphone ID] [--battery ID]`
   and copy the file it names to the card root as `_power.cfg`. Part ids come from
   `components.json`; add a part there first if it is new.
   - Fridge and freezer runs default to a 60-minute soak at the floor before the first step.
3. **Start the capture, then power the board.**
   - Source-meter runs: `python3 tools/power/ppk2_capture.py capture --out captures/<suite>_<parts>_<temperature>`.
     The capture switches the supply on itself, at 3.6 V.
   - Battery runs: add `--mode ampere`, start the capture, then connect the cell last.
4. **Wait for the capture to stop on its own.** It stops when the firmware sends its end-of-suite
   frame, and prints how many windows it decoded and any problems.
5. **Ingest the run.** Copy `_power.results` off the card, then run
   `python3 tools/power/power_ingest.py run --results <card>/_power.results --windows captures/<...>.windows.json`.
   - Events whose baseline was measured in a different suite stay `pending` until that suite has
     run. Run `power_ingest.py recompute` once it has.
6. **Check coverage.** `python3 tools/power/power_ingest.py status` shows every quantity against
   every temperature.

### Brown-out sweep

The sweep finds the lowest supply the board works at, and so where a cell is really used up.

1. Fit the heaviest card and microphone combination.
2. Write a `brownout` suite config.
3. Run `python3 tools/power/ppk2_capture.py sweep --out captures/brownout_<temperature>`.

The sweep holds 3.6 V until the firmware is running. It then steps the supply down 25 mV every
20 s until a cycle fails to write or the heartbeats stop, and then switches the supply off.

Ingest the result with
`power_ingest.py sweep --sweep captures/brownout_<temperature>.sweep.json --temperature <t> --card <id> --microphone <id>`.

Use a scratch card for this run, because writes at failing voltages can corrupt it.

### Run matrix

| Suite | Steps | About | Run with | Temperatures |
|---|---|---|---|---|
| core | 21 | 25 min | any one card and microphone | room, fridge, freezer |
| sd | 9 | 8 min | each card: ADATA, Micron, Delkin USDCOEM | all three |
| mic | 7 | 8 min | each microphone: SPH18R1LM4H-1, IM72D128V, MMICT5838, SPH0141L, MP34DT05, CMM4030DT, DMM3526-4-B | all three |
| analog | 7 | 8 min | the analog front end, if fitted | all three |
| dsp | 14 | 10 min | any parts | room (one freezer run confirms it does not move) |
| imu | 9 | 12 min | any parts | all three |
| battery | 5 | 6 min | each cell, ampere mode, fresh cells | all three |
| brownout | sweep | 15–30 min | heaviest card and microphone, source mode | all three |

Times exclude the soak. Fridge and freezer runs add an hour each, which a whole suite list can
share if the board stays in the cold between runs. Swapping parts usually means opening the
door, though, so plan the cold runs around the parts swaps.

### Coming out of the cold

When a board comes out of the freezer, let it warm up sealed in a bag before opening it, so that
condensation does not form on the board.

## Validation runs

The characterization runs measure the pieces. Validation runs measure whole deployments, so that
the forecaster can be checked against them. Each run is an ordinary deployment on the deployment
firmware built with markers.

1. Build and flash with `cd a3em-firmware && make POWER_MARKERS=1`. The objects go to
   `bin/power_markers/`, apart from the normal build.
2. Generate a config with `node tools/power/make-power-configs.mjs <digital|analog|transitions|shelf>`
   and copy it to the card as `_conf.a3m`.
3. Capture with `ppk2_capture.py capture`, using the `--max-hours` the generator prints.
4. Activate the device with the magnet.

The capture reports the charge between consecutive markers as `segments`:

- Each `PHASE_START` to `PHASE_END` segment is one phase, to set against the forecast for that
  phase.
- Each `PHASE_END` to the next `PHASE_START` is the cost of a phase transition: the reset, the
  boot, and the setup of the next phase.

The device's own TELEM lines report what it did during each phase:

- card wakes;
- writes;
- kilobytes written;
- files opened and closed;
- microphone starts;
- Opus time;
- awake time;
- deep sleeps.

Feed those counts into the forecaster to check its physics separately from its behaviour model.
Aim for agreement within 5% per phase.

| Config | Phases | Checks |
|---|---|---|
| digital | 8 × 60 min | The recording modes, the IMU at 800 Hz, Opus, the silence gate with a band-pass filter, motion detection while armed, and the state between clips |
| analog | 2 × 60 min | Amplitude triggering while armed, and continuous analog capture |
| transitions | 12 × 3 min | The cost of each phase boundary |
| shelf | 1 × 10 min, with a 2 h wait before it and a 2 h capture after it | The pre-deployment wait and the post-deployment sleep |

Run all four at room temperature, and the digital config once more in the freezer.
