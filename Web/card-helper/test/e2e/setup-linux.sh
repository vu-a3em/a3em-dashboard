#!/bin/sh
# Linux counterpart of setup-macos.sh: four loop devices standing in for cards, and cards.json.
# Runs as root (sudo on a desktop, or in a privileged container).
#
#   sudo test/e2e/setup-linux.sh <a3em-card-helper> <work folder>
#   sudo test/e2e/setup-linux.sh teardown <work folder>
#
# Writes only to the image files it creates and the loop devices it attached from them.
set -eu
if [ "$1" = teardown ]; then
  WORK=$2
  for id in $(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(" ".join(c[r] for r in ("old","prepared","damaged","blank","dirty") if r in c))' "$WORK/cards.json" 2>/dev/null); do
    case "$id" in loop*) ;; *) continue ;; esac
    for part in /dev/${id}p*; do [ -e "$part" ] && umount "$part" 2>/dev/null || true; done
    losetup -d "/dev/$id" 2>/dev/null && echo "detached $id"
  done
  rm -rf "$WORK"
  exit 0
fi
HELPER=$(realpath "$1")
WORK=$(realpath -m "$2")
mkdir -p "$WORK/images"; cd "$WORK"
export A3EM_HELPER_VIRTUAL_ONLY=1 A3EM_HELPER_STATE_DIR="$WORK/state"
attach() { truncate -s 1G "$1"; losetup -f --show -P "$1"; }
guard() { case "$1" in /dev/loop*) ;; *) echo "NOT A LOOP DEVICE: $1" >&2; exit 1 ;; esac; }
prepare() { # device label
  id=${1#/dev/}
  token=$("$HELPER" call '{"op":"challenge","device":"'"$id"'","operation":"prepare"}' 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
  "$HELPER" call "$(python3 -c 'import json,sys; print(json.dumps({"op":"prepare","targets":[{"device":sys.argv[1],"grant":sys.argv[2],"allocationUnitBytes":4096,"label":sys.argv[3],"config":"DEVICE_LABEL = "+sys.argv[3]+"\n"}]}))' "$id" "$token" "$2")" >/dev/null 2>&1
}
mount_of() { findmnt -no TARGET "${1}p1" | head -1; }
spoil_bitmap() { # loop device
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

OLD=$(attach old.img); guard "$OLD"
echo 'start=2048, type=7' | sfdisk -q "$OLD"; partx -u "$OLD" 2>/dev/null || true; sleep 1
mkfs.exfat -q -L OLDCARD "${OLD}p1" >/dev/null
mkdir -p /run/media/a3em/e2e-old && mount "${OLD}p1" /run/media/a3em/e2e-old
mkdir -p /run/media/a3em/e2e-old/OWL_03 && head -c 300000 /dev/urandom > /run/media/a3em/e2e-old/OWL_03/clip.wav

PREPARED=$(attach prepared.img); guard "$PREPARED"; prepare "$PREPARED" OWL_01

DAMAGED=$(attach damaged.img); guard "$DAMAGED"; prepare "$DAMAGED" OWL_07
MP=$(mount_of "$DAMAGED"); mkdir -p "$MP/OWL_07/Activation_0001"
for i in 1 2 3; do head -c 200000 /dev/urandom > "$MP/OWL_07/Activation_0001/clip_$i.wav"; done
sync; umount "${DAMAGED}p1"
# The helper's layout puts the partition at sector 4096; sector 11 of its boot region is the checksum.
dd if=/dev/zero of="$DAMAGED" bs=512 seek=4107 count=1 conv=notrunc 2>/dev/null; sync
blockdev --flushbufs "$DAMAGED" 2>/dev/null || true

BLANK=$(attach blank.img); guard "$BLANK"

DIRTY=$(attach dirty.img); guard "$DIRTY"; prepare "$DIRTY" OWL_09
MP=$(mount_of "$DIRTY"); mkdir -p "$MP/OWL_09"; head -c 400000 /dev/urandom > "$MP/OWL_09/clip.wav"
sync; umount "${DIRTY}p1"; spoil_bitmap "$DIRTY"; sync; blockdev --flushbufs "$DIRTY" 2>/dev/null || true
mkdir -p "/run/media/a3em/${DIRTY#/dev/}p1"; mount "${DIRTY}p1" "/run/media/a3em/${DIRTY#/dev/}p1"

python3 - "$WORK" "${OLD#/dev/}" "${PREPARED#/dev/}" "${DAMAGED#/dev/}" "${BLANK#/dev/}" "$(mount_of "$PREPARED")" "${DIRTY#/dev/}" "$(mount_of "$DIRTY")" <<'PY'
import json, os, sys
work, old, prepared, damaged, blank, mount, dirty, dirty_mount = sys.argv[1:]
json.dump({"old": old, "prepared": prepared, "damaged": damaged, "blank": blank, "dirty": dirty,
           "preparedLabel": "OWL_01", "preparedMount": mount, "dirtyLabel": "OWL_09", "dirtyMount": dirty_mount,
           "stateDir": os.path.join(work, "state"), "imageDir": os.path.join(work, "images")},
          open(os.path.join(work, "cards.json"), "w"), indent=2)
PY
cat "$WORK/cards.json"
