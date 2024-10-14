#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# PYTHON INCLUSIONS ---------------------------------------------------------------------------------------------------

from datetime import datetime
import os, pytz


# CONSTANTS AND DEFINITIONS -------------------------------------------------------------------------------------------

VALID_AUDIO_MODES = {'Threshold-Based': 'AMPLITUDE',
                     'Schedule-Based': 'SCHEDULED',
                     'Interval-Based': 'INTERVAL',
                     'Continuous': 'CONTINUOUS'}
VALID_IMU_MODES = {'Motion-Based': 'ACTIVITY', 'Audio-Synced': 'AUDIO', 'None': 'NONE'}
VALID_TIME_SCALES = {'Second': 'SECONDS', 'Minute': 'MINUTES', 'Hour': 'HOURS', 'Day': 'DAYS'}
VALID_VHF_MODES = {'Never': 'NEVER', 'End of Deployment': 'END', 'Scheduled': 'SCHEDULED'}


# PARSER FUNCTION -----------------------------------------------------------------------------------------------------

def write_config(self, filename):
   write_order = [0]
   if self.deployment_is_split.get():
      start_times = []
      for idx, phase in enumerate(self.deployment_phases):
         _, date_start, date_end, time_start, time_end = self.deployment_phase_times[idx]
         start_times.append((int(datetime.strptime(date_start.get() + ' ' + time_start.get(), '%Y-%m-%d %H:%M').timestamp()), idx))
      write_order = [item[1] for item in sorted(start_times, key=lambda x: x[0])]
   with open(os.path.join(self.save_directory.get(), filename), 'w') as file:
      time_zone = self.device_timezone.get()
      utc_offset = int(datetime.now(pytz.timezone(time_zone)).utcoffset().total_seconds())
      hour_utc_offset = utc_offset // 3600
      print('DEVICE_LABEL = "{}"'.format(self.device_label.get()), file=file)
      print('DEVICE_TIMEZONE = "{}"'.format(time_zone), file=file)
      print('DEVICE_UTC_OFFSET = "{}"'.format(utc_offset), file=file)
      print('DEVICE_UTC_OFFSET_HOUR = "{}"'.format(hour_utc_offset), file=file)
      print('SET_RTC_AT_MAGNET_DETECT = "{}"'.format(self.set_rtc_at_magnet_detect.get()), file=file)
      utc_datetime = pytz.timezone(time_zone).localize(datetime.strptime(self.deployment_start_date.get() + ' ' + self.deployment_start_time.get(), '%Y-%m-%d %H:%M')).astimezone(pytz.utc)
      print('DEPLOYMENT_START_TIME = "{}"'.format(int(utc_datetime.timestamp())), file=file)
      utc_datetime = pytz.timezone(time_zone).localize(datetime.strptime(self.deployment_end_date.get() + ' ' + self.deployment_end_time.get(), '%Y-%m-%d %H:%M')).astimezone(pytz.utc)
      print('DEPLOYMENT_END_TIME = "{}"'.format(int(utc_datetime.timestamp())), file=file)
      print('GPS_AVAILABLE = "{}"'.format(self.gps_available.get()), file=file)
      print('AWAKE_ON_MAGNET = "{}"'.format(self.awake_on_magnet.get()), file=file)
      print('LEDS_ENABLED = "{}"'.format(self.leds_enabled.get()), file=file)
      print('LEDS_ACTIVE_SECONDS = "{}"'.format(self.leds_active_seconds.get()), file=file)
      print('MIC_AMPLIFICATION = "{}"'.format(self.mic_amplification_level_db.get()), file=file)
      print('MAGNET_FIELD_VALIDATION_MS = "{}"'.format(self.magnetic_field_validation_length_ms.get()), file=file)
      utc_datetime = pytz.timezone(time_zone).localize(datetime.strptime(self.vhf_start_date.get() + ' ' + self.vhf_start_time.get(), '%Y-%m-%d %H:%M')).astimezone(pytz.utc)
      print('VHF_MODE = "{}"'.format(VALID_VHF_MODES[self.vhf_mode.get()]), file=file)
      print('VHF_RADIO_START_TIME = "{}"'.format(int(utc_datetime.timestamp())), file=file)
      print('PHASED_DEPLOYMENT = "{}"'.format(self.deployment_is_split.get()), file=file)
      for idx in write_order:
         phase = self.deployment_phases[idx]
         print('\n[PHASE]', file=file)
         print('PHASE_NAME = "{}"'.format(phase.name.get()), file=file)
         if self.deployment_is_split.get():
            _, date_start, date_end, time_start, time_end = self.deployment_phase_times[idx]
            utc_datetime = pytz.timezone(time_zone).localize(datetime.strptime(date_start.get() + ' ' + time_start.get(), '%Y-%m-%d %H:%M')).astimezone(pytz.utc)
            print('PHASE_START_TIME = "{}"'.format(int(utc_datetime.timestamp())), file=file)
            utc_datetime = pytz.timezone(time_zone).localize(datetime.strptime(date_end.get() + ' ' + time_end.get(), '%Y-%m-%d %H:%M')).astimezone(pytz.utc)
            print('PHASE_END_TIME = "{}"'.format(int(utc_datetime.timestamp())), file=file)
         print('AUDIO_RECORDING_MODE = "{}"'.format(VALID_AUDIO_MODES[phase.audio_recording_mode.get()]), file=file)
         print('AUDIO_EXTEND_CLIP = "{}"'.format(phase.extend_clip_if_continuous_audio.get()), file=file)
         print('AUDIO_MAX_CLIPS_NUMBER = "{}"'.format(phase.max_audio_clips.get()), file=file)
         print('AUDIO_MAX_CLIPS_TIME_SCALE = "{}"'.format(VALID_TIME_SCALES[phase.max_clips_time_scale.get()]), file=file)
         print('AUDIO_TRIGGER_THRESHOLD = "{}"'.format(phase.audio_trigger_threshold.get()), file=file)
         print('AUDIO_TRIGGER_INTERVAL = "{}"'.format(phase.audio_trigger_interval.get()), file=file)
         print('AUDIO_TRIGGER_INTERVAL_TIME_SCALE = "{}"'.format(VALID_TIME_SCALES[phase.audio_trigger_interval_time_scale.get()]), file=file)
         for trigger_time in phase.audio_trigger_times:
            hours, minutes = trigger_time[0].get().split(':')
            start_time = ((int(hours) * 3600) + (int(minutes) * 60))
            hours, minutes = trigger_time[1].get().split(':')
            end_time = ((int(hours) * 3600) + (int(minutes) * 60))
            print('AUDIO_TRIGGER_SCHEDULE = "{}-{}"'.format(start_time, end_time), file=file)
         print('AUDIO_SAMPLING_RATE_HZ = "{}"'.format(phase.audio_sampling_rate.get()), file=file)
         print('AUDIO_CLIP_LENGTH_SECONDS = "{}"'.format(phase.audio_clip_length.get()), file=file)
         print('IMU_RECORDING_MODE = "{}"'.format(VALID_IMU_MODES[phase.imu_recording_mode.get()]), file=file)
         print('IMU_DEGREES_OF_FREEDOM = "{}"'.format(phase.imu_degrees_of_freedom.get()), file=file)
         print('IMU_TRIGGER_THRESHOLD = "{}"'.format(phase.imu_trigger_threshold.get()), file=file)
         print('IMU_SAMPLING_RATE_HZ = "{}"'.format(phase.imu_sampling_rate.get()), file=file)
