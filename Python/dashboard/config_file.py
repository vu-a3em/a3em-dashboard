#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
The recorder's configuration file, read and written exactly as the web dashboard reads and writes it.

A port of the web dashboard's serializer and parser (Web/packages/config-schema/src/serialize.ts and
parse.ts), so a file either tool writes is read the same by the other and by the firmware: the same
keys in the same order, only the keys each mode uses, schedules split at midnight and sorted, and
daylight saving handled the same way. The firmware holds one UTC offset for a whole deployment, so
where a change of offset would move a clock-time recording period, the phase is written as one
[PHASE] per side of the change, the later side's periods shifted to fire at the same local time,
and DST_ADJUSTED says so, for the reader to undo. Solar schedules and the deployment's position,
which this tool cannot edit, are carried through unchanged.

No user interface here: `read_config` and `write_config` move values between this and the window.
"""

# PYTHON INCLUSIONS ---------------------------------------------------------------------------------------------------

from datetime import datetime
import math, os, time
import pytz


# CONSTANTS AND DEFINITIONS -------------------------------------------------------------------------------------------

# Not ".cfg": Chrome on Windows will not let a web page read or write any .cfg file. Cards prepared
# before the rename carry the legacy name, which the firmware reads when the current one is absent.
CONFIG_FILE_NAME = '_conf.a3m'
LEGACY_CONFIG_FILE_NAME = '_a3em.cfg'

MAX_LINE_LENGTH = 79                # the firmware stops reading the file at a longer line
MAX_DEVICE_LABEL_LEN = 31
MAX_AUDIO_TRIGGER_TIMES = 12
MAX_DEPLOYMENT_PHASES = 20
OPUS_REQUIRED_SAMPLE_RATE_HZ = 48000
MAX_FREQUENCY_HEADROOM_HZ = 200
IMU_MOTION_THRESHOLD_MIN_MG = 2000 / 255
IMU_MOTION_THRESHOLD_MAX_MG = 2000
SECONDS_PER_DAY = 86400
DEVICE_LABEL_FORBIDDEN = '\\/:*?"<>|'

# The web dashboard's limits (firmware-constants.ts), for `validate`.
PHASE_NAME_MAX_LEN = MAX_LINE_LENGTH - len('PHASE_NAME = ""')
MAX_REPRESENTABLE_EPOCH_SECONDS = 2 ** 31 - 1
LEDS_MAX_ACTIVE_SECONDS = 86400
MAGNET_VALIDATION_MIN_MS, MAGNET_VALIDATION_MAX_MS = 1000, 30000
MIC_AMPLIFICATION_MAX_DB_ANALOG, MIC_AMPLIFICATION_MAX_DB_DIGITAL = 45, 34.5
BATTERY_CUTOFF_MIN_MV, BATTERY_CUTOFF_MAX_MV = 2500, 4200
AUDIO_MIN_CLIP_LENGTH_SECONDS, AUDIO_MAX_CLIP_LENGTH_SECONDS = 1, 3600
OPUS_MIN_BITRATE, OPUS_MAX_BITRATE = 5000, 128000
TRIGGER_DIGIPOT_STEPS = 255
TIME_SCALE_SECONDS = {'SECONDS': 1, 'MINUTES': 60, 'HOURS': 3600, 'DAYS': 86400}

PHASE_KEYS = {
   'PHASE_NAME', 'PHASE_START_TIME', 'PHASE_END_TIME', 'AUDIO_RECORDING_MODE', 'AUDIO_EXTEND_CLIP',
   'AUDIO_MAX_CLIPS_NUMBER', 'AUDIO_MAX_CLIPS_TIME_SCALE', 'AUDIO_TRIGGER_THRESHOLD', 'AUDIO_TRIGGER_INTERVAL',
   'AUDIO_TRIGGER_INTERVAL_TIME_SCALE', 'AUDIO_TRIGGER_SCHEDULE_TYPE', 'AUDIO_TRIGGER_SCHEDULE', 'AUDIO_SOLAR_SCHEDULE',
   'AUDIO_SAMPLING_RATE_HZ', 'AUDIO_CLIP_LENGTH_SECONDS', 'IMU_RECORDING_MODE', 'IMU_DEGREES_OF_FREEDOM',
   'IMU_TRIGGER_THRESHOLD', 'IMU_SAMPLING_RATE_HZ', 'FILTER_TYPE', 'FILTER_LOW_FREQUENCY', 'FILTER_HIGH_FREQUENCY',
   'SILENCE_THRESHOLD', 'MIN_FREQUENCY', 'MAX_FREQUENCY', 'USE_OPUS', 'OPUS_BITRATE',
}


class ConfigError(Exception):
   """A configuration that cannot be written as it stands, in words for the person writing it."""


def find_config(directory):
   """The card's configuration file: the current name, or the legacy one on an older card, or None."""
   for name in (CONFIG_FILE_NAME, LEGACY_CONFIG_FILE_NAME):
      path = os.path.join(directory, name)
      if os.path.isfile(path):
         return path
   return None


# RECORDING PERIODS ---------------------------------------------------------------------------------------------------

# Periods are (start, end) seconds of the day. The firmware can express neither an overnight
# period nor an out-of-order one, so an overnight period (end past 86400) is written as the two
# entries either side of midnight, and the entries are sorted.

def period_segments(period):
   start, end = period
   if end <= SECONDS_PER_DAY:
      return [(start, end)]
   return [segment for segment in ((start, SECONDS_PER_DAY), (0, end - SECONDS_PER_DAY)) if segment[1] > segment[0]]

def firmware_trigger_times(periods):
   return sorted((segment for period in periods for segment in period_segments(period)), key=lambda s: (s[0], s[1]))

def merge_midnight_periods(periods):
   """An entry ending at midnight and one starting at it, back into the one overnight period."""
   evening = next((i for i, (s, e) in enumerate(periods) if e == SECONDS_PER_DAY and s > 0), -1)
   morning = next((i for i, (s, e) in enumerate(periods) if s == 0 and e < SECONDS_PER_DAY), -1)
   if evening < 0 or morning < 0:
      return list(periods)
   merged = (periods[evening][0], SECONDS_PER_DAY + periods[morning][1])
   return [merged if i == evening else p for i, p in enumerate(periods) if i != morning]

def _wrap_day(seconds):
   wrapped = math.fmod(seconds, SECONDS_PER_DAY)
   return int(wrapped + SECONDS_PER_DAY if wrapped < 0 else wrapped)

def shift_periods(periods, shift):
   if not shift:
      return list(periods)
   shifted = []
   for start, end in periods:
      new_start = _wrap_day(start + shift)
      shifted.append((new_start, new_start + max(0, end - start)))
   return shifted


# TIME ZONES ----------------------------------------------------------------------------------------------------------

def offset_at(time_zone, epoch):
   """The zone's UTC offset at an instant, to the minute, as the dashboard resolves it."""
   offset = datetime.fromtimestamp(epoch, pytz.timezone(time_zone)).utcoffset().total_seconds()
   return int(round(offset / 60.0) * 60)

def offset_changes(time_zone, start, end):
   """Every change of the zone's offset in [start, end), as (at, before, after), found to the minute."""
   changes = []
   if end <= start:
      return changes
   before = offset_at(time_zone, start)
   t = start
   while t < end:
      following = min(t + SECONDS_PER_DAY, end)
      after = offset_at(time_zone, following)
      if after != before:
         low, high = t // 60, -(-following // 60)
         while high - low > 1:
            middle = low + (high - low) // 2
            if offset_at(time_zone, middle * 60) == before:
               low = middle
            else:
               high = middle
         if high * 60 < end:
            changes.append((high * 60, before, after))
         before = after
      t += SECONDS_PER_DAY
   return changes

def _has_clock_periods(phase):
   return phase['audio_mode'] == 'SCHEDULED' and len(phase['periods']) > 0

def _phase_span(config, phase):
   if config['phased']:
      return (phase['start'] if phase['start'] is not None else config['start'],
              phase['end'] if phase['end'] is not None else config['end'])
   return (config['start'], config['end'])

def dst_segments(config):
   """The phases cut at every offset change that moves a clock-time period, each with its shift."""
   device_offset = offset_at(config['timezone'], config['start'])
   ordered = sorted(config['phases'], key=lambda phase: _phase_span(config, phase)[0])
   if not config['phased']:
      ordered = ordered[:1]
   segments = []
   for phase in ordered:
      start, end = _phase_span(config, phase)
      if not _has_clock_periods(phase) or end <= start:
         segments.append((phase, start, end, 0))
         continue
      cursor = start
      for cut in [change[0] for change in offset_changes(config['timezone'], start, end)] + [end]:
         segments.append((phase, cursor, cut, device_offset - offset_at(config['timezone'], cursor)))
         cursor = cut
   return segments

def dst_changes_affecting_schedule(config):
   spans = [_phase_span(config, phase) for phase in (config['phases'] if config['phased'] else config['phases'][:1])
            if _has_clock_periods(phase)]
   if not spans:
      return []
   return [change for change in offset_changes(config['timezone'], config['start'], config['end'])
           if any(span[1] > change[0] for span in spans)]

def dst_adjustment_applies(config):
   return config.get('adjust_for_dst', True) and any(segment[3] != 0 for segment in dst_segments(config))


# WRITING -------------------------------------------------------------------------------------------------------------

def _render(value):
   if isinstance(value, bool):
      return 'True' if value else 'False'
   if isinstance(value, float) and value.is_integer():
      return str(int(value))
   return str(value) if not isinstance(value, float) else repr(value)

def _effective_sample_rate(phase):
   return OPUS_REQUIRED_SAMPLE_RATE_HZ if phase['use_opus'] else phase['sample_rate']

def _effective_max_frequency(phase):
   ceiling = _effective_sample_rate(phase) // 2 - MAX_FREQUENCY_HEADROOM_HZ
   return min(phase['max_freq'], ceiling) if phase['max_freq'] > 0 else ceiling

def _as_entered(phase):
   """
   A phase's periods as the web dashboard holds them: an overnight one whole, not as its two entries.
   Those read from a card are kept as they were entered, which is not always what joining entries
   at midnight gives, and they are used while they still describe the periods on screen.
   """
   entered = phase.get('entered')
   if entered is not None and firmware_trigger_times(entered) == firmware_trigger_times(phase['periods']):
      return list(entered)
   return merge_midnight_periods(phase['periods'])

def serialize(config):
   """The configuration file's text, byte for byte as the web dashboard writes the same settings."""
   lines = []
   def kv(key, value):
      line = '{} = "{}"'.format(key, _render(value))
      if len(line) > MAX_LINE_LENGTH:
         raise ConfigError('The line for {} is {} characters, and the recorder reads at most {}: it would stop reading '
                           'the file there. Shorten it.'.format(key, len(line), MAX_LINE_LENGTH))
      lines.append(line)

   adjust = dst_adjustment_applies(config)
   kv('DEVICE_LABEL', config['label'])
   kv('DEVICE_TIMEZONE', config['timezone'])
   kv('DEVICE_UTC_OFFSET', offset_at(config['timezone'], config['start']))
   if adjust:
      kv('DST_ADJUSTED', True)
   kv('SET_RTC_AT_MAGNET_DETECT', config['set_rtc'])
   kv('DEPLOYMENT_START_TIME', config['start'])
   kv('DEPLOYMENT_END_TIME', config['end'])
   latitude, longitude = config.get('latitude'), config.get('longitude')
   if latitude is not None and longitude is not None and abs(latitude) <= 90 and abs(longitude) <= 180:
      kv('DEPLOYMENT_LATITUDE', '{:.5f}'.format(latitude))
      kv('DEPLOYMENT_LONGITUDE', '{:.5f}'.format(longitude))
   kv('GPS_AVAILABLE', config['gps'])
   kv('AWAKE_ON_MAGNET', config['awake_on_magnet'])
   kv('LEDS_ENABLED', config['leds_enabled'])
   if config['leds_enabled']:
      kv('LEDS_ACTIVE_SECONDS', config['leds_active_seconds'])
   kv('MIC_TYPE', config['mic_type'])
   kv('MIC_AMPLIFICATION', '{:.1f}'.format(float(config['mic_amplification'])))
   kv('BATTERY_LOW_MV', config['battery_low_mv'])
   kv('MAGNET_FIELD_VALIDATION_MS', config['magnet_ms'])
   kv('FORBID_DEACTIVATION_SECONDS', config['forbid_deactivation_s'])
   kv('VHF_MODE', config['vhf_mode'])
   if config['vhf_mode'] == 'END':
      kv('VHF_RADIO_START_TIME', config['end'])
   elif config['vhf_mode'] == 'SCHEDULED':
      kv('VHF_RADIO_START_TIME', config['vhf_start'])
   phased = config['phased'] or adjust
   kv('PHASED_DEPLOYMENT', phased)

   if adjust:
      written = [(phase, start, end, shift) for phase, start, end, shift in dst_segments(config)]
   else:
      ordered = sorted(config['phases'], key=lambda phase: _phase_span(config, phase)[0]) if config['phased'] else config['phases'][:1]
      written = [(phase,) + _phase_span(config, phase) + (0,) for phase in ordered]
   if len(written) > MAX_DEPLOYMENT_PHASES:
      raise ConfigError('Adjusting for daylight saving splits this deployment into {} phases, and the recorder holds '
                        '{}. Use fewer phases.'.format(len(written), MAX_DEPLOYMENT_PHASES))

   for phase, start, end, shift in written:
      lines.append('')
      lines.append('[PHASE]')
      kv('PHASE_NAME', phase['name'])
      if phased:
         kv('PHASE_START_TIME', start)
         kv('PHASE_END_TIME', end)
      mode = phase['audio_mode']
      kv('AUDIO_RECORDING_MODE', mode)
      if mode == 'AMPLITUDE':
         kv('AUDIO_EXTEND_CLIP', phase['extend_clip'])
         kv('AUDIO_MAX_CLIPS_NUMBER', phase['max_clips'])
         kv('AUDIO_MAX_CLIPS_TIME_SCALE', phase['max_clips_scale'])
         kv('AUDIO_TRIGGER_THRESHOLD', phase['trigger_threshold'])
      if mode == 'INTERVAL':
         kv('AUDIO_TRIGGER_INTERVAL', phase['interval'])
         kv('AUDIO_TRIGGER_INTERVAL_TIME_SCALE', phase['interval_scale'])
      if mode == 'SCHEDULED':
         kv('AUDIO_TRIGGER_SCHEDULE_TYPE', phase['schedule_type'])
         # Under a solar schedule too: they are the fallback for a day the sun gives no window.
         for entry_start, entry_end in firmware_trigger_times(shift_periods(_as_entered(phase), shift)):
            kv('AUDIO_TRIGGER_SCHEDULE', '{}-{}'.format(entry_start, entry_end))
         if phase['schedule_type'] == 'SOLAR':
            for window in phase['solar']:
               kv('AUDIO_SOLAR_SCHEDULE', window)
      kv('AUDIO_SAMPLING_RATE_HZ', _effective_sample_rate(phase))
      kv('AUDIO_CLIP_LENGTH_SECONDS', phase['clip_length'])
      kv('IMU_RECORDING_MODE', phase['imu_mode'])
      if phase['imu_mode'] != 'NONE':
         kv('IMU_DEGREES_OF_FREEDOM', phase['imu_dof'])
         if phase['imu_mode'] == 'ACTIVITY':
            kv('IMU_TRIGGER_THRESHOLD', phase['imu_threshold_mg'])
         kv('IMU_SAMPLING_RATE_HZ', phase['imu_rate'])
      kv('FILTER_TYPE', phase['filter_type'])
      if phase['filter_type'] in ('HIGH', 'BAND'):
         kv('FILTER_LOW_FREQUENCY', phase['filter_low'])
      if phase['filter_type'] in ('LOW', 'BAND'):
         kv('FILTER_HIGH_FREQUENCY', phase['filter_high'])
      kv('SILENCE_THRESHOLD', phase['silence_threshold'])
      if phase['silence_threshold'] > 0:
         kv('MIN_FREQUENCY', phase['min_freq'])
         kv('MAX_FREQUENCY', _effective_max_frequency(phase))
      kv('USE_OPUS', phase['use_opus'])
      if phase['use_opus']:
         kv('OPUS_BITRATE', phase['opus_bitrate'])
   return '\n'.join(lines) + '\n'

def validate(config, now=None):
   """
   The first thing the web dashboard would refuse to write, of the settings this tool edits or carries,
   in its words; None if nothing. A port of the error-level rules in the web dashboard's validate.ts.
   """
   now = time.time() if now is None else now
   label = config['label']
   if not label.strip():
      return 'Give the device a label.'
   if len(label) > MAX_DEVICE_LABEL_LEN:
      return 'Device labels are limited to {} characters (this one is {}).'.format(MAX_DEVICE_LABEL_LEN, len(label))
   if any(character in label for character in DEVICE_LABEL_FORBIDDEN):
      return 'Device labels cannot contain \\ / : * ? " < > or |, since the label is used as a folder name on the card.'
   start, end = config['start'], config['end']
   if start >= end:
      return 'The deployment must end after it starts.'
   if end <= now:
      return 'The deployment ends in the past. Set the dates for this deployment.'
   if end > MAX_REPRESENTABLE_EPOCH_SECONDS:
      return 'The device cannot represent a date past 19 January 2038. Shorten the deployment.'
   latitude, longitude = config.get('latitude'), config.get('longitude')
   for name, value, limit in (('latitude', latitude, 90), ('longitude', longitude, 180)):
      if value is not None and not abs(value) <= limit:
         return 'The {} must be a number between -{} and {} degrees.'.format(name, limit, limit)
   if (latitude is None) != (longitude is None):
      return 'A position needs both a latitude and a longitude. The device ignores one without the other.'
   if config['vhf_mode'] == 'SCHEDULED' and config['vhf_start'] < start:
      return 'The VHF beacon cannot be scheduled before the deployment starts.'
   if not 0 <= config['leds_active_seconds'] <= LEDS_MAX_ACTIVE_SECONDS:
      return 'Keep the LED active time between 0 and {} seconds.'.format(LEDS_MAX_ACTIVE_SECONDS)
   if config['awake_on_magnet'] and config['magnet_ms'] < MAGNET_VALIDATION_MIN_MS:
      return 'A magnet hold time under {} ms risks the device activating or shutting down from a stray magnetic field while it is being carried.'.format(MAGNET_VALIDATION_MIN_MS)
   if config['awake_on_magnet'] and config['magnet_ms'] > MAGNET_VALIDATION_MAX_MS:
      return 'A magnet hold time over {} ms is longer than anyone will hold a magnet against the case.'.format(MAGNET_VALIDATION_MAX_MS)
   digital = config['mic_type'] == 'DIGITAL'
   gain_ceiling = MIC_AMPLIFICATION_MAX_DB_DIGITAL if digital else MIC_AMPLIFICATION_MAX_DB_ANALOG
   if not 0 <= config['mic_amplification'] <= gain_ceiling:
      return 'A{} microphone takes a gain between 0 and {} dB. The device clamps silently to that range rather than reporting it.'.format(' digital' if digital else 'n analog', _render(float(gain_ceiling)))
   battery = config['battery_low_mv']
   if battery < 0:
      return 'The low-battery cutoff must be a voltage in millivolts, or 0 to disable it.'
   if 0 < battery < BATTERY_CUTOFF_MIN_MV:
      return 'A low-battery cutoff below {} mV will never fire. Use 0 if you mean to disable it.'.format(BATTERY_CUTOFF_MIN_MV)
   if battery > BATTERY_CUTOFF_MAX_MV:
      return 'A low-battery cutoff above {} mV is higher than a fully charged cell, so the deployment would stop as soon as it starts.'.format(BATTERY_CUTOFF_MAX_MV)

   phases = config['phases']
   if not phases:
      return 'Add at least one recording phase.'
   if len(phases) > MAX_DEPLOYMENT_PHASES:
      return 'A deployment can have at most {} phases.'.format(MAX_DEPLOYMENT_PHASES)
   if config['phased']:
      names = [phase['name'].strip().lower() for phase in phases]
      if '' in names:
         return 'Every phase needs a name, so they can be told apart.'
      if len(set(names)) != len(names):
         return 'Two phases have the same name. Give each one a distinct name.'
      previous_end = None
      for phase in sorted(phases, key=lambda phase: phase['start']):
         if phase['start'] >= phase['end']:
            return 'Phase "{}" must end after it starts.'.format(phase['name'])
         if phase['start'] < start or phase['end'] > end:
            return 'Phase "{}" falls outside the deployment dates.'.format(phase['name'])
         if previous_end is not None and phase['start'] < previous_end:
            return 'Phase "{}" overlaps the phase before it.'.format(phase['name'])
         previous_end = phase['end']
   for phase in phases:
      named = ('In phase "{}": '.format(phase['name']) if config['phased'] else '') + '{}'
      if len(phase['name']) > PHASE_NAME_MAX_LEN:
         return named.format('phase names are limited to {} characters.'.format(PHASE_NAME_MAX_LEN))
      mode = phase['audio_mode']
      if mode == 'AMPLITUDE':
         if digital:
            return named.format('sound-triggered recording needs an analog microphone.')
         if phase['max_clips'] <= 0:
            return named.format('a clip cap of zero is rewritten to a single clip per period by the device. Set the number of clips it may capture.')
         if not 0 < phase['trigger_threshold'] <= 1:
            return named.format('the threshold trigger level is a fraction of full scale between 0 and 1.')
         if int(TRIGGER_DIGIPOT_STEPS * phase['trigger_threshold']) < 1:
            return named.format('a trigger level this low cannot be set on the hardware, and the device would never record.')
      if mode == 'INTERVAL':
         interval = phase['interval'] * TIME_SCALE_SECONDS[phase['interval_scale']]
         if phase['clip_length'] > interval:
            return named.format('clips of {} s do not fit into an interval of {} s.'.format(phase['clip_length'], interval))
      if mode == 'SCHEDULED':
         solar = phase['schedule_type'] == 'SOLAR'
         if not phase['periods'] and not solar:
            return named.format('add at least one listening period.')
         if solar:
            if not phase['solar']:
               return named.format('add at least one solar listening period.')
            if len(phase['solar']) > MAX_AUDIO_TRIGGER_TIMES:
               return named.format('a phase can have at most {} solar listening periods.'.format(MAX_AUDIO_TRIGGER_TIMES))
            if latitude is None:
               return named.format('a solar schedule needs the deployment position.')
         if len(firmware_trigger_times(_as_entered(phase))) > MAX_AUDIO_TRIGGER_TIMES:
            return named.format('a phase can have at most {} listening periods.'.format(MAX_AUDIO_TRIGGER_TIMES))
         for period_start, period_end in phase['periods']:
            if period_start == period_end or not 0 <= period_start < SECONDS_PER_DAY or period_end < period_start:
               return named.format('each listening period must end after it starts.')
         ordered = sorted(phase['periods'])
         for (_, earlier_end), (later_start, _) in zip(ordered, ordered[1:]):
            if later_start < earlier_end:
               return named.format('listening periods must not overlap.')
      if not AUDIO_MIN_CLIP_LENGTH_SECONDS <= phase['clip_length'] <= AUDIO_MAX_CLIP_LENGTH_SECONDS:
         return named.format('clip length must be between {} and {} seconds.'.format(AUDIO_MIN_CLIP_LENGTH_SECONDS, AUDIO_MAX_CLIP_LENGTH_SECONDS))
      if phase['use_opus'] and not OPUS_MIN_BITRATE <= phase['opus_bitrate'] <= OPUS_MAX_BITRATE:
         return named.format('the Opus bitrate must be between {} and {} bps.'.format(OPUS_MIN_BITRATE, OPUS_MAX_BITRATE))
      corner_ceiling = _effective_sample_rate(phase) // 2 - 1
      if phase['filter_type'] in ('HIGH', 'BAND') and not 0 < phase['filter_low'] < corner_ceiling:
         return named.format('the high-pass corner must be between 1 and {} Hz at this sample rate.'.format(corner_ceiling))
      if phase['filter_type'] in ('LOW', 'BAND') and not 0 < phase['filter_high'] <= corner_ceiling:
         return named.format('the low-pass corner must be between 1 and {} Hz at this sample rate.'.format(corner_ceiling))
      if phase['filter_type'] == 'BAND' and phase['filter_low'] >= phase['filter_high']:
         return named.format('the high-pass corner must be below the low-pass corner.')
      if not 0 <= phase['silence_threshold'] <= 1:
         return named.format('the silence threshold must be between 0 and 100% of full scale.')
      if phase['silence_threshold'] > 0 and phase['min_freq'] >= phase['max_freq']:
         return named.format('the low end of the silence frequency range must be below the high end.')
      if phase['imu_mode'] == 'ACTIVITY' and not IMU_MOTION_THRESHOLD_MIN_MG <= phase['imu_threshold_mg'] <= IMU_MOTION_THRESHOLD_MAX_MG:
         return named.format('the motion trigger threshold must be between {:.1f} and {} mg.'.format(IMU_MOTION_THRESHOLD_MIN_MG, IMU_MOTION_THRESHOLD_MAX_MG))
   try:
      serialize(config)
   except ConfigError as error:
      return str(error)
   return None


# READING -------------------------------------------------------------------------------------------------------------

def _new_phase(name):
   return {'name': name, 'start': None, 'end': None, 'audio_mode': None, 'extend_clip': None, 'max_clips': None,
           'max_clips_scale': None, 'trigger_threshold': None, 'interval': None, 'interval_scale': None,
           'schedule_type': 'CLOCK', 'periods': [], 'entered': None, 'solar': [], 'sample_rate': None, 'clip_length': None,
           'imu_mode': None, 'imu_dof': None, 'imu_threshold_mg': None, 'imu_rate': None, 'filter_type': None,
           'filter_low': None, 'filter_high': None, 'silence_threshold': None, 'min_freq': None, 'max_freq': None,
           'use_opus': None, 'opus_bitrate': None}

def _number(value):
   number = float(value)
   return int(number) if number.is_integer() and '.' not in value and 'e' not in value.lower() else number

def parse(text):
   """
   The settings a configuration file holds, as the web dashboard reads it. Values it does not hold are None,
   for the window to leave as they are. Overnight periods come back as their two entries either side of
   midnight, which is how this tool shows them; a daylight-saving split comes back as the phases entered.
   """
   config = {'label': None, 'timezone': None, 'set_rtc': None, 'start': None, 'end': None, 'latitude': None,
             'longitude': None, 'gps': None, 'awake_on_magnet': None, 'leds_enabled': None,
             'leds_active_seconds': None, 'mic_type': None, 'mic_amplification': None, 'battery_low_mv': None,
             'magnet_ms': None, 'forbid_deactivation_s': None, 'vhf_mode': None, 'vhf_start': None,
             'phased': False, 'adjust_for_dst': True, 'phases': []}
   dst_adjusted = False
   lines = text.split('\n')
   # The recorder drops a last line with no newline after it; an empty one is only the file's end.
   lines = lines[:-1]
   for line in lines:
      line = line.rstrip('\r')
      if len(line) > MAX_LINE_LENGTH:
         break                      # the recorder stops reading here
      if len(line) < 4:
         continue
      trimmed = line.lstrip(' \t')
      if '"' not in trimmed:
         if trimmed.startswith('[PHASE]'):
            config['phases'].append(_new_phase('Phase {}'.format(len(config['phases']) + 1)))
         continue
      key = trimmed.split('=', 1)[0].strip()
      value = trimmed[trimmed.index('"') + 1:trimmed.rindex('"')]
      if key in PHASE_KEYS:
         if not config['phases']:
            continue
         phase = config['phases'][-1]
         if key == 'PHASE_NAME': phase['name'] = value
         elif key == 'PHASE_START_TIME': phase['start'] = int(value)
         elif key == 'PHASE_END_TIME': phase['end'] = int(value)
         elif key == 'AUDIO_RECORDING_MODE': phase['audio_mode'] = value
         elif key == 'AUDIO_EXTEND_CLIP': phase['extend_clip'] = value == 'True'
         elif key == 'AUDIO_MAX_CLIPS_NUMBER': phase['max_clips'] = int(value)
         elif key == 'AUDIO_MAX_CLIPS_TIME_SCALE': phase['max_clips_scale'] = value
         elif key == 'AUDIO_TRIGGER_THRESHOLD': phase['trigger_threshold'] = float(value)
         elif key == 'AUDIO_TRIGGER_INTERVAL': phase['interval'] = int(value)
         elif key == 'AUDIO_TRIGGER_INTERVAL_TIME_SCALE': phase['interval_scale'] = value
         elif key == 'AUDIO_TRIGGER_SCHEDULE_TYPE': phase['schedule_type'] = value
         elif key == 'AUDIO_TRIGGER_SCHEDULE':
            start, end = value.split('-')
            phase['periods'].append((int(start), int(end)))
         elif key == 'AUDIO_SOLAR_SCHEDULE': phase['solar'].append(value)
         elif key == 'AUDIO_SAMPLING_RATE_HZ': phase['sample_rate'] = int(value)
         elif key == 'AUDIO_CLIP_LENGTH_SECONDS': phase['clip_length'] = int(value)
         elif key == 'IMU_RECORDING_MODE': phase['imu_mode'] = value
         elif key == 'IMU_DEGREES_OF_FREEDOM': phase['imu_dof'] = int(value)
         elif key == 'IMU_TRIGGER_THRESHOLD': phase['imu_threshold_mg'] = _number(value)
         elif key == 'IMU_SAMPLING_RATE_HZ': phase['imu_rate'] = int(value)
         elif key == 'FILTER_TYPE': phase['filter_type'] = value
         elif key == 'FILTER_LOW_FREQUENCY': phase['filter_low'] = int(value)
         elif key == 'FILTER_HIGH_FREQUENCY': phase['filter_high'] = int(value)
         elif key == 'SILENCE_THRESHOLD': phase['silence_threshold'] = _number(value)
         elif key == 'MIN_FREQUENCY': phase['min_freq'] = int(value)
         elif key == 'MAX_FREQUENCY': phase['max_freq'] = int(value)
         elif key == 'USE_OPUS': phase['use_opus'] = value == 'True'
         elif key == 'OPUS_BITRATE': phase['opus_bitrate'] = int(value)
         continue
      if key == 'DEVICE_LABEL': config['label'] = value
      elif key == 'DEVICE_TIMEZONE': config['timezone'] = value
      elif key == 'DST_ADJUSTED': dst_adjusted = value == 'True'
      elif key == 'SET_RTC_AT_MAGNET_DETECT': config['set_rtc'] = value == 'True'
      elif key == 'DEPLOYMENT_START_TIME': config['start'] = int(value)
      elif key == 'DEPLOYMENT_END_TIME': config['end'] = int(value)
      elif key == 'DEPLOYMENT_LATITUDE': config['latitude'] = float(value)
      elif key == 'DEPLOYMENT_LONGITUDE': config['longitude'] = float(value)
      elif key == 'GPS_AVAILABLE': config['gps'] = value == 'True'
      elif key == 'AWAKE_ON_MAGNET': config['awake_on_magnet'] = value == 'True'
      elif key == 'LEDS_ENABLED': config['leds_enabled'] = value == 'True'
      elif key == 'LEDS_ACTIVE_SECONDS': config['leds_active_seconds'] = int(value)
      elif key == 'MIC_TYPE': config['mic_type'] = value
      elif key == 'MIC_AMPLIFICATION': config['mic_amplification'] = float(value)
      elif key == 'BATTERY_LOW_MV': config['battery_low_mv'] = int(value)
      elif key == 'MAGNET_FIELD_VALIDATION_MS': config['magnet_ms'] = int(value)
      elif key == 'FORBID_DEACTIVATION_SECONDS': config['forbid_deactivation_s'] = int(value)
      elif key == 'VHF_MODE': config['vhf_mode'] = value
      elif key == 'VHF_RADIO_START_TIME': config['vhf_start'] = int(value)
      elif key == 'PHASED_DEPLOYMENT': config['phased'] = value == 'True'
   config['timezone'] = config['timezone'] or 'UTC'

   # An overnight period is written as the two entries either side of midnight: joined again, as entered.
   for phase in config['phases']:
      phase['entered'] = merge_midnight_periods(phase['periods'])

   # Put back what the writer split for daylight saving: each piece's periods moved back onto the
   # local clock, and the pieces of one phase joined up again. Pieces are the same name, end to end
   # in time, and identical in every setting once moved back.
   if dst_adjusted and config['phased'] and config['start'] is not None:
      device_offset = offset_at(config['timezone'], config['start'])
      joined = []
      # Periods compared as the recorder's entries: two meeting at midnight read back as one
      # overnight period, and moved by the change may come back as two, the same recording.
      settings = lambda p: dict({k: v for k, v in p.items() if k not in ('start', 'end', 'periods', 'entered')},
                                entries=firmware_trigger_times(p['entered']))
      for phase in sorted(config['phases'], key=lambda p: p['start'] if p['start'] is not None else config['start']):
         begins = phase['start'] if phase['start'] is not None else config['start']
         shift = device_offset - offset_at(config['timezone'], begins)
         phase = dict(phase, entered=shift_periods(phase['entered'], -shift))
         previous = joined[-1] if joined else None
         if previous and previous['name'] == phase['name'] and previous['end'] is not None and \
               phase['start'] is not None and previous['end'] == phase['start'] and settings(previous) == settings(phase):
            previous['end'] = phase['end']
            continue
         joined.append(phase)
      only = joined[0] if len(joined) == 1 else None
      if only and (only['start'] is None or only['start'] == config['start']) and (only['end'] is None or only['end'] == config['end']):
         only['start'] = only['end'] = None
         config['phased'] = False
      config['phases'] = joined
   # This tool shows each period as the entries the recorder is given.
   for phase in config['phases']:
      phase['periods'] = firmware_trigger_times(phase['entered'])
   if not config['phased']:
      for phase in config['phases']:
         phase['start'] = phase['end'] = None
   # A card written without the adjustment, across a change that would have moved its periods, ran
   # unadjusted, and is written back the same way.
   if config['start'] is not None and config['end'] is not None:
      config['adjust_for_dst'] = dst_adjusted or not dst_changes_affecting_schedule(config)
   return config
