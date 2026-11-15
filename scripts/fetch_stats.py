#!/usr/bin/env python3
"""Fetch public stats for every page/platform in config.json.

Writes:
  data/latest.json   - current snapshot (one block per page/platform)
  data/history.json  - one snapshot per run per platform (full resolution 3 days,
                       hourly up to 14 days, daily up to history_days >= 90)
  data/avatars/      - local copy of every profile photo, re-downloaded every run

Rules:
  * Every platform runs in its own try/except. A failure keeps the previous
    values (marked "stale") instead of wiping them.
  * Numbers that cannot be read are stored as null - never guessed.
  * Polite pace: a delay between every request.

Optional environment variables:
  YT_API_KEY                   YouTube Data API v3 key
  YT_CLIENT_ID, YT_CLIENT_SECRET, TOKEN_KEY
                               connected YouTube channels (config/yt_tokens.enc.json, see yt_tokens.py):
                               exact per-video views/likes/comments + subscribers via the owner's OAuth
                               token, and the newest comments -> data/comments.json
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
POSTS_HISTORY_PATH = os.path.join(DATA_DIR, "posts_history.json")
COMMENTS_PATH = os.path.join(DATA_DIR, "comments.json")
COMMENTS_KEEP = 100
POSTS_KEEP_DAYS = 95

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

    rss_ok = False
    try:
        r = get("https://www.youtube.com/feeds/videos.xml", params={"channel_id": channel_id})
        r.raise_for_status()
        root = ET.fromstring(r.content)
        rss_ok = True
    except Exception as e:  # the RSS feed has been returning 404 since Nov 2026: use the channel tabs instead
        out["notes"].append(f"RSS feed failed: {type(e).__name__}: {str(e)[:60]}")
        root = None
    ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
          "m": "http://search.yahoo.com/mrss/"}
    for e in (root.findall("a:entry", ns)[:n] if root is not None else []):
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
    tabs_ok = False
    if not out["recent"]:
        # RSS missing/empty: read the Videos / Shorts / Live tabs, then each video's own page for exact numbers
        try:
            tabs_ok = youtube_tabs(channel_id, out, n)
        except Exception as e:
            out["notes"].append(f"videos/shorts tabs failed: {type(e).__name__}")
        if out["recent"]:
            youtube_details(out, prev)
    if not rss_ok and not tabs_ok:
        raise RuntimeError("YouTube RSS feed and channel tabs both unavailable")
    if out["posts"] is None and not out["recent"]:
        out["posts"] = 0
        out["notes"].append("no public videos found")
    if out["followers"] is None:
        out["notes"].append("subscriber count not shown publicly (zero or hidden)")
    out["notes"].append("no API key: comments unavailable")
    out["source"] = "YouTube channel page + RSS feed" if rss_ok else "YouTube channel page + video pages"
    out["ok"] = True
    return out


# --------------------------------------------------------------------------
# YouTube via a connected channel (official OAuth; the owner's own token)
# --------------------------------------------------------------------------
def yt_store():
    """Connected channels, or {} when the store / TOKEN_KEY is unavailable (public scraping then)."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import yt_tokens
        return yt_tokens, yt_tokens.load()
    except Exception as e:  # cryptography missing etc.
        log(f"yt token store unavailable: {type(e).__name__}")
        return None, {"channels": {}}


def yt_api(path, access, params):
    import yt_tokens
    r = get(f"{yt_tokens.API}/{path}", params=params, headers={"Authorization": f"Bearer {access}"})
    if r.status_code != 200:
        try:
            reason = ((r.json().get("error") or {}).get("errors") or [{}])[0].get("reason")
        except Exception:
            reason = None
        raise RuntimeError(f"{path} HTTP {r.status_code}" + (f" {reason}" if reason else ""))
    return r.json()


def youtube_oauth(handle, prev, ent, yt_tokens):
    """Exact stats for a connected channel. Returns (platform block, comments block)."""
    h = handle if handle.startswith("@") else "@" + handle
    out = blank("youtube", h, f"https://www.youtube.com/{h}")
    n = int(CONFIG.get("recent_posts", 12))
    access = yt_tokens.access_token(yt_tokens.decrypt(ent), session=SESSION)
    d = yt_api("channels", access, {"part": "snippet,statistics,contentDetails", "mine": "true"})
    items = d.get("items") or []
    if not items:
        raise RuntimeError("connected account has no channel")
    ch = items[0]
    if ch["id"] != ent["channel_id"]:
        raise RuntimeError("token now belongs to another channel")
    st, sn = ch.get("statistics", {}), ch.get("snippet", {})
    out["channel_id"] = ch["id"]
    out["title"] = sn.get("title")
    _th = sn.get("thumbnails", {})
    out["avatar"] = (_th.get("medium") or _th.get("default") or {}).get("url")
    subs = None if st.get("hiddenSubscriberCount") else to_int(st.get("subscriberCount"))
    out["followers"] = subs
    # the Data API rounds subscriber counts to 3 significant figures, so below 1,000 the number is exact
    out["followers_approx"] = bool(subs is not None and subs >= 1000)
    out["posts"] = to_int(st.get("videoCount"))
    out["total_views"] = to_int(st.get("viewCount"))
    titles = {}
    uploads = ch.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads")
    if uploads:
        pl = yt_api("playlistItems", access, {"part": "contentDetails", "playlistId": uploads, "maxResults": n})
        ids = [it["contentDetails"]["videoId"] for it in pl.get("items", [])]
        if ids:
            vd = yt_api("videos", access, {"part": "snippet,statistics,status", "id": ",".join(ids)})
            byid = {v["id"]: v for v in vd.get("items", [])}
            for vid in ids:  # keep the uploads order (newest first)
                v = byid.get(vid)
                if not v:
                    continue
                vsn, vs = v.get("snippet", {}), v.get("statistics", {})
                if (v.get("status") or {}).get("privacyStatus") not in (None, "public"):
                    continue  # the owner's token also sees private/unlisted uploads; the panel lists public ones
                thumbs = vsn.get("thumbnails", {})
                thumb = (thumbs.get("medium") or thumbs.get("default") or {}).get("url")
                titles[vid] = vsn.get("title")
                out["recent"].append(post(vid, vsn.get("title"), f"https://www.youtube.com/watch?v={vid}",
                                          vsn.get("publishedAt"), vs.get("viewCount"), vs.get("likeCount"),
                                          vs.get("commentCount"), thumb))
    comments = None
    try:
        comments = youtube_comments(ch["id"], access, titles)
    except Exception as e:
        out["notes"].append(f"comments failed: {str(e)[:80]}")
    out["source"] = "YouTube Data API v3 (حساب متصل)"
    out["oauth"] = {"channel_id": ch["id"], "status": "ok"}
    out["ok"] = True
    return out, comments


def youtube_comments(channel_id, access, titles):
    d = yt_api("commentThreads", access, {"part": "snippet,replies", "allThreadsRelatedToChannelId": channel_id,
                                          "maxResults": 50, "order": "time", "textFormat": "plainText"})
    threads = []
    for it in d.get("items", []):
        sn = it.get("snippet", {})
        top = (sn.get("topLevelComment") or {})
        ts = top.get("snippet", {})
        reps = []
        for rp in ((it.get("replies") or {}).get("comments") or []):
            rs = rp.get("snippet", {})
            reps.append({"id": rp.get("id"), "author": rs.get("authorDisplayName"),
                         "author_channel_id": (rs.get("authorChannelId") or {}).get("value"),
                         "avatar": rs.get("authorProfileImageUrl"), "text": rs.get("textDisplay") or rs.get("textOriginal"),
                         "likes": to_int(rs.get("likeCount")), "published": rs.get("publishedAt")})
        reps.sort(key=lambda x: x.get("published") or "")
        vid = sn.get("videoId") or ts.get("videoId")
        threads.append({"id": it.get("id"), "comment_id": top.get("id"), "video_id": vid,
                        "video_title": titles.get(vid), "author": ts.get("authorDisplayName"),
                        "author_channel_id": (ts.get("authorChannelId") or {}).get("value"),
                        "avatar": ts.get("authorProfileImageUrl"),
                        "text": ts.get("textDisplay") or ts.get("textOriginal"), "likes": to_int(ts.get("likeCount")),
                        "published": ts.get("publishedAt"), "updated": ts.get("updatedAt"),
                        "reply_count": to_int(sn.get("totalReplyCount")), "can_reply": bool(sn.get("canReply", True)),
                        "replies": reps})
    threads.sort(key=lambda x: x.get("published") or "", reverse=True)
    return {"channel_id": channel_id, "fetched_at": iso(now_utc()), "threads": threads}


def merge_comments(old, new):
    """Keep threads seen before (newest COMMENTS_KEEP), refreshed by the newest read."""
    byid = {t["id"]: t for t in (old or {}).get("threads", []) if t.get("id")}
    for t in new.get("threads", []):
        byid[t["id"]] = t
    th = sorted(byid.values(), key=lambda x: x.get("published") or "", reverse=True)[:COMMENTS_KEEP]
    return {"channel_id": new.get("channel_id"), "fetched_at": new.get("fetched_at"), "threads": th}


def youtube_details(out, prev):
    """Exact numbers for each listed video from its watch page (views, likes, publish time).
    Values the page does not give stay as read from the tabs; dates fall back to the previous run's."""
    prev_by_id = {x.get("id"): x for x in ((prev or {}).get("recent") or [])}
    exact = 0
    exact_date = set()
    for p in out["recent"]:
        old = prev_by_id.get(p["id"]) or {}
        try:
            r = get("https://www.youtube.com/watch", params={"v": p["id"], "hl": "en", "gl": "US"},
                    cookies={"CONSENT": "YES+1", "SOCS": "CAI"})
            if r.status_code != 200 or "/sorry/" in r.url:
                raise RuntimeError(f"HTTP {r.status_code}")
            t = r.text
            vc = re.search(r'"videoDetails":\{.*?"viewCount":"(\d+)"', t, re.S)
            if vc:
                p["views"] = int(vc.group(1))
                p.pop("views_approx", None)
                exact += 1
            pd = re.search(r'"publishDate":"([^"]+)"', t) or re.search(r'"uploadDate":"([^"]+)"', t)
            if pd and len(pd.group(1)) > 10:
                dt = parse_ts(pd.group(1))
                if dt:
                    p["published"] = iso(dt)
                    exact_date.add(p["id"])
            lk = (re.search(r'along with ([\d,]+) other', t) or re.search(r'"likeCount":"?(\d+)', t))
            if lk:
                p["likes"] = to_int(lk.group(1))
        except Exception as e:
            out["notes"].append(f"video page {p['id']}: {type(e).__name__}")
        if p["id"] not in exact_date and old.get("published"):
            p["published"] = old.get("published")  # the earlier exact date beats "3 days ago" from the tab
    if exact:
        out["notes"].append(f"exact view counts from {exact}/{len(out['recent'])} video pages")
    log(f"      youtube details: {exact}/{len(out['recent'])} exact")


def _ago_to_dt(text):
    """'3 days ago' / 'Streamed 2 hours ago' -> approximate UTC datetime."""
    m = re.search(r"(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago", text or "")
    if not m:
        return None
    k = int(m.group(1))
    sec = {"second": 1, "minute": 60, "hour": 3600, "day": 86400, "week": 604800,
           "month": 2592000, "year": 31536000}[m.group(2)]
    return now_utc() - timedelta(seconds=k * sec)


def _walk(o, key):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key:
                yield v
            yield from _walk(v, key)
    elif isinstance(o, list):
        for v in o:
            yield from _walk(v, key)


def youtube_tabs(channel_id, out, n):
    seen = {p["id"] for p in out["recent"]}
    parsed = False
    for tab in ("videos", "shorts", "streams"):
        r = get(f"https://www.youtube.com/channel/{channel_id}/{tab}", params={"hl": "en", "gl": "US"},
                cookies={"CONSENT": "YES+1", "SOCS": "CAI"})
        if r.status_code != 200:
            continue
        m = re.search(r"var ytInitialData = (\{.*?\});</script>", r.text, re.S)
        if not m:
            continue
        data = json.loads(m.group(1))
        parsed = True
        for v in _walk(data, "videoRenderer"):
            vid = v.get("videoId")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            title = "".join(x.get("text", "") for x in (v.get("title") or {}).get("runs", []))
            pub = _ago_to_dt((v.get("publishedTimeText") or {}).get("simpleText"))
            views = to_int(re.sub(r"\D", "", (v.get("viewCountText") or {}).get("simpleText", "")) or None)
            out["recent"].append(post(vid, title, f"https://www.youtube.com/watch?v={vid}", pub, views,
                                      thumb=f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"))
        for v in _walk(data, "shortsLockupViewModel"):
            vid = ((v.get("onTap") or {}).get("innertubeCommand") or {}).get("reelWatchEndpoint", {}).get("videoId")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            title = ((v.get("overlayMetadata") or {}).get("primaryText") or {}).get("content", "")
            vtxt = ((v.get("overlayMetadata") or {}).get("secondaryText") or {}).get("content", "")
            views, approx = parse_compact(vtxt) if re.search(r"\d", vtxt or "") else (None, False)
            p = post(vid, title, f"https://www.youtube.com/shorts/{vid}", None, views,
                     thumb=f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg")
            if approx:
                p["views_approx"] = True
            out["recent"].append(p)
    out["recent"] = out["recent"][:n]
    if out["recent"]:
        out["notes"].append("recent videos from channel tabs")
        if out["posts"] is None:
            out["posts"] = len(out["recent"])
    return parsed


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

    # public profile embed page: profile photo, followers, post count and the
    # latest posts with their dates / likes / comments (works without login)
    try:
        if instagram_embed(username, out, n):
            return out
    except Exception as e:
        out["notes"].append(f"embed page failed: {type(e).__name__}: {str(e)[:80]}")

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


IG_EMBED_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
               "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")


def instagram_embed(username, out, n):
    """Read https://www.instagram.com/<user>/embed/ (contextJSON). Returns True on success."""
    r = get(f"https://www.instagram.com/{username}/embed/", headers={"User-Agent": IG_EMBED_UA,
                                                                     "Accept": "text/html"})
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    m = re.search(r'"contextJSON":"((?:\\.|[^"\\])*)"', r.text)
    if not m:
        raise RuntimeError("contextJSON not found (account missing, private or layout changed)")
    ctx = json.loads(json.loads('"' + m.group(1) + '"')).get("context") or {}
    if not ctx.get("username"):
        raise RuntimeError("empty profile context")
    out["title"] = ctx.get("full_name") or ctx.get("username")
    out["avatar"] = ctx.get("profile_pic_url")
    out["followers"] = to_int(ctx.get("followers_count"))
    out["posts"] = to_int(ctx.get("posts_count"))
    for g in (ctx.get("graphql_media") or [])[:n]:
        nd = g.get("shortcode_media") or {}
        sc = nd.get("shortcode")
        if not sc:
            continue
        cap = ""
        caps = (nd.get("edge_media_to_caption") or {}).get("edges") or []
        if caps:
            cap = (caps[0].get("node") or {}).get("text", "")
        ts = nd.get("taken_at_timestamp")
        likes = (nd.get("edge_liked_by") or nd.get("edge_media_preview_like") or {}).get("count")
        kind = "reel" if nd.get("is_video") else "p"
        thumb = None
        res = nd.get("display_resources") or []
        if res:
            thumb = res[0].get("src")
        out["recent"].append(post(sc, cap, f"https://www.instagram.com/{kind}/{sc}/",
                                  datetime.fromtimestamp(ts, timezone.utc) if ts else None,
                                  nd.get("video_view_count"), likes,
                                  (nd.get("edge_media_to_comment") or {}).get("count"), thumb))
    out["notes"].append("public embed page: views/shares/saves need the Graph API token")
    out["source"] = "Instagram public profile embed"
    out["ok"] = True
    return True


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


AVATAR_DIR = os.path.join(DATA_DIR, "avatars")


def is_placeholder_bytes(content):
    """True for auto-generated letter avatars / flat platform defaults (not a real profile photo)."""
    try:
        from io import BytesIO
        from PIL import Image
        im = Image.open(BytesIO(content)).convert("RGB").resize((64, 64))
        cols = sorted(im.getcolors(4096) or [], reverse=True)
        if not cols:
            return False  # very many colours -> a photo
        top2 = sum(c for c, _ in cols[:2]) / 4096
        return top2 > 0.6  # flat background + one letter / silhouette
    except Exception:
        return False


def store_avatar(pid, plat, url):
    """Download the profile photo on EVERY run (no reuse of old URLs) and keep a local copy
    in data/avatars/ so the site never depends on expiring CDN links.
    Returns (local_path_or_None, sha8_or_None, reason)."""
    path = os.path.join(AVATAR_DIR, f"{pid}-{plat}.jpg")
    if not url or "avatar-is-chann" in url or "default" in url.lower():
        if os.path.exists(path):
            os.remove(path)
        return None, None, "placeholder url"
    r = get(url, headers={"Accept": "image/*"})
    r.raise_for_status()
    if is_placeholder_bytes(r.content):
        if os.path.exists(path):
            os.remove(path)
        return None, None, "placeholder image"
    import hashlib
    try:  # normalise to a small JPEG
        from io import BytesIO
        from PIL import Image
        im = Image.open(BytesIO(r.content)).convert("RGB")
        im.thumbnail((256, 256))
        buf = BytesIO()
        im.save(buf, "JPEG", quality=86)
        content = buf.getvalue()
    except Exception:
        content = r.content
    os.makedirs(AVATAR_DIR, exist_ok=True)
    old = open(path, "rb").read() if os.path.exists(path) else None
    if old != content:
        with open(path, "wb") as f:
            f.write(content)
    return f"data/avatars/{pid}-{plat}.jpg", hashlib.sha1(content).hexdigest()[:8], "ok"


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


def parse_ts(v):
    """ISO string (with Z or offset) -> aware datetime, or None."""
    if not v:
        return None
    s = str(v).strip()
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=TEHRAN)
    except ValueError:
        pass
    # display-style strings, e.g. "Sat 2026-11-14 4:24 PM (UTC+03:30)"
    m = re.match(r"^(?:[A-Za-z]{3},?\s+)?(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?"
                 r"\s*\(?\s*(?:UTC|GMT)?\s*([+-]\d{2}):?(\d{2})?\s*\)?$", s)
    if not m:
        return None
    h = int(m.group(4))
    if m.group(7):
        pm = m.group(7).lower() == "pm"
        h = (12 if pm else 0) if h == 12 else h + (12 if pm else 0)
    tz = TEHRAN
    if m.group(8):
        sign = -1 if m.group(8)[0] == "-" else 1
        tz = timezone(sign * timedelta(hours=int(m.group(8)[1:]), minutes=int(m.group(9) or 0)))
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), h, int(m.group(5)), int(m.group(6) or 0), tzinfo=tz)
    except ValueError:
        return None


def point_time(p):
    """History point -> aware datetime. Old points only had a Tehran date ('d')."""
    if p.get("t"):
        return parse_ts(p["t"])
    if p.get("d"):
        try:
            return datetime.fromisoformat(p["d"] + "T12:00:00").replace(tzinfo=TEHRAN)
        except ValueError:
            return None
    return None


def prune_series(pts, now):
    """Full resolution for 3 days, then one point per hour up to 14 days,
    then one point per (Tehran) day; drop anything older than history_days (+ margin)."""
    keep_days = max(90, int(CONFIG.get("history_days", 90)))
    out, seen_hour, seen_day = [], set(), set()
    parsed = []
    for p in pts:
        t = parse_ts(p.get("t"))
        if t is not None:
            parsed.append((t, dict(p, t=iso(t))))  # normalize any legacy time string to ISO UTC
    for t, p in sorted(parsed, key=lambda x: x[0], reverse=True):  # newest first: keep latest per bucket
        age = now - t
        if age > timedelta(days=keep_days + 5):
            continue
        if age <= timedelta(days=3):
            out.append(p)
        elif age <= timedelta(days=14):
            k = t.astimezone(timezone.utc).strftime("%Y%m%d%H")
            if k not in seen_hour:
                seen_hour.add(k)
                out.append(p)
        else:
            k = t.astimezone(TEHRAN).date().isoformat()
            if k not in seen_day:
                seen_day.add(k)
                out.append(p)
    out.sort(key=lambda q: q["t"])
    return out


def resolution_key(t, now):
    """Same resolution policy as history.json: every point for 3 days, one per hour to 14 days, one per Tehran day after."""
    age = now - t
    if age <= timedelta(days=3):
        return None
    if age <= timedelta(days=14):
        return "h" + t.astimezone(timezone.utc).strftime("%Y%m%d%H")
    return "d" + t.astimezone(TEHRAN).date().isoformat()


def prune_times(items, now, tf, keep_first=False):
    """Keep the newest item per resolution bucket; drop items older than POSTS_KEEP_DAYS
    (keep_first: the oldest item is always kept, it marks the first observation)."""
    parsed = [(tf(x), x) for x in items]
    parsed = [(t, x) for t, x in parsed if t is not None]
    parsed.sort(key=lambda q: q[0])
    first = parsed[0][1] if (keep_first and parsed) else None
    out, seen = [], set()
    for t, x in reversed(parsed):
        if now - t > timedelta(days=POSTS_KEEP_DAYS) and x is not first:
            continue
        k = resolution_key(t, now)
        if k is not None and x is not first:
            if k in seen:
                continue
            seen.add(k)
        out.append(x)
    out.reverse()
    return out


def update_posts_history(ph, latest, run_at):
    """Per-post snapshot history (data/posts_history.json).

    channels["<page>/<platform>"] = {
      "runs": [iso, ...]          every successful read of this account (coverage of the data)
      "posts": {"<post id>": {"title","url","thumb","published","first","last",
                              "s": [[iso, views, likes, comments], ...]}}
    }
    "s" stores the first observation and then a point only when a number changed, so the value at any
    time between first and last is the last point at or before it. Views that the source gave only
    rounded (e.g. "1.2K") are stored as null - never as a guessed number."""
    chans = ph.setdefault("channels", {})
    for pid, pb in latest["pages"].items():
        for plat, r in pb["platforms"].items():
            if not r.get("ok") or r.get("stale"):
                continue
            t = parse_ts(r.get("fetched_at")) or run_at
            ts = iso(t)
            ch = chans.setdefault(f"{pid}/{plat}", {"runs": [], "posts": {}})
            if ts in ch["runs"]:
                continue
            ch["runs"].append(ts)
            for x in r.get("recent") or []:
                post_id = str(x.get("id") or "")
                if not post_id:
                    continue
                vals = [None if x.get("views_approx") else to_int(x.get("views")), to_int(x.get("likes")),
                        to_int(x.get("comments"))]
                e = ch["posts"].setdefault(post_id, {"s": []})
                e["title"] = (x.get("title") or "")[:120]
                e["url"] = x.get("url")
                e["thumb"] = x.get("thumb")
                if x.get("published"):
                    e["published"] = x.get("published")
                e.setdefault("first", ts)
                if parse_ts(e.get("last")) is None or parse_ts(e["last"]) < t:
                    e["last"] = ts
                if not e["s"] or e["s"][-1][1:] != vals:
                    e["s"].append([ts] + vals)
    return ph


def prune_posts_history(ph, now):
    for key, ch in ph.get("channels", {}).items():
        ch["runs"] = prune_times(ch.get("runs", []), now, parse_ts)
        posts = {}
        for post_id, e in (ch.get("posts") or {}).items():
            last = parse_ts(e.get("last"))
            if last is None or now - last > timedelta(days=POSTS_KEEP_DAYS):
                continue
            e["s"] = prune_times(e.get("s", []), now, lambda q: parse_ts(q[0]), keep_first=True)
            if e["s"]:
                e["first"] = min(e.get("first") or e["s"][0][0], e["s"][0][0], key=lambda v: parse_ts(v))
            posts[post_id] = e
        ch["posts"] = posts
    ph["v"] = 1
    ph["updated_at"] = iso(now)
    ph["resolution"] = "all runs for 3 days, hourly to 14 days, daily to 95 days; post values stored on change"
    return ph


def write_compact(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, path)


def snapshot_point(r, at):
    recent = r.get("recent") or []

    def sum_of(k):
        vals = [x.get(k) for x in recent if x.get(k) is not None]
        return sum(vals) if vals else None
    views = r.get("total_views") if r.get("total_views") is not None else sum_of("views")
    likes = r.get("total_likes") if r.get("total_likes") is not None else sum_of("likes")
    # basis of each cumulative number: "t" = channel total, "r" = sum over the recent-posts list.
    # The app only diffs consecutive snapshots with the same basis (and, for "r", the same post count),
    # so a post entering/leaving the recent list is never shown as new views/likes/comments.
    basis = {"v": "t" if r.get("total_views") is not None else "r",
             "l": "t" if r.get("total_likes") is not None else "r",
             "c": "r"}
    return {"t": iso(at), "f": r.get("followers"), "p": r.get("posts"), "v": views, "l": likes,
            "c": sum_of("comments"), "b": basis}


def newest_post(r):
    dates = [x.get("published") for x in (r.get("recent") or []) if x.get("published")]
    return max(dates) if dates else None


def main():
    global CONFIG
    CONFIG = load_json(CONFIG_PATH, None)
    if not CONFIG:
        sys.exit("config.json missing or invalid")
    only = set(a.lower() for a in sys.argv[1:])  # optional: limit to platforms, e.g. `youtube tiktok`

    os.makedirs(DATA_DIR, exist_ok=True)
    prev_latest = load_json(LATEST_PATH, {"pages": {}})
    history = load_json(HISTORY_PATH, {"days": 0, "series": {}})

    yt_mod, yt_st = yt_store()
    comments = load_json(COMMENTS_PATH, {"v": 1, "channels": {}})
    comments.setdefault("channels", {})

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
            oauth_info = None
            try:
                res = None
                if plat == "youtube":
                    ent = yt_mod.entry_for_page(yt_st, pid) if yt_mod else None
                    bad = (yt_mod.entry_for_page(yt_st, pid, allow_mismatch=True) if yt_mod and not ent else None)
                    if bad:
                        oauth_info = {"channel_id": bad["channel_id"], "status": "mismatch"}
                    if ent:
                        try:
                            res, cm = youtube_oauth(handle, prev, ent, yt_mod)
                            if cm is not None:
                                key = f"{pid}/youtube"
                                comments["channels"][key] = merge_comments(comments["channels"].get(key), cm)
                        except Exception as e:  # messages here never contain a token (Bearer header / POST body)
                            msg = str(e)[:160]
                            oauth_info = {"channel_id": ent["channel_id"], "status": "revoked" if msg == "revoked" else "error",
                                          "error": msg, "at": iso(now_utc())}
                            log(f"WARN  {pid:16s} youtube   connected-channel API failed: {msg}; using public pages")
                            res = None
                if res is None:
                    res = FETCHERS[plat](handle, prev)
                    if oauth_info:
                        res["oauth"] = oauth_info
                res["fetched_at"] = iso(now_utc())
                src = res.get("avatar")
                res["avatar_src"] = src
                res["avatar"] = None
                res["avatar_hash"] = None
                try:
                    local, h, why = store_avatar(pid, plat, src)
                    res["avatar"], res["avatar_hash"] = local, h
                except Exception as e:  # download failed: fall back to the fresh remote URL
                    res["avatar"] = src
                    res["notes"].append(f"avatar download failed: {type(e).__name__}")
                ok_count += 1
                log(f"OK    {pid:16s} {plat:9s} followers={res['followers']} posts={res['posts']} "
                    f"recent={len(res['recent'])} avatar={'yes' if res['avatar'] else 'no'} via {res['source']}")
            except Exception as e:
                fail_count += 1
                err = f"{type(e).__name__}: {str(e)[:200]}"
                log(f"FAIL  {pid:16s} {plat:9s} {err}")
                if prev and prev.get("fetched_at"):
                    res = dict(prev)
                    res["stale"] = True
                    res["error"] = err
                    res.pop("oauth", None)
                else:
                    res = blank(plat, handle, "")
                    res["url"] = {"instagram": f"https://www.instagram.com/{handle}/",
                                  "youtube": f"https://www.youtube.com/{handle if handle.startswith('@') else '@' + handle}",
                                  "aparat": f"https://www.aparat.com/{handle}",
                                  "tiktok": f"https://www.tiktok.com/@{handle.lstrip('@')}"}[plat]
                    res["error"] = err
                res["last_attempt_at"] = iso(now_utc())
                if oauth_info:
                    res["oauth"] = oauth_info

            # activity markers: newest dated post, and when the post count / newest post last changed
            res["last_post_at"] = newest_post(res)
            changed = False
            if prev and not res.get("stale"):
                pp, np_ = prev.get("posts"), res.get("posts")
                if pp is not None and np_ is not None and np_ > pp:
                    changed = True
                prev_ids = {x.get("id") for x in (prev.get("recent") or [])}
                if prev.get("fetched_at") and any(x.get("id") not in prev_ids for x in res.get("recent") or []):
                    changed = True
            if changed:
                res["last_change_at"] = iso(run_at)
            else:
                res["last_change_at"] = (prev or {}).get("last_change_at")
                if not res["last_change_at"] and (res.get("posts") or 0) > 0:
                    # first time: earliest snapshot that already shows the current post count
                    pts = [q for q in history.get("series", {}).get(f"{pid}/{plat}", []) if q.get("p") is not None]
                    pts.sort(key=lambda q: point_time(q) or run_at)
                    when = None
                    for q in pts:
                        if q.get("p") == res.get("posts") and when is None:
                            when = point_time(q)
                        elif q.get("p") != res.get("posts"):
                            when = None
                    res["last_change_at"] = iso(when) if when else None
            pblock["platforms"][plat] = res
        latest["pages"][pid] = pblock

    # ---- history: one snapshot per run; full resolution 3 days, hourly to 14 days, daily after
    series = history.get("series", {})
    for key in list(series.keys()):  # migrate old daily points {"d": ...} -> {"t": ...}
        conv = []
        for q in series[key]:
            if "t" not in q:
                t = point_time(q)
                if t is None:
                    continue
                q = {"t": iso(t), "f": q.get("f"), "p": q.get("p")}
            conv.append(q)
        series[key] = conv
    for pid, pb in latest["pages"].items():
        for plat, r in pb["platforms"].items():
            key = f"{pid}/{plat}"
            pts = list(series.get(key, []))
            if r.get("ok") and not r.get("stale") and (r.get("followers") is not None or r.get("posts") is not None):
                pts.append(snapshot_point(r, run_at))
            series[key] = prune_series(pts, run_at)
    history = {"days": max(90, int(CONFIG.get("history_days", 90))), "updated_at": iso(run_at),
               "resolution": "all points for 3 days, hourly to 14 days, daily after", "series": series}

    latest["summary"] = {"ok": ok_count, "failed": fail_count}
    write_json(LATEST_PATH, latest)
    write_compact(HISTORY_PATH, history)  # compact: this file grows with every run

    # ---- per-post history (views/likes/comments of every listed post, per run)
    ph = load_json(POSTS_HISTORY_PATH, {"v": 1, "channels": {}})
    update_posts_history(ph, latest, run_at)
    prune_posts_history(ph, run_at)
    write_compact(POSTS_HISTORY_PATH, ph)

    # ---- comments of connected YouTube channels (only channels still connected are kept)
    live = {f"{e.get('page')}/youtube" for e in yt_st.get("channels", {}).values()}
    comments["channels"] = {k: v for k, v in comments["channels"].items() if k in live}
    if comments["channels"] or os.path.exists(COMMENTS_PATH):
        comments["updated_at"] = iso(run_at)
        write_json(COMMENTS_PATH, comments)
    log(f"done: {ok_count} ok, {fail_count} failed")


if __name__ == "__main__":
    main()
