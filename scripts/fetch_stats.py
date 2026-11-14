#!/usr/bin/env python3
"""Fetch public stats for every page/platform in config.json.

Writes:
  data/latest.json   - current snapshot (one block per page/platform)
  data/history.json  - one point per day per platform (last N days)

Rules:
  * Every platform runs in its own try/except. A failure keeps the previous
    values (marked "stale") instead of wiping them.
  * Numbers that cannot be read are stored as null - never guessed.
  * Polite pace: a delay between every request.

Optional environment variables:
  YT_API_KEY                   YouTube Data API v3 key
  IG_ACCESS_TOKEN, IG_USER_ID  Instagram Graph API (Business Discovery)

Only `requests` + the standard library are used.
"""
import json
import os
import re
import sys
import time
import html as htmllib
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import requests

try:
    from zoneinfo import ZoneInfo
    TEHRAN = ZoneInfo("Asia/Tehran")
except Exception:  # pragma: no cover - fallback if tz database is missing
    TEHRAN = timezone(timedelta(hours=3, minutes=30))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config.json")
DATA_DIR = os.path.join(ROOT, "data")
LATEST_PATH = os.path.join(DATA_DIR, "latest.json")
HISTORY_PATH = os.path.join(DATA_DIR, "history.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
TIMEOUT = 25
PLATFORMS = ["instagram", "youtube", "aparat", "tiktok"]

CONFIG = {}
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def log(*a):
    print(*a, file=sys.stderr, flush=True)


def pause():
    time.sleep(float(CONFIG.get("request_delay_seconds", 2.5)))


def get(url, **kw):
    """GET with a polite pause before every request."""
    pause()
    kw.setdefault("timeout", TIMEOUT)
    r = SESSION.get(url, **kw)
    return r


def now_utc():
    return datetime.now(timezone.utc)


def iso(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def to_int(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip().replace(",", "").replace("\u066c", "")
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def parse_compact(text):
    """'1.2K subscribers' -> (1200, approximate=True). '20 subscribers' -> (20, False)."""
    if not text:
        return None, False
    m = re.search(r"([\d.,]+)\s*([KMB])?", text, re.I)
    if not m:
        return None, False
    num = float(m.group(1).replace(",", ""))
    suf = (m.group(2) or "").upper()
    mult = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}.get(suf, 1)
    return int(round(num * mult)), bool(suf)


def blank(platform, handle, url):
    return {
        "platform": platform,
        "handle": handle,
        "url": url,
        "ok": False,
        "stale": False,
        "source": None,
        "followers": None,
        "followers_approx": False,
        "posts": None,
        "total_views": None,
        "total_likes": None,
        "avatar": None,
        "recent": [],
        "notes": [],
        "error": None,
        "fetched_at": None,
    }


def post(pid, title, url, published, views=None, likes=None, comments=None, thumb=None,
         shares=None, saves=None, retention=None, duration=None):
    return {
        "shares": to_int(shares),
        "saves": to_int(saves),
        "retention": retention,
        "duration": to_int(duration),
        "id": str(pid),
        "title": (title or "").strip()[:160],
        "url": url,
        "published": iso(published) if isinstance(published, datetime) else published,
        "views": to_int(views),
        "likes": to_int(likes),
        "comments": to_int(comments),
        "thumb": thumb,
    }


# --------------------------------------------------------------------------
# YouTube
# --------------------------------------------------------------------------
def youtube(handle, prev):
    h = handle if handle.startswith("@") else "@" + handle
    out = blank("youtube", h, f"https://www.youtube.com/{h}")
    key = os.environ.get("YT_API_KEY", "").strip()
    n = int(CONFIG.get("recent_posts", 12))

    if key:
        api = "https://www.googleapis.com/youtube/v3"
        r = get(f"{api}/channels", params={"part": "snippet,statistics,contentDetails",
                                           "forHandle": h, "key": key})
        r.raise_for_status()
        items = r.json().get("items") or []
        if not items:
            raise RuntimeError("channel not found via forHandle")
        ch = items[0]
        st = ch.get("statistics", {})
        out["channel_id"] = ch["id"]
        out["url"] = f"https://www.youtube.com/{h}"
        out["title"] = ch.get("snippet", {}).get("title")
        _th = ch.get("snippet", {}).get("thumbnails", {})
        out["avatar"] = (_th.get("medium") or _th.get("default") or {}).get("url")
        out["followers"] = None if st.get("hiddenSubscriberCount") else to_int(st.get("subscriberCount"))
        out["followers_approx"] = True  # API rounds subscriber counts to 3 significant figures
        out["posts"] = to_int(st.get("videoCount"))
        out["total_views"] = to_int(st.get("viewCount"))
        uploads = ch.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads")
        if uploads:
            r = get(f"{api}/playlistItems", params={"part": "contentDetails", "playlistId": uploads,
                                                    "maxResults": n, "key": key})
            r.raise_for_status()
            ids = [it["contentDetails"]["videoId"] for it in r.json().get("items", [])]
            if ids:
                r = get(f"{api}/videos", params={"part": "snippet,statistics", "id": ",".join(ids),
                                                 "key": key})
                r.raise_for_status()
                for v in r.json().get("items", []):
                    sn, vs = v.get("snippet", {}), v.get("statistics", {})
                    thumbs = sn.get("thumbnails", {})
                    thumb = (thumbs.get("medium") or thumbs.get("default") or {}).get("url")
                    out["recent"].append(post(v["id"], sn.get("title"),
                                              f"https://www.youtube.com/watch?v={v['id']}",
                                              sn.get("publishedAt"), vs.get("viewCount"),
                                              vs.get("likeCount"), vs.get("commentCount"), thumb))
        out["source"] = "YouTube Data API v3"
        out["ok"] = True
        return out

    # ---- fallback: channel page (subscribers, video count) + RSS (recent videos)
    channel_id = (prev or {}).get("channel_id")
    try:
        r = get(f"https://www.youtube.com/{h}/about", params={"hl": "en", "gl": "US"},
                cookies={"CONSENT": "YES+1", "SOCS": "CAI"})
        if r.status_code == 404:
            raise LookupError(f"handle {h} not found on YouTube (HTTP 404)")
        r.raise_for_status()
        page = r.text
        m = (re.search(r'"externalId":"(UC[\w-]{22})"', page)
             or re.search(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{22})"', page)
             or re.search(r'"browseId":"(UC[\w-]{22})"', page))
        if m:
            channel_id = m.group(1)
        sm = re.search(r'"subscriberCountText":"([^"]+)"', page)
        if sm:
            out["followers"], out["followers_approx"] = parse_compact(sm.group(1))
        vm = re.search(r'"videoCountText":"([^"]+)"', page)
        if vm:
            out["posts"], _ = parse_compact(vm.group(1))
        tv = re.search(r'"viewCountText":"([\d,]+) views"', page)
        if tv:
            out["total_views"] = to_int(tv.group(1))
        im = re.search(r'<meta property="og:image" content="([^"]+)"', page)
        if im:
            out["avatar"] = htmllib.unescape(im.group(1))
        tm = re.search(r'<meta property="og:title" content="([^"]*)"', page)
        if tm:
            out["title"] = htmllib.unescape(tm.group(1))
    except Exception as e:  # keep going with RSS if we already know the channel id
        if not channel_id:
            raise
        out["notes"].append(f"channel page failed: {type(e).__name__}")

    if not channel_id:
        raise RuntimeError("could not resolve channel id")
    out["channel_id"] = channel_id

    r = get("https://www.youtube.com/feeds/videos.xml", params={"channel_id": channel_id})
    r.raise_for_status()
    ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
          "m": "http://search.yahoo.com/mrss/"}
    root = ET.fromstring(r.content)
    for e in root.findall("a:entry", ns)[:n]:
        vid = e.findtext("yt:videoId", default="", namespaces=ns)
        link = e.find("a:link", ns)
        grp = e.find("m:group", ns)
        views = likes = thumb = None
        if grp is not None:
            stt = grp.find("m:community/m:statistics", ns)
            rat = grp.find("m:community/m:starRating", ns)
            th = grp.find("m:thumbnail", ns)
            views = stt.get("views") if stt is not None else None
            likes = rat.get("count") if rat is not None else None  # RSS 'count' = like count
            thumb = th.get("url") if th is not None else None
        pub = e.findtext("a:published", default=None, namespaces=ns)
        out["recent"].append(post(vid, e.findtext("a:title", default="", namespaces=ns),
                                  link.get("href") if link is not None else f"https://www.youtube.com/watch?v={vid}",
                                  pub, views, likes, None, thumb))
    if out["posts"] is None and not out["recent"]:
        out["posts"] = 0
        out["notes"].append("video count from empty RSS feed (no public videos)")
    if out["followers"] is None:
        out["notes"].append("subscriber count not shown publicly (zero or hidden)")
    out["notes"].append("no API key: comments unavailable; likes/views from RSS feed (last 15 videos max)")
    out["source"] = "YouTube channel page + RSS feed"
    out["ok"] = True  # channel resolved and RSS feed read
    return out


# --------------------------------------------------------------------------
# Aparat
# --------------------------------------------------------------------------
def aparat(username, prev):
    out = blank("aparat", username, f"https://www.aparat.com/{username}")
    n = int(CONFIG.get("recent_posts", 12))

    # profile: v1 endpoint first (numeric follower count), legacy etc/api as fallback
    prof = None
    try:
        r = get(f"https://www.aparat.com/api/fa/v1/user/user/information/username/{username}")
        r.raise_for_status()
        a = r.json()["data"]["attributes"]
        prof = {"name": a.get("name"), "followers": a.get("follower_cnt_num", a.get("follower_cnt")),
                "videos": a.get("video_cnt"), "views": a.get("video_visit"),
                "avatar": a.get("pic_m") or a.get("pic_s")}
    except Exception as e:
        out["notes"].append(f"v1 profile failed: {type(e).__name__}")
    if prof is None:
        r = get(f"https://www.aparat.com/etc/api/profile/username/{username}")
        r.raise_for_status()
        a = r.json()["profile"]
        prof = {"name": a.get("name"), "followers": a.get("follower_cnt"), "videos": a.get("video_cnt"),
                "views": None}
    out["title"] = prof["name"]
    out["avatar"] = prof.get("avatar")
    out["followers"] = to_int(prof["followers"])
    out["posts"] = to_int(prof["videos"])
    out["total_views"] = to_int(prof["views"])

    # latest videos (legacy videobyuser returns 503, the v1 list works)
    try:
        r = get(f"https://www.aparat.com/api/fa/v1/user/video/list/username/{username}")
        r.raise_for_status()
        vids = [x for x in r.json().get("included", []) if x.get("type") == "Video"]
        for x in vids[:n]:
            v = x.get("attributes", {})
            pub = None
            if v.get("sdate_rss"):
                try:  # Aparat gives Tehran local time without an offset
                    pub = datetime.strptime(v["sdate_rss"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=TEHRAN)
                except ValueError:
                    pub = None
            likes = v.get("like_cnt")
            if likes is None and isinstance(v.get("like"), dict):
                likes = v["like"].get("cnt")
            out["recent"].append(post(v.get("uid") or v.get("id"), v.get("title"),
                                      f"https://www.aparat.com/v/{v.get('uid')}", pub,
                                      v.get("visit_cnt_int") or v.get("visit_cnt"), likes, None,
                                      v.get("small_poster"), duration=v.get("duration")))
    except Exception as e:
        out["notes"].append(f"video list failed: {type(e).__name__}")
    out["notes"].append("Aparat public API gives views; likes/comments are not exposed")
    out["source"] = "Aparat public API"
    out["ok"] = True
    return out


# --------------------------------------------------------------------------
# Instagram
# --------------------------------------------------------------------------
def instagram(username, prev):
    out = blank("instagram", username, f"https://www.instagram.com/{username}/")
    n = int(CONFIG.get("recent_posts", 12))
    token = os.environ.get("IG_ACCESS_TOKEN", "").strip()
    ig_id = os.environ.get("IG_USER_ID", "").strip()

    if token and ig_id:
        fields = (f"business_discovery.username({username}){{username,name,profile_picture_url,followers_count,media_count,"
                  f"media.limit({n}){{id,caption,timestamp,like_count,comments_count,permalink,media_type}}}}")
        r = get(f"https://graph.facebook.com/v21.0/{ig_id}",
                params={"fields": fields, "access_token": token})
        if r.status_code != 200:
            raise RuntimeError(f"Graph API HTTP {r.status_code}: {r.text[:160]}")
        bd = r.json().get("business_discovery", {})
        out["title"] = bd.get("name")
        out["avatar"] = bd.get("profile_picture_url")
        out["followers"] = to_int(bd.get("followers_count"))
        out["posts"] = to_int(bd.get("media_count"))
        for m in (bd.get("media", {}) or {}).get("data", []):
            out["recent"].append(post(m.get("id"), m.get("caption"), m.get("permalink"),
                                      m.get("timestamp"), None, m.get("like_count"),
                                      m.get("comments_count")))
        out["source"] = "Instagram Graph API (Business Discovery)"
        out["ok"] = True
        return out

    # best-effort public endpoint (often blocked for datacenter IPs)
    r = get("https://i.instagram.com/api/v1/users/web_profile_info/",
            params={"username": username},
            headers={"x-ig-app-id": "936619743392459", "Accept": "application/json",
                     "Referer": "https://www.instagram.com/"})
    ctype = r.headers.get("content-type", "")
    if r.status_code != 200 or "json" not in ctype:
        first = f"public profile endpoint blocked (HTTP {r.status_code}, {ctype.split(';')[0]})"
        # last resort: profile page meta description "N Followers, N Following, N Posts"
        r2 = get(f"https://www.instagram.com/{username}/", allow_redirects=False,
                 headers={"User-Agent": "facebookexternalhit/1.1"})
        m = re.search(r'content="([\d.,KMkm]+)\s+Followers,\s*[\d.,KMkm]+\s+Following,\s*([\d.,KMkm]+)\s+Posts', r2.text or "")
        if r2.status_code == 200 and m:
            out["followers"], out["followers_approx"] = parse_compact(m.group(1))
            out["posts"], _ = parse_compact(m.group(2))
            out["notes"].append("totals only (from profile page meta); recent posts unavailable")
            out["source"] = "Instagram profile page meta (unofficial)"
            out["ok"] = True
            return out
        raise RuntimeError(f"{first}; profile page HTTP {r2.status_code}")
    u = r.json()["data"]["user"]
    out["title"] = u.get("full_name")
    out["followers"] = to_int(u.get("edge_followed_by", {}).get("count"))
    media = u.get("edge_owner_to_timeline_media", {})
    out["posts"] = to_int(media.get("count"))
    for ed in media.get("edges", [])[:n]:
        nd = ed.get("node", {})
        cap = ""
        caps = nd.get("edge_media_to_caption", {}).get("edges", [])
        if caps:
            cap = caps[0].get("node", {}).get("text", "")
        ts = nd.get("taken_at_timestamp")
        likes = (nd.get("edge_liked_by") or nd.get("edge_media_preview_like") or {}).get("count")
        out["recent"].append(post(nd.get("shortcode"), cap,
                                  f"https://www.instagram.com/p/{nd.get('shortcode')}/",
                                  datetime.fromtimestamp(ts, timezone.utc) if ts else None,
                                  nd.get("video_view_count"), likes,
                                  nd.get("edge_media_to_comment", {}).get("count")))
    out["source"] = "Instagram public web profile (unofficial)"
    out["ok"] = True
    return out


# --------------------------------------------------------------------------
# TikTok
# --------------------------------------------------------------------------
def tiktok(username, prev):
    u = username.lstrip("@")
    out = blank("tiktok", u, f"https://www.tiktok.com/@{u}")
    r = get(f"https://www.tiktok.com/@{u}", headers={"Accept": "text/html"})
    r.raise_for_status()
    m = re.search(r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', r.text, re.S)
    if not m:
        raise RuntimeError("embedded JSON not found (blocked or layout changed)")
    d = json.loads(m.group(1))
    det = d.get("__DEFAULT_SCOPE__", {}).get("webapp.user-detail", {})
    if det.get("statusCode") not in (0, None):
        raise RuntimeError(f"TikTok statusCode {det.get('statusCode')}")
    info = det.get("userInfo") or {}
    st = info.get("stats") or {}
    if not st:
        raise RuntimeError("no stats in embedded JSON")
    out["title"] = (info.get("user") or {}).get("nickname")
    out["avatar"] = (info.get("user") or {}).get("avatarMedium") or (info.get("user") or {}).get("avatarThumb")
    out["followers"] = to_int(st.get("followerCount"))
    out["posts"] = to_int(st.get("videoCount"))
    out["total_likes"] = to_int(st.get("heartCount") or st.get("heart"))
    out["notes"].append("TikTok profile page exposes totals only; per-video stats and dates are not available")
    out["source"] = "TikTok public profile page"
    out["ok"] = True
    return out


def is_placeholder_avatar(url):
    """True for auto-generated letter avatars / platform defaults (not a real profile photo)."""
    if not url:
        return True
    if "avatar-is-chann" in url or "default" in url.lower():
        return True
    try:
        from io import BytesIO
        from PIL import Image
        r = get(url)
        r.raise_for_status()
        im = Image.open(BytesIO(r.content)).convert("RGB").resize((64, 64))
        cols = sorted(im.getcolors(4096) or [], reverse=True)
        if not cols:
            return False  # very many colours -> a photo
        top2 = sum(c for c, _ in cols[:2]) / 4096
        return top2 > 0.6  # flat background + one letter
    except Exception:
        return False


FETCHERS = {"instagram": instagram, "youtube": youtube, "aparat": aparat, "tiktok": tiktok}


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def main():
    global CONFIG
    CONFIG = load_json(CONFIG_PATH, None)
    if not CONFIG:
        sys.exit("config.json missing or invalid")
    only = set(a.lower() for a in sys.argv[1:])  # optional: limit to platforms, e.g. `youtube tiktok`

    os.makedirs(DATA_DIR, exist_ok=True)
    prev_latest = load_json(LATEST_PATH, {"pages": {}})
    history = load_json(HISTORY_PATH, {"days": 0, "series": {}})

    run_at = now_utc()
    latest = {"updated_at": iso(run_at), "timezone": CONFIG.get("timezone", "Asia/Tehran"), "pages": {},
              "summary": {}}
    ok_count = fail_count = 0

    for page in CONFIG["pages"]:
        pid = page["id"]
        pblock = {"id": pid, "name": page["name"], "topic_fa": page.get("topic_fa"), "platforms": {}}
        prev_page = prev_latest.get("pages", {}).get(pid, {}).get("platforms", {})
        for plat in PLATFORMS:
            handle = page.get("accounts", {}).get(plat)
            if not handle:
                continue
            prev = prev_page.get(plat)
            if only and plat not in only:
                if prev:
                    pblock["platforms"][plat] = prev
                continue
            try:
                res = FETCHERS[plat](handle, prev)
                res["fetched_at"] = iso(now_utc())
                if res.get("avatar") and is_placeholder_avatar(res["avatar"]):
                    res["avatar"] = None
                ok_count += 1
                log(f"OK    {pid:16s} {plat:9s} followers={res['followers']} posts={res['posts']} "
                    f"recent={len(res['recent'])} via {res['source']}")
            except Exception as e:
                fail_count += 1
                err = f"{type(e).__name__}: {str(e)[:200]}"
                log(f"FAIL  {pid:16s} {plat:9s} {err}")
                if prev and prev.get("fetched_at"):
                    res = dict(prev)
                    res["stale"] = True
                    res["error"] = err
                else:
                    url = blank(plat, handle, "")["url"]
                    res = blank(plat, handle, url)
                    res["url"] = {"instagram": f"https://www.instagram.com/{handle}/",
                                  "youtube": f"https://www.youtube.com/{handle if handle.startswith('@') else '@' + handle}",
                                  "aparat": f"https://www.aparat.com/{handle}",
                                  "tiktok": f"https://www.tiktok.com/@{handle.lstrip('@')}"}[plat]
                    res["error"] = err
                res["last_attempt_at"] = iso(now_utc())
            pblock["platforms"][plat] = res
        latest["pages"][pid] = pblock

    # ---- history: one point per day (Tehran date) per platform; keep last N days
    keep = int(CONFIG.get("history_days", 90))
    today = run_at.astimezone(TEHRAN).date()
    cutoff = (today - timedelta(days=keep - 1)).isoformat()
    series = history.get("series", {})
    for pid, pb in latest["pages"].items():
        for plat, r in pb["platforms"].items():
            key = f"{pid}/{plat}"
            pts = [p for p in series.get(key, []) if p.get("d", "") >= cutoff and p.get("d") != today.isoformat()]
            if r.get("ok") and not r.get("stale") and (r.get("followers") is not None or r.get("posts") is not None):
                pts.append({"d": today.isoformat(), "f": r.get("followers"), "p": r.get("posts")})
            else:
                # keep today's earlier point if this run failed
                old_today = [p for p in series.get(key, []) if p.get("d") == today.isoformat()]
                pts.extend(old_today)
            pts.sort(key=lambda p: p["d"])
            series[key] = pts
    history = {"days": keep, "updated_at": iso(run_at), "series": series}

    latest["summary"] = {"ok": ok_count, "failed": fail_count}
    write_json(LATEST_PATH, latest)
    write_json(HISTORY_PATH, history)
    log(f"done: {ok_count} ok, {fail_count} failed")


if __name__ == "__main__":
    main()
