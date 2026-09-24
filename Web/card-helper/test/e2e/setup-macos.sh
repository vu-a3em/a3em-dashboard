#!/bin/sh
# Four disk images standing in for cards, for e2e.mjs, and the cards.json that names them.
#
#   test/e2e/setup-macos.sh <a3em-card-helper> <work folder>        creates them
#   test/e2e/setup-macos.sh teardown <work folder>                  detaches and deletes them
#
# The roles every platform's setup must provide, whatever its disks are:
#   old       exFAT made by the operating system, with a file on it: preparing must erase it
#   prepared  prepared by the helper, label OWL_01, mounted, at the 4 kB clusters the default
#             configuration recommends for a 1 GB card: it needs at most its settings
#   damaged   prepared by the helper as OWL_07, with files, then its boot checksum zeroed —
#             the system will not mount it, and fsck can repair it
#   blank     no partitions at all
#   dirty     prepared by the helper as OWL_09, with a recording; opens normally, but its
#             allocation bitmap marks part of the recording free, so the check finds problems and
#             a repair fixes them
#
# Writes only to the image files it creates and to the disks it attached from them, each
# checked to be a disk image first.
set -eu
if [ "$1" = teardown ]; then
  WORK=$2
  for id in $(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(" ".join(c[r] for r in ("old","prepared","damaged","blank","dirty") if r in c))' "$WORK/cards.json" 2>/dev/null); do
    diskutil info "/dev/$id" 2>/dev/null | grep -q "Protocol: *Disk Image" && hdiutil detach "/dev/$id" -force >/dev/null && echo "detached $id"
  done
  rm -rf "$WORK"
  exit 0
fi
HELPER=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
WORK=$2
mkdir -p "$WORK"; cd "$WORK"
export A3EM_HELPER_VIRTUAL_ONLY=1 A3EM_HELPER_STATE_DIR="$WORK/state"
guard() { diskutil info "$1" | grep -q "Protocol: *Disk Image" || { echo "NOT A DISK IMAGE: $1" >&2; exit 1; }; }
attach() { hdiutil attach -nomount -imagekey diskimage-class=CRawDiskImage "$1" | awk 'NR==1{print $1}'; }
prepare() { # device label
  id=${1#/dev/}
  token=$("$HELPER" call '{"op":"challenge","device":"'"$id"'","operation":"prepare"}' 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
  "$HELPER" call "$(python3 -c 'import json,sys; print(json.dumps({"op":"prepare","targets":[{"device":sys.argv[1],"grant":sys.argv[2],"allocationUnitBytes":4096,"label":sys.argv[3],"config":"DEVICE_LABEL = "+sys.argv[3]+"\n"}]}))' "$id" "$token" "$2")" >/dev/null 2>&1
}
mount_of() { diskutil info "${1}s1" | awk -F': *' '/Mount Point/{print $2}'; }
spoil_bitmap() { # image file
# Marks 80 clusters of the recording (26 to 105) free in the allocation bitmap, so the bitmap
# disagrees with the files, as on a card pulled while the recorder was writing — the kind every
# platform's fsck reports; space marked in use that nothing uses, Linux's does not. The partition
# starts at sector 4096; the boot sector gives the cluster heap's offset, and the bitmap is the
# heap's first cluster in the helper's layout.
python3 - "$1" <<'PY'
import struct, sys
path = sys.argv[1]
with open(path, "r+b") as disk:
    disk.seek(4096 * 512 + 0x58)
    heap = struct.unpack("<I", disk.read(4))[0]
    disk.seek((4096 + heap) * 512 + 3)
    disk.write(bytes(10))
PY
}

mkfile -n 1g old.img; OLD=$(attach old.img); guard "$OLD"
diskutil eraseDisk ExFAT OLDCARD MBR "$OLD" >/dev/null
mkdir -p "$(mount_of "$OLD")/OWL_03"; head -c 300000 /dev/urandom > "$(mount_of "$OLD")/OWL_03/clip.wav"

mkfile -n 1g prepared.img; PREPARED=$(attach prepared.img); guard "$PREPARED"; prepare "$PREPARED" OWL_01

mkfile -n 1g damaged.img; DAMAGED=$(attach damaged.img); guard "$DAMAGED"; prepare "$DAMAGED" OWL_07
MP=$(mount_of "$DAMAGED"); mkdir -p "$MP/OWL_07/Activation_0001"
for i in 1 2 3; do head -c 200000 /dev/urandom > "$MP/OWL_07/Activation_0001/clip_$i.wav"; done
sync; hdiutil detach "$DAMAGED" >/dev/null
# The helper's layout puts the partition at sector 4096; sector 11 of its boot region is the checksum.
dd if=/dev/zero of=damaged.img bs=512 seek=4107 count=1 conv=notrunc 2>/dev/null
DAMAGED=$(attach damaged.img); guard "$DAMAGED"; diskutil mount "${DAMAGED}s1" >/dev/null 2>&1 || true

mkfile -n 1g blank.img; BLANK=$(attach blank.img); guard "$BLANK"

mkfile -n 1g dirty.img; DIRTY=$(attach dirty.img); guard "$DIRTY"; prepare "$DIRTY" OWL_09
MP=$(mount_of "$DIRTY"); mkdir -p "$MP/OWL_09"; head -c 400000 /dev/urandom > "$MP/OWL_09/clip.wav"
# Nothing of macOS's own is to be written when it mounts the card again: into space the spoiled
# bitmap calls free, it would land on the recording, and the card would then be cross-linked,
# which only the system's repair can deal with, rather than holding the one mistake intended.
mkdir -p "$MP/.fseventsd"; touch "$MP/.fseventsd/no_log" "$MP/.metadata_never_index"
sync; hdiutil detach "$DIRTY" >/dev/null
spoil_bitmap dirty.img
DIRTY=$(attach dirty.img); guard "$DIRTY"; diskutil mount "${DIRTY}s1" >/dev/null

python3 - "$WORK/cards.json" "${OLD#/dev/}" "${PREPARED#/dev/}" "${DAMAGED#/dev/}" "${BLANK#/dev/}" "$(mount_of "$PREPARED")" "${DIRTY#/dev/}" "$(mount_of "$DIRTY")" "$WORK/images" <<'PY'
import json, sys
import os
path, old, prepared, damaged, blank, mount, dirty, dirty_mount, images = sys.argv[1:]
os.makedirs(images, exist_ok=True)
json.dump({"old": old, "prepared": prepared, "damaged": damaged, "blank": blank, "dirty": dirty,
           "preparedLabel": "OWL_01", "preparedMount": mount, "dirtyLabel": "OWL_09", "dirtyMount": dirty_mount,
           "stateDir": os.environ["A3EM_HELPER_STATE_DIR"], "imageDir": images}, open(path, "w"), indent=2)
PY
cat "$WORK/cards.json"
