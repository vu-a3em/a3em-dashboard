#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# PYTHON INCLUSIONS ---------------------------------------------------------------------------------------------------

try: from .read_config import read_config
except: from read_config import read_config
try: from .write_config import write_config
except: from write_config import write_config
try: from .tkcal import DateEntry
except: from tkcal import DateEntry
from tkinter import ttk, filedialog
from datetime import datetime
from functools import partial
import os, psutil, pytz, tzlocal
import tkinter as tk
import asyncio


# CONSTANTS AND DEFINITIONS -------------------------------------------------------------------------------------------

CONFIG_FILE_NAME = '_a3em.cfg'
LAST_TIMESTAMP_FILE_NAME = '_a3em.timestamp'
ACTIVATION_FILE_NAME = '_a3em.active'
MAX_DEVICE_LABEL_LEN = 15
MAX_AUDIO_TRIGGER_TIMES = 12

DEFAULT_MAGNETIC_FIELD_VALIDATION_LENGTH_MS = 5000
DEFAULT_AUDIO_SAMPLE_RATE_HZ = 20000
DEFAULT_AUDIO_CLIP_LENGTH_S = 10
DEFAULT_IMU_SAMPLE_RATE_HZ = 6

VALID_AUDIO_MODES = {'Threshold-Based': 'AMPLITUDE',
                     'Schedule-Based': 'SCHEDULED',
                     'Interval-Based': 'INTERVAL',
                     'Continuous': 'CONTINUOUS'}
VALID_IMU_MODES = {'Motion-Based': 'ACTIVITY', 'Audio-Synced': 'AUDIO'}
VALID_TIME_SCALES = {'Second': 'SECONDS', 'Minute': 'MINUTES', 'Hour': 'HOURS', 'Day': 'DAYS'}
VALID_VHF_MODES = {'Never': 'NEVER', 'End of Deployment': 'END', 'Scheduled': 'SCHEDULED'}
VALID_IMU_SAMPLE_RATES = ['3', '6', '12', '25', '50', '100', '200', '400', '800']
VALID_DOFS = ['3']


# HELPER FUNCTIONS ----------------------------------------------------------------------------------------------------

def get_download_directory():
   if os.name == 'nt':
      import winreg
      sub_key = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders'
      downloads_guid = '{374DE290-123F-4565-9164-39C4925E467B}'
      with winreg.OpenKey(winreg.HKEY_CURRENT_USER, sub_key) as key:
         location = winreg.QueryValueEx(key, downloads_guid)[0]
      return location
   else:
      return os.path.join(os.path.expanduser('~'), 'Downloads')

def validate_time(var, why, new_val):
   good = (len(new_val) == 0) or \
          (len(new_val) == 1 and new_val.isnumeric()) or \
          (len(new_val) == 2 and (new_val[-1] == ':' or (new_val[-1].isnumeric() and int(new_val) < 24))) or \
          (len(new_val) == 3 and ((new_val[-2] != ':' and new_val[-1] == ':') or (new_val[-2] == ':' and new_val[-1].isnumeric() and int(new_val[-1]) <= 5))) or \
          (len(new_val) == 4 and new_val[-1].isnumeric() and (new_val[-2] != ':' or int(new_val[-1]) <= 5)) or \
          (len(new_val) == 5 and new_val[-1].isnumeric() and new_val[-3] == ':')
   if int(why) == -1 and (not good or len(new_val) != 5):
      var.set('00:00')
      return True
   return good

def validate_number(var, min_val, max_val, why, new_val):
   if int(why) == 0:
      return True
   elif int(why) == -1 and (not new_val.isdigit() or int(new_val) < min_val):
      var.set(min_val)
      return True
   return new_val.isdigit() and int(new_val) <= max_val

def validate_float(var, new_val):
   return new_val.replace('.', '').isdigit() and new_val.count('.') <= 1 and float(new_val) >= 0.0 and float(new_val) <= 45.0

def validate_details(self):
   write_order = [0]
   last_phase_end = None
   time_zone = self.device_timezone.get()
   utc_offset = int(datetime.now(pytz.timezone(time_zone)).utcoffset().total_seconds())
   start_datetime = pytz.timezone(time_zone).localize(datetime.strptime(self.deployment_start_date.get() + ' ' + self.deployment_start_time.get(), '%Y-%m-%d %H:%M')).astimezone(pytz.utc)
   end_datetime = pytz.timezone(time_zone).localize(datetime.strptime(self.deployment_end_date.get() + ' ' + self.deployment_end_time.get(), '%Y-%m-%d %H:%M')).astimezone(pytz.utc)
   vhf_datetime = pytz.timezone(time_zone).localize(datetime.strptime(self.vhf_start_date.get() + ' ' + self.vhf_start_time.get(), '%Y-%m-%d %H:%M')).astimezone(pytz.utc)
   if start_datetime >= end_datetime:
      return 'Deployment start datetime must be before deployment end datetime'
   if vhf_datetime < start_datetime:
      return 'VHF start datetime must be after deployment start datetime'
   if self.deployment_is_split.get():
      start_times = []
      if len(self.deployment_phases) == 0:
         return 'At least one deployment phase must be defined'
      for idx, phase in enumerate(self.deployment_phases):
         _, date_start, date_end, time_start, time_end = self.deployment_phase_times[idx]
         start_times.append((int(datetime.strptime(date_start.get() + ' ' + time_start.get(), '%Y-%m-%d %H:%M').timestamp()), idx))
      write_order = [item[1] for item in sorted(start_times, key=lambda x: x[0])]
   for idx in write_order:
      phase = self.deployment_phases[idx]
      if self.deployment_is_split.get():
         _, date_start, date_end, time_start, time_end = self.deployment_phase_times[idx]
         phase_start_datetime = pytz.timezone(time_zone).localize(datetime.strptime(date_start.get() + ' ' + time_start.get(), '%Y-%m-%d %H:%M')).astimezone(pytz.utc)
         phase_end_datetime = pytz.timezone(time_zone).localize(datetime.strptime(date_end.get() + ' ' + time_end.get(), '%Y-%m-%d %H:%M')).astimezone(pytz.utc)
         if phase_start_datetime < start_datetime or phase_end_datetime > end_datetime:
            return 'Deployment phases must be within deployment start/end times'
         if last_phase_end and phase_start_datetime < last_phase_end:
            return 'Deployment phases cannot overlap'
         last_phase_end = phase_end_datetime
      if phase.audio_recording_mode.get() == 'Interval-Based':
         interval_seconds = 0
         if phase.audio_trigger_interval_time_scale.get() == 'Second':
            interval_seconds = int(phase.audio_trigger_interval.get())
         elif phase.audio_trigger_interval_time_scale.get() == 'Minute':
            interval_seconds = int(phase.audio_trigger_interval.get()) * 60
         elif phase.audio_trigger_interval_time_scale.get() == 'Hour':
            interval_seconds = int(phase.audio_trigger_interval.get()) * 3600
         elif phase.audio_trigger_interval_time_scale.get() == 'Day':
            interval_seconds = int(phase.audio_trigger_interval.get()) * 86400
         if int(phase.audio_clip_length.get()) > interval_seconds:
            return 'Audio-reading interval must be greater than or equal to the audio clip length'
      if phase.audio_recording_mode.get() == 'Schedule-Based':
         last_end_time = 0
         if len(phase.audio_trigger_times) == 0:
            return 'Schedule-based audio recording must have at least one start/end time pair'
         for trigger_time in phase.audio_trigger_times:
            hours, minutes = trigger_time[0].get().split(':')
            start_time = (((int(hours) * 3600) + (int(minutes) * 60)) - utc_offset) % 86400
            hours, minutes = trigger_time[1].get().split(':')
            end_time = (((int(hours) * 3600) + (int(minutes) * 60)) - utc_offset) % 86400
            if start_time >= end_time:
               return 'Schedule-based audio start times must be before their corresponding end times'
            if start_time < last_end_time:
               return 'Schedule-based audio start/end times cannot overlap'
            last_end_time = end_time
   return None


# INTERMEDIATE STORAGE CLASSES ----------------------------------------------------------------------------------------

class SchedulePhase:
   
   def __init__(self, master, name):
      self.name = name
      self.extend_clip_if_continuous_audio = tk.BooleanVar(master, False)
      self.imu_recording_mode = tk.StringVar(master, 'Audio-Synced')
      self.audio_recording_mode = tk.StringVar(master, 'Threshold-Based')
      self.max_clips_time_scale = tk.StringVar(master, 'Hour')
      self.audio_trigger_interval_time_scale = tk.StringVar(master, 'Minute')
      self.max_audio_clips = tk.IntVar(master, 0)
      self.audio_trigger_interval = tk.IntVar(master, 10)
      self.audio_clip_length = tk.IntVar(master, 10)
      self.audio_sampling_rate = tk.IntVar(master, 20000)
      self.imu_sampling_rate = tk.IntVar(master, 6)
      self.imu_degrees_of_freedom = tk.IntVar(master, 3)
      self.audio_trigger_threshold = tk.DoubleVar(master, 0.25)
      self.imu_trigger_threshold = tk.DoubleVar(master, 0.25)
      self.audio_trigger_times = []


# GUI DESIGN ----------------------------------------------------------------------------------------------------------

class A3EMGui(ttk.Frame):

   def __init__(self):

      # Set up the root application window
      super().__init__(None)
      self.master.title('A3EM Dashboard')
      try:
         self.master.iconphoto(True, tk.PhotoImage(file='dashboard/a3em_icon.png'))
      except Exception:
         self.master.iconphoto(True, tk.PhotoImage(file=os.path.dirname(os.path.realpath(__file__)) + '/a3em_icon.png'))
      self.master.protocol('WM_DELETE_WINDOW', self._exit)
      self.master.geometry('900x700+' + str((self.winfo_screenwidth()-900)//2) + '+' + str((self.winfo_screenheight()-700)//2))
      self.pack(fill=tk.BOTH, expand=True)

      # Create an asynchronous event loop
      self.event_loop = asyncio.new_event_loop()
      asyncio.set_event_loop(self.event_loop)

      # Create all necessary shared variables
      self.deployment_is_split = tk.BooleanVar(self.master, False)
      self.set_rtc_at_magnet_detect = tk.BooleanVar(self.master, True)
      self.gps_available = tk.BooleanVar(self.master, False)
      self.awake_on_magnet = tk.BooleanVar(self.master, True)
      self.leds_enabled = tk.BooleanVar(self.master, True)
      self.leds_active_seconds = tk.IntVar(self.master, 3600)
      self.mic_amplification_level_db = tk.DoubleVar(self.master, 35.0)
      self.magnetic_field_validation_length_ms = tk.IntVar(self.master, 5000)
      self.target_selection = tk.StringVar(self.master, 'Select a target device...')
      self.device_timezone = tk.StringVar(self.master, tzlocal.get_localzone())
      self.save_directory = tk.StringVar(self.master, get_download_directory())
      self.device_label = tk.StringVar(self.master)
      self.deployment_start_date = tk.StringVar(self.master, datetime.today().strftime('%Y-%m-%d'))
      self.deployment_start_time = tk.StringVar(self.master, '00:00')
      self.deployment_end_date = tk.StringVar(self.master, datetime.today().strftime('%Y-%m-%d'))
      self.deployment_end_time = tk.StringVar(self.master, '00:00')
      self.vhf_start_date = tk.StringVar(self.master, datetime.today().strftime('%Y-%m-%d'))
      self.vhf_start_time = tk.StringVar(self.master, '00:00')
      self.vhf_mode = tk.StringVar(self.master, 'End of Deployment')
      self.deployment_phase_default = [SchedulePhase(self.master, tk.StringVar(self.master, 'Default'))]
      self.deployment_phases_custom = []
      self.deployment_phases = self.deployment_phase_default
      self.selected_phase = tk.StringVar(self.master, 'Default')
      self.deployment_phase_times = []
      self.audio_detail_fields = []
      self.active_data_entry = None

      # Create the control bar
      control_bar = ttk.Frame(self)
      control_bar.pack(side=tk.TOP, fill=tk.X, padx=5, pady=5, expand=False)
      control_bar.columnconfigure(1, weight=1)
      self.scan_button = ttk.Button(control_bar, text='Scan for Devices', command=self._scan_for_devices, width=20)
      self.scan_button.grid(column=0, row=0, padx=(10,0))
      self.target_selector = ttk.Combobox(control_bar, textvariable=self.target_selection, state=['readonly'])
      self.target_selector.bind('<<ComboboxSelected>>', self._target_selection_changed)
      self.target_selector.grid(column=1, row=0, padx=10, pady=(3,0), sticky=tk.W+tk.E)
      self.target_selector['values'] = ['Local Directory']
      self.configure_button = ttk.Button(control_bar, text='Configure', command=self._configure, state=['disabled'])
      self.configure_button.grid(column=2, row=0)
      ttk.Button(control_bar, text='Quit', command=self._exit).grid(column=3, row=0)

      # Create the operations bar
      self.operations_bar = ttk.Frame(self)
      self.operations_bar.pack(side=tk.LEFT, fill=tk.Y, padx=5, expand=False)
      ttk.Label(self.operations_bar, text='A3EM Actions', padding=6).grid(row=0)
      ttk.Button(self.operations_bar, text='Get Current Configuration', command=self._get_configuration).grid(row=1, sticky=tk.W+tk.E)
      ttk.Button(self.operations_bar, text='Update Deployment Details', command=self._update_deployment_details).grid(row=2, sticky=tk.W+tk.E)
      self.phases_button = ttk.Button(self.operations_bar, text='Update Deployment Phases', command=self._update_deployment_phases)
      self.update_audio_button = ttk.Button(self.operations_bar, text='Update Audio Recording Details', command=self._update_audio_details)
      self.update_audio_button.grid(row=4, sticky=tk.W+tk.E)
      self.update_imu_button = ttk.Button(self.operations_bar, text='Update IMU Recording Details', command=self._update_imu_details)
      self.update_imu_button.grid(row=5, sticky=tk.W+tk.E)
      ttk.Button(self.operations_bar, text='Read Deployment Statistics', command=self._read_deployment_statistics).grid(row=6, sticky=tk.W+tk.E)

      # Scan for SD Card devices
      self._scan_for_devices()

      # Create the workspace canvas
      self.canvas = ttk.Frame(self)
      self.canvas.pack(fill=tk.BOTH, padx=(0, 5), pady=(0, 5), expand=True)
      tk.Label(self.canvas, text='Select a target device to continue...').pack(fill=tk.BOTH, expand=True)

   def _exit(self):
      self._clear_canvas()
      tk.Label(self.canvas, text='Shutting down...').pack(fill=tk.BOTH, expand=True)
      self.master.destroy()

   def _clear_canvas(self):
      for item in self.canvas.winfo_children():
         item.destroy()

   def _change_button_states(self, enable):
      self.configure_button.configure(state=['enabled' if enable else 'disabled'])
      for item in self.operations_bar.winfo_children():
         if isinstance(item, ttk.Button):
            item.configure(state=['enabled' if enable else 'disabled'])

   def _target_selection_changed(self, event):
      if self.target_selection.get() == 'Local Directory':
         new_directory = filedialog.askdirectory(parent=self, title='Choose A3EM Storage Directory', initialdir=self.save_directory.get())
         if new_directory:
            self.save_directory.set(new_directory)
            self.target_selection.set(new_directory)
            self._change_button_states(True)
         else:
            self.target_selection.set('Select a target device...')
            self._change_button_states(False)
         self.target_selector.selection_clear()
      else:
         self.save_directory.set(self.target_selection.get())
         self._change_button_states(True)

   def _deployment_end_changed(self, var, why, new_val):
      good_val = validate_time(var, why, new_val) if not isinstance(new_val, tk.Event) else True
      if good_val and self.vhf_mode.get() == 'End of Deployment':
         self.vhf_start_date.set(self.deployment_end_date.get())
         self.vhf_start_time.set(self.deployment_end_time.get())
      self._date_entry_changed(None)
      return good_val

   def _scan_for_devices(self):
      self._change_button_states(False)
      self.target_selection.set('Select a target device...')
      self.target_selector['values'] = ['Local Directory'] + [partition.mountpoint for partition in psutil.disk_partitions()
                                                              if 'fat' in partition.fstype or 'msdos' in partition.fstype]

   def _get_configuration(self):
      self._clear_canvas()
      try:
         read_config(self, CONFIG_FILE_NAME, SchedulePhase)
         tk.Label(self.canvas, text='Successfully loaded configuration from the device!').pack(fill=tk.BOTH, expand=True)
      except:
         tk.Label(self.canvas, text='Unable to load the configuration file').pack(fill=tk.BOTH, expand=True)
         tk.messagebox.showerror('A3EM Error', 'ERROR\n\nUnable to parse configuration file at {}/{}'.format(self.save_directory.get(), CONFIG_FILE_NAME))

   def _change_leds_enabled(self):
      for field in self.led_fields:
         field.configure(state=['' if self.leds_enabled.get() else 'disabled'])

   def _change_magnet_enabled(self):
      for field in self.magnet_fields:
         field.configure(state=['' if self.awake_on_magnet.get() else 'disabled'])

   def _imu_mode_changed(self, phase, event=None):
      for field in self.imu_motion_fields:
         field.configure(state=['' if phase.imu_recording_mode.get() == 'Motion-Based' else 'disabled'])

   def _change_vhf_enabled(self, event=None):
      for field in self.vhf_fields:
         field.configure(state=['' if self.vhf_mode.get() == 'Scheduled' else 'disabled'])
      if self.vhf_mode.get() == 'End of Deployment':
         self.vhf_start_date.set(self.deployment_end_date.get())
         self.vhf_start_time.set(self.deployment_end_time.get())
      elif self.vhf_mode.get() == 'Never':
         self.vhf_start_date.set('2000-01-01')
         self.vhf_start_time.set('00:00')

   def _change_deployment_split(self):
      if self.deployment_is_split.get():
         self.phases_button.grid(row=3, sticky=tk.W+tk.E)
         self.deployment_phases = self.deployment_phases_custom
         if len(self.deployment_phases) > 0:
            self.selected_phase.set(self.deployment_phases[0].name.get())
         self.update_audio_button.configure(state=['enabled' if self.deployment_phase_times else 'disabled'])
         self.update_imu_button.configure(state=['enabled' if self.deployment_phase_times else 'disabled'])
      else:
         self.phases_button.grid_forget()
         self.deployment_phases = self.deployment_phase_default
         self.selected_phase.set('Default')
         self.update_audio_button.configure(state=['enabled'])
         self.update_imu_button.configure(state=['enabled'])

   def _deployment_phase_changed(self, from_tab, event=None):
      if from_tab == 'audio':
         self._update_audio_details()
      elif from_tab == 'imu':
         self._update_imu_details()

   def _focus_in(self, event):
      if self.active_data_entry is not None:
         self.active_data_entry.drop_down()

   def _date_entry_clicked(self, event):
      self.focus_set()
      self.active_data_entry = event.widget

   def _date_entry_changed(self, event):
      self.active_data_entry = None

   def _update_deployment_details(self):
      self._clear_canvas()
      prompt_area = ttk.Frame(self.canvas)
      prompt_area.place(relx=0.5, anchor=tk.N)
      ttk.Label(prompt_area, text='Deployment Details', font=('Helvetica', '14', 'bold')).grid(column=0, row=0, columnspan=5, pady=(20,20), sticky=tk.N+tk.S)
      ttk.Label(prompt_area, text='Device Details', font=('Helvetica', '14', 'bold')).grid(column=0, row=1, columnspan=5, pady=(0,10), sticky=tk.W+tk.N+tk.S)
      row = ttk.Frame(prompt_area)
      row.grid(row=2, column=0, columnspan=5, pady=(0,10), sticky=tk.W+tk.E)
      ttk.Label(row, text='Device Label:  ').pack(side=tk.LEFT, expand=False)
      ttk.Entry(row, textvariable=self.device_label, validate='all', validatecommand=(row.register(lambda new_val: len(new_val) <= MAX_DEVICE_LABEL_LEN), '%P')).pack(side=tk.RIGHT, fill=tk.X, expand=True)
      ttk.Checkbutton(prompt_area, text='GPS Available on Device', variable=self.gps_available).grid(column=0, row=3, columnspan=5, pady=(0,5), sticky=tk.W)
      ttk.Checkbutton(prompt_area, text='Device LEDs Enabled', variable=self.leds_enabled, command=self._change_leds_enabled).grid(column=0, row=4, columnspan=5, sticky=tk.W)
      field1 = ttk.Label(prompt_area, text='     LEDs Active after Activation for:')
      field1.grid(column=0, row=5, columnspan=3, sticky=tk.W+tk.E+tk.N+tk.S)
      field2 = ttk.Entry(prompt_area, textvariable=self.leds_active_seconds, width=7, validate='all', validatecommand=(prompt_area.register(partial(validate_number, self.leds_active_seconds, 0, 604800)), '%d', '%P'))
      field2.grid(column=3, row=5, columnspan=1, sticky=tk.W+tk.E+tk.N+tk.S)
      field3 = ttk.Label(prompt_area, text=' seconds')
      field3.grid(column=4, row=5, columnspan=1, sticky=tk.W+tk.E+tk.N+tk.S)
      self.led_fields = [field1, field2, field3]
      self._change_leds_enabled()
      ttk.Label(prompt_area, text='Microphone Amplification Level: ').grid(column=0, row=6, columnspan=3, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Spinbox(prompt_area, textvariable=self.mic_amplification_level_db, width=10, from_=0.0, to=45.0, increment=0.5, validate='all', validatecommand=(prompt_area.register(partial(validate_float, self.mic_amplification_level_db)), '%P')).grid(column=3, row=6, columnspan=1, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Label(prompt_area, text=' dB').grid(column=4, row=6, columnspan=1, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Checkbutton(prompt_area, text='Magnetic Activation Enabled', variable=self.awake_on_magnet, command=self._change_magnet_enabled).grid(column=0, row=7, columnspan=5, sticky=tk.W)
      field1 = ttk.Label(prompt_area, text='     Magnetic Duration for Activation: ')
      field1.grid(column=0, row=8, columnspan=3, sticky=tk.W+tk.E+tk.N+tk.S)
      field2 = ttk.Entry(prompt_area, textvariable=self.magnetic_field_validation_length_ms, width=7, validate='all', validatecommand=(prompt_area.register(partial(validate_number, self.magnetic_field_validation_length_ms, 1000, 30000)), '%d', '%P'))
      field2.grid(column=3, row=8, columnspan=1, sticky=tk.W+tk.E+tk.N+tk.S)
      field3 = ttk.Label(prompt_area, text=' ms')
      field3.grid(column=4, row=8, columnspan=1, sticky=tk.W+tk.E+tk.N+tk.S)
      self.magnet_fields = [field1, field2, field3]
      self._change_magnet_enabled()
      ttk.Separator(prompt_area, orient='horizontal').grid(column=0, row=9, pady=20, columnspan=5, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Label(prompt_area, text='Scheduling Details', font=('Helvetica', '14', 'bold')).grid(column=0, row=10, columnspan=5, pady=(0,10), sticky=tk.W+tk.N+tk.S)
      ttk.Label(prompt_area, text='Deployment Timezone:').grid(column=0, row=11, columnspan=2, pady=(0,8), sticky=tk.W+tk.N+tk.S)
      ttk.Combobox(prompt_area, textvariable=self.device_timezone, values=pytz.all_timezones, state=['readonly']).grid(column=2, row=11, columnspan=3, pady=(0,8), sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Label(prompt_area, text='Start Date').grid(column=0, row=12, sticky=tk.W)
      ttk.Label(prompt_area, text='Start Time').grid(column=1, row=12, sticky=tk.W)
      ttk.Label(prompt_area, text='End Date').grid(column=3, row=12, sticky=tk.W)
      ttk.Label(prompt_area, text='End Time').grid(column=4, row=12, sticky=tk.W)
      start_date = DateEntry(prompt_area, textvariable=self.deployment_start_date, selectmode='day', firstweekday='sunday', showweeknumbers=False, date_pattern='yyyy-mm-dd')
      start_date.grid(column=0, row=13, sticky=tk.W)
      start_date.bind('<FocusIn>', self._focus_in)
      start_date.bind('<Button-1>', self._date_entry_clicked)
      start_date.bind('<<DateEntrySelected>>', self._date_entry_changed)
      ttk.Entry(prompt_area, textvariable=self.deployment_start_time, width=7, validate='all', validatecommand=(prompt_area.register(partial(validate_time, self.deployment_start_time)), '%d', '%P')).grid(column=1, row=13, sticky=tk.W)
      end_date = DateEntry(prompt_area, textvariable=self.deployment_end_date, selectmode='day', firstweekday='sunday', showweeknumbers=False, date_pattern='yyyy-mm-dd')
      end_date.grid(column=3, row=13, sticky=tk.W)
      end_date.bind('<FocusIn>', self._focus_in)
      end_date.bind('<Button-1>', self._date_entry_clicked)
      end_date.bind('<<DateEntrySelected>>', partial(self._deployment_end_changed, None, 0)) 
      ttk.Entry(prompt_area, textvariable=self.deployment_end_time, width=7, validate='all', validatecommand=(prompt_area.register(partial(self._deployment_end_changed, self.deployment_end_time)), '%d', '%P')).grid(column=4, row=13, sticky=tk.W)
      ttk.Checkbutton(prompt_area, text='Set RTC to Start Date/Time upon Magnetic Activation', variable=self.set_rtc_at_magnet_detect).grid(column=0, row=14, columnspan=5, pady=(10,0), sticky=tk.W+tk.N+tk.S)
      ttk.Checkbutton(prompt_area, text='Split Deployment into Phases', variable=self.deployment_is_split, command=self._change_deployment_split).grid(column=0, row=15, columnspan=5, pady=(5,10), sticky=tk.W+tk.N+tk.S)
      ttk.Label(prompt_area, text='VHF Beacon Activation Mode: ').grid(column=0, row=16, columnspan=2, pady=(0,7), sticky=tk.W+tk.E+tk.N+tk.S)
      vhf_selector = ttk.Combobox(prompt_area, textvariable=self.vhf_mode, width=10, values=list(VALID_VHF_MODES.keys()), state=['readonly'])
      vhf_selector.grid(column=2, row=16, columnspan=3, pady=(0,7), sticky=tk.W+tk.E+tk.N+tk.S)
      vhf_selector.bind('<<ComboboxSelected>>', self._change_vhf_enabled)
      field1 = ttk.Label(prompt_area, text='VHF Date')
      field1.grid(column=3, row=17, columnspan=1, sticky=tk.W)
      field2 = ttk.Label(prompt_area, text='VHF Time')
      field2.grid(column=4, row=17, columnspan=1, sticky=tk.W)
      field3 = ttk.Label(prompt_area, text='Enable: ')
      field3.grid(column=2, row=18, columnspan=1, sticky=tk.W)
      field4 = DateEntry(prompt_area, textvariable=self.vhf_start_date, selectmode='day', firstweekday='sunday', showweeknumbers=False, date_pattern='yyyy-mm-dd')
      field4.grid(column=3, row=18, columnspan=1, sticky=tk.W)
      field4.bind('<FocusIn>', self._focus_in)
      field4.bind('<Button-1>', self._date_entry_clicked)
      field4.bind('<<DateEntrySelected>>', self._date_entry_changed)
      field5 = ttk.Entry(prompt_area, textvariable=self.vhf_start_time, width=7, validate='all', validatecommand=(prompt_area.register(partial(validate_time, self.vhf_start_time)), '%d', '%P'))
      field5.grid(column=4, row=18, columnspan=1, sticky=tk.W)
      self.vhf_fields = [field1, field2, field3, field4, field5]
      self._change_vhf_enabled()

   def _update_deployment_phases(self):
      self.phases = []
      self._clear_canvas()
      prompt_area = ttk.Frame(self.canvas)
      prompt_area.place(relx=0.5, anchor=tk.N)
      ttk.Label(prompt_area, text='Deployment Phase Scheduling', font=('Helvetica', '14', 'bold')).grid(column=0, row=0, columnspan=5, pady=(20,10), sticky=tk.N+tk.S)
      def remove_phase(self, phase):
         phase.destroy()
         del self.deployment_phases[self.phases.index(phase)]
         del self.deployment_phase_times[self.phases.index(phase)]
         self.phases.remove(phase)
         for idx in range(len(self.phases)):
            self.phases[idx].grid(row=5+idx, column=0, columnspan=5, sticky=tk.W+tk.E)
         if len(self.phases) == 0:
            self.update_audio_button.configure(state=['disabled'])
            self.update_imu_button.configure(state=['disabled'])
         else:
            self.selected_phase.set(self.deployment_phases[0].name.get())
      def add_phase(self, phase_times=None):
         phase = ttk.Frame(prompt_area)
         phase.grid(row=5+len(self.phases), column=0, columnspan=5, sticky=tk.W+tk.E)
         if phase_times is not None:
            period_name, period_date_start, period_date_end, period_time_start, period_time_end = phase_times
         else:
            period_name = tk.StringVar(self.master, 'Phase {}'.format(len(self.phases)+1))
            period_date_start = tk.StringVar(self.master, datetime.today().strftime('%Y-%m-%d'))
            period_date_end = tk.StringVar(self.master, datetime.today().strftime('%Y-%m-%d'))
            period_time_start = tk.StringVar(self.master, '00:00')
            period_time_end = tk.StringVar(self.master, '00:00')
            self.deployment_phase_times.append((period_name, period_date_start, period_date_end, period_time_start, period_time_end))
            self.deployment_phases.append(SchedulePhase(self.master, period_name))
            self.selected_phase.set(self.deployment_phases[0].name.get())
         period_name.trace_add('write', lambda _name, _idx, _mode: self.selected_phase.set(self.deployment_phases[0].name.get()))
         row = ttk.Frame(phase)
         row.grid(row=0, column=0, pady=10, columnspan=5, sticky=tk.W+tk.E+tk.N+tk.S)
         ttk.Separator(row, orient='horizontal').pack(fill=tk.X, expand=True)
         row = ttk.Frame(phase)
         row.grid(row=1, column=0, columnspan=5, sticky=tk.W+tk.E+tk.N+tk.S)
         ttk.Label(row, text='Phase Name: ').pack(side=tk.LEFT, expand=False)
         ttk.Button(row, text='Remove', command=partial(remove_phase, self, phase)).pack(side=tk.RIGHT, expand=False)
         ttk.Label(row, text='  ').pack(side=tk.RIGHT, expand=False)
         ttk.Entry(row, textvariable=period_name).pack(side=tk.LEFT, expand=True)
         row = ttk.Frame(phase)
         row.grid(row=2, column=0, columnspan=5, sticky=tk.W+tk.E)
         ttk.Label(row, text='Start Date:').pack(side=tk.LEFT, expand=False)
         start_date = DateEntry(row, textvariable=period_date_start, selectmode='day', firstweekday='sunday', showweeknumbers=False, date_pattern='yyyy-mm-dd', mindate=datetime.strptime(self.deployment_start_date.get(), '%Y-%m-%d'), maxdate=datetime.strptime(self.deployment_end_date.get(), '%Y-%m-%d'))
         start_date.pack(side=tk.LEFT, fill=tk.X, expand=True)
         start_date.bind('<FocusIn>', self._focus_in)
         start_date.bind('<Button-1>', self._date_entry_clicked)
         start_date.bind('<<DateEntrySelected>>', self._date_entry_changed)
         ttk.Label(row, text=' End Date:').pack(side=tk.LEFT, expand=False)
         end_date = DateEntry(row, textvariable=period_date_end, selectmode='day', firstweekday='sunday', showweeknumbers=False, date_pattern='yyyy-mm-dd', mindate=datetime.strptime(self.deployment_start_date.get(), '%Y-%m-%d'), maxdate=datetime.strptime(self.deployment_end_date.get(), '%Y-%m-%d'))
         end_date.pack(side=tk.LEFT, fill=tk.X, expand=True)
         end_date.bind('<FocusIn>', self._focus_in)
         end_date.bind('<Button-1>', self._date_entry_clicked)
         end_date.bind('<<DateEntrySelected>>', self._date_entry_changed)
         row = ttk.Frame(phase)
         row.grid(row=3, column=0, columnspan=5, sticky=tk.W+tk.E)
         ttk.Label(row, text='Start Time:').pack(side=tk.LEFT, expand=False)
         ttk.Entry(row, textvariable=period_time_start, width=5, validate='all', validatecommand=(row.register(partial(validate_time, period_time_start)), '%d', '%P')).pack(side=tk.LEFT, fill=tk.X, expand=True)
         ttk.Label(row, text=' End Time:').pack(side=tk.LEFT, expand=False)
         ttk.Entry(row, textvariable=period_time_end, width=5, validate='all', validatecommand=(row.register(partial(validate_time, period_time_end)), '%d', '%P')).pack(side=tk.LEFT, fill=tk.X, expand=True)
         self.phases.append(phase)
         self.update_audio_button.configure(state=['enabled'])
         self.update_imu_button.configure(state=['enabled'])
      field1 = ttk.Label(prompt_area, text='Phase Schedule:')
      field1.grid(column=0, row=1, columnspan=4, sticky=tk.W+tk.E+tk.N+tk.S)
      field2 = ttk.Button(prompt_area, text='Add', command=partial(add_phase, self))
      field2.grid(column=4, row=1, sticky=tk.E)
      for phase_times in self.deployment_phase_times:
         add_phase(self, phase_times)

   def _update_audio_details(self):
      self._clear_canvas()
      prompt_area = ttk.Frame(self.canvas)
      prompt_area.place(relx=0.5, anchor=tk.N)
      phase = [phase for phase in self.deployment_phases if self.selected_phase.get() == phase.name.get()][0]
      ttk.Label(prompt_area, text='Audio Recording Details', font=('Helvetica', '14', 'bold')).grid(column=0, row=0, columnspan=5, pady=(20,20), sticky=tk.N+tk.S)
      if self.deployment_is_split.get():
         ttk.Label(prompt_area, text='For Deployment Phase:  ').grid(column=0, row=1, columnspan=2, sticky=tk.W+tk.E+tk.N+tk.S)
         phase_selector = ttk.Combobox(prompt_area, textvariable=self.selected_phase, width=10, values=[phase.name.get() for phase in self.deployment_phases], state=['readonly'])
         phase_selector.grid(column=2, row=1, columnspan=3, sticky=tk.W+tk.E+tk.N+tk.S)
         phase_selector.bind('<<ComboboxSelected>>', partial(self._deployment_phase_changed, 'audio'))
         ttk.Separator(prompt_area, orient='horizontal').grid(column=0, row=2, pady=20, columnspan=5, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Label(prompt_area, text='Sampling Rate (Hz):   ').grid(column=0, row=3, columnspan=2, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Entry(prompt_area, textvariable=phase.audio_sampling_rate, validate='all', validatecommand=(prompt_area.register(partial(validate_number, phase.audio_sampling_rate, 8000, 96000)), '%d', '%P')).grid(column=2, row=3, columnspan=3, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Label(prompt_area, text='Audio Clip Length (s):   ').grid(column=0, row=4, columnspan=2, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Entry(prompt_area, textvariable=phase.audio_clip_length, validate='all', validatecommand=(prompt_area.register(partial(validate_number, phase.audio_clip_length, 1, 3600)), '%d', '%P')).grid(column=2, row=4, columnspan=3, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Checkbutton(prompt_area, text='Extend Clip if Continuous Audio Detected', variable=phase.extend_clip_if_continuous_audio).grid(column=0, row=5, columnspan=5, pady=(10,0), sticky=tk.W+tk.N+tk.S)
      ttk.Separator(prompt_area, orient='horizontal').grid(column=0, row=6, pady=20, columnspan=5, sticky=tk.W+tk.E+tk.N+tk.S)
      def show_threshold_options(self):
         for field in self.audio_detail_fields:
            field.destroy()
         field1 = ttk.Label(prompt_area, text='Threshold Trigger Level (dB):   ')
         field1.grid(column=0, row=9, columnspan=2, sticky=tk.W+tk.E+tk.N+tk.S)
         field2 = ttk.Entry(prompt_area, textvariable=phase.audio_trigger_threshold)
         field2.grid(column=2, row=9, columnspan=3, sticky=tk.W+tk.E+tk.N+tk.S)
         field3 = ttk.Label(prompt_area, text='Max Number of Audio Clips:   ')
         field3.grid(column=0, row=10, columnspan=2, sticky=tk.W+tk.E+tk.N+tk.S)
         field4 = ttk.Entry(prompt_area, textvariable=phase.max_audio_clips, width=5, validate='all', validatecommand=(prompt_area.register(partial(validate_number, phase.max_audio_clips, 0, 100000)), '%d', '%P'))
         field4.grid(column=2, row=10, columnspan=1, sticky=tk.W+tk.E+tk.N+tk.S)
         field5 = ttk.Label(prompt_area, text=' per ')
         field5.grid(column=3, row=10, columnspan=1, sticky=tk.W+tk.E+tk.N+tk.S)
         field6 = ttk.Combobox(prompt_area, textvariable=phase.max_clips_time_scale, width=7, values=list(VALID_TIME_SCALES.keys()), state=['readonly'])
         field6.grid(column=4, row=10, columnspan=1, sticky=tk.W+tk.E+tk.N+tk.S)
         self.audio_detail_fields = [field1, field2, field3, field4, field5, field6]
      def show_interval_options(self):
         for field in self.audio_detail_fields:
            field.destroy()
         field1 = ttk.Label(prompt_area, text='Record New Clip Every:   ')
         field1.grid(column=0, row=11, columnspan=3, sticky=tk.W+tk.E+tk.N+tk.S)
         field2 = ttk.Entry(prompt_area, textvariable=phase.audio_trigger_interval, width=5, validate='all', validatecommand=(prompt_area.register(partial(validate_number, phase.audio_trigger_interval, 1, 60)), '%d', '%P'))
         field2.grid(column=2, row=11, columnspan=3, sticky=tk.W+tk.N+tk.S)
         field3 = ttk.Combobox(prompt_area, textvariable=phase.audio_trigger_interval_time_scale, width=7, values=list(VALID_TIME_SCALES.keys()), state=['readonly'])
         field3.grid(column=3, row=11, columnspan=3, sticky=tk.W+tk.E+tk.N+tk.S)
         self.audio_detail_fields = [field1, field2, field3]
      def show_schedule_options(self):
         for field in self.audio_detail_fields:
            field.destroy()
         self.periods = []
         def remove_period(self, row):
            row.destroy()
            del phase.audio_trigger_times[self.periods.index(row)]
            self.periods.remove(row)
            for idx in range(len(self.periods)):
               self.periods[idx].grid(row=13+idx, column=0, columnspan=5, sticky=tk.W+tk.E)
         def add_period(self, trigger_times=None):
            if len(self.periods) < MAX_AUDIO_TRIGGER_TIMES:
               row = ttk.Frame(prompt_area)
               if trigger_times is not None:
                  period_start, period_end = trigger_times
               else:
                  period_start, period_end = tk.StringVar(self.master, '00:00'), tk.StringVar(self.master, '00:00')
                  phase.audio_trigger_times.append((period_start, period_end))
               row.grid(row=13+len(self.periods), column=0, columnspan=5, sticky=tk.W+tk.E)
               ttk.Label(row, text='Start Time:').pack(side=tk.LEFT, expand=False)
               ttk.Entry(row, textvariable=period_start, width=5, validate='all', validatecommand=(row.register(partial(validate_time, period_start)), '%d', '%P')).pack(side=tk.LEFT, fill=tk.X, expand=True)
               ttk.Label(row, text=' End Time:').pack(side=tk.LEFT, expand=False)
               ttk.Entry(row, textvariable=period_end, width=5, validate='all', validatecommand=(row.register(partial(validate_time, period_end)), '%d', '%P')).pack(side=tk.LEFT, fill=tk.X, expand=True)
               ttk.Label(row, text='  ').pack(side=tk.LEFT, expand=False)
               ttk.Button(row, text='Remove', command=partial(remove_period, self, row)).pack(side=tk.LEFT, expand=False)
               self.audio_detail_fields.append(row)
               self.periods.append(row)
         field1 = ttk.Label(prompt_area, text='Active Listening Periods:')
         field1.grid(column=0, row=12, columnspan=4, sticky=tk.W+tk.E+tk.N+tk.S)
         field2 = ttk.Button(prompt_area, text='Add', command=partial(add_period, self))
         field2.grid(column=4, row=12, sticky=tk.E)
         self.audio_detail_fields = [field1, field2]
         for trigger_times in phase.audio_trigger_times:
            add_period(self, trigger_times)
      def audio_mode_changed(self, event):
         if phase.audio_recording_mode.get() == 'Threshold-Based':
            show_threshold_options(self)
         elif phase.audio_recording_mode.get() == 'Schedule-Based':
            show_schedule_options(self)
         elif phase.audio_recording_mode.get() == 'Interval-Based':
            show_interval_options(self)
         else:
            for field in self.audio_detail_fields:
               field.destroy()
      ttk.Label(prompt_area, text='Audio Recording Mode:   ').grid(column=0, row=7, columnspan=2, pady=(0,10), sticky=tk.W+tk.E+tk.N+tk.S)
      mode_selector = ttk.Combobox(prompt_area, textvariable=phase.audio_recording_mode, width=18, values=list(VALID_AUDIO_MODES.keys()), state=['readonly'])
      mode_selector.grid(column=2, row=7, columnspan=3, pady=(0,10), sticky=tk.W+tk.E+tk.N+tk.S)
      mode_selector.bind('<<ComboboxSelected>>', partial(audio_mode_changed, self))
      audio_mode_changed(self, None)

   def _update_imu_details(self):
      self._clear_canvas()
      prompt_area = ttk.Frame(self.canvas)
      prompt_area.place(relx=0.5, anchor=tk.N)
      phase = [phase for phase in self.deployment_phases if self.selected_phase.get() == phase.name.get()][0]
      ttk.Label(prompt_area, text='IMU Recording Details', font=('Helvetica', '14', 'bold')).grid(column=0, row=0, columnspan=6, pady=(20,20), sticky=tk.N+tk.S)
      if self.deployment_is_split.get():
         ttk.Label(prompt_area, text='For Deployment Phase:  ').grid(column=0, row=1, columnspan=3, sticky=tk.E+tk.N+tk.S)
         phase_selector = ttk.Combobox(prompt_area, textvariable=self.selected_phase, width=10, values=[phase.name.get() for phase in self.deployment_phases], state=['readonly'])
         phase_selector.grid(column=3, row=1, columnspan=3, sticky=tk.W+tk.E+tk.N+tk.S)
         phase_selector.bind('<<ComboboxSelected>>', partial(self._deployment_phase_changed, 'imu'))
         ttk.Separator(prompt_area, orient='horizontal').grid(column=0, row=2, pady=20, columnspan=6, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Label(prompt_area, text='Degrees of Freedom:   ').grid(column=0, row=3, columnspan=3, sticky=tk.E+tk.N+tk.S)
      ttk.Combobox(prompt_area, textvariable=phase.imu_degrees_of_freedom, width=10, values=VALID_DOFS, state=['readonly']).grid(column=3, row=3, columnspan=2, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Label(prompt_area, text='Sampling Rate (Hz):   ').grid(column=0, row=4, columnspan=3, sticky=tk.E+tk.N+tk.S)
      ttk.Combobox(prompt_area, textvariable=phase.imu_sampling_rate, width=10, values=VALID_IMU_SAMPLE_RATES, state=['readonly']).grid(column=3, row=4, columnspan=2, sticky=tk.W+tk.E+tk.N+tk.S)
      ttk.Label(prompt_area, text='Recording Mode:   ').grid(column=0, row=5, columnspan=3, sticky=tk.E+tk.N+tk.S)
      mode_selector = ttk.Combobox(prompt_area, textvariable=phase.imu_recording_mode, width=10, values=list(VALID_IMU_MODES.keys()), state=['readonly'])
      mode_selector.grid(column=3, row=5, columnspan=2, sticky=tk.W+tk.E+tk.N+tk.S)
      mode_selector.bind('<<ComboboxSelected>>', partial(self._imu_mode_changed, phase))
      field1 = ttk.Label(prompt_area, text='Motion Trigger Threshold (mg):   ')
      field1.grid(column=0, row=6, columnspan=3, sticky=tk.E+tk.N+tk.S)
      field2 = ttk.Entry(prompt_area, textvariable=phase.imu_trigger_threshold)
      field2.grid(column=3, row=6, columnspan=2, sticky=tk.W+tk.E+tk.N+tk.S)
      self.imu_motion_fields = [field1, field2]
      self._imu_mode_changed(phase)

   def _read_deployment_statistics(self):
      self._clear_canvas()
      print('TODO')

   def _configure(self):
      self._clear_canvas()
      try:
         error = validate_details(self)
         if error:
            tk.Label(self.canvas, text='Fix configuration errors and try again').pack(fill=tk.BOTH, expand=True)
            tk.messagebox.showerror('A3EM Error', error)
         else:
            file_path = os.path.join(self.save_directory.get(), LAST_TIMESTAMP_FILE_NAME)
            if os.path.exists(file_path):
               os.remove(file_path)
            file_path = os.path.join(self.save_directory.get(), ACTIVATION_FILE_NAME)
            if os.path.exists(file_path):
               os.remove(file_path)
            write_config(self, CONFIG_FILE_NAME)
            tk.Label(self.canvas, text='Successfully stored configuration to device!').pack(fill=tk.BOTH, expand=True)
      except:
         tk.Label(self.canvas, text='Unable to store the configuration file').pack(fill=tk.BOTH, expand=True)
         tk.messagebox.showerror('A3EM Error', 'ERROR\n\nUnable to write configuration file to {}'.format(self.save_directory.get()))


# TOP-LEVEL FUNCTIONALITY ---------------------------------------------------------------------------------------------

def main():
   gui = A3EMGui()
   gui.mainloop()

if __name__ == '__main__':
   main()
