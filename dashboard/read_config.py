#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# PYTHON INCLUSIONS ---------------------------------------------------------------------------------------------------

from datetime import datetime
import tkinter as tk
import os, pytz


# CONSTANTS AND DEFINITIONS -------------------------------------------------------------------------------------------

VALID_AUDIO_MODES = {'Threshold-Based': 'AMPLITUDE',
                     'Schedule-Based': 'SCHEDULED',
                     'Interval-Based': 'INTERVAL',
                     'Continuous': 'CONTINUOUS'}
VALID_IMU_MODES = {'Motion-Based': 'ACTIVITY', 'Audio-Synced': 'AUDIO', 'None': 'NONE'}
VALID_TIME_SCALES = {'Second': 'SECONDS', 'Minute': 'MINUTES', 'Hour': 'HOURS', 'Day': 'DAYS'}
VALID_VHF_MODES = {'Never': 'NEVER', 'End of Deployment': 'END', 'Scheduled': 'SCHEDULED'}
VALID_MIC_TYPES = {'Analog': 'ANALOG', 'Digital': 'DIGITAL'}


# PARSER FUNCTION -----------------------------------------------------------------------------------------------------

def read_config(self, filename, SchedulePhase):
   with open(os.path.join(self.save_directory.get(), filename), 'r') as file:

      # Reset all GUI fields to their default values
      self.deployment_phase_default = [SchedulePhase(self.master, tk.StringVar(self.master, 'Default'))]
      self.deployment_phases_custom.clear()
      self.deployment_phases = self.deployment_phase_default
      self.selected_phase.set('Default')
      self.deployment_phase_times.clear()
      self.audio_detail_fields.clear()
      self.active_data_entry = None
      time_zone = pytz.utc

      # Parse the config file line by line
      for line in file:
         if '=' in line:
            key, value = line.split('=')
            key, value = (key.strip(), value.strip('\t\n "'))
            if key == 'DEVICE_LABEL':
               self.device_label.set(value)
            elif key == 'DEVICE_TIMEZONE':
               time_zone = value
               self.device_timezone.set(value)
            elif key == 'SET_RTC_AT_MAGNET_DETECT':
               self.set_rtc_at_magnet_detect.set(value == 'True')
            elif key == 'DEPLOYMENT_START_TIME':
               local_datetime = datetime.fromtimestamp(int(value), pytz.utc).astimezone(pytz.timezone(time_zone))
               self.deployment_start_date.set(local_datetime.strftime('%Y-%m-%d'))
               self.deployment_start_time.set(local_datetime.strftime('%H:%M'))
            elif key == 'DEPLOYMENT_END_TIME':
               local_datetime = datetime.fromtimestamp(int(value), pytz.utc).astimezone(pytz.timezone(time_zone))
               self.deployment_end_date.set(local_datetime.strftime('%Y-%m-%d'))
               self.deployment_end_time.set(local_datetime.strftime('%H:%M'))
            elif key == 'GPS_AVAILABLE':
               self.gps_available.set(value == 'True')
            elif key == 'AWAKE_ON_MAGNET':
               self.awake_on_magnet.set(value == 'True')
            elif key == 'LEDS_ENABLED':
               self.leds_enabled.set(value == 'True')
            elif key == 'LEDS_ACTIVE_SECONDS':
               self.leds_active_seconds.set(int(value))
            elif key == 'MIC_TYPE':
               self.microphone_type.set(list(VALID_MIC_TYPES.keys())[list(VALID_MIC_TYPES.values()).index(value)])
            elif key == 'MIC_AMPLIFICATION':
               self.mic_amplification_level_db.set(float(value))
            elif key == 'BATTERY_LOW_MV':
               self.battery_low_mv.set(int(value))
            elif key == 'MAGNET_FIELD_VALIDATION_MS':
               self.magnetic_field_validation_length_ms.set(int(value))
            elif key == 'VHF_MODE':
               self.vhf_mode.set(list(VALID_VHF_MODES.keys())[list(VALID_VHF_MODES.values()).index(value)])
            elif key == 'VHF_RADIO_START_TIME':
               local_datetime = datetime.fromtimestamp(int(value), pytz.utc).astimezone(pytz.timezone(time_zone))
               self.vhf_start_date.set(local_datetime.strftime('%Y-%m-%d'))
               self.vhf_start_time.set(local_datetime.strftime('%H:%M'))
            elif key == 'PHASED_DEPLOYMENT':
               self.deployment_is_split.set(value == 'True')
               if value == 'True':
                  self.deployment_phases = self.deployment_phases_custom
               else:
                  self.deployment_phase_default.clear()
            elif key == 'PHASE_NAME':
               self.deployment_phases[-1].name.set(value)
               if self.deployment_is_split.get():
                  self.deployment_phase_times.append((self.deployment_phases[-1].name, tk.StringVar(self.master, datetime.today().strftime('%Y-%m-%d')), tk.StringVar(self.master, datetime.today().strftime('%Y-%m-%d')), tk.StringVar(self.master, '00:00'), tk.StringVar(self.master, '00:00')))
            elif key == 'PHASE_START_TIME':
               if self.deployment_is_split.get():
                  local_datetime = datetime.fromtimestamp(int(value), pytz.utc).astimezone(pytz.timezone(time_zone))
                  self.deployment_phase_times[-1][1].set(local_datetime.strftime('%Y-%m-%d'))
                  self.deployment_phase_times[-1][3].set(local_datetime.strftime('%H:%M'))
            elif key == 'PHASE_END_TIME':
               if self.deployment_is_split.get():
                  local_datetime = datetime.fromtimestamp(int(value), pytz.utc).astimezone(pytz.timezone(time_zone))
                  self.deployment_phase_times[-1][2].set(local_datetime.strftime('%Y-%m-%d'))
                  self.deployment_phase_times[-1][4].set(local_datetime.strftime('%H:%M'))
            elif key == 'AUDIO_RECORDING_MODE':
               self.deployment_phases[-1].audio_recording_mode.set(list(VALID_AUDIO_MODES.keys())[list(VALID_AUDIO_MODES.values()).index(value)])
            elif key == 'AUDIO_EXTEND_CLIP':
               self.deployment_phases[-1].extend_clip_if_continuous_audio.set(value == 'True')
            elif key == 'AUDIO_MAX_CLIPS_NUMBER':
               self.deployment_phases[-1].max_audio_clips.set(int(value))
            elif key == 'AUDIO_MAX_CLIPS_TIME_SCALE':
               self.deployment_phases[-1].max_clips_time_scale.set(list(VALID_TIME_SCALES.keys())[list(VALID_TIME_SCALES.values()).index(value)])
            elif key == 'AUDIO_TRIGGER_THRESHOLD':
               self.deployment_phases[-1].audio_trigger_threshold.set(float(value))
            elif key == 'AUDIO_TRIGGER_INTERVAL':
               self.deployment_phases[-1].audio_trigger_interval.set(int(value))
            elif key == 'AUDIO_TRIGGER_INTERVAL_TIME_SCALE':
               self.deployment_phases[-1].audio_trigger_interval_time_scale.set(list(VALID_TIME_SCALES.keys())[list(VALID_TIME_SCALES.values()).index(value)])
            elif key == 'AUDIO_TRIGGER_SCHEDULE':
               start, end = value.split('-')
               start = '{:02d}:{:02d}'.format(int(start) // 3600, (int(start) % 3600) // 60)
               end = '{:02d}:{:02d}'.format(int(end) // 3600, (int(end) % 3600) // 60)
               self.deployment_phases[-1].audio_trigger_times.append((tk.StringVar(self.master, start), tk.StringVar(self.master, end)))
            elif key == 'AUDIO_SAMPLING_RATE_HZ':
               self.deployment_phases[-1].audio_sampling_rate.set(int(value))
            elif key == 'AUDIO_CLIP_LENGTH_SECONDS':
               self.deployment_phases[-1].audio_clip_length.set(int(value))
            elif key == 'IMU_RECORDING_MODE':
               self.deployment_phases[-1].imu_recording_mode.set(list(VALID_IMU_MODES.keys())[list(VALID_IMU_MODES.values()).index(value)])
            elif key == 'IMU_DEGREES_OF_FREEDOM':
               self.deployment_phases[-1].imu_degrees_of_freedom.set(int(value))
            elif key == 'IMU_TRIGGER_THRESHOLD':
               self.deployment_phases[-1].imu_trigger_threshold.set(float(value))
            elif key == 'IMU_SAMPLING_RATE_HZ':
               self.deployment_phases[-1].imu_sampling_rate.set(int(value))
         elif '[PHASE]' in line:
            self.deployment_phases.append(SchedulePhase(self.master, tk.StringVar(self.master, 'Default')))
      self._change_deployment_split()
