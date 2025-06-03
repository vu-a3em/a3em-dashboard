#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from datetime import datetime, timedelta
from pathlib import Path
import glob, os, sys

def relabel_audio_files(audio_dir, offset_in_seconds, original_timestamp=None):

   # Get a recursive list of all audio files in the specified directory
   audio_files = glob.glob(os.path.join(audio_dir, '**', '*.wav'), recursive=True)
   renamed_dirs = set()

   # Loop through each audio file and rename it
   for audio_file in audio_files:

      # Get the current timestamp from the filename
      audio_path = Path(audio_file)
      timestamp_str = audio_path.stem
      timestamp = datetime.strptime(timestamp_str, '%Y-%m-%d %H-%M-%S')

      # Add the specified offset to the timestamp and create the updated directory pieces
      new_timestamp = timestamp + timedelta(seconds=offset_in_seconds)
      date_string = new_timestamp.strftime('%Y-%m-%d_renamed')
      hour_bin_string = str(int(new_timestamp.strftime('%H')) // 4 * 4).zfill(2)
      timestamp_string = new_timestamp.strftime('%Y-%m-%d %H-%M-%S.wav')

      # Create a new filename from the individual pieces
      renamed_dirs.add(audio_path.parent.parent.parent.joinpath(date_string))
      new_filename = audio_path.parent.parent.parent.joinpath(date_string, hour_bin_string, timestamp_string)

      # Rename the file
      os.renames(audio_file, new_filename)

   # Loop through the renamed directories and put them back into their original structure
   for renamed_dir in renamed_dirs:

      # Move any remaining non-audio files into the renamed directory
      original_dir = renamed_dir.parent.joinpath(renamed_dir.stem.replace('_renamed', ''))
      if original_dir.exists():
         for item in original_dir.iterdir():
            item.replace(renamed_dir.joinpath(item.name))
         original_dir.rmdir()

      # Replace the directory to remove the '_renamed' suffix
      renamed_dir.replace(original_dir)

   # Store the original timestamp if provided
   if original_timestamp is not None:
      with open(os.path.join(audio_dir, 'orig_first_log_time.txt'), 'w') as f:
         f.write(str(original_timestamp))


if __name__ == '__main__':

   # Ensure that proper inputs are passed to this script
   if len(sys.argv) != 3:
      print('Usage: {} <AUDIO_DIR> <OFFSET_IN_SECONDS>'.format(sys.argv[0]))
      sys.exit(1)

   # Run the actual relabeling function
   relabel_audio_files(Path(sys.argv[1]).resolve(), int(sys.argv[2]))
