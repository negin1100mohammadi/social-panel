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
for f in ["index.html", "oauth.html", "app.js", "styles.css", "sw.js", "manifest.json", "config.json", "favicon.png"]:
    shutil.copy(os.path.join(ROOT, f), out)
shutil.copytree(os.path.join(ROOT, "icons"), os.path.join(out, "icons"))
if os.path.isdir(os.path.join(ROOT, "vendor")):
    shutil.copytree(os.path.join(ROOT, "vendor"), os.path.join(out, "vendor"))
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

# ---------------------------------------------------------------- per-post history (v6)
# Generated directly (a run every 30 min), stored change-only exactly like update_posts_history, then pruned by
# the real prune_posts_history. Coverage differs per account: 92 days, 20 days, last 2 hours, none.
def gen_posts(key, idx):
    span = [timedelta(days=92), timedelta(days=20), timedelta(hours=2), timedelta(days=92)][idx % 4]
    pl = key.split("/")[1]
    t0 = last_snap - span
    runs = []
    t = last_snap
    while t >= t0:
        runs.append(t)
        t -= timedelta(minutes=30)
    runs.reverse()
    ages = [timedelta(minutes=50), timedelta(hours=2, minutes=40), timedelta(hours=10), timedelta(days=2),
            timedelta(days=20), timedelta(days=60), timedelta(days=100), None]
    posts = {}
    for j, age in enumerate(ages):
        pub = (last_snap - age) if age is not None else None
        pid = f"{pl}-{idx}-{j}"
        e = {"s": [], "title": f"پست {j} ({pl})", "url": f"https://example.com/{pid}", "thumb": None,
             "published": fs.iso(pub) if pub else None}
        v = l = c = 0
        for rt in runs:
            if pub is not None and rt < pub:
                continue
            if pub is None and rt < last_snap - timedelta(days=5):
                continue
            v += rnd.randint(0, 9) if rnd.random() < 0.6 else 0
            l += 1 if rnd.random() < 0.15 else 0
            if rnd.random() < 0.01:
                v -= 1  # platforms sometimes correct a count downwards
            c += 1 if rnd.random() < 0.05 else 0
            vals = [None if pl == "instagram" else v, None if pl == "aparat" else l, c if pl == "instagram" else None]
            ts = fs.iso(rt)
            e.setdefault("first", ts)
            e["last"] = ts
            if not e["s"] or e["s"][-1][1:] != vals:
                e["s"].append([ts] + vals)
        if e["s"]:
            posts[pid] = e
    return {"runs": [fs.iso(x) for x in runs], "posts": posts}


ph = {"v": 1, "channels": {}}
for idx, key in enumerate(keys):
    pl = key.split("/")[1]
    if pl == "tiktok":
        ph["channels"][key] = {"runs": [fs.iso(last_snap - timedelta(minutes=30 * i)) for i in range(40)][::-1], "posts": {}}
        continue
    if key == "pretime-tv/youtube":
        continue  # hand-made below
    if key == "hamrah-seller/youtube":
        continue  # no per-post data at all
    ph["channels"][key] = gen_posts(key, idx)
fs.POSTS_KEEP_DAYS = 95
fs.prune_posts_history(ph, now)

# hand-made account with known answers (checked by tests/v6.test.js against numbers worked out by hand):
N = now
def T(**kw):
    return fs.iso(N - timedelta(**kw))
ph["channels"]["pretime-tv/youtube"] = {
    "runs": [T(hours=4), T(hours=2), T(hours=1), T(minutes=10)],
    "posts": {
        "A": {"title": "A", "url": "https://example.com/A", "published": T(hours=5), "first": T(hours=4), "last": T(minutes=10),
              "s": [[T(hours=4), 100, 1, None], [T(hours=2), 150, 2, None], [T(hours=1), 170, 2, None], [T(minutes=10), 200, 3, None]]},
        "B": {"title": "B", "url": "https://example.com/B", "published": T(days=30), "first": T(hours=4), "last": T(minutes=10),
              "s": [[T(hours=4), 1000, None, None], [T(hours=1), 1010, None, None], [T(minutes=10), 1030, None, None]]},
        "C": {"title": "C", "url": "https://example.com/C", "published": T(minutes=30), "first": T(minutes=10), "last": T(minutes=10),
              "s": [[T(minutes=10), 7, 0, None]]},
    }}
json.dump(ph, open(os.path.join(out, "data", "posts_history.json"), "w"), ensure_ascii=False)
print("fixture written", out, sum(len(v) for v in series.values()), "points;",
      sum(len(c["posts"]) for c in ph["channels"].values()), "posts")
