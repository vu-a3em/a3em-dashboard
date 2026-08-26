A3EM Management Dashboard
=========================

Overview
--------

This package provides a graphical interface called the A3EM Management Dashboard, which
should be used for setup and preparation of all live A3EM deployments. Once installed,
it can be accessed from any location in a command terminal by entering:

``a3em``


Installation
------------

The easiest way to install this tool is through `pip` by entering:

``python3 -m pip install a3em``

If you wish to install the package manually or develop it further, you should first
clone the `A3EM Dashboard repository <https://github.com/vu-a3em/a3em-dashboard>`_ to
your hard drive, `cd` into the root directory of the repository, then issue the
following command in a terminal:

``python3 -m pip install -e .``

Upon configuration and completion of a deployment, all audio and log files should be
properly labeled and accessible on the SD card of the deployed A3EM device.


Available Configuration Options
-------------------------------

TODO: Finish this list and add descriptions

* Deployment Options:
   * Device Label
   * Timezone
   * Start Date and Time
   * End Date and Time (optional)
   * Set RTC to Start Date/Time at Magnet Detect (yes/no)
   * LEDs enabled (yes/no)
   * If LEDs enabled:
      * For how many seconds after deployment starts
   * VHF Radio Start Date and Time
* Audio Recording Options:
   * Mode: Threshold-Triggered, Time-Scheduled, Interval-Scheduled, Continuous
   * If Threshold-Triggered:
      * Max num events per unit time
      * Threshold level (right now in percent of max, but prob should map dB to percent)
   * If Time-Scheduled:
      * List of start/end times (i.e., 6AM-11AM, 6PM-10PM)
   * If Interval-Scheduled:
      * Record every X time units
   * Clip length in seconds (even for continuous, should segment into clips)
   * Extend clip length if continuous audio detected (yes/no)
   * Audio sampling rate
   * Microphone amplification level (low, medium, high)
* IMU Recording Options:
   * Mode: Threshold-Triggered, Audio-Triggered (store IMU data whenever audio clip is recording)
   * If Threshold-Triggered:
      * Threshold level
   * Degrees of Freedom (only 3 available on current chip)
   * IMU sampling rate
