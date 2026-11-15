"""Build a synthetic site copy with 92 days of history for the chart tests.

usage: python tests/make_fixture.py <out_dir> <now_epoch_ms>
Copies the app into <out_dir>, then writes data/history.json (snapshots every 30 min for 92 days,
pruned exactly like the refresh job does) and data/latest.json (posts spread over 90 days).
Series are varied on purpose: rising, flat (all-equal), nulls, a basis switch, post-count changes,
a series that starts 2 hours ago, a single point, and an empty one.
"""
import json
import math
import os
import random
import shutil
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import fetch_stats as fs  # noqa: E402

out, now_ms = sys.argv[1], int(sys.argv[2])
now = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
cfg = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
fs.CONFIG = cfg

if os.path.exists(out):
    shutil.rmtree(out)
os.makedirs(out)
for f in ["index.html", "app.js", "styles.css", "sw.js", "manifest.json", "config.json", "favicon.png"]:
    shutil.copy(os.path.join(ROOT, f), out)
shutil.copytree(os.path.join(ROOT, "icons"), os.path.join(out, "icons"))
os.makedirs(os.path.join(out, "data"))

rnd = random.Random(42)
PLATS = ["instagram", "youtube", "aparat", "tiktok"]
series = {}
last_snap = now - timedelta(minutes=7)  # runs at :07/:37
start = last_snap - timedelta(days=92)


def gen(key, idx):
    pts = []
    t = start
    f, v, l, c, p = 1000 + idx * 37, 50000 + idx * 1000, 4000, 300, 20
    i = 0
    while t <= last_snap:
        i += 1
        kind = idx % 6
        if kind == 0:      # steady growth, total basis
            f += rnd.randint(0, 3); v += rnd.randint(0, 40); l += rnd.randint(0, 4)
            pt = {"t": fs.iso(t), "f": f, "p": p, "v": v, "l": l, "c": None, "b": {"v": "t", "l": "t", "c": "r"}}
        elif kind == 1:    # flat followers (all equal), recent-sum basis with post-count changes
            if i % 400 == 0:
                p += 1; v -= 900  # a post enters, an older one leaves the recent list: not "new views"
            v += rnd.randint(0, 25); c += rnd.randint(0, 2)
            pt = {"t": fs.iso(t), "f": 500, "p": p, "v": v, "l": None, "c": c, "b": {"v": "r", "l": "r", "c": "r"}}
        elif kind == 2:    # old points without basis field + some null gaps
            f += 1 if i % 5 == 0 else 0
            pt = {"t": fs.iso(t), "f": f if i % 13 else None, "p": p, "v": v + i * 3, "l": None, "c": None}
        elif kind == 3:    # basis switch half way (total -> recent sum)
            half = i > 2208
            v += 10
            pt = {"t": fs.iso(t), "f": f + i // 50, "p": p, "v": (v if not half else v // 3), "l": l + i,
                  "c": None, "b": {"v": "r" if half else "t", "l": "t", "c": "r"}}
        elif kind == 4:    # data only for the last 2 hours
            if last_snap - t > timedelta(hours=2):
                t += timedelta(minutes=30); continue
            pt = {"t": fs.iso(t), "f": 77 + i % 3, "p": 3, "v": 900 + i, "l": 10, "c": 1, "b": {"v": "t", "l": "t", "c": "r"}}
        else:              # legacy display-format time strings (backward compatibility)
            f += 2
            tt = t.astimezone(fs.TEHRAN)
            pt = {"t": tt.strftime("%a %Y-%m-%d %I:%M %p (UTC+03:30)").replace(" 0", " "), "f": f, "p": p, "v": v + i, "l": None, "c": None}
        pts.append(pt)
        t += timedelta(minutes=30)
    return pts


keys = [f"{pg['id']}/{pl}" for pg in cfg["pages"] for pl in PLATS]
for idx, key in enumerate(keys):
    if key.endswith("pretime-tv/tiktok"):
        series[key] = []  # empty
        continue
    if key.endswith("pretime-tv/aparat"):
        series[key] = [{"t": fs.iso(last_snap), "f": 5, "p": 0, "v": 0, "l": None, "c": None}]  # one point
        continue
    raw = gen(key, idx)
    pruned = fs.prune_series(raw, now)
    if idx % 6 == 5:  # keep legacy strings in the fixture (prune_series normalizes them to ISO)
        legacy = {fs.iso(fs.parse_ts(p["t"])): p["t"] for p in raw}
        for p in pruned:
            p["t"] = legacy.get(p["t"], p["t"])
    series[key] = pruned

history = {"days": 90, "updated_at": fs.iso(last_snap), "resolution": "fixture", "series": series}
json.dump(history, open(os.path.join(out, "data", "history.json"), "w"), ensure_ascii=False)

latest = {"updated_at": fs.iso(last_snap), "timezone": "Asia/Tehran", "pages": {}, "summary": {}}
for pidx, pg in enumerate(cfg["pages"]):
    pb = {"id": pg["id"], "name": pg["name"], "platforms": {}}
    for plidx, pl in enumerate(PLATS):
        recent = []
        for j in range(12):
            age = timedelta(hours=1 + j * (7 + pidx * 3 + plidx) + (j * j * 2))
            pub = last_snap - age
            recent.append({"id": f"{pl}{j}", "title": f"post {j}", "url": "https://example.com/" + str(j),
                           "published": fs.iso(pub) if (pidx + j) % 7 else pub.astimezone(fs.TEHRAN).strftime("%a %Y-%m-%d %I:%M %p (UTC+03:30)"),
                           "views": None if pl == "instagram" else 100 * (j + 1),
                           "likes": 5 * j if pl != "aparat" else None,
                           "comments": j if pl in ("instagram",) else None, "thumb": None})
        pb["platforms"][pl] = {"platform": pl, "handle": pg["accounts"][pl], "url": "https://example.com", "ok": True,
                               "followers": 100, "posts": 40, "total_views": 1000, "total_likes": None,
                               "recent": recent if pl != "tiktok" else [], "fetched_at": fs.iso(last_snap)}
    latest["pages"][pg["id"]] = pb
json.dump(latest, open(os.path.join(out, "data", "latest.json"), "w"), ensure_ascii=False)
print("fixture written", out, sum(len(v) for v in series.values()), "points")
