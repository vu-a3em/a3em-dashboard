#!/bin/sh
# Checks this helper's own filesystem check and repairs against fsck_exfat, on exFAT volumes
# macOS itself made and wrote. Disk images only; A3EM_HELPER_VIRTUAL_ONLY hides real devices.
#
#   test/crosscheck-macos.sh <path to a3em-card-helper>
set -eu
HELPER=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
export A3EM_HELPER_VIRTUAL_ONLY=1 A3EM_HELPER_STATE_DIR="$WORK/state"
cd "$WORK"
DEV=""
cleanup() { [ -n "$DEV" ] && hdiutil detach "$DEV" -force >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
attach() {
  DEV=$(hdiutil attach -nomount -imagekey diskimage-class=CRawDiskImage card.img | awk 'NR==1{print $1}')
  diskutil info "$DEV" | grep -q "Protocol: *Disk Image" || { echo "NOT A DISK IMAGE"; exit 1; }
  ID=${DEV#/dev/}; VOL=${ID}s1
}
detach() { hdiutil detach "$DEV" -force >/dev/null; DEV=""; }
ours() { "$HELPER" call '{"op":"diagnose","volume":"'"$VOL"'"}' 2>/dev/null | python3 -c '
import json,sys; r=json.load(sys.stdin)
if not r.get("ok"): print("  ours: failed:", r["error"]); sys.exit(0)
r=r["report"]; print("  ours:", "clean" if r["clean"] else "; ".join(f["kind"]+("("+",".join(f.get("paths",[])[:2])+")" if f.get("paths") else "") for f in r["findings"]), "| fixable here" if r.get("fixableHere") else "", "|", r.get("files"), "files,", r.get("directories"), "folders")'; }
system() { code=0; fsck_exfat -n "/dev/r$VOL" >out 2>&1 || code=$?; echo "  fsck_exfat: exit $code, $(grep -E 'appears to be OK|corrupt|needs to be repaired|bitmap|Cannot|Invalid' out | tr '\n' ' ' | cut -c1-160)"; }
repair() {
  TOKEN=$("$HELPER" call '{"op":"challenge","device":"'"$ID"'","operation":"repair"}' 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
  "$HELPER" call '{"op":"repair","device":"'"$ID"'","volume":"'"$VOL"'","grant":"'"$TOKEN"'"}' 2>/dev/null | python3 -c '
import json,sys; r=json.load(sys.stdin)
if not r.get("ok"): print("  repair failed:", r["error"]); sys.exit(0)
r=r["report"]; print("  repair:", r["engine"], "repaired", r.get("repaired"), "| now", "clean" if r["clean"] else "not clean", "| saved", len(r.get("saved") or []))'
}
contents() { mp=$(diskutil info "${DEV}s1" | awk -F': *' '/Mount Point/{print $2}'); (cd "$mp" && find . -type f ! -name '.*' ! -path './.*' -exec md5 -r {} \; | sort); }

SYSTEM_SEES_LOST=1
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

mkfile -n 1g card.img; attach
diskutil eraseDisk ExFAT REALCARD MBR "$DEV" >/dev/null
MP=$(diskutil info "${DEV}s1" | awk -F': *' '/Mount Point/{print $2}')
mkdir -p "$MP/OWL_01/Activation_0001" "$MP/OWL_01/Activation_0002/deep/deeper" "$MP/empty folder"
for i in $(seq 1 60); do head -c $((i * 7000)) /dev/urandom > "$MP/OWL_01/Activation_0001/clip_$i.wav"; done
for i in $(seq 1 60 2); do rm -f "$MP/OWL_01/Activation_0001/clip_$i.wav"; done   # holes, for fragmentation
head -c 3000000 /dev/urandom > "$MP/fragmented recording with a long name.wav"
head -c 2000000 /dev/urandom > "$MP/big.bin"; head -c 500000 /dev/urandom > "$MP/small.bin"
printf 'x' > "$MP/OWL_01/Activation_0002/deep/deeper/tiny"; : > "$MP/empty.txt"
printf 'é' > "$MP/Größe — 日本語.txt"; printf 'DEVICE_LABEL = REAL\n' > "$MP/_a3em.cfg"
sync; diskutil unmount "${DEV}s1" >/dev/null
echo "== written by macOS, unmounted"; o=$(ours); echo "$o"; s=$(system); echo "$s"
want "unmounted" "$o" "ours: clean"; want "unmounted" "$s" "exit 0,"
diskutil mount "${DEV}s1" >/dev/null; contents > before.txt; diskutil unmount "${DEV}s1" >/dev/null
echo "  files on the card: $(wc -l < before.txt | tr -d ' ')"
cp card.img pristine.img 2>/dev/null || true
set +e   # from here, a tool reporting damage is the point, not a reason to stop
for case in "free big.bin" lost boot "crosslink big.bin small.bin"; do
  detach; cp pristine.img card.img
  python3 "$HERE/crosscheck.py" card.img $case >/dev/null
  attach; diskutil unmount "${DEV}s1" >/dev/null 2>&1 || true
  echo "== $case"
  o=$(ours); echo "$o"; s1=$(system); echo "$s1"; r=$(repair); echo "$r"; s2=$(system); echo "$s2"
  judge "$case" "$o" "$s1" "$r" "$s2"
  if diskutil mount "${DEV}s1" >/dev/null 2>&1; then contents > after.txt
    if [ "$case" = "crosslink big.bin small.bin" ]; then echo "  files after: $(wc -l < after.txt | tr -d ' ') (the system's tool decides what to do with a shared file)"
    elif cmp -s before.txt after.txt; then echo "  every file identical after the repair"; else echo "  ✕ FILES DIFFER after the repair"; diff before.txt after.txt | head -5; FAILED=$((FAILED + 1)); fi
    diskutil unmount "${DEV}s1" >/dev/null
  else echo "  ✕ does not mount after the repair"; FAILED=$((FAILED + 1)); fi
done

if [ "$FAILED" -eq 0 ]; then echo "crosscheck: passed"; else echo "crosscheck: $FAILED expectations failed"; exit 1; fi
