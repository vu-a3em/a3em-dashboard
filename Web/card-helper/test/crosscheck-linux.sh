#!/bin/sh
# Checks this helper's own filesystem check and repairs against fsck.exfat (exfatprogs), on
# exFAT volumes Linux itself made and wrote. Loop devices only, as root; A3EM_HELPER_VIRTUAL_ONLY
# hides real devices.
#
#   sudo test/crosscheck-linux.sh <path to a3em-card-helper>
set -u
HELPER=$(realpath "$1")
HERE=$(dirname "$(realpath "$0")")
WORK=$(mktemp -d)
export A3EM_HELPER_VIRTUAL_ONLY=1 A3EM_HELPER_STATE_DIR="$WORK/state"
cd "$WORK"
LOOP=""
cleanup() { umount "$WORK/mnt" 2>/dev/null; [ -n "$LOOP" ] && losetup -d "$LOOP"; rm -rf "$WORK"; }
trap cleanup EXIT
attach() { LOOP=$(losetup -f --show -P card.img); ID=$(basename "$LOOP"); VOL=${ID}p1; sleep 1; }
detach() { losetup -d "$LOOP"; LOOP=""; }
ours() { "$HELPER" call '{"op":"diagnose","volume":"'"$VOL"'"}' 2>/dev/null | python3 -c '
import json,sys; r=json.load(sys.stdin)
if not r.get("ok"): print("  ours: failed:", r["error"]); sys.exit(0)
r=r["report"]; print("  ours:", "clean" if r["clean"] else "; ".join(f["kind"]+("("+",".join(f.get("paths",[])[:2])+")" if f.get("paths") else "") for f in r["findings"]), "| fixable here" if r.get("fixableHere") else "", "|", r.get("files"), "files,", r.get("directories"), "folders")'; }
system() { code=0; fsck.exfat -n "/dev/$VOL" >out 2>&1 || code=$?; echo "  fsck.exfat: exit $code, $(grep -vE '^exfatprogs' out | tr '\n' ' ' | cut -c1-160)"; }
repair() {
  TOKEN=$("$HELPER" call '{"op":"challenge","device":"'"$ID"'","operation":"repair"}' 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
  "$HELPER" call '{"op":"repair","device":"'"$ID"'","volume":"'"$VOL"'","grant":"'"$TOKEN"'"}' 2>/dev/null | python3 -c '
import json,sys; r=json.load(sys.stdin)
if not r.get("ok"): print("  repair failed:", r["error"]); sys.exit(0)
r=r["report"]; print("  repair:", r["engine"], "repaired", r.get("repaired"), "| now", "clean" if r["clean"] else "not clean", "| saved", len(r.get("saved") or []))'
}
contents() { (cd "$WORK/mnt" && find . -type f -exec md5sum {} \; | sort -k2); }
SYSTEM_SEES_LOST=0
# What each case must show. The system's checker must see every damage but one: exfatprogs does
# not report space marked in use that nothing uses (SYSTEM_SEES_LOST=0).
FAILED=0
want() { case "$2" in *"$3"*) ;; *) echo "  ✕ $1: expected \"$3\""; FAILED=$((FAILED + 1)) ;; esac; }
refuse() { case "$2" in *"$3"*) echo "  ✕ $1: did not expect \"$3\""; FAILED=$((FAILED + 1)) ;; esac; }
judge() { # case, ours, the system's before, repair, the system's after
  case "$1" in
    free*) want "$1" "$2" "bitmap-free(big.bin)"; want "$1" "$2" "fixable here"; want "$1" "$4" "a3em repaired ['bitmap']" ;;
    lost) want "$1" "$2" "bitmap-lost"; want "$1" "$2" "fixable here"; want "$1" "$4" "a3em repaired ['bitmap']" ;;
    boot) want "$1" "$2" "boot-region"; want "$1" "$2" "fixable here"; want "$1" "$4" "a3em repaired ['boot']" ;;
    crosslink*) want "$1" "$2" "cross-link"; refuse "$1" "$2" "fixable here"; want "$1" "$4" "repair: system" ;;
  esac
  want "$1" "$4" "now clean"; want "$1" "$5" "exit 0,"
  if [ "$1" != lost ] || [ "$SYSTEM_SEES_LOST" = 1 ]; then refuse "$1" "$3" "exit 0,"; fi
}

mkdir -p mnt
truncate -s 1G card.img; attach
echo 'start=4096, type=7' | sfdisk -q "$LOOP"; partx -u "$LOOP" 2>/dev/null; sleep 1
mkfs.exfat -q -L REALCARD "/dev/$VOL" >/dev/null
mount "/dev/$VOL" mnt
mkdir -p mnt/OWL_01/Activation_0001 mnt/OWL_01/Activation_0002/deep/deeper "mnt/empty folder"
for i in $(seq 1 60); do head -c $((i * 7000)) /dev/urandom > "mnt/OWL_01/Activation_0001/clip_$i.wav"; done
for i in $(seq 1 60 2); do rm -f "mnt/OWL_01/Activation_0001/clip_$i.wav"; done
head -c 3000000 /dev/urandom > "mnt/fragmented recording with a long name.wav"
head -c 2000000 /dev/urandom > mnt/big.bin; head -c 500000 /dev/urandom > mnt/small.bin
printf 'x' > mnt/OWL_01/Activation_0002/deep/deeper/tiny; : > mnt/empty.txt
printf 'é' > "mnt/Größe — 日本語.txt"; printf 'DEVICE_LABEL = REAL\n' > mnt/_conf.a3m
contents > before.txt; sync; umount mnt
echo "== written by Linux, unmounted"; o=$(ours); echo "$o"; s=$(system); echo "$s"
want "unmounted" "$o" "ours: clean"; want "unmounted" "$s" "exit 0,"
echo "  files on the card: $(wc -l < before.txt)"
detach; cp card.img pristine.img
for case in "free big.bin" lost boot "crosslink big.bin small.bin"; do
  cp pristine.img card.img
  python3 "$HERE/crosscheck.py" card.img $case >/dev/null
  attach
  echo "== $case"
  o=$(ours); echo "$o"; s1=$(system); echo "$s1"; r=$(repair); echo "$r"; s2=$(system); echo "$s2"
  judge "$case" "$o" "$s1" "$r" "$s2"
  if mount "/dev/$VOL" mnt 2>/dev/null; then contents > after.txt
    if [ "$case" = "crosslink big.bin small.bin" ]; then echo "  files after: $(wc -l < after.txt) (the system's tool decides what to do with a shared file)"
    elif cmp -s before.txt after.txt; then echo "  every file identical after the repair"; else echo "  ✕ FILES DIFFER after the repair"; diff before.txt after.txt | head -5; FAILED=$((FAILED + 1)); fi
    umount mnt
  else echo "  ✕ does not mount after the repair"; FAILED=$((FAILED + 1)); fi
  detach
done

if [ "$FAILED" -eq 0 ]; then echo "crosscheck: passed"; else echo "crosscheck: $FAILED expectations failed"; exit 1; fi
