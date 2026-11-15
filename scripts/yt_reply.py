#!/usr/bin/env python3
"""Post a reply to a YouTube comment (run by .github/workflows/yt-reply.yml).

Inputs (workflow_dispatch event file): page, parent_id (top-level comment / thread id), text, req.
Uses the page's connected channel from config/yt_tokens.enc.json and comments.insert.
Appends the outcome to config/yt_replies.json (last 100, no secrets), which the panel reads.
"""
import json
import os
import re
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yt_tokens as T  # noqa: E402

REPLIES_PATH = os.path.join(T.ROOT, "config", "yt_replies.json")
MAX_TEXT = 5000


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def read_inputs():
    path = os.environ.get("GITHUB_EVENT_PATH")
    data = {}
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            data = (json.load(f) or {}).get("inputs") or {}
    return {k: str(data.get(k) or "").strip() for k in ("page", "parent_id", "text", "req")}


def record(entry):
    try:
        with open(REPLIES_PATH, encoding="utf-8") as f:
            d = json.load(f)
    except (FileNotFoundError, ValueError):
        d = {}
    items = [x for x in (d.get("items") or []) if x.get("req") != entry.get("req")]
    entry["at"] = T.now_iso()
    items.append(entry)
    d = {"v": 1, "updated_at": entry["at"], "items": items[-100:]}
    os.makedirs(os.path.dirname(REPLIES_PATH), exist_ok=True)
    with open(REPLIES_PATH, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
        f.write("\n")


def main():
    i = read_inputs()
    e = {"req": i["req"][:64], "page": i["page"], "parent_id": i["parent_id"], "text": i["text"][:MAX_TEXT],
         "status": "failed"}
    if not re.match(r"^[\w-]{1,64}$", i["req"] or "x") or not re.match(r"^[\w.-]{5,120}$", i["parent_id"]) \
            or not i["text"] or not i["page"]:
        e["error_fa"] = "درخواست ناقص بود."
        record(e)
        log("bad input")
        return 0
    try:
        store = T.load()
        ent = T.entry_for_page(store, i["page"])
        if not ent:
            e["status"] = "needs_setup"
            e["error_fa"] = "این پیج حساب یوتیوب متصل (و هم‌خوان) ندارد؛ اول «اتصال» را بزن."
            record(e)
            log("no connected channel for page")
            return 0
        access = T.access_token(T.decrypt(ent))
        r = requests.post(f"{T.API}/comments", params={"part": "snippet"},
                          headers={"Authorization": f"Bearer {access}", "Content-Type": "application/json"},
                          json={"snippet": {"parentId": i["parent_id"], "textOriginal": e["text"]}}, timeout=30)
        if r.status_code == 200:
            b = r.json()
            e.update({"status": "sent", "reply_id": b.get("id"), "channel_id": ent["channel_id"],
                      "published": (b.get("snippet") or {}).get("publishedAt")})
            log(f"reply posted to {i['parent_id']}")
        else:
            try:
                reason = ((r.json().get("error") or {}).get("errors") or [{}])[0].get("reason") or f"HTTP {r.status_code}"
            except Exception:
                reason = f"HTTP {r.status_code}"
            e["error"] = reason
            e["error_fa"] = {"commentsDisabled": "کامنت‌های این ویدیو بسته است.",
                             "forbidden": "یوتیوب اجازه‌ی پاسخ نداد (دسترسی کافی نیست).",
                             "parentCommentNotFound": "این کامنت دیگر وجود ندارد.",
                             "quotaExceeded": "سهمیه‌ی روزانه‌ی API یوتیوب تمام شده؛ فردا دوباره امتحان کن."}.get(
                reason, "یوتیوب پاسخ را نپذیرفت (" + reason + ").")
            log(f"comments.insert refused: {reason}")
    except T.StoreError as ex:
        msg = str(ex)
        e["status"] = "needs_setup" if msg == "revoked" or "missing" in msg else "failed"
        e["error_fa"] = ("دسترسی پنل به این کانال لغو شده؛ دوباره «اتصال» را بزن." if msg == "revoked"
                         else "تنظیمات سرور کامل نیست: " + msg)
        log(f"store error: {msg}")
    except Exception as ex:
        e["error_fa"] = "خطای غیرمنتظره (" + type(ex).__name__ + ")."
        log(f"unexpected {type(ex).__name__}")
    record(e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
