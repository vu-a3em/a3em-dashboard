#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# PYTHON INCLUSIONS ---------------------------------------------------------------------------------------------------

import os, psutil, re, sys

CONFIG_FILE_NAME = '_a3em.cfg'

format_complete = False
def format_callback(command, modifier, arg):
   global format_complete
   format_complete = command == 11
   return 1

def sd_card_check_formatting(device, passwd):
   if os.name == 'nt':
      from ctypes import windll, pointer, c_ulonglong, c_wchar_p
      sectorsPerCluster, bytesPerSector = c_ulonglong(0), c_ulonglong(0)
      windll.kernel32.GetDiskFreeSpaceW(c_wchar_p(device), pointer(sectorsPerCluster), pointer(bytesPerSector), None, None)
      return bytesPerSector.value * sectorsPerCluster.value == 4096
   elif sys.platform == 'darwin':
      device = re.match(r'.*disk[0-9]+', device)[0]
      os.system(f'diskutil unmountDisk {device}')
      valid = os.system(f'/bin/sh -c "[ $(echo {passwd} | sudo -S newfs_exfat -N {device} | grep cluster | cut -f 2 -d :) -eq 4096 ]"') == 0
      os.system(f'diskutil mountDisk {device}')
      return valid
   else:
      os.system(f'/bin/sh -c "if ! dpkg -s exfatprogs >/dev/null 2>&1 && ! echo {passwd} | sudo -S apt -y install exfatprogs >/dev/null 2>&1; then if ! dpkg -s exfat-fuse >/dev/null 2>&1 || ! dpkg -s exfat-utils >/dev/null 2>&1; then echo {passwd} | sudo -S apt -y install exfat-fuse exfat-utils >/dev/null 2>&1; fi; fi"')
      return os.system(f'/bin/sh -c "[ $(echo {passwd} | sudo -S fsck.exfat -n -v {device} | grep cluster | cut -f 2 -d \":\" | cut -f 2 -d \" \") = \"4.00\" ]"') == 0

def format_sd_card_as_exfat(mountpoint, device, passwd):
   if os.name == 'nt':
      from ctypes import windll, WINFUNCTYPE, pointer, c_int, c_ulonglong, c_void_p, c_wchar_p
      global format_complete
      format_complete = False
      fm = windll.LoadLibrary('fmifs.dll')
      FMT_CB_FUNC = WINFUNCTYPE(c_int, c_int, c_int, c_void_p)
      while not format_complete:
         fm.FormatEx(c_wchar_p(device), 0, c_wchar_p('EXFAT'), c_wchar_p('A3EM'), True, c_int(4096), FMT_CB_FUNC(format_callback))
         while not format_complete:
            sleep(0.1)
         format_complete = sd_card_check_formatting(device, passwd)
   elif sys.platform == 'darwin':
      device = re.match(r'.*disk[0-9]+', device)[0]
      os.system(f'diskutil unmountDisk {device}')
      os.system(f'echo {passwd} | sudo -S newfs_exfat -b 4096 -v A3EM {device}')
      os.system(f'diskutil mountDisk {device}')
   else:
      os.system(f'/bin/sh -c "if ! dpkg -s exfatprogs >/dev/null 2>&1 && ! echo {passwd} | sudo -S apt -y install exfatprogs >/dev/null 2>&1; then if ! dpkg -s exfat-fuse >/dev/null 2>&1 || ! dpkg -s exfat-utils >/dev/null 2>&1; then echo {passwd} | sudo -S apt -y install exfat-fuse exfat-utils >/dev/null 2>&1; fi; fi"')
      os.system(f'echo {passwd} | sudo -S umount {device}')
      os.system(f'echo {passwd} | sudo -S mkfs -t exfat -c 4096 -L A3EM {device}')
      os.system(f'echo {passwd} | sudo -S fsck.exfat {device}')


if __name__ == '__main__':
   target_device_mapping = [ (partition.mountpoint, partition.device, partition.fstype.lower())
                             for partition in psutil.disk_partitions()
                             if partition.fstype.lower() in ['fat', 'msdos', 'exfat'] ]
   if target_device_mapping[0][2] != 'exfat' or (not os.path.exists(os.path.join(target_device_mapping[0][0], CONFIG_FILE_NAME)) and not sd_card_check_formatting(target_device_mapping[0][1], 'freebsd')):
      format_sd_card_as_exfat(target_device_mapping[0][0], target_device_mapping[0][1], 'freebsd')
   else:
      print('good')
