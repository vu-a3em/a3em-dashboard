#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# PYTHON INCLUSIONS ---------------------------------------------------------------------------------------------------

from collections import defaultdict
import json, struct, time
import pandas as pd


# PANDAS DISPLAY OPTIONS ----------------------------------------------------------------------------------------------

pd.options.plotting.backend = 'plotly'
pd.options.display.float_format = '{:.2f}'.format
pd.set_option('display.max_rows', None)


# PROCESSING FUNCTIONS ------------------------------------------------------------------------------------------------

def get_imu_data(imu_data_path):
	imu_data = defaultdict(dict)
	with open(imu_data_path, 'rb') as file:
		i = 8
		data = file.read()
		sample_rate = struct.unpack('<I', data[0:4])[0]
		timestamp = float(struct.unpack('<I', data[4:8])[0])
		delta_time_s = 1.0 / float(sample_rate)
		while i + 12 <= len(data):
			imu_data[timestamp]['x'] = struct.unpack('f', data[i:i+4])[0]
			imu_data[timestamp]['y'] = struct.unpack('f', data[i+4:i+8])[0]
			imu_data[timestamp]['z'] = struct.unpack('f', data[i+8:i+12])[0]
			timestamp += delta_time_s
			i += 12
	imu_data = [dict({'t': ts}, **datum) for ts, datum in imu_data.items()]
	imu_data = pd.json_normalize(data=imu_data).groupby('t').first()
	imu_data.plot(title='IMU Data Time Series', template='simple_white', labels=dict(t='Timestamp', value='Acceleration (in mgs)', variable='Axis')).show()
	return imu_data

def get_voltage_time_series(log_file_path):
	details = defaultdict(dict)
	with open(log_file_path, 'r') as file:
		in_details = False
		timestamp = 0
		voltage = 0
		for line in file:
			if 'Current Device Details' in line:
				in_details = True
			elif in_details and 'UTC Timestamp' in line:
				timestamp = int(line.split(':')[1].strip())
			elif in_details and 'Voltage' in line:
				voltage = int(line.split(':')[1].strip())
			if in_details and timestamp > 0 and voltage > 0:
				details[timestamp]['voltage'] = voltage
				timestamp = voltage = 0
				in_details = False
	details = [dict({'t': ts}, **datum) for ts, datum in details.items()]
	details = pd.json_normalize(data=details).groupby('t').first()
	return details

def get_temperature_time_series(log_file_path):
	details = defaultdict(dict)
	with open(log_file_path, 'r') as file:
		in_details = False
		timestamp = 0
		temperature = 0.0
		for line in file:
			if 'Current Device Details' in line:
				in_details = True
			elif in_details and 'UTC Timestamp' in line:
				timestamp = int(line.split(':')[1].strip())
			elif in_details and 'Temperature' in line:
				temperature = float(line.split(':')[1].strip())
			if in_details and timestamp > 0 and temperature > 0:
				details[timestamp]['temp'] = temperature
				timestamp = 0
				temperature = 0.0
				in_details = False
	details = [dict({'t': ts}, **datum) for ts, datum in details.items()]
	details = pd.json_normalize(data=details).groupby('t').first()
	return details

def get_voltage_vs_temperature(log_file_path):
	details = defaultdict(dict)
	with open(log_file_path, 'r') as file:
		in_details = False
		timestamp = 0
		voltage = 0
		temperature = 0.0
		for line in file:
			if 'Current Device Details' in line:
				in_details = True
			elif in_details and 'UTC Timestamp' in line:
				timestamp = int(line.split(':')[1].strip())
			elif in_details and 'Voltage' in line:
				voltage = int(line.split(':')[1].strip())
			elif in_details and 'Temperature' in line:
				temperature = float(line.split(':')[1].strip())
			if in_details and timestamp > 0 and voltage > 0 and temperature > 0:
				details[timestamp]['voltage'] = voltage
				details[timestamp]['temp'] = temperature
				timestamp = voltage = 0
				temperature = 0.0
				in_details = False
	details = [dict({'t': ts}, **datum) for ts, datum in details.items()]
	details = pd.json_normalize(data=details).groupby('t').first()
	return details

def get_gps_time_series(log_file_path):
	details = defaultdict(dict)
	with open(log_file_path, 'r') as file:
		in_details = False
		location = None
		timestamp = 0
		for line in file:
			if 'Current Device Details' in line:
				in_details = True
			elif in_details and 'UTC Timestamp' in line:
				timestamp = int(line.split(':')[1].strip())
			elif in_details and 'Location' in line:
				location = line.split(':')[1].strip()
			if in_details and timestamp > 0 and location is not None:
				loc = json.loads(location)
				details[timestamp]['lat'] = loc[0]
				details[timestamp]['lon'] = loc[1]
				details[timestamp]['ht'] = loc[2]
				timestamp = 0
				location = None
				in_details = False
	details = [dict({'t': ts}, **datum) for ts, datum in details.items()]
	details = pd.json_normalize(data=details).groupby('t').first()
	return details

def get_deployment_statistics(log_file_path):
	pass
