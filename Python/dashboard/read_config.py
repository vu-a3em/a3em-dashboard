#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# PYTHON INCLUSIONS ---------------------------------------------------------------------------------------------------

from datetime import datetime
import tkinter as tk
import pytz
try: from .config_file import CONFIG_FILE_NAME, find_config, parse
except ImportError: from config_file import CONFIG_FILE_NAME, find_config, parse


# CONSTANTS AND DEFINITIONS -------------------------------------------------------------------------------------------

VALID_AUDIO_MODES = {'Threshold-Based': 'AMPLITUDE',
                     'Schedule-Based': 'SCHEDULED',
                     'Interval-Based': 'INTERVAL',
                     'Continuous': 'CONTINUOUS'}
VALID_IMU_MODES = {'Motion-Based': 'ACTIVITY', 'Audio-Synced': 'AUDIO', 'None': 'NONE'}
VALID_TIME_SCALES = {'Second': 'SECONDS', 'Minute': 'MINUTES', 'Hour': 'HOURS', 'Day': 'DAYS'}
VALID_VHF_MODES = {'Never': 'NEVER', 'End of Deployment': 'END', 'Scheduled': 'SCHEDULED'}
VALID_MIC_TYPES = {'Analog': 'ANALOG', 'Digital': 'DIGITAL'}
VALID_FILTER_TYPES = {'No filtering': 'NONE', 'High-pass': 'HIGH', 'Low-pass': 'LOW', 'Band-pass': 'BAND'}


# HELPERS -------------------------------------------------------------------------------------------------------------

def _label(choices, value):
   return list(choices.keys())[list(choices.values()).index(value)]

def _local(epoch, time_zone):
   return datetime.fromtimestamp(epoch, pytz.utc).astimezone(pytz.timezone(time_zone))

def _clock(seconds):
   return '{:02d}:{:02d}'.format(seconds // 3600, (seconds % 3600) // 60)

def _set(variable, value, convert=lambda value: value):
   if value is not None:
      variable.set(convert(value))


# PARSER FUNCTION -----------------------------------------------------------------------------------------------------

def read_config(self, SchedulePhase):
   """The card's configuration into the window: the current file name, or the legacy one on an older card."""
   path = find_config(self.save_directory.get())
   if path is None:
      raise FileNotFoundError('No {} on the card'.format(CONFIG_FILE_NAME))
   with open(path, 'r', encoding='utf-8') as file:
      config = parse(file.read())

   # Reset all GUI fields to their default values
   self.deployment_phase_default = [SchedulePhase(self.master, tk.StringVar(self.master, 'Default'))]
   self.deployment_phases_custom.clear()
   self.deployment_phases = self.deployment_phase_default
   self.selected_phase.set('Default')
   self.deployment_phase_times.clear()
   self.audio_detail_fields.clear()
   self.active_data_entry = None

   time_zone = config['timezone']
   _set(self.device_label, config['label'])
   self.device_timezone.set(time_zone)
   _set(self.set_rtc_at_magnet_detect, config['set_rtc'])
   for epoch, date, clock in ((config['start'], self.deployment_start_date, self.deployment_start_time),
                              (config['end'], self.deployment_end_date, self.deployment_end_time),
                              (config['vhf_start'], self.vhf_start_date, self.vhf_start_time)):
      if epoch is not None:
         local = _local(epoch, time_zone)
         date.set(local.strftime('%Y-%m-%d'))
         clock.set(local.strftime('%H:%M'))
   # Kept as they are for writing back: this tool has no fields for them.
   self.deployment_latitude.set('' if config['latitude'] is None else repr(config['latitude']))
   self.deployment_longitude.set('' if config['longitude'] is None else repr(config['longitude']))
   self.adjust_for_dst.set(config['adjust_for_dst'])
   _set(self.gps_available, config['gps'])
   _set(self.awake_on_magnet, config['awake_on_magnet'])
   _set(self.leds_enabled, config['leds_enabled'])
   _set(self.leds_active_seconds, config['leds_active_seconds'])
   _set(self.microphone_type, config['mic_type'], lambda value: _label(VALID_MIC_TYPES, value))
   _set(self.mic_amplification_level_db, config['mic_amplification'])
   _set(self.battery_low_mv, config['battery_low_mv'])
   _set(self.magnetic_field_validation_length_ms, config['magnet_ms'])
   _set(self.forbid_deactivation_seconds, config['forbid_deactivation_s'])
   _set(self.vhf_mode, config['vhf_mode'], lambda value: _label(VALID_VHF_MODES, value))

   self.deployment_is_split.set(config['phased'])
   if config['phases']:
      self.deployment_phases = self.deployment_phases_custom if config['phased'] else self.deployment_phase_default
      self.deployment_phases.clear()
   for parsed in config['phases']:
      phase = SchedulePhase(self.master, tk.StringVar(self.master, parsed['name']))
      self.deployment_phases.append(phase)
      if config['phased']:
         start, end = _local(parsed['start'], time_zone), _local(parsed['end'], time_zone)
         self.deployment_phase_times.append((phase.name, tk.StringVar(self.master, start.strftime('%Y-%m-%d')),
                                             tk.StringVar(self.master, end.strftime('%Y-%m-%d')),
                                             tk.StringVar(self.master, start.strftime('%H:%M')),
                                             tk.StringVar(self.master, end.strftime('%H:%M'))))
      _set(phase.audio_recording_mode, parsed['audio_mode'], lambda value: _label(VALID_AUDIO_MODES, value))
      _set(phase.extend_clip_if_continuous_audio, parsed['extend_clip'])
      _set(phase.max_audio_clips, parsed['max_clips'])
      _set(phase.max_clips_time_scale, parsed['max_clips_scale'], lambda value: _label(VALID_TIME_SCALES, value))
      _set(phase.audio_trigger_threshold, parsed['trigger_threshold'])
      _set(phase.audio_trigger_interval, parsed['interval'])
      _set(phase.audio_trigger_interval_time_scale, parsed['interval_scale'], lambda value: _label(VALID_TIME_SCALES, value))
      phase.audio_schedule_type.set(parsed['schedule_type'])
      phase.audio_solar_windows = list(parsed['solar'])
      # As the web dashboard holds them, for writing back while those on screen are unchanged.
      phase.audio_periods_entered = list(parsed['entered'])
      for start, end in parsed['periods']:
         phase.audio_trigger_times.append((tk.StringVar(self.master, _clock(start)), tk.StringVar(self.master, _clock(end))))
      _set(phase.audio_sampling_rate, parsed['sample_rate'])
      _set(phase.audio_clip_length, parsed['clip_length'])
      _set(phase.imu_recording_mode, parsed['imu_mode'], lambda value: _label(VALID_IMU_MODES, value))
      _set(phase.imu_degrees_of_freedom, parsed['imu_dof'])
      _set(phase.imu_trigger_threshold, parsed['imu_threshold_mg'])
      _set(phase.imu_sampling_rate, parsed['imu_rate'])
      _set(phase.audio_filter_type, parsed['filter_type'], lambda value: _label(VALID_FILTER_TYPES, value))
      _set(phase.audio_filter_low, parsed['filter_low'])
      _set(phase.audio_filter_high, parsed['filter_high'])
      # The file holds a fraction of full scale; this tool shows a percentage.
      _set(phase.silence_threshold, parsed['silence_threshold'], lambda value: round(float(value) * 100.0, 6))
      _set(phase.min_frequency, parsed['min_freq'])
      _set(phase.max_frequency, parsed['max_freq'])
      _set(phase.use_opus_encoding, parsed['use_opus'])
      _set(phase.opus_bitrate, parsed['opus_bitrate'])
   self._change_deployment_split()
