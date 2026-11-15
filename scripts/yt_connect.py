#!/usr/bin/env python3
"""Finish a YouTube OAuth connection (run by .github/workflows/yt-connect.yml).

Inputs come from the workflow_dispatch event file, never from the command line or env, so the
authorization code is never echoed into a step header. The code is masked before anything else.

  inputs.code  one-time authorization code from oauth.html
  inputs.page  panel page key (config.json pages[].id)
  inputs.req   random request id chosen by the browser (to find this run and its result)

Writes
  config/yt_tokens.enc.json   refresh token, AES-GCM encrypted with TOKEN_KEY, keyed by channel id
  config/yt_connect_last.json result of this attempt (no secrets) for oauth.html to show
Exit code is 0 even when Google refuses, so the result file is always committed; the browser reads it.
"""
import json
import os
import re
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yt_tokens as T  # noqa: E402

ROOT = T.ROOT
RESULT_PATH = os.path.join(ROOT, "config", "yt_connect_last.json")
LATEST_PATH = os.path.join(ROOT, "data", "latest.json")
CONFIG_PATH = os.path.join(ROOT, "config.json")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def read_inputs():
    path = os.environ.get("GITHUB_EVENT_PATH")
    data = {}
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            data = (json.load(f) or {}).get("inputs") or {}
    code = str(data.get("code") or "").strip()
    T.mask(code)  # first thing: nothing below may print it
    return code, str(data.get("page") or "").strip(), str(data.get("req") or "").strip()


def write_result(res):
    os.makedirs(os.path.dirname(RESULT_PATH), exist_ok=True)
    res["at"] = T.now_iso()
    with open(RESULT_PATH, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
        f.write("\n")


def expected_channel(page):
    try:
        with open(LATEST_PATH, encoding="utf-8") as f:
            r = json.load(f)["pages"][page]["platforms"]["youtube"]
        cid = r.get("channel_id")
        return cid if cid and re.match(r"^UC[\w-]{22}$", cid) else None
    except Exception:
        return None


def page_exists(page):
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg = json.load(f)
        return any(p.get("id") == page and (p.get("accounts") or {}).get("youtube") for p in cfg.get("pages", []))
    except Exception:
        return False


def main():
    code, page, req = read_inputs()
    res = {"req": req[:64], "page": page, "ok": False}
    if not re.match(r"^[\w-]{1,64}$", req or "x") or not code or not page_exists(page):
        res["error"] = "bad_input"
        res["error_fa"] = "درخواست ناقص بود (کد یا پیج نامعتبر)."
        write_result(res)
        log("bad input")
        return 0
    try:
        T._key()  # TOKEN_KEY must be usable before the one-time code is spent
        cid, csec = T.client_creds()
        r = requests.post(T.TOKEN_URL, data={"code": code, "client_id": cid, "client_secret": csec,
                                             "redirect_uri": T.REDIRECT_URI, "grant_type": "authorization_code"},
                          timeout=30)
        try:
            body = r.json()
        except ValueError:
            body = {}
        for k in ("access_token", "refresh_token", "id_token"):
            T.mask(body.get(k))
        if r.status_code != 200 or not body.get("access_token"):
            err = body.get("error") or f"HTTP {r.status_code}"
            log(f"token exchange refused: {err}")
            res["error"] = err
            res["error_fa"] = ("کد تأیید منقضی یا قبلاً استفاده شده؛ دوباره «اتصال» را بزن." if err == "invalid_grant"
                               else "گوگل کد را نپذیرفت (" + err + ").")
            write_result(res)
            return 0
        access, refresh = body["access_token"], body.get("refresh_token")
        granted = sorted((body.get("scope") or "").split())
        if not refresh:
            res["error"] = "no_refresh_token"
            res["error_fa"] = "گوگل توکن دائمی نداد؛ دوباره «اتصال» را بزن و همه‌ی دسترسی‌ها را تأیید کن."
            write_result(res)
            log("no refresh token in response")
            return 0
        ch = requests.get(f"{T.API}/channels", params={"part": "snippet", "mine": "true"},
                          headers={"Authorization": f"Bearer {access}"}, timeout=30)
        items = (ch.json() if ch.status_code == 200 else {}).get("items") or []
        if not items:
            res["error"] = "no_channel" if ch.status_code == 200 else f"channels HTTP {ch.status_code}"
            res["error_fa"] = ("این حساب گوگل کانال یوتیوب ندارد؛ در صفحه‌ی گوگل، حساب یا کانال (Brand Account) درست را انتخاب کن."
                               if ch.status_code == 200 else "خواندن کانال از یوتیوب ممکن نشد (HTTP " + str(ch.status_code) + ").")
            write_result(res)
            log(f"no channel: HTTP {ch.status_code}")
            return 0
        it = items[0]
        sn = it.get("snippet") or {}
        channel_id = it["id"]
        exp = expected_channel(page)
        mismatch = bool(exp and exp != channel_id)
        iv, ct = T.encrypt(refresh, channel_id)
        store = T.load()
        thumbs = sn.get("thumbnails") or {}
        store["channels"][channel_id] = {
            "page": page, "channel_id": channel_id, "title": sn.get("title"), "handle": sn.get("customUrl"),
            "thumb": (thumbs.get("default") or thumbs.get("medium") or {}).get("url"),
            "expected_channel_id": exp, "mismatch": mismatch, "scopes": granted,
            "connected_at": T.now_iso(), "status": "ok", "iv": iv, "ct": ct}
        T.save(store)
        res.update({"ok": True, "channel_id": channel_id, "title": sn.get("title"), "handle": sn.get("customUrl"),
                    "expected_channel_id": exp, "mismatch": mismatch, "scopes": granted})
        missing = [s for s in ("youtube.upload", "youtube.force-ssl", "youtube.readonly", "yt-analytics.readonly")
                   if not any(g.endswith("/" + s) for g in granted)]
        if missing and granted:
            res["missing_scopes"] = missing
        write_result(res)
        log(f"connected {channel_id} for page {page}" + (" (MISMATCH with configured channel)" if mismatch else ""))
        return 0
    except T.StoreError as e:
        res["error"] = "setup"
        res["error_fa"] = "تنظیمات سرور کامل نیست: " + str(e)
        write_result(res)
        log(f"setup error: {e}")
        return 0
    except Exception as e:  # never print the exception text of a request that may carry the code
        res["error"] = type(e).__name__
        res["error_fa"] = "خطای غیرمنتظره در اتصال (" + type(e).__name__ + ")."
        write_result(res)
        log(f"unexpected {type(e).__name__}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
