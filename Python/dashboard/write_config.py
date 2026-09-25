#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# PYTHON INCLUSIONS ---------------------------------------------------------------------------------------------------

from datetime import datetime
import os, pytz
try: from .config_file import CONFIG_FILE_NAME, LEGACY_CONFIG_FILE_NAME, serialize
except ImportError: from config_file import CONFIG_FILE_NAME, LEGACY_CONFIG_FILE_NAME, serialize


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

def _bool(value):
   return value in (True, 1, 'True', 'true', '1')

def _number(value):
   value = float(value)
   return int(value) if value.is_integer() else value

def _epoch(time_zone, date, clock):
   local = pytz.timezone(time_zone).localize(datetime.strptime(date + ' ' + clock, '%Y-%m-%d %H:%M'))
   return int(local.astimezone(pytz.utc).timestamp())

def _seconds(clock):
   hours, minutes = clock.split(':')
   return int(hours) * 3600 + int(minutes) * 60

def _optional(value):
   return float(value) if value not in (None, '') else None


# CONVERSION FUNCTION -------------------------------------------------------------------------------------------------

def config_from_window(self):
   """The settings on screen, as the configuration file's module holds them."""
   time_zone = self.device_timezone.get()
   phased = _bool(self.deployment_is_split.get())
   phases = []
   for idx, phase in enumerate(self.deployment_phases):
      start = end = None
      if phased:
         _, date_start, date_end, time_start, time_end = self.deployment_phase_times[idx]
         start = _epoch(time_zone, date_start.get(), time_start.get())
         end = _epoch(time_zone, date_end.get(), time_end.get())
      schedule_type = getattr(phase, 'audio_schedule_type', None)
      phases.append({
         'name': phase.name.get(),
         'start': start,
         'end': end,
         'audio_mode': VALID_AUDIO_MODES[phase.audio_recording_mode.get()],
         'extend_clip': _bool(phase.extend_clip_if_continuous_audio.get()),
         'max_clips': int(phase.max_audio_clips.get()),
         'max_clips_scale': VALID_TIME_SCALES[phase.max_clips_time_scale.get()],
         'trigger_threshold': _number(phase.audio_trigger_threshold.get()),
         'interval': int(phase.audio_trigger_interval.get()),
         'interval_scale': VALID_TIME_SCALES[phase.audio_trigger_interval_time_scale.get()],
         'schedule_type': schedule_type.get() if schedule_type is not None else 'CLOCK',
         'periods': [(_seconds(begin.get()), _seconds(finish.get())) for begin, finish in phase.audio_trigger_times],
         'entered': getattr(phase, 'audio_periods_entered', None),
         'solar': list(getattr(phase, 'audio_solar_windows', [])),
         'sample_rate': int(phase.audio_sampling_rate.get()),
         'clip_length': int(phase.audio_clip_length.get()),
         'imu_mode': VALID_IMU_MODES[phase.imu_recording_mode.get()],
         'imu_dof': int(phase.imu_degrees_of_freedom.get()),
         'imu_threshold_mg': _number(phase.imu_trigger_threshold.get()),
         'imu_rate': int(phase.imu_sampling_rate.get()),
         'filter_type': VALID_FILTER_TYPES[phase.audio_filter_type.get()],
         'filter_low': int(phase.audio_filter_low.get()),
         'filter_high': int(phase.audio_filter_high.get()),
         # Shown as a percentage of full scale; the file holds the fraction.
         'silence_threshold': _number(round(float(phase.silence_threshold.get()) / 100.0, 10)),
         'min_freq': int(phase.min_frequency.get()),
         'max_freq': int(phase.max_frequency.get()),
         'use_opus': _bool(phase.use_opus_encoding.get()),
         'opus_bitrate': int(phase.opus_bitrate.get()),
      })
   latitude, longitude = getattr(self, 'deployment_latitude', None), getattr(self, 'deployment_longitude', None)
   adjust_for_dst = getattr(self, 'adjust_for_dst', None)
   vhf_mode = VALID_VHF_MODES[self.vhf_mode.get()]
   return {
      'label': self.device_label.get(),
      'timezone': time_zone,
      'set_rtc': _bool(self.set_rtc_at_magnet_detect.get()),
      'start': _epoch(time_zone, self.deployment_start_date.get(), self.deployment_start_time.get()),
      'end': _epoch(time_zone, self.deployment_end_date.get(), self.deployment_end_time.get()),
      'latitude': _optional(latitude.get()) if latitude is not None else None,
      'longitude': _optional(longitude.get()) if longitude is not None else None,
      'gps': _bool(self.gps_available.get()),
      'awake_on_magnet': _bool(self.awake_on_magnet.get()),
      'leds_enabled': _bool(self.leds_enabled.get()),
      'leds_active_seconds': int(self.leds_active_seconds.get()),
      'mic_type': VALID_MIC_TYPES[self.microphone_type.get()],
      'mic_amplification': float(self.mic_amplification_level_db.get()),
      'battery_low_mv': int(self.battery_low_mv.get()),
      'magnet_ms': int(self.magnetic_field_validation_length_ms.get()),
      'forbid_deactivation_s': int(self.forbid_deactivation_seconds.get()),
      'vhf_mode': vhf_mode,
      'vhf_start': _epoch(time_zone, self.vhf_start_date.get(), self.vhf_start_time.get()) if vhf_mode == 'SCHEDULED' else None,
      'phased': phased,
      'adjust_for_dst': _bool(adjust_for_dst.get()) if adjust_for_dst is not None else True,
      'phases': phases,
   }


# WRITER FUNCTION -----------------------------------------------------------------------------------------------------

def write_config(self, filename=CONFIG_FILE_NAME):
   text = serialize(config_from_window(self))
   directory = self.save_directory.get()
   # Newlines as the recorder and the web dashboard write them, on every system.
   with open(os.path.join(directory, filename), 'w', encoding='utf-8', newline='\n') as file:
      file.write(text)
   # One under the legacy name would sit beside it holding other settings.
   if filename == CONFIG_FILE_NAME:
      try:
         os.remove(os.path.join(directory, LEGACY_CONFIG_FILE_NAME))
      except OSError:
         pass
