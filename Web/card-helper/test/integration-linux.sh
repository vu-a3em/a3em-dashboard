#!/bin/sh
# Prepares a loop device the way the dashboard prepares a card, and checks every result.
# Runs as root (in CI with sudo, or in a privileged container). Never touches a real device:
# A3EM_HELPER_VIRTUAL_ONLY hides every one.
#
#   test/integration-linux.sh <path to linux a3em-card-helper>
set -eu
HELPER=$(realpath "$1")
HERE=$(dirname "$(realpath "$0")")
WORK=$(mktemp -d)
export A3EM_HELPER_VIRTUAL_ONLY=1 A3EM_HELPER_STATE_DIR="$WORK/state"
cd "$WORK"

truncate -s 2G card.img
LOOP=$(losetup -f --show -P card.img)
ID=$(basename "$LOOP")
cleanup() { umount "${LOOP}p1" 2>/dev/null || true; losetup -d "$LOOP" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
echo "card: $LOOP"

check() { python3 "$HERE/check.py" "$@"; }
call() { "$HELPER" call "$1" > reply.json 2> progress.log; }

call '{"op":"listDevices"}'; check only-device reply.json "$ID"
call '{"op":"challenge","device":"'"$ID"'","operation":"prepare"}'; TOKEN=$(check token reply.json)

# A label the firmware cannot use is refused before anything is written.
call '{"op":"prepare","targets":[{"device":"'"$ID"'","grant":"'"$TOKEN"'","allocationUnitBytes":32768,"label":"NOT/ALLOWED"}]}'
check refused reply.json bad-request

CONFIG='DEVICE_LABEL = FIELD1
'
REQUEST=$(python3 -c 'import json,sys; print(json.dumps({"op":"prepare","targets":[{"device":sys.argv[1],"grant":sys.argv[2],"allocationUnitBytes":32768,"label":"FIELD1","config":sys.argv[3]}]}))' "$ID" "$TOKEN" "$CONFIG")
call "$REQUEST"; check prepared reply.json 32768 FIELD1

# The confirmation was spent.
call "$REQUEST"; check refused reply.json bad-grant

call '{"op":"readiness","device":"'"$ID"'","deep":true}'; check ready reply.json "$CONFIG"
call '{"op":"diagnose","volume":"'"$ID"'p1"}'; check clean reply.json

# Renamed, and mounted again; the system sees the new name.
call '{"op":"rename","volume":"'"$ID"'p1","label":"OWL_02"}'
python3 -c 'import json,sys; r=json.load(open("reply.json")); sys.exit(0 if r.get("ok") and r.get("renamed") else "rename failed: %s" % r)'
[ "$(blkid -p -s LABEL -o value "${LOOP}p1")" = OWL_02 ] || { echo "rename: the system does not see OWL_02"; exit 1; }
echo "rename: the system sees OWL_02"

call '{"op":"eject","device":"'"$ID"'"}'
fsck.exfat -n "${LOOP}p1"
echo "linux integration: passed"
