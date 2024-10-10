A3EM Management Dashboard
=========================

Overview
--------

This repository contains the source code for the A3EM Management Dashboard. All setup and preparation for live A3EM deployments should be carried out through the A3EM Dashboard.


Installation
------------

The easiest way to install this tool is by cloning the A3EM Dashboard repository to your hard drive and issuing the following command in a terminal:

``python3 -m pip install .``


Usage
-----

Once installed, the management dashboard is accessible from any location in a terminal by entering the following command:

``a3em``

You do not need to navigate to the A3EM source code directory to run the application.

The suggested procedure for setting up a new live deployment is the following:

1. Label the device
2. TODO

After the above steps have been completed, your devices are ready for use and will automatically shut down until time for the deployment to begin.

Upon completion of a deployment, all audio and log files should be properly labeled and accessible on the SD card of the deployed device.


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
