#!/usr/bin/env python3
"""One-off: rebuild data/posts_history.json from every committed version of data/latest.json.

Each data commit holds the per-post numbers that run read, so the per-post history can be recovered
exactly (no estimation). Runs already present are skipped, so it is safe to re-run.
usage: python scripts/backfill_posts_history.py
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_stats as fs  # noqa: E402

ROOT = fs.ROOT
fs.CONFIG = fs.load_json(fs.CONFIG_PATH, {})
commits = subprocess.check_output(["git", "log", "--reverse", "--format=%H", "--", "data/latest.json"],
                                  cwd=ROOT, text=True).split()
ph = fs.load_json(fs.POSTS_HISTORY_PATH, {"v": 1, "channels": {}})
used = 0
for c in commits:
    try:
        raw = subprocess.check_output(["git", "show", f"{c}:data/latest.json"], cwd=ROOT, text=True)
        latest = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        print("skip", c[:7], type(e).__name__)
        continue
    run_at = fs.parse_ts(latest.get("updated_at"))
    if run_at is None:
        continue
    fs.update_posts_history(ph, latest, run_at)
    used += 1
# then the working-tree copy (latest run)
fs.update_posts_history(ph, fs.load_json(fs.LATEST_PATH, {"pages": {}}), fs.now_utc())
fs.prune_posts_history(ph, fs.now_utc())
fs.write_compact(fs.POSTS_HISTORY_PATH, ph)
n_posts = sum(len(ch["posts"]) for ch in ph["channels"].values())
n_runs = sum(len(ch["runs"]) for ch in ph["channels"].values())
print(f"{used} commits read; {len(ph['channels'])} accounts, {n_posts} posts, {n_runs} runs")
