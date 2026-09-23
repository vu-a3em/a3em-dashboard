#!/bin/sh
# Prepares an hdiutil disk image the way the dashboard prepares a card, and checks every result.
# Needs no administrator rights: an attached image belongs to whoever attached it. Never
# touches a real device: A3EM_HELPER_VIRTUAL_ONLY hides every one.
#
#   test/integration-macos.sh <path to a3em-card-helper>
set -eu
HELPER=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
export A3EM_HELPER_VIRTUAL_ONLY=1 A3EM_HELPER_STATE_DIR="$WORK/state"
cd "$WORK"

mkfile -n 2g card.img
DEV=$(hdiutil attach -nomount -imagekey diskimage-class=CRawDiskImage card.img | awk 'NR==1{print $1}')
ID=${DEV#/dev/}
cleanup() { hdiutil detach "$DEV" -force >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
echo "card: $DEV"

check() { python3 "$HERE/check.py" "$@"; }
call() { "$HELPER" call "$1" > reply.json 2> progress.log; }

call '{"op":"listDevices"}'; check only-device reply.json "$ID"
for CLUSTER in 4096 131072; do
  call '{"op":"challenge","device":"'"$ID"'","operation":"prepare"}'; TOKEN=$(check token reply.json)
  CONFIG="DEVICE_LABEL = FIELD$CLUSTER
"
  REQUEST=$(python3 -c 'import json,sys; print(json.dumps({"op":"prepare","targets":[{"device":sys.argv[1],"grant":sys.argv[2],"allocationUnitBytes":int(sys.argv[3]),"label":"C"+sys.argv[3],"config":sys.argv[4]}]}))' "$ID" "$TOKEN" "$CLUSTER" "$CONFIG")
  call "$REQUEST"; check prepared reply.json "$CLUSTER" "C$CLUSTER"
  call "$REQUEST"; check refused reply.json bad-grant
  call '{"op":"readiness","device":"'"$ID"'","deep":true}'; check ready reply.json "$CONFIG"
  call '{"op":"diagnose","volume":"'"$ID"'s1"}'; check clean reply.json
done

# The same job, through the worker's job directory rather than in this process.
export A3EM_HELPER_WORKER=direct
call '{"op":"challenge","device":"'"$ID"'","operation":"format"}'; TOKEN=$(check token reply.json)
call '{"op":"format","device":"'"$ID"'","grant":"'"$TOKEN"'","allocationUnitBytes":32768,"label":"WORKER"}'
python3 -c 'import json,sys; r=json.load(open("reply.json")); sys.exit(0 if r["ok"] and r["layout"]["reference"] else "worker format failed: %s" % r)'
echo "worker format: layout matches"
unset A3EM_HELPER_WORKER

call '{"op":"eject","device":"'"$ID"'"}'
echo "macos integration: passed"
