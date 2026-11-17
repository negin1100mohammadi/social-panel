#!/usr/bin/env python3
"""Read Buffer channels + sent posts with metrics per page. Keys come from
env BUFFER_KEY_<PAGE_ID> (e.g. BUFFER_KEY_TITAN_STATION). Writes data/buffer.json
(no keys). Free plan: 1,000 requests/channel/month -> keep calls few."""
import json, os, sys, time, urllib.request, datetime
API = "https://api.buffer.com"
def gql(key, q, v=None):
    req = urllib.request.Request(API, data=json.dumps({"query": q, "variables": v or {}}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        d = json.loads(e.read() or b"{}")
    if d.get("errors"):
        raise RuntimeError("; ".join(x.get("message", "") for x in d["errors"]))
    return d["data"]
Q_ORG = "query { account { email organizations { id name } } }"
Q_CH = "query($o:OrganizationId!){ channels(input:{organizationId:$o}){ id name displayName service avatar isQueuePaused } }"
Q_POSTS = """query($o:OrganizationId!){ posts(first:30, input:{organizationId:$o, filter:{status:[sent]}}){
 edges{ node{ id text dueAt channelId externalLink metrics{ type name value unit } metricsUpdatedAt } } } }"""


def clean_key(raw):
    """HTTP headers are latin-1: a key pasted with a bullet, NBSP, zero-width or Persian character made urllib fail
    ('latin-1' codec can't encode…). Keep only printable ASCII; report how many characters were dropped (never the key)."""
    raw = raw or ""
    key = "".join(c for c in raw if 33 <= ord(c) < 127)
    return key, len(raw.strip()) - len(key)
def main():
    cfg = json.load(open("config.json"))
    out = {"updated": datetime.datetime.now(datetime.timezone.utc).isoformat(), "pages": {}}
    ok = 0
    for p in cfg["pages"]:
        env = "BUFFER_KEY_" + p["id"].upper().replace("-", "_")
        key, dropped = clean_key(os.environ.get(env, ""))
        if not key:
            out["pages"][p["id"]] = {"status": "no_key"}; continue
        if dropped:
            print(p["id"], "key: dropped %d non-ASCII/space character(s); re-copy the key into %s if this keeps failing" % (dropped, env), file=sys.stderr)
        try:
            a = gql(key, Q_ORG)["account"]
            org = a["organizations"][0]["id"]
            ch = gql(key, Q_CH, {"o": org})["channels"]
            try:
                posts = [e["node"] for e in gql(key, Q_POSTS, {"o": org})["posts"]["edges"]]
            except Exception as e:
                posts = []; print(p["id"], "posts:", e, file=sys.stderr)
            out["pages"][p["id"]] = {"status": "ok", "account": a.get("email"), "channels": ch, "posts": posts}
            print(p["id"], "ok", a.get("email"), a["organizations"][0].get("name"), len(ch), "channels", len(posts), "posts"); ok += 1
        except Exception as e:
            out["pages"][p["id"]] = {"status": "error", "error": str(e)[:200] + (" (key had %d non-ASCII chars removed)" % dropped if dropped else "")}
            print(p["id"], "ERROR", e, file=sys.stderr)
        time.sleep(1)
    os.makedirs("data", exist_ok=True)
    json.dump(out, open("data/buffer.json", "w"), ensure_ascii=False, indent=1)
    print("pages ok:", ok)
if __name__ == "__main__":
    main()
