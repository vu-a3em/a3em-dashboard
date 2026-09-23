"""Assertions over the helper's JSON replies, shared by the integration scripts.

    python3 check.py <assertion> <reply.json> [arguments]
"""
import json
import sys


def fail(message, reply):
    print("FAIL:", message)
    print(json.dumps(reply, indent=2)[:4000])
    sys.exit(1)


def main():
    assertion, path = sys.argv[1], sys.argv[2]
    args = sys.argv[3:]
    with open(path) as handle:
        reply = json.load(handle)
    if assertion != "refused" and reply.get("ok") is not True:
        fail("the helper refused: %s" % reply.get("error"), reply)

    if assertion == "only-device":
        ids = [d["id"] for d in reply["devices"]]
        if ids != [args[0]]:
            fail("expected only %s, listed %s" % (args[0], ids), reply)
    elif assertion == "token":
        print(reply["token"])
    elif assertion == "prepared":
        cluster, label = int(args[0]), args[1]
        card = reply["results"][0]
        if card.get("error"):
            fail("prepare: %s" % card["error"], reply)
        if card["capacity"]["verdict"] != "genuine" or not card["layout"]["reference"]:
            fail("the probe or the layout check failed", reply)
        if card["geometry"]["allocationUnitBytes"] != cluster or card["geometry"]["filesystem"] != "exfat":
            fail("the system reports the wrong geometry", reply)
        if not card["configWritten"]:
            fail("the configuration was not written", reply)
        print("prepared %s: %s clusters, label %s, latency %s, capacity check %.1fs"
              % (card["volume"], cluster, label, card["latency"]["verdict"], card["capacity"]["seconds"]))
    elif assertion == "ready":
        config = args[0]
        r = reply["readiness"]
        if not r["layout"] or not r["layout"]["reference"]:
            fail("the layout does not match the reference", reply)
        if not r["config"] or r["config"]["text"] != config:
            fail("the configuration on the card is not the one written", reply)
        if r["contents"]["files"] != 0:
            fail("the card is not empty", reply)
        if not r["prepared"]:
            fail("the preparation was not recorded", reply)
        print("ready: layout matches, config present, empty, %d bytes free" % r["freeBytes"])
    elif assertion == "clean":
        if not reply["report"]["clean"]:
            fail("the filesystem check found problems", reply)
        print("filesystem check: clean")
    elif assertion == "refused":
        if reply.get("ok") is not False or reply.get("code") != args[0]:
            fail("expected a %s refusal" % args[0], reply)
        print("refused as expected: %s" % reply["code"])
    else:
        fail("unknown assertion " + assertion, reply)


main()
